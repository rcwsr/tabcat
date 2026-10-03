import { DEFAULT_SETTINGS } from "./settings.js";
import { averageLinkage, averageSimilarity, nameCandidates, sharedKeywords, tabText, topicPrompt } from "./cluster.js";
import { embed, topic } from "./ml.js";
import { createProvider } from "./providers.js";
import { showToast } from "./toast.js";

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

// Tells the popup, if it's open, what's taking so long.
function progress(text) {
  browser.runtime.sendMessage({ type: "progress", text }).catch(() => {});
}

// Finds groups by itself: similar tabs (by on-device embeddings) are clustered, ungrouped
// tabs join an existing group they closely match, and new groups are named from their tabs.
async function organiseAutomatically(windowId, tabs, settings) {
  if (!tabs.length) return summarise([], 0);
  const threshold = settings.groupingThreshold;
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

// Firefox suspends an idle background page after ~30 s, even mid-download or while the
// popup awaits a reply. Extension API calls count as activity, so make one regularly.
async function keepAlive(work) {
  const timer = setInterval(() => browser.runtime.getPlatformInfo(), 10_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

// One run per window at a time: a second click (say, from a reopened popup) waits for the
// run in progress instead of grouping the same tabs twice.
const running = new Map();

function organiseOnce(windowId) {
  if (!running.has(windowId)) {
    running.set(windowId, keepAlive(() => organiseWindow(windowId)).finally(() => running.delete(windowId)));
  }
  return running.get(windowId);
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "organise") return organiseOnce(message.windowId);
  if (message?.type === "undo") return undoMove(message.moveId);
});

// --- Keeping tabs organised ---
// With keepOrganised on, a tab that finishes loading in the background, or that you switch
// away from, joins a matching group. It never touches the tab you're looking at, and a tab
// you take out of a group is left alone from then on. Each move flashes the group and shows
// a toast with Undo in the page you're on.

// Titles often change just after a page loads, so wait for them to settle.
const SETTLE_MS = 2000;
const pending = new Map(); // tabId -> timer

function schedule(tabId, delay = SETTLE_MS) {
  clearTimeout(pending.get(tabId));
  pending.set(
    tabId,
    setTimeout(() => {
      pending.delete(tabId);
      placeTab(tabId).catch((err) => console.warn("Tav couldn't place a tab:", err));
    }, delay),
  );
}

// storage.session outlives this background page, which Firefox suspends when idle.
async function sessionGet(key, fallback) {
  return (await browser.storage.session.get({ [key]: fallback }))[key];
}

async function leaveAlone(tabId) {
  const ids = await sessionGet("leftAlone", []);
  if (!ids.includes(tabId)) await browser.storage.session.set({ leftAlone: [...ids, tabId] });
}

async function placeTab(tabId) {
  const settings = await getSettings();
  if (!settings.keepOrganised) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || tab.active || tab.status !== "complete" || isGrouped(tab) || !isOrganisable(tab)) return;
  if (running.has(tab.windowId) || (await sessionGet("leftAlone", [])).includes(tabId)) return;
  const target = settings.mode === "categories" ? await categoryFor(tab, settings) : await closestGroup(tab, settings);
  if (target) await moveTab(tab, target);
}

// Tabs get re-checked every time you switch away from them, so remember their vectors.
const vectorCache = new Map(); // tabText -> vector

async function embedCached(texts) {
  if (vectorCache.size > 1000) vectorCache.clear();
  const missing = [...new Set(texts.filter((t) => !vectorCache.has(t)))];
  if (missing.length) (await embed(missing)).forEach((v, i) => vectorCache.set(missing[i], v));
  return texts.map((t) => vectorCache.get(t));
}

// Automatic mode: the existing group the tab is closest to, as in organiseAutomatically.
async function closestGroup(tab, settings) {
  const grouped = (await browser.tabs.query({ windowId: tab.windowId })).filter((t) => isOrganisable(t) && isGrouped(t));
  if (!grouped.length) return null;
  const vectors = await embedCached([tab, ...grouped].map((t) => tabText(t.title ?? "", t.url)));
  const members = new Map();
  grouped.forEach((t, i) => members.set(t.groupId, [...(members.get(t.groupId) ?? []), i + 1]));
  let best = null;
  for (const [groupId, ix] of members) {
    const s = averageSimilarity(vectors, [0], ix);
    if (s >= settings.groupingThreshold && (!best || s > best.s)) best = { groupId, s };
  }
  if (!best) return null;
  const { title } = await browser.tabGroups.get(best.groupId);
  return { groupId: best.groupId, title: title || "Group" };
}

// Categories mode: the category's group, made if it doesn't exist yet.
async function categoryFor(tab, settings) {
  const { choice, confidence } = await classifyTab(tab, settings.categories, createProvider(settings));
  if (confidence < settings.minConfidence) return null;
  const title = titleFor(choice);
  const group = (await browser.tabGroups.query({ windowId: tab.windowId })).find((g) => g.title === title);
  return { groupId: group?.id, title };
}

async function moveTab(tab, { groupId, title }) {
  const id = await browser.tabs.group(
    groupId === undefined ? { tabIds: [tab.id], createProperties: { windowId: tab.windowId } } : { tabIds: [tab.id], groupId },
  );
  if (groupId === undefined) await browser.tabGroups.update(id, { title });
  flash(id);
  const move = { id: crypto.randomUUID(), tabId: tab.id, tabTitle: tab.title ?? "", group: title, index: tab.index, windowId: tab.windowId };
  // The popup lists recent moves with Undo too, for when the toast can't be shown.
  move.seen = await announce(move);
  const moves = await sessionGet("moves", []);
  await browser.storage.session.set({ moves: [move, ...moves].slice(0, 10) });
  await updateBadge(tab.windowId);
}

// Extensions can't animate the tab bar, but they can change a group's colour: blink it a
// few times so the eye goes to where the tab went.
async function flash(groupId) {
  const original = (await browser.tabGroups.get(groupId)).color;
  const blink = original === "yellow" ? "orange" : "yellow";
  try {
    for (const color of [blink, original, blink, original, blink, original]) {
      await browser.tabGroups.update(groupId, { color });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } catch {} // The group was closed mid-blink.
}

// Shows the toast in the page you're looking at. Returns false if it can't: without the
// "all websites" permission, or on pages extensions can't touch (about:, PDFs, AMO).
async function announce(move) {
  const [active] = await browser.tabs.query({ windowId: move.windowId, active: true });
  try {
    await browser.scripting.executeScript({
      target: { tabId: active.id },
      func: showToast,
      args: [move.tabTitle, move.group, move.id],
    });
    return true;
  } catch {
    return false;
  }
}

// Moves the toast couldn't show are counted on the toolbar button until the popup is opened.
async function updateBadge(windowId) {
  const unseen = (await sessionGet("moves", [])).filter((m) => m.windowId === windowId && !m.seen).length;
  await browser.action.setBadgeText({ windowId, text: unseen ? String(unseen) : "" });
}

async function undoMove(moveId) {
  const moves = await sessionGet("moves", []);
  const move = moves.find((m) => m.id === moveId);
  if (!move) return;
  await browser.storage.session.set({ moves: moves.filter((m) => m !== move) });
  await leaveAlone(move.tabId);
  try {
    await browser.tabs.ungroup(move.tabId);
    await browser.tabs.move(move.tabId, { index: move.index });
    // Landing between two tabs of a group would put it back in that group.
    await browser.tabs.ungroup(move.tabId);
  } catch {} // The tab was closed.
  await updateBadge(move.windowId);
}

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  // Taken out of a group (by you, or by Undo): don't put it back.
  if (change.groupId === -1) leaveAlone(tabId);
  if (change.status === "complete" && !tab.active) schedule(tabId);
});

browser.tabs.onActivated.addListener(({ previousTabId }) => {
  if (previousTabId !== undefined) schedule(previousTabId, 500);
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  clearTimeout(pending.get(tabId));
  const ids = await sessionGet("leftAlone", []);
  if (ids.includes(tabId)) await browser.storage.session.set({ leftAlone: ids.filter((id) => id !== tabId) });
});
