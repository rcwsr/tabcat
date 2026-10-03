import { DEFAULT_SETTINGS } from "./settings.js";
import { averageLinkage, averageSimilarity, nameCandidates, sharedKeywords, tabText, topicPrompt } from "./cluster.js";
import { embed, topic } from "./ml.js";
import { createProvider } from "./providers.js";

async function getSettings() {
  // Passing defaults fills in any keys that haven't been saved yet.
  return browser.storage.local.get(DEFAULT_SETTINGS);
}

function describeTab(tab) {
  let where = tab.url;
  try {
    const url = new URL(tab.url);
    // Query strings are mostly noise (and sometimes tokens); keep host + path.
    where = url.hostname + url.pathname;
  } catch {}
  return { title: tab.title ?? "", url: where };
}

async function classifyTab(tab, categories, provider) {
  const result = await provider.decide(describeTab(tab), {
    category: {
      type: "choice",
      instructions: "Which category does this browser tab belong to?",
      criteria: categories,
    },
  });
  const { choice, probabilities } = result.answers.category;
  return { choice, confidence: probabilities?.[choice] ?? 0 };
}

function titleFor(key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function isOrganisable(tab) {
  return !tab.pinned && /^https?:/.test(tab.url ?? "");
}

const isGrouped = (tab) => tab.groupId !== undefined && tab.groupId !== -1;

// groups: [{ title, tabIds, groupId? }]. Without a groupId, a group in this window with the
// same title is reused, otherwise a new one is made.
async function applyGroups(windowId, groups) {
  for (const { title, tabIds, groupId } of groups) {
    // Look again each time: moving a group's last tab out closes that group.
    const existing = await browser.tabGroups.query({ windowId });
    const targetId = groupId ?? existing.find((g) => g.title === title)?.id;
    const id = await browser.tabs.group(
      targetId === undefined ? { tabIds, createProperties: { windowId } } : { tabIds, groupId: targetId },
    );
    if (targetId === undefined) await browser.tabGroups.update(id, { title });
  }
}

function summarise(groups, skipped) {
  return {
    organised: groups.reduce((n, g) => n + g.tabIds.length, 0),
    skipped,
    groups: Object.fromEntries(groups.map((g) => [g.title, g.tabIds.length])),
  };
}

// Sorts tabs into the user's categories. Tabs in a group the user made themselves (one not
// named after a category) stay where they are.
async function organiseByCategory(windowId, tabs, settings) {
  const categoryTitles = new Set(Object.keys(settings.categories).map(titleFor));
  const groupTitles = new Map((await browser.tabGroups.query({ windowId })).map((g) => [g.id, g.title]));
  const provider = createProvider(settings);
  const buckets = {};
  let skipped = 0;
  for (const tab of tabs) {
    if (isGrouped(tab) && !categoryTitles.has(groupTitles.get(tab.groupId))) continue;
    const { choice, confidence } = await classifyTab(tab, settings.categories, provider);
    if (confidence < settings.minConfidence) {
      skipped++;
      continue;
    }
    (buckets[choice] ??= []).push(tab.id);
  }
  const groups = Object.entries(buckets).map(([key, tabIds]) => ({ title: titleFor(key), tabIds }));
  await applyGroups(windowId, groups);
  return summarise(groups, skipped);
}

// Finds groups by itself: similar tabs (by on-device embeddings) are clustered, ungrouped
// tabs join an existing group they closely match, and new groups are named from their tabs.
async function organiseAutomatically(windowId, tabs, settings) {
  if (!tabs.length) return summarise([], 0);
  const threshold = settings.groupingThreshold;
  // The first run downloads the models; say how that's going.
  const progress = (text) => setStatus(windowId, { title: text });
  const vectors = await embed(tabs.map((t) => tabText(t.title ?? "", t.url)), progress);
  const existing = await browser.tabGroups.query({ windowId });

  // Existing groups (Tav's or the user's) keep their tabs and can take in close matches.
  const members = new Map();
  tabs.forEach((t, i) => isGrouped(t) && members.set(t.groupId, [...(members.get(t.groupId) ?? []), i]));
  const joins = new Map();
  const loose = [];
  tabs.forEach((tab, i) => {
    if (isGrouped(tab)) return;
    let best = null;
    for (const [groupId, ix] of members) {
      const s = averageSimilarity(vectors, [i], ix);
      if (s >= threshold && (!best || s > best.s)) best = { groupId, s };
    }
    if (best) joins.set(best.groupId, [...(joins.get(best.groupId) ?? []), tab.id]);
    else loose.push(i);
  });
  const groups = [...joins].map(([groupId, tabIds]) => ({
    groupId,
    title: existing.find((g) => g.id === groupId)?.title || "Group",
    tabIds,
  }));

  const clusters = averageLinkage(vectors, loose, threshold).filter((c) => c.length >= 2);
  const taken = new Set(existing.map((g) => g.title));
  for (const ix of clusters) {
    const titles = ix.map((i) => tabs[i].title ?? "");
    const keywords = sharedKeywords(titles);
    const suggestion = await topic(topicPrompt(titles, keywords), progress);
    const hosts = ix.map((i) => new URL(tabs[i].url).hostname);
    let title = nameCandidates(suggestion, keywords, hosts)[0] ?? "Tabs";
    // Don't fold an unrelated cluster into an existing group just because the names match.
    const base = title;
    for (let n = 2; taken.has(title); n++) title = `${base} ${n}`;
    taken.add(title);
    groups.push({ title, tabIds: ix.map((i) => tabs[i].id) });
  }

  await applyGroups(windowId, groups);
  const skipped = loose.length - clusters.reduce((n, c) => n + c.length, 0);
  return summarise(groups, skipped);
}

async function organiseWindow(windowId) {
  const settings = await getSettings();
  const tabs = (await browser.tabs.query({ windowId })).filter(isOrganisable);
  return settings.mode === "categories"
    ? organiseByCategory(windowId, tabs, settings)
    : organiseAutomatically(windowId, tabs, settings);
}

// Firefox suspends an idle background page after ~30 s, even mid-download or
// mid-sort. Extension API calls count as activity, so make one regularly.
async function keepAlive(work) {
  const timer = setInterval(() => browser.runtime.getPlatformInfo(), 10_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

// One run per window at a time: a second click waits for the run in progress instead of
// grouping the same tabs twice.
const running = new Map();

function organiseOnce(windowId) {
  if (!running.has(windowId)) {
    running.set(windowId, keepAlive(() => organiseWindow(windowId)).finally(() => running.delete(windowId)));
  }
  return running.get(windowId);
}

// The toolbar button is the only UI: its badge and tooltip show what Tav is doing.
const BADGE_COLOURS = { busy: "#666", done: "#2a7d2a", error: "#c00" };

async function setStatus(windowId, { badge, colour, title }) {
  if (badge !== undefined) await browser.action.setBadgeText({ windowId, text: badge });
  if (colour) await browser.action.setBadgeBackgroundColor({ windowId, color: BADGE_COLOURS[colour] });
  if (title !== undefined) await browser.action.setTitle({ windowId, title: `Tav: ${title}` });
}

function describeResult({ organised, skipped, groups }) {
  const parts = Object.entries(groups).map(([name, n]) => `${name} ${n}`);
  if (skipped) parts.push(`${skipped} left alone`);
  return organised ? `grouped ${parts.join(", ")}` : skipped ? `nothing grouped, ${skipped} left alone` : "nothing to tidy";
}

async function tidyWindow(windowId) {
  if (!running.has(windowId)) await setStatus(windowId, { badge: "…", colour: "busy", title: "sorting tabs…" });
  try {
    const result = await organiseOnce(windowId);
    await setStatus(windowId, {
      badge: result.organised ? String(result.organised) : "✓",
      colour: "done",
      title: `${describeResult(result)}. Click to tidy again.`,
    });
    // The count is only news for a moment; the tooltip keeps the details.
    setTimeout(() => running.has(windowId) || browser.action.setBadgeText({ windowId, text: "" }), 5000);
    return result;
  } catch (err) {
    // Left showing until the next click, so it isn't missed.
    await setStatus(windowId, { badge: "!", colour: "error", title: `${err.message.replace(/\.?$/, ".")} Click to try again.` });
    throw err;
  }
}

browser.action.onClicked.addListener((tab) => tidyWindow(tab.windowId).catch(() => {}));

// Settings live in the button's right-click menu.
browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({ id: "settings", title: "Settings", contexts: ["action"] });
});
browser.menus.onClicked.addListener((info) => {
  if (info.menuItemId === "settings") browser.runtime.openOptionsPage();
});
