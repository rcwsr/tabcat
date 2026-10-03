import { DEFAULT_SETTINGS } from "./settings.js";
import {
  averageLinkage,
  averageSimilarity,
  isThin,
  nameCandidates,
  sharedKeywords,
  tabText,
  topicPrompt,
  withPageInfo,
} from "./cluster.js";
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

// The page's <meta> description and keywords. Needs the optional permission for websites
// (the same one as the toast); without it, or on pages scripts can't reach, there's none.
// Read on the device and only used for the embedding.
const pageInfoCache = new Map(); // "tabId url" -> { description, keywords } or null
async function pageInfo(tab) {
  const key = `${tab.id} ${tab.url}`;
  if (!pageInfoCache.has(key)) {
    if (pageInfoCache.size > 500) pageInfoCache.clear();
    let info = null;
    try {
      const [{ result }] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const meta = (selector) => document.querySelector(selector)?.content ?? "";
          return {
            description: meta('meta[name="description" i]') || meta('meta[property="og:description"]'),
            keywords: meta('meta[name="keywords" i]'),
          };
        },
      });
      info = result;
    } catch {}
    pageInfoCache.set(key, info);
  }
  return pageInfoCache.get(key);
}

// What the embedding model sees for each tab. Tabs with thin text (a home page titled
// with just the site's name) get their page's description added; for other tabs it made
// grouping worse, so they're left as they are.
function textsFor(tabs) {
  return Promise.all(
    tabs.map(async (t) => {
      const text = tabText(t.title ?? "", t.url);
      if (!isThin(text) || t.status !== "complete") return text;
      return withPageInfo(text, (await pageInfo(t)) ?? {});
    }),
  );
}

// Finds groups by itself: similar tabs (by on-device embeddings) are clustered, ungrouped
// tabs join an existing group they closely match, and new groups are named from their tabs.
async function organiseAutomatically(windowId, tabs, settings) {
  if (!tabs.length) return summarise([], 0);
  const threshold = settings.groupingThreshold;
  const vectors = await embed(await textsFor(tabs), progress);
  const existing = await browser.tabGroups.query({ windowId });

  // Existing groups (Tabcat's or the user's) keep their tabs and can take in close matches.
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
    const members = ix.map((i) => tabs[i]);
    groups.push({ title: await nameGroup(members, taken, progress), tabIds: members.map((t) => t.id) });
  }

  await applyGroups(windowId, groups);
  const skipped = loose.length - clusters.reduce((n, c) => n + c.length, 0);
  return summarise(groups, skipped);
}

// A name for a new group of these tabs, from the topic model, that isn't in `taken` (the
// window's group titles; the new name is added). An unrelated group shouldn't get folded
// into an existing one just because the names match.
async function nameGroup(tabs, taken, onProgress) {
  const titles = tabs.map((t) => t.title ?? "");
  const keywords = sharedKeywords(titles);
  const suggestion = await topic(topicPrompt(titles, keywords), onProgress);
  const hosts = tabs.map((t) => new URL(t.url).hostname);
  const base = nameCandidates(suggestion, keywords, hosts)[0] ?? "Tabs";
  let title = base;
  for (let n = 2; taken.has(title); n++) title = `${base} ${n}`;
  taken.add(title);
  return title;
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

function runOnce(windowId, work) {
  if (!running.has(windowId)) {
    running.set(windowId, keepAlive(work).finally(() => running.delete(windowId)));
  }
  return running.get(windowId);
}

// Lets the onUpdated events from our own ungrouping arrive while the run still counts as
// running, so they aren't taken for the user pulling tabs out of groups.
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

// Reorganise starts over: every group in the window is broken up and all its tabs sorted
// again. The layout before is kept (per window, until the next Tidy or Reorganise) so Undo
// can put it back.
async function reorganiseWindow(windowId) {
  const tabs = (await browser.tabs.query({ windowId })).filter(isOrganisable);
  const groups = await browser.tabGroups.query({ windowId });
  const leftAlone = await sessionGet("leftAlone", []);
  const ids = tabs.map((t) => t.id);
  const snapshot = {
    tabs: tabs.map((t) => ({ id: t.id, index: t.index, group: isGrouped(t) ? groups.findIndex((g) => g.id === t.groupId) : null })),
    groups: groups.map(({ title, color, collapsed }) => ({ title, color, collapsed })),
    leftAlone: leftAlone.filter((id) => ids.includes(id)),
  };
  const grouped = tabs.filter(isGrouped).map((t) => t.id);
  if (grouped.length) await browser.tabs.ungroup(grouped);
  await settle();
  // Everything gets sorted, including tabs once taken out of a group.
  await browser.storage.session.set({ leftAlone: leftAlone.filter((id) => !ids.includes(id)) });
  const result = await organiseWindow(windowId);
  await setSnapshot(windowId, snapshot);
  return { ...result, canUndo: true };
}

async function setSnapshot(windowId, snapshot) {
  const { [windowId]: _, ...others } = await sessionGet("reorganised", {});
  await browser.storage.session.set({ reorganised: snapshot ? { ...others, [windowId]: snapshot } : others });
}

// Puts back the layout from before Reorganise, for the tabs that are still open.
async function restoreWindow(windowId) {
  const snapshot = (await sessionGet("reorganised", {}))[windowId];
  if (!snapshot) return { restored: false };
  await setSnapshot(windowId, null);
  const open = new Set((await browser.tabs.query({ windowId })).map((t) => t.id));
  const tabs = snapshot.tabs.filter((t) => open.has(t.id));
  if (tabs.length) await browser.tabs.ungroup(tabs.map((t) => t.id));
  // Lowest first, so each lands where it was.
  for (const t of tabs.toSorted((a, b) => a.index - b.index)) await browser.tabs.move(t.id, { index: t.index });
  for (const [i, { title, color, collapsed }] of snapshot.groups.entries()) {
    const tabIds = tabs.filter((t) => t.group === i).map((t) => t.id);
    if (!tabIds.length) continue;
    const groupId = await browser.tabs.group({ tabIds, createProperties: { windowId } });
    await browser.tabGroups.update(groupId, { title, color, collapsed });
  }
  // Landing between two tabs of a group would have put a loose tab in that group.
  const loose = tabs.filter((t) => t.group === null).map((t) => t.id);
  if (loose.length) await browser.tabs.ungroup(loose);
  await settle();
  const leftAlone = await sessionGet("leftAlone", []);
  await browser.storage.session.set({ leftAlone: [...new Set([...leftAlone, ...snapshot.leftAlone])] });
  return { restored: true };
}

function handleMessage(message) {
  const { type, windowId } = message ?? {};
  if (type === "organise") {
    // A Tidy afterwards is a new starting point; Undo would throw its work away.
    return runOnce(windowId, async () => {
      await setSnapshot(windowId, null);
      return organiseWindow(windowId);
    });
  }
  if (type === "reorganise") return runOnce(windowId, () => reorganiseWindow(windowId));
  if (type === "undoReorganise") return runOnce(windowId, () => restoreWindow(windowId));
  if (type === "canUndoReorganise") return sessionGet("reorganised", {}).then((s) => Boolean(s[windowId]));
  if (type === "undo") return undoMove(message.moveId);
}

browser.runtime.onMessage.addListener(handleMessage);

// --- Keeping tabs organised ---
// With keepOrganised on, a tab is grouped a moment after it loads: it joins a matching
// group, or in automatic mode starts a new one (see autoTarget). A tab you take out of a
// group is left alone from then on. Each move flashes the group and shows a toast with
// Undo in the page you're on.

// Titles often change just after a page loads, so wait for them to settle.
const SETTLE_MS = 2000;
const pending = new Map(); // tabId -> timer

function schedule(tabId) {
  clearTimeout(pending.get(tabId));
  pending.set(
    tabId,
    setTimeout(() => {
      pending.delete(tabId);
      placeTab(tabId).catch((err) => console.warn("Tabcat couldn't place a tab:", err));
    }, SETTLE_MS),
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
  if (!tab || tab.status !== "complete" || isGrouped(tab) || !isOrganisable(tab)) return;
  if (running.has(tab.windowId) || (await sessionGet("leftAlone", [])).includes(tabId)) return;
  const target = settings.mode === "categories" ? await categoryFor(tab, settings) : await autoTarget(tab, settings);
  if (target) await moveTab(tab, target);
}

// Tabs get re-checked every time you switch away from them, so remember their vectors.
const vectorCache = new Map(); // textsFor -> vector

async function embedCached(texts) {
  if (vectorCache.size > 1000) vectorCache.clear();
  const missing = [...new Set(texts.filter((t) => !vectorCache.has(t)))];
  if (missing.length) (await embed(missing)).forEach((v, i) => vectorCache.set(missing[i], v));
  return texts.map((t) => vectorCache.get(t));
}

// Automatic mode, in order: the existing group the tab is closest to (as in
// organiseAutomatically); else a new group with similar ungrouped tabs; else, if
// newGroupForLoneTabs is on, a new group of its own.
async function autoTarget(tab, settings) {
  const threshold = settings.groupingThreshold;
  const leftAlone = await sessionGet("leftAlone", []);
  const others = (await browser.tabs.query({ windowId: tab.windowId })).filter((t) => t.id !== tab.id && isOrganisable(t));
  const grouped = others.filter(isGrouped);
  // Loose tabs that can join it: not the one you're on, and not ones you took out of a group.
  const loose = others.filter((t) => !isGrouped(t) && !t.active && !leftAlone.includes(t.id));
  const tabs = [tab, ...grouped, ...loose];
  const vectors = await embedCached(await textsFor(tabs));

  const byGroup = new Map();
  grouped.forEach((t, i) => byGroup.set(t.groupId, [...(byGroup.get(t.groupId) ?? []), i + 1]));
  let best = null;
  for (const [groupId, ix] of byGroup) {
    const s = averageSimilarity(vectors, [0], ix);
    if (s >= threshold && (!best || s > best.s)) best = { groupId, s };
  }
  if (best) {
    const { title } = await browser.tabGroups.get(best.groupId);
    return { groupId: best.groupId, title: title || "Group" };
  }

  const looseIx = [0, ...loose.map((_, i) => 1 + grouped.length + i)];
  const cluster = averageLinkage(vectors, looseIx, threshold).find((c) => c.includes(0));
  if (cluster.length < 2 && !settings.newGroupForLoneTabs) return null;
  const members = cluster.map((i) => tabs[i]);
  const taken = new Set((await browser.tabGroups.query({ windowId: tab.windowId })).map((g) => g.title));
  return { title: await nameGroup(members, taken), tabs: members };
}

// Categories mode: the category's group, made if it doesn't exist yet.
async function categoryFor(tab, settings) {
  const { choice, confidence } = await classifyTab(tab, settings.categories, createProvider(settings));
  if (confidence < settings.minConfidence) return null;
  const title = titleFor(choice);
  const group = (await browser.tabGroups.query({ windowId: tab.windowId })).find((g) => g.title === title);
  return { groupId: group?.id, title };
}

// target: { groupId, title } to join a group, or { title, tabs } for a new group of those
// tabs (just this one if tabs is missing).
async function moveTab(tab, { groupId, title, tabs = [tab] }) {
  const tabIds = tabs.map((t) => t.id);
  const id = await browser.tabs.group(
    groupId === undefined ? { tabIds, createProperties: { windowId: tab.windowId } } : { tabIds, groupId },
  );
  if (groupId === undefined) await browser.tabGroups.update(id, { title });
  flash(id);
  const name = `“${tab.title ?? ""}”`;
  const others = tabs.length - 1;
  const message = others
    ? `Grouped ${name} and ${others} similar tab${others > 1 ? "s" : ""} as ${title}`
    : `Moved ${name} to ${groupId === undefined ? "a new group, " : ""}${title}`;
  const move = {
    id: crypto.randomUUID(),
    windowId: tab.windowId,
    message,
    // Where each tab was, for Undo.
    tabs: tabs.map((t) => ({ id: t.id, index: t.index })),
  };
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
      args: [move.message, move.id],
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
  const ids = move.tabs.map((t) => t.id);
  for (const id of ids) await leaveAlone(id);
  try {
    await browser.tabs.ungroup(ids);
    // Lowest first, so each lands where it was.
    for (const t of move.tabs.toSorted((a, b) => a.index - b.index)) await browser.tabs.move(t.id, { index: t.index });
    // Landing between two tabs of a group would put them back in that group.
    await browser.tabs.ungroup(ids);
  } catch {} // A tab was closed.
  await updateBadge(move.windowId);
}

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  // Taken out of a group (by you, or by Undo): don't put it back. Reorganise and its Undo
  // ungroup tabs too, but only to sort them again.
  if (change.groupId === -1 && !running.has(tab.windowId)) leaveAlone(tabId);
  if (change.status === "complete") schedule(tabId);
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  clearTimeout(pending.get(tabId));
  const ids = await sessionGet("leftAlone", []);
  if (ids.includes(tabId)) await browser.storage.session.set({ leftAlone: ids.filter((id) => id !== tabId) });
});
