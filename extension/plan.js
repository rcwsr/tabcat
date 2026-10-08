// Deciding where tabs go. Pure (no browser APIs), so the extension, the tests and
// scripts/eval.mjs all run the same code. Everything works on indices into `tabs` and
// `vectors`, the tabs' embeddings (unit vectors of their tabText).
//
// tabs: [{ title, url, text, description }], text being what was embedded.
// targets: where a tab can go besides a new group: the window's groups ({ title, members })
//   and your categories ({ title, about, vector, members: [] }, `about` being what belongs
//   in it and `vector` its embedding). A category with a group in the window is one target.
import { averageLinkage, averageSimilarity, dot, isThin, representatives } from "./cluster.js";

const host = (tab) => {
  try {
    return new URL(tab.url).hostname;
  } catch {
    return "";
  }
};

// How close tab i is to a target: its average similarity to the target's tabs, or to what
// belongs in the category, whichever is higher. Text that's still thin (a home page titled
// "YouTube" with no description to be had) scores close to anything, so it only goes by
// tabs on its own site. Categories don't have that problem: the model knows what YouTube
// is, and a bare brand name matched its category on every labelled tab.
export function closeness(tabs, vectors, i, target) {
  let members = target.members.filter((j) => j !== i);
  if (isThin(tabs[i].text)) members = members.filter((j) => host(tabs[j]) === host(tabs[i]));
  const byTabs = members.length ? averageSimilarity(vectors, [i], members) : -1;
  const byCategory = target.vector ? dot(vectors[i], target.vector) : -1;
  return Math.max(byTabs, byCategory);
}

// Sorts the tabs at `ix` into joins, Map(target index -> [tab index]) for tabs at least
// `threshold` close to a target (the closest), and the rest, for new groups.
//
// Measured with scripts/eval.mjs: asking an AI service or decision model about tabs past the
// threshold lost more right answers than it gained, and asking about tabs just short of it
// helped less than letting the AI service see them in new groups (see `place`).
export function match(tabs, vectors, targets, ix, threshold) {
  const joins = new Map();
  const rest = [];
  for (const i of ix) {
    let best = null;
    targets.forEach((target, t) => {
      const score = closeness(tabs, vectors, i, target);
      if (score >= threshold && (!best || score > best.score)) best = { t, score };
    });
    if (best) joins.set(best.t, [...(joins.get(best.t) ?? []), i]);
    else rest.push(i);
  }
  return { joins, rest };
}

// Tabs that went nowhere, in clusters of similar tabs (arrays of indices). Thin tabs only
// go with thin tabs from their own site.
export function cluster(tabs, vectors, ix, threshold) {
  const thin = ix.filter((i) => isThin(tabs[i].text));
  const full = ix.filter((i) => !isThin(tabs[i].text));
  return [...averageLinkage(vectors, full, threshold), ...Map.groupBy(thin, (i) => host(tabs[i])).values()];
}

// How far short of the threshold a group can be and still be offered to the AI service for
// a new cluster, which may know better that they belong together.
export const NEAR = 0.05;

// How far short of the threshold a category can be and a tab still be asked about, in case
// it belongs. A category's description is short, so tabs score lower against it than against
// a group's tabs. Measured as you browse into the example categories: asking about every tab
// when there are categories took 22 requests for 48 tabs; asking only about tabs within this
// of one took 15, for as many right answers and fewer wrong.
export const CATEGORY_NEAR = 0.1;

// Groups a cluster might belong in after all, closest first (at most `limit`).
export function nearTargets(tabs, vectors, targets, ix, floor, limit = 3) {
  return targets
    .map((target, t) => ({ t, score: ix.reduce((s, i) => s + closeness(tabs, vectors, i, target), 0) / ix.length }))
    .filter((r) => r.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.t);
}

// The AI service sees at most this many tabs of a cluster (those nearest its middle); the
// others go where most of those do. 20 pages from one site don't need 20 lines.
export const TABS_PER_CLUSTER = 8;

// At most this many tabs go in one request, so the prompt fits small local models (a tab
// is about 25 tokens).
export const TABS_PER_REQUEST = 60;

const onePage = (tabs, ix) => new Set(ix.map((i) => tabs[i].title)).size === 1;

// The most common of some names (ignoring case), or undefined if there are none.
export const commonest = (names) => [...Map.groupBy(names, (n) => n.toLowerCase()).values()].sort((a, b) => b.length - a.length)[0]?.[0];

// Decides where the tabs at `focus` go: into a target, into new groups, or nowhere.
// - partners: other loose tabs that may go into a new group with a focus tab (as you
//   browse, a tab that loads can bring similar loose tabs with it), but aren't placed alone.
// - threshold: how close tabs must be to share a group. lone: whether a tab like nothing
//   else gets a group of its own.
// - nameWithAi(tabs, offered) -> [name]: an AI service, given tabs to sort and the groups
//   and categories they might belong in (as namingMessages wants them), naming the group
//   each tab belongs in. Optional.
// - nameLocally(ix, taken) -> { title, onePage }: on-device names, also used when the AI
//   service fails or gives no name.
// Resolves to { joins: Map(target index -> [tab index]), created: [{ title, tabs, onePage }],
// skipped: [tab index], warning }.
//
// This computer places what it's sure of (tabs close to a group or category) and clusters
// the rest. With an AI service, the clusters' tabs go to it in one request, in cluster order
// so related tabs are side by side, and it names the group each belongs in: an existing
// one's name joins it, tabs it gives the same new name become a group. Naming tabs rather
// than clusters lets it split a cluster that's wrong, and costs about the same: most
// clusters are a few tabs. It's only asked where it can do better than this computer:
// clusters of different pages (to name), and ones that might belong in a group or category.
// A single page with nowhere else to go is named after its site without a request, but goes
// along with one that's made anyway: a line more lets the service put it with pages this
// computer didn't see were alike.
export async function place({ tabs, vectors, targets, focus, partners = [], threshold, lone, nameWithAi, nameLocally }) {
  const { joins, rest } = match(tabs, vectors, targets, focus, threshold);
  const focused = new Set(focus);
  const clusters = cluster(tabs, vectors, [...rest, ...partners], threshold).filter((c) => c.some((i) => focused.has(i)));
  const wanted = (ix) => ix.length > 1 || lone;
  const categories = targets.flatMap((t, i) => (t.about ? [i] : []));
  const aiName = new Map(); // tab index -> the AI service's name for its group
  let warning;

  if (nameWithAi) {
    const near = clusters.map((ix) => nearTargets(tabs, vectors, targets, ix, threshold - NEAR));
    // Whether a cluster might belong in a group, or (a little further off) a category.
    const somewhere = (ix, n) =>
      near[n].length > 0 || nearTargets(tabs, vectors, targets, ix, threshold - CATEGORY_NEAR, Infinity).some((t) => targets[t].about);
    const worthAsking = clusters.some((ix, n) => (wanted(ix) && !onePage(tabs, ix)) || somewhere(ix, n));
    const ask = worthAsking ? [...clusters.keys()] : [];
    // Requests of whole clusters, at most TABS_PER_REQUEST tabs each.
    const requests = [];
    for (const n of ask) {
      const shown = representatives(vectors, clusters[n], TABS_PER_CLUSTER);
      const last = requests.at(-1);
      if (last && last.tabs.length + shown.length <= TABS_PER_REQUEST) last.tabs.push(...shown), last.clusters.push(n);
      else requests.push({ tabs: shown, clusters: [n] });
    }
    const examples = (t) => [...new Set(representatives(vectors, targets[t].members, 3).map((i) => tabs[i].title))];
    for (const request of requests) {
      // Categories are always offered: you made them to be used.
      const offered = [...new Set([...request.clusters.flatMap((n) => near[n]), ...categories])].filter((t) => targets[t].title);
      try {
        const names = await nameWithAi(
          request.tabs.map((i) => tabs[i]),
          offered.map((t) => ({ name: targets[t].title, about: targets[t].about, examples: examples(t) })),
        );
        request.tabs.forEach((i, k) => names[k] && aiName.set(i, names[k]));
      } catch (err) {
        warning = err.message;
        break;
      }
    }
    // Tabs not shown (or not named) go with most of their cluster.
    for (const ix of clusters) {
      const common = commonest(ix.flatMap((i) => aiName.get(i) ?? []));
      if (common) for (const i of ix) if (!aiName.has(i)) aiName.set(i, common);
    }
  }

  // Tabs the AI service named, by name: a target's name joins it, a new name is a new group.
  // Tabs it didn't name stay in their clusters, named on this computer. Partners only go
  // where a focus tab goes.
  const groups = [];
  for (const ix of Map.groupBy(aiName.keys(), (i) => aiName.get(i).toLowerCase()).values()) groups.push({ title: aiName.get(ix[0]), tabs: ix });
  for (const ix of clusters) {
    const left = ix.filter((i) => !aiName.has(i));
    if (left.length) groups.push({ tabs: left });
  }
  const join = (t, ix) => joins.set(t, [...(joins.get(t) ?? []), ...ix]);
  const taken = new Set(targets.map((t) => t.title));
  const created = [];
  const skipped = [];
  const unnamed = [];
  for (const { title, tabs: ix } of groups) {
    if (!ix.some((i) => focused.has(i))) continue;
    const target = title ? targets.findIndex((t) => t.title.toLowerCase() === title.toLowerCase()) : -1;
    if (target !== -1) join(target, ix);
    else if (!wanted(ix)) skipped.push(...ix);
    else if (title) created.push({ title, tabs: ix, onePage: onePage(tabs, ix) }), taken.add(title);
    else unnamed.push(ix);
  }
  for (const ix of unnamed) {
    const named = await nameLocally(ix, taken);
    taken.add(named.title);
    created.push({ ...named, tabs: ix });
  }
  return { joins, created, skipped: skipped.filter((i) => focused.has(i)), warning };
}
