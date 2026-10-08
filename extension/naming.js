// Naming groups on this computer: pure helpers, no browser APIs, so they can be tested in Node.

const STOP_WORDS = new Set(
  ("the a an and or of to in for on with by from at is are vs how what your you my our " +
    "www com co uk org net html en us docs documentation home best things week sign new")
    .split(" "),
);

function words(text) {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

// Words that appear in at least two different titles, most common first.
export function sharedKeywords(titles, limit = 3) {
  const count = new Map();
  for (const t of new Set(titles)) for (const w of new Set(words(t))) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

// What a group's name is made from, for tabs given as { title, description, keywords }:
// each distinct title once (copies of one page would make every word "shared"), with its
// page's description, and the words the titles share followed by the pages' own keywords.
export function namingInputs(tabs) {
  const lines = new Map(); // title -> line
  for (const { title = "", description = "" } of tabs) {
    const d = description.trim().slice(0, 200);
    if (!lines.has(title) || d) lines.set(title, d ? `${title} — ${d}` : title);
  }
  const own = tabs.flatMap(({ keywords = "" }) =>
    keywords.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 3),
  );
  const keywords = [...new Set([...sharedKeywords([...lines.keys()]), ...own])].slice(0, 6);
  return { lines: [...lines.values()], keywords };
}

// A site's name for a page: the name it gives itself (og:site_name, or a web app's
// application-name), else its hostname. The small topic model names a single page badly
// ("Appliances" for a pack of washers), so a group of one page is named after its site.
export function siteName(site, url) {
  return site?.trim() || new URL(url).hostname.replace(/^www\./, "");
}

// The prompt format Firefox's own smart tab groups use with Mozilla/smart-tab-topic.
export function topicPrompt(titles, keywords) {
  return `Topic from keywords: ${keywords.join(", ")}. titles: \n${titles.join(" \n")}`;
}

const capitalise = (w) => w.charAt(0).toUpperCase() + w.slice(1);

// Possible names for a group, best first: the topic model's suggestion, then shared title
// words, then the site if every tab is on the same one. At most 8.
export function nameCandidates(topic, keywords, hosts) {
  const names = [];
  // The topic model sometimes stutters ("Tax Tax").
  topic = topic?.replace(/(^|\s)(\p{L}+)(?:\s+\2)+(?=\s|$)/giu, "$1$2");
  if (topic && !/^none$/i.test(topic)) names.push(capitalise(topic));
  names.push(...keywords.map(capitalise));
  if (hosts.length && hosts.every((h) => h === hosts[0])) names.push(hosts[0].replace(/^www\./, ""));
  const seen = new Set();
  return names
    .filter((n) => {
      const key = n.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

// `base`, or `base 2`, `base 3`… whichever isn't in `taken` (compared ignoring case). An
// unrelated group shouldn't be folded into another just because the names match.
export function uniqueName(base, taken) {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  let name = base;
  for (let n = 2; lower.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}
