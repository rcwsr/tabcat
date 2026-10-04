// An AI service of the user's choosing, through the OpenAI-compatible chat completions API
// (OpenAI, OpenRouter, Ollama, LM Studio…). Used, if set up in Settings, to name groups and
// to sort tabs into categories. Tab titles, addresses and page descriptions go to the
// service's address.

// Firefox's data collection permission for sending tab data off this computer.
export const SEND_TAB_DATA = { data_collection: ["browsingActivity", "websiteContent"] };

// Whether the address is on this computer, so tab data doesn't leave it.
export function isLocal(url) {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

// The address, key and model from Settings, checked. Returns { url, key, model } to save,
// or throws with a message for the user.
export function checkService({ url, key, model }) {
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error("The AI service address isn't a valid URL.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal(parsed.href))) {
    throw new Error("The AI service address must start with https:// (or http:// on this computer).");
  }
  if (!model.trim()) throw new Error("Enter the AI service's model.");
  return { url: parsed.href.replace(/\/$/, ""), key: key.trim(), model: model.trim() };
}

// The service's reply to a chat, as text.
export async function chat({ apiUrl, apiKey, apiModel }, messages) {
  if (!isLocal(apiUrl) && !(await browser.permissions.contains(SEND_TAB_DATA))) {
    throw new Error("Tabcat isn't allowed to send tab data to your AI service. Save it in Settings again to allow it.");
  }
  let res;
  try {
    res = await fetch(`${apiUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify({ model: apiModel, messages }),
    });
  } catch {
    throw new Error(`Can't reach the AI service at ${apiUrl}.`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.error?.message ?? (typeof body.error === "string" ? body.error : "");
    throw new Error(`AI service: ${detail || `error ${res.status}`}`);
  }
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("AI service: no answer in the reply.");
  return text;
}

// Tabs given as { title, url, description }.
const describe = (tabs) =>
  tabs.map(({ title, url, description }) => `- ${title} (${url})${description ? `\n  ${description.slice(0, 300)}` : ""}`).join("\n");

export function namingMessages(tabs) {
  return [
    {
      role: "system",
      content:
        "You name groups of browser tabs. Reply with the name only: one to three words, " +
        "title case, saying what the tabs are about or for (like Trip to Lisbon, Rust, " +
        "House Hunting, Shopping). No quotes or punctuation. Don't use email addresses, " +
        "people's names, numbers or codes from the titles.",
    },
    { role: "user", content: `Tabs in the group:\n${describe(tabs)}` },
  ];
}

// The name in a reply, or "" if there isn't a usable one.
export function parseName(text) {
  const line = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n")[0];
  const name = line.replace(/^(name|group)\s*:\s*/i, "").replace(/^["'“‘*`]+|["'”’*`.]+$/g, "").trim();
  return name.length <= 40 ? name : "";
}

// categories: { key: what belongs }.
export function categoryMessages(tab, categories) {
  const list = Object.entries(categories).map(([key, criteria]) => `- ${key}: ${criteria}`).join("\n");
  return [
    {
      role: "system",
      content:
        "You sort browser tabs into categories. Reply with the category's name only, exactly " +
        "as listed, or none if no category clearly fits.\n\nCategories:\n" + list,
    },
    { role: "user", content: `Tab:\n${describe([tab])}` },
  ];
}

// The category key in a reply, or null for none (or an answer that isn't a category).
export function parseCategory(text, categories) {
  const answer = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n")[0]
    .replace(/^category\s*:\s*/i, "").replace(/^["'“‘*`-]+|["'”’*`.]+$/g, "").trim().toLowerCase();
  return Object.keys(categories).find((k) => k.toLowerCase() === answer) ?? null;
}
