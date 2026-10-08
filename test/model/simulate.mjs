// A window of labelled tabs (from test/fixtures/tabs.mjs), placed by the extension's own
// planning code (plan.js) with its embedding model in Node: for the model tests and
// scripts/eval.mjs.
import { DEFAULT_SETTINGS } from "../../extension/settings.js";
import { tabText } from "../../extension/cluster.js";
import { siteName, uniqueName } from "../../extension/naming.js";
import { place } from "../../extension/plan.js";
import { embed } from "./embed.mjs";

export const { groupingThreshold: threshold } = DEFAULT_SETTINGS;

// rows: [label, title, host + path]. categories: { name: what belongs }.
export async function windowOf(rows, categories = {}) {
  const tabs = rows.map(([, title, url]) => ({ title, url: `https://${url}`, text: tabText(title, `https://${url}`) }));
  const vectors = await embed(tabs.map((t) => t.text));
  const entries = Object.entries(categories);
  const categoryVectors = entries.length ? await embed(entries.map(([, about]) => about)) : [];
  const targets = entries.map(([title, about], i) => ({ title, about, vector: categoryVectors[i], members: [] }));
  return { tabs, vectors, labels: rows.map(([label]) => label), targets };
}

// The topic model isn't run here: names don't change which tabs go together.
const nameLocally = (win) => async (ix, taken) => ({
  title: uniqueName(siteName("", win.tabs[ix[0]].url), taken),
  onePage: new Set(ix.map((i) => win.tabs[i].title)).size === 1,
});

// Applies a placement: joined tabs become members, new groups targets.
function apply(win, { joins, created }) {
  for (const [t, ix] of joins) win.targets[t].members.push(...ix);
  for (const { title, tabs } of created) win.targets.push({ title, members: [...tabs] });
}

// Tidy: every tab placed in one go. nameWithAi as for place(), or undefined.
export async function tidy(win, nameWithAi) {
  const focus = win.tabs.map((_, i) => i);
  apply(win, await place({ ...win, focus, threshold, lone: true, nameWithAi, nameLocally: nameLocally(win) }));
}

// As you browse: tabs arrive one at a time, each placed against the window so far, with the
// loose tabs before it as partners.
export async function browse(win, nameWithAi) {
  const loose = new Set();
  for (let i = 0; i < win.tabs.length; i++) {
    const partners = [...loose];
    const result = await place({ ...win, focus: [i], partners, threshold, lone: false, nameWithAi, nameLocally: nameLocally(win) });
    apply(win, result);
    loose.add(i);
    for (const ix of [...result.joins.values(), ...result.created.map((c) => c.tabs)]) for (const j of ix) loose.delete(j);
  }
}

// Pairs of tabs grouped together that belong together (precision), and the reverse (recall).
// Tabs labelled "solo" or "other" belong with nothing.
export function pairScores(win) {
  const groupOf = [];
  win.targets.forEach((t, k) => t.members.forEach((i) => (groupOf[i] = k)));
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < win.tabs.length; i++) {
    for (let j = i + 1; j < win.tabs.length; j++) {
      const belong = win.labels[i] === win.labels[j] && !["solo", "other"].includes(win.labels[i]);
      const together = groupOf[i] !== undefined && groupOf[i] === groupOf[j];
      tp += belong && together;
      fp += !belong && together;
      fn += belong && !together;
    }
  }
  return { precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1) };
}

// For categories: tabs in the category they're labelled with (right), in another (wrong),
// and "other" tabs put in a category (intruders).
export function categoryScores(win) {
  let right = 0, wrong = 0, intruders = 0;
  for (const t of win.targets) {
    if (!t.about) continue;
    for (const i of t.members) {
      if (win.labels[i] === "other") intruders++;
      else if (t.title.toLowerCase() === win.labels[i]) right++;
      else wrong++;
    }
  }
  return { right, wrong, intruders };
}

// Each group's labels, to see what went where.
export const describeGroups = (win) =>
  win.targets.filter((t) => t.members.length).map((t) => `${t.title}: ${t.members.map((i) => win.labels[i]).join(", ")}`);
