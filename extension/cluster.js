// Pure helpers for the on-device models: no browser APIs, so they can be tested in Node.

// Text the embedding model sees: the title plus the words of the URL path. Path words
// help ("rust-lang ... ownership") and nothing leaves the machine, but numeric ids are noise.
export function tabText(title, url) {
  let path = "";
  try {
    path = new URL(url).pathname
      .split("/")
      .join(" ")
      .replace(/[._-]+/g, " ")
      .replace(/\b\w*\d\w*\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {}
  return path ? `${title} — ${path}` : title;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Average cosine similarity between two sets of unit vectors.
export function averageSimilarity(vectors, as, bs) {
  let s = 0;
  for (const i of as) for (const j of bs) s += dot(vectors[i], vectors[j]);
  return s / (as.length * bs.length);
}

// Average-linkage agglomerative clustering over unit vectors: keep merging the two most
// similar clusters until no pair averages at least `threshold`. Returns arrays of indices.
export function averageLinkage(vectors, indices, threshold) {
  const clusters = indices.map((i) => [i]);
  for (;;) {
    let best = null;
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const s = averageSimilarity(vectors, clusters[a], clusters[b]);
        if (!best || s > best.s) best = { a, b, s };
      }
    }
    if (!best || best.s < threshold) return clusters;
    clusters[best.a] = clusters[best.a].concat(clusters[best.b]);
    clusters.splice(best.b, 1);
  }
}

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

// Words that appear in at least two of the titles, most common first.
export function sharedKeywords(titles, limit = 3) {
  const count = new Map();
  for (const t of titles) for (const w of new Set(words(t))) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
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
  if (topic && !/^none$/i.test(topic)) names.push(topic);
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

// Text the embedding model sees for a tab in categories mode: the title and the site.
// Of the formats tried on 48 labelled tabs this matched most (37); path words added noise.
export function choiceText({ title, url }) {
  const site = url?.split("/")[0].replace(/^www\./, "");
  return site ? `${title} (${site})` : title;
}

// Picks the option whose vector is most similar to `vector`. A softmax over the similarities
// gives Laya-style probabilities, so the same minimum-confidence setting works for both.
export function chooseBySimilarity(vector, options, temperature) {
  const keys = Object.keys(options);
  const scores = keys.map((k) => Math.exp(dot(options[k], vector) / temperature));
  const total = scores.reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(keys.map((k, i) => [k, scores[i] / total]));
  const choice = keys.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
  return { choice, probabilities };
}
