// Events and messages. The work is in organise.js (deciding and grouping), layout.js
// (groups, order, Reorganise's Undo) and moves.js (finding moved tabs).
import { loadSettings } from "./settings.js";
import { placeLoaded, tidyWindow } from "./organise.js";
import { isGrouped, isOrganisable, restoreSnapshot, setSnapshot, settle, sortGroup, takeSnapshot } from "./layout.js";
import { clearMarks, forgetGroup, goBack, recordMove, seenMoves, showMove, undoMove, visited } from "./moves.js";
import { sessionGet, sessionUpdate } from "./session.js";

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
// run in progress instead of grouping the same tabs twice. A run also waits for tabs being
// placed as they load (placingIn), and tabs that load during a run wait for it.
const running = new Map();
const placingIn = new Map();

function runOnce(windowId, work) {
  if (!running.has(windowId)) {
    const run = async () => {
      await placingIn.get(windowId)?.catch(() => {});
      return work();
    };
    running.set(windowId, keepAlive(run).finally(() => running.delete(windowId)));
  }
  return running.get(windowId);
}

async function organiseWindow(windowId) {
  return tidyWindow(windowId, await loadSettings());
}

// Reorganise starts over: every group in the window is broken up and all its tabs sorted
// again. If sorting fails, the layout before is put back straight away.
async function reorganiseWindow(windowId) {
  const tabs = (await browser.tabs.query({ windowId })).filter(isOrganisable);
  await takeSnapshot(windowId, tabs);
  try {
    const grouped = tabs.filter(isGrouped).map((t) => t.id);
    if (grouped.length) await browser.tabs.ungroup(grouped);
    await settle();
    // Everything gets sorted, including tabs once taken out of a group.
    const ids = tabs.map((t) => t.id);
    await sessionUpdate("leftAlone", [], (left) => left.filter((id) => !ids.includes(id)));
    return { ...(await organiseWindow(windowId)), canUndo: true };
  } catch (err) {
    await restoreSnapshot(windowId);
    throw err;
  }
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
  if (type === "undoReorganise") return runOnce(windowId, () => restoreSnapshot(windowId));
  if (type === "canUndoReorganise") return sessionGet("reorganised", {}).then((s) => Boolean(s[windowId]));
  if (type === "undo") return undoMove(message.moveId);
  if (type === "show") return showMove(message.moveId, windowId);
  if (type === "back") return goBack(message.tabId);
  if (type === "seen") return seenMoves(windowId);
}

browser.runtime.onMessage.addListener(handleMessage);

// --- As you browse ---
// A tab is placed a moment after it loads: it joins the group or category it fits, or
// starts a new group. Tabs that finish loading close together (restoring a session,
// opening a folder of bookmarks) are placed together: one pass of the model, and at most
// one request to the AI service.

// Titles often change just after a page loads, so wait for them to settle.
const SETTLE_MS = 2000;
const pending = new Map(); // tabId -> timer
const ready = new Set(); // tabIds settled and waiting to be placed
let placing = Promise.resolve();

function schedule(tabId) {
  clearTimeout(pending.get(tabId));
  pending.set(
    tabId,
    setTimeout(() => {
      pending.delete(tabId);
      ready.add(tabId);
      // One lot at a time; tabs that settle while one is being placed (which can take a few
      // seconds with an AI service) are the next lot.
      placing = placing.then(placeReady).catch((err) => console.warn("Tabcat couldn't place tabs:", err));
    }, SETTLE_MS),
  );
}

async function placeReady() {
  if (!ready.size) return;
  const ids = [...ready];
  ready.clear();
  const settings = await loadSettings();
  const tabs = (await Promise.all(ids.map((id) => browser.tabs.get(id).catch(() => null)))).filter(Boolean);
  for (const [windowId, loaded] of Map.groupBy(tabs, (t) => t.windowId)) {
    // Tidy tabs or Reorganise may group these tabs itself; the rest are placed after it.
    while (running.has(windowId)) await running.get(windowId).catch(() => {});
    const work = keepAlive(() => placeIn(windowId, loaded.map((t) => t.id), settings));
    placingIn.set(windowId, work);
    await work.catch((err) => console.warn("Tabcat couldn't place tabs:", err)).finally(() => placingIn.delete(windowId));
  }
}

// Places tabs that have loaded in a window, as they are now.
async function placeIn(windowId, ids, settings) {
  const loaded = (await Promise.all(ids.map((id) => browser.tabs.get(id).catch(() => null)))).filter((t) => t?.windowId === windowId);
  // A grouped tab that went to another page has a new title, so its place in A–Z order
  // may have changed.
  for (const groupId of new Set(loaded.filter(isGrouped).map((t) => t.groupId))) await sortGroup(groupId, settings.tabOrder);
  const loose = loaded.filter((t) => !isGrouped(t)).map((t) => t.id);
  if (!settings.keepOrganised || !loose.length) return;
  const result = await placeLoaded(windowId, loose, settings);
  if (result.moved.length) await recordMove(windowId, loose, result, settings);
}

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  // Taken out of a group (by you, or by Undo): don't put it back. Reorganise and its Undo
  // ungroup tabs too, but only to sort them again.
  if (change.groupId === -1 && !running.has(tab.windowId)) {
    sessionUpdate("leftAlone", [], (ids) => (ids.includes(tabId) ? ids : [...ids, tabId]));
  }
  if (change.status === "complete") schedule(tabId);
});

browser.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(pending.get(tabId));
  pending.delete(tabId);
  sessionUpdate("leftAlone", [], (ids) => ids.filter((id) => id !== tabId));
});

// Going to a tab in a marked group means you've found it.
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (tab) await visited(tab);
});

browser.tabGroups.onRemoved.addListener((group) => forgetGroup(group.id));

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "show-last-move") return;
  const win = await browser.windows.getLastFocused();
  await showMove(null, win.id);
});

browser.runtime.onStartup.addListener(clearMarks);

// Choosing A–Z order sorts the groups there are already.
browser.storage.onChanged.addListener(async (changes, area) => {
  const order = changes.tabOrder?.newValue;
  if (area !== "local" || !order) return;
  for (const group of await browser.tabGroups.query({})) await sortGroup(group.id, order);
});
