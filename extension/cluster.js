// Pure helpers for finding similar tabs: no browser APIs, so they can be tested in Node.

// Text the embedding model sees: the title plus the words of the URL path. Path words
// help ("rust-lang ... ownership") and nothing leaves the machine, but numeric ids are noise.
// Of the formats tried, this one also matched categories most precisely (25 of 25 at 0.25).
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

// Too little text to group by: a site's home page is often titled with just its name
// ("YouTube"), and a bare name scores close to anything.
export function isThin(text) {
  return (text.match(/\p{L}[\p{L}\p{N}']*/gu) ?? []).length <= 3;
}

// Thin text with the page's own description and keywords (from its <meta> tags) added.
export function withPageInfo(text, { description = "", keywords = "" } = {}) {
  const info = [description.slice(0, 300), keywords.slice(0, 100)].map((s) => s.trim()).filter(Boolean).join(" ");
  return info ? `${text} — ${info}` : text;
}

export function dot(a, b) {
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
// The similarities are worked out once; after a merge, the new cluster's average with
// every other is the size-weighted mean of its two parts' (Lance–Williams), so a window of
// hundreds of tabs takes milliseconds rather than re-averaging vectors at every step.
export function averageLinkage(vectors, indices, threshold) {
  const clusters = indices.map((i) => [i]);
  // sim[a][b] for b < a.
  const sim = clusters.map((_, a) => {
    const row = new Float64Array(a);
    for (let b = 0; b < a; b++) row[b] = dot(vectors[indices[a]], vectors[indices[b]]);
    return row;
  });
  const at = (a, b) => (a > b ? sim[a][b] : sim[b][a]);
  const alive = [...clusters.keys()];
  for (;;) {
    let best = null;
    for (const a of alive) {
      for (const b of alive) {
        if (b < a && sim[a][b] >= threshold && (!best || sim[a][b] > best.s)) best = { a, b, s: sim[a][b] };
      }
    }
    if (!best) return alive.map((k) => clusters[k]);
    const { a, b } = best; // b is merged into a.
    const [na, nb] = [clusters[a].length, clusters[b].length];
    for (const k of alive) {
      if (k === a || k === b) continue;
      const s = (na * at(a, k) + nb * at(b, k)) / (na + nb);
      if (a > k) sim[a][k] = s;
      else sim[k][a] = s;
    }
    clusters[a] = clusters[a].concat(clusters[b]);
    alive.splice(alive.indexOf(b), 1);
  }
}

// The members of a cluster closest to its average, best first: what to show of a big group
// when asking an AI service about it, so a group of 40 tabs costs no more than one of 4.
export function representatives(vectors, ix, limit) {
  if (ix.length <= limit) return [...ix];
  const mean = new Float64Array(vectors[ix[0]].length);
  for (const i of ix) for (let d = 0; d < mean.length; d++) mean[d] += vectors[i][d];
  return ix
    .map((i) => [i, dot(vectors[i], mean)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([i]) => i);
}
