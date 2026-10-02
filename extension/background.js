import { DEFAULT_SETTINGS } from "./categories.js";
import { averageLinkage, averageSimilarity, nameCandidates, sharedKeywords, tabText, topicPrompt } from "./cluster.js";
import { embed, keepAlive, topic } from "./ml.js";
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

// groups: [{ title, tabIds, groupId? }]. Without a groupId, a group in this window with the
// same title is reused, otherwise a new one is made.
async function applyGroups(windowId, groups) {
  if (browser.tabs.group && browser.tabGroups) {
    const existing = await browser.tabGroups.query({ windowId });
    for (const { title, tabIds, groupId } of groups) {
      const targetId = groupId ?? existing.find((g) => g.title === title)?.id;
      const id = await browser.tabs.group(
        targetId === undefined ? { tabIds, createProperties: { windowId } } : { tabIds, groupId: targetId },
      );
      if (targetId === undefined) await browser.tabGroups.update(id, { title });
    }
    return "grouped";
  }

  // No tab groups API: move each group to the end in turn so related tabs sit together.
  for (const { tabIds } of groups) {
    await browser.tabs.move(tabIds, { windowId, index: -1 });
  }
  return "sorted";
}

function summarise(mode, groups, skipped) {
  return {
    mode,
    organised: groups.reduce((n, g) => n + g.tabIds.length, 0),
    skipped,
    groups: Object.fromEntries(groups.map((g) => [g.title, g.tabIds.length])),
  };
}

async function organiseByCategory(windowId, tabs, settings) {
  const provider = createProvider(settings);
  const buckets = {};
  let skipped = 0;
  for (const tab of tabs) {
    const { choice, confidence } = await classifyTab(tab, settings.categories, provider);
    if (confidence < settings.minConfidence) {
      skipped++;
      continue;
    }
    (buckets[choice] ??= []).push(tab.id);
  }
  const groups = Object.entries(buckets).map(([key, tabIds]) => ({ title: titleFor(key), tabIds }));
  return summarise(await applyGroups(windowId, groups), groups, skipped);
}

// Laya picks the best of the candidate names; without layad, the first candidate wins.
async function chooseName(candidates, titles, provider) {
  if (candidates.length < 2) return candidates[0];
  try {
    const result = await provider.decide(
      { tabs: titles },
      {
        name: {
          type: "choice",
          instructions: "Which name best describes what this group of browser tabs has in common?",
          criteria: Object.fromEntries(candidates.map((c) => [c, c])),
        },
      },
    );
    return result.answers.name.choice;
  } catch (err) {
    console.warn("Tav: naming with Laya failed, using the topic model's name.", err);
    return candidates[0];
  }
}

// Tells the popup, if it's open, what's taking so long.
function progress(text) {
  browser.runtime.sendMessage({ type: "progress", text }).catch(() => {});
}

const isGrouped = (tab) => tab.groupId !== undefined && tab.groupId !== -1;

// Finds groups by itself: similar tabs (by on-device embeddings) are clustered, ungrouped
// tabs join an existing group they closely match, and new groups are named from their tabs.
async function organiseAutomatically(windowId, tabs, settings) {
  const threshold = settings.groupingThreshold;
  const vectors = await embed(tabs.map((t) => tabText(t.title ?? "", t.url)), progress);
  const existing = browser.tabGroups ? await browser.tabGroups.query({ windowId }) : [];

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
  const provider = createProvider(settings);
  const taken = new Set(existing.map((g) => g.title));
  for (const ix of clusters) {
    const titles = ix.map((i) => tabs[i].title ?? "");
    const keywords = sharedKeywords(titles);
    const suggestion = await topic(topicPrompt(titles, keywords), progress);
    const hosts = ix.map((i) => new URL(tabs[i].url).hostname);
    let title = (await chooseName(nameCandidates(suggestion, keywords, hosts), titles, provider)) ?? "Tabs";
    // Don't fold an unrelated cluster into an existing group just because the names match.
    const base = title;
    for (let n = 2; taken.has(title); n++) title = `${base} ${n}`;
    taken.add(title);
    groups.push({ title, tabIds: ix.map((i) => tabs[i].id) });
  }

  const skipped = loose.length - clusters.reduce((n, c) => n + c.length, 0);
  return summarise(await applyGroups(windowId, groups), groups, skipped);
}

async function organiseWindow(windowId) {
  const settings = await getSettings();
  const tabs = (await browser.tabs.query({ windowId })).filter(isOrganisable);
  return settings.mode === "categories"
    ? organiseByCategory(windowId, tabs, settings)
    : organiseAutomatically(windowId, tabs, settings);
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "organise") return keepAlive(() => organiseWindow(message.windowId));
});
