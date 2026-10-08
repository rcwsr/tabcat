// An AI service of the user's choosing, through the OpenAI-compatible chat completions API
// (OpenAI, OpenRouter, Ollama, LM Studio…). If it's set up in Settings, it's asked to name
// new groups and, in the same request, to say which tabs belong in an existing group or
// category (see plan.js). Tab titles, sites and some page descriptions go to the service's
// address.

import { isThin } from "./cluster.js";

// Firefox's data collection permission for sending tab data off this computer.
export const SEND_TAB_DATA = { data_collection: ["browsingActivity", "websiteContent"] };

// Whether the address is on this computer, so tab data doesn't leave it.
export function isLocal(url) {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

// The service's address from Settings, checked, without a trailing slash. Throws with a
// message for the user.
export function checkAddress(url) {
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error("The AI service address isn't a valid URL.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal(parsed.href))) {
    throw new Error("The AI service address must start with https:// (or http:// on this computer).");
  }
  return parsed.href.replace(/\/$/, "");
}

// The address, key and model from Settings, checked. Returns { url, key, model } to save,
// or throws with a message for the user.
export function checkService({ url, key, model }) {
  const address = checkAddress(url);
  if (!model.trim()) throw new Error("Choose the AI service's model.");
  return { url: address, key: key.trim(), model: model.trim() };
}

// One request to the service: the reply's body, or the service's error.
async function send({ apiUrl, apiKey }, path, request) {
  let res;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method: request ? "POST" : "GET",
      headers: { ...(request && { "Content-Type": "application/json" }), ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
      body: request && JSON.stringify(request),
    });
  } catch {
    throw new Error(`Can't reach the AI service at ${apiUrl}.`);
  }
  const body = await res.json().catch(() => ({}));
  const error = !res.ok && (body.error?.message || (typeof body.error === "string" && body.error) || `error ${res.status}`);
  return { body, error };
}

const post = (service, request) => send(service, "/chat/completions", request);

// Models that can't chat (embeddings, speech, images), which services list alongside the rest.
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|sora|davinci|babbage/i;

// The models the service offers for chat, A–Z, for Settings to choose from. Throws with the
// service's error.
export async function listModels(service) {
  const { body, error } = await send(service, "/models");
  if (error) throw new Error(error);
  const ids = (body.data ?? []).map((m) => m?.id).filter((id) => typeof id === "string" && !NOT_CHAT.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

// Services that only take their default temperature, by address and model.
const defaultTemperature = new Set();

// The service's reply to a chat: { text, usage: { input, output } } (tokens). Tab data only
// leaves this computer with Firefox's permission; `sample` is for requests with made-up
// tabs (Settings' Test button).
//
// It asks for the likeliest answer (temperature 0), so the same tabs get the same groups.
// Measured with scripts/eval.mjs: at Gemma's default temperature, one request's answers
// ranged from much better than this computer's to much worse; at 0 they were the same every
// time, and better. Some services (OpenAI's reasoning models) refuse it: they're asked again
// without.
export async function chat(service, messages, { sample = false } = {}) {
  if (!sample && !isLocal(service.apiUrl) && !(await browser.permissions.contains(SEND_TAB_DATA))) {
    throw new Error("Tabcat isn't allowed to send tab data to your AI service. Save it in Settings again to allow it.");
  }
  const request = { model: service.apiModel, messages };
  const key = `${service.apiUrl} ${service.apiModel}`;
  let { body, error } = await post(service, defaultTemperature.has(key) ? request : { ...request, temperature: 0 });
  if (error && /temperature/i.test(error) && !defaultTemperature.has(key)) {
    defaultTemperature.add(key);
    ({ body, error } = await post(service, request));
  }
  if (error) throw new Error(`AI service: ${error}`);
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("AI service: no answer in the reply.");
  return { text, usage: { input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0 } };
}

const site = (url) => {
  try {
    return new URL(/^https?:/.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// One tab, as briefly as is still useful: the title and the site. A title that says almost
// nothing ("YouTube") gets the start of its page's description.
export function describeTab({ title = "", url = "", description = "" }) {
  const name = title.length > 90 ? `${title.slice(0, 89)}…` : title;
  const about = isThin(title) && description ? ` — ${description.trim().slice(0, 150)}` : "";
  return `${name} (${site(url)})${about}`;
}

// The user's own instructions (apiPrompt in Settings), added after Tabcat's.
const withInstructions = (system, instructions) =>
  instructions?.trim() ? `${system}\n\nThe user's instructions:\n${instructions.trim()}` : system;

// Asks which group each tab belongs in, by name: an existing group's, or a new one. Tabs
// given the same new name become a group. Everything that's the same for each request (the
// rules, then the existing groups) comes first, so a service that caches the start of
// prompts (llama.cpp, LM Studio, OpenAI) can reuse it.
// - tabs: [{ title, url, description }], related tabs side by side.
// - groups: [{ name, about, examples: [title] }]: the existing groups and categories the
//   tabs might belong in. `about` is what belongs in a category.
export function namingMessages(tabs, groups = [], instructions) {
  let system =
    "You sort browser tabs into groups. Give each numbered tab the name of the group it belongs " +
    "in: one to three words, title case, saying what the tabs are about or for (like Trip to " +
    "Lisbon, Rust, House Hunting, Shopping). Tabs about the same thing get the same name. Don't " +
    "use email addresses, people's names, numbers or codes from the titles.";
  if (groups.length) {
    const list = groups
      .map(({ name, about, examples = [] }) => `- ${name}${about ? `: ${about}` : ""}${examples.length ? ` (like ${examples.join("; ")})` : ""}`)
      .join("\n");
    system +=
      "\n\nThese groups already exist. When a tab clearly fits one of them, answer with its name exactly " +
      `as written; only give a new name when none fits:\n${list}`;
  }
  system += "\n\nReply with one line per tab and nothing else, like:\n1: Trip to Lisbon\n2: Trip to Lisbon\n3: Rust";
  const list = tabs.map((tab, n) => `${n + 1}. ${describeTab(tab)}`).join("\n");
  return [
    { role: "system", content: withInstructions(system, instructions) },
    { role: "user", content: `Tabs:\n${list}` },
  ];
}

// Reasoning models put their thinking in the reply; the answer comes after it.
const answerOf = (text) => text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

// One name, cleaned up, or "" if it isn't usable.
export function cleanName(text) {
  // Some local models leak control tokens ("Rust<channel|>").
  const name = text.replace(/<[^>]*>/g, "").replace(/^(name|group)\s*:\s*/i, "").replace(/^["'“‘*`]+|["'”’*`.]+$/g, "").trim();
  return name.length <= 40 ? name : "";
}

// The names in a reply to namingMessages: one per tab ("" where it gave none).
export function parseNames(text, count) {
  const names = Array(count).fill("");
  for (const line of answerOf(text).split("\n")) {
    const match = /^\s*[-*]?\s*(\d+)\s*[:.)\]-]\s*(.+)$/.exec(line);
    if (match && match[1] >= 1 && match[1] <= count) names[match[1] - 1] ||= cleanName(match[2]);
  }
  return names;
}

// Made-up tabs for Settings' Test button, so a test sends none of yours.
export const SAMPLE_TABS = [
  { title: "Cheap flights London to Lisbon | Skyscanner", url: "https://www.skyscanner.net/routes/lond/lis/" },
  { title: "Hotels in Alfama, Lisbon - Booking.com", url: "https://www.booking.com/district/pt/lisbon/alfama.html" },
];
