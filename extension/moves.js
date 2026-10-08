// Tabs Tabcat moves by itself as you browse, and finding them again: a message when it moves
// the tab you're on (with Show and Undo), a mark on the group's title until you've been to
// it, a blink of the group's colour, the toolbar badge for the other moves, and in the popup
// and with a keyboard shortcut, Show for any of them (with Back on the page it goes to).
import { MARK, isGrouped, plainTitle } from "./layout.js";
import { sessionGet, sessionUpdate } from "./session.js";
import { showToast } from "./toast.js";

const quote = (title) => `“${title ?? ""}”`;

// What the message says about tabs going into groups (moved, from organise()), tab being
// the one that loaded (the first, if several did).
function describeMove(tab, moved) {
  if (moved.length === 1) {
    const [{ title, tabIds, created }] = moved;
    const others = tabIds.length - 1;
    if (others) return `Grouped ${quote(tab.title)} and ${others} similar tab${others > 1 ? "s" : ""} as ${title}`;
    return `Moved ${quote(tab.title)} to ${created ? "a new group, " : ""}${title}`;
  }
  const count = moved.reduce((n, g) => n + g.tabIds.length, 0);
  const titles = moved.map((g) => g.title);
  const list = titles.length > 3 ? `${titles.slice(0, 3).join(", ")} and ${titles.length - 3} more` : titles.join(", ");
  return `Grouped ${count} tabs into ${list}`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Extensions can't animate the tab bar, but they can change a group's colour: blink it a
// few times so the eye goes to where the tab went. A group already blinking isn't blinked
// again: the second blink would take the first's colour for the group's own, and keep it.
const flashing = new Set();

async function flash(groupId) {
  if (flashing.has(groupId)) return;
  flashing.add(groupId);
  try {
    const original = (await browser.tabGroups.get(groupId)).color;
    const blink = original === "yellow" ? "orange" : "yellow";
    for (const color of [blink, original, blink, original, blink, original]) {
      await browser.tabGroups.update(groupId, { color });
      await wait(300);
    }
  } catch {
    // The group was closed mid-blink.
  } finally {
    flashing.delete(groupId);
  }
}

// There's no API to scroll the tab bar, but Firefox scrolls it to the tab you're on whenever
// that tab moves. So the tab moves one place along in its group and straight back; a group of
// one moves past the tab or group beside it and back.
async function scrollTo(tab) {
  if (!isGrouped(tab)) return;
  const tabs = await browser.tabs.query({ windowId: tab.windowId });
  const i = tabs.findIndex((t) => t.id === tab.id);
  const sameGroup = (t) => t?.groupId === tab.groupId;
  const step = sameGroup(tabs[i + 1]) ? 1 : sameGroup(tabs[i - 1]) ? -1 : 0;
  if (step) {
    try {
      await browser.tabs.move(tab.id, { index: i + step });
    } finally {
      await browser.tabs.move(tab.id, { index: i });
    }
    return;
  }
  const span = (t) => (isGrouped(t) ? tabs.filter((u) => u.groupId === t.groupId) : [t]);
  const [before, after] = [tabs[i - 1], tabs[i + 1]];
  // Pinned tabs come first, and a group can't go among them.
  const to = before && !before.pinned ? span(before)[0].index : after ? i + span(after).length : null;
  if (to === null) return;
  try {
    await browser.tabGroups.move(tab.groupId, { index: to });
  } finally {
    await browser.tabGroups.move(tab.groupId, { index: i });
  }
}

// Opens a collapsed group, and waits for Firefox to widen its tabs (0.1 s), so the tab bar
// scrolls to where the tab ends up.
async function expand(groupId) {
  if (!(await browser.tabGroups.get(groupId)).collapsed) return;
  await browser.tabGroups.update(groupId, { collapsed: false });
  await wait(200);
}

// Shows a message in a tab. Returns false if it can't: with Tabcat's access to websites
// turned off, or on pages extensions can't touch (about:, PDFs, addons.mozilla.org).
async function showIn(tabId, text, buttons) {
  try {
    await browser.scripting.executeScript({ target: { tabId }, func: showToast, args: [text, buttons] });
    return true;
  } catch {
    return false;
  }
}

// Groups marked as having a tab moved in that you haven't been to: [groupId].
async function mark(groupId) {
  await sessionUpdate("marked", [], (ids) => [...new Set([...ids, groupId])]);
  const { title } = await browser.tabGroups.get(groupId);
  if (!title.startsWith(MARK)) await browser.tabGroups.update(groupId, { title: MARK + title });
}

async function unmark(groupId) {
  await sessionUpdate("marked", [], (ids) => ids.filter((id) => id !== groupId));
  const group = await browser.tabGroups.get(groupId).catch(() => null);
  // Only the mark comes off: if you've renamed the group since, that stays.
  if (group?.title.startsWith(MARK)) await browser.tabGroups.update(groupId, { title: plainTitle(group.title) });
}

// You've gone to a tab: if its group was marked, you've found it.
export async function visited(tab) {
  if (isGrouped(tab) && (await sessionGet("marked", [])).includes(tab.groupId)) await unmark(tab.groupId);
}

export const forgetGroup = (groupId) => sessionUpdate("marked", [], (ids) => ids.filter((id) => id !== groupId));

// Marks don't outlive Firefox (storage.session doesn't), so any left on group titles when
// it starts are taken off.
export async function clearMarks() {
  for (const group of await browser.tabGroups.query({})) {
    if (group.title.startsWith(MARK)) await browser.tabGroups.update(group.id, { title: plainTitle(group.title) });
  }
}

// Moves the message didn't show (tabs you weren't on, or pages it can't be shown on) are
// counted on the toolbar button until the popup is opened.
async function updateBadge(windowId) {
  const unseen = (await sessionGet("moves", [])).filter((m) => m.windowId === windowId && !m.seen).length;
  await browser.action.setBadgeText({ windowId, text: unseen ? String(unseen) : "" });
}

// The popup has listed them.
export async function seenMoves(windowId) {
  await sessionUpdate("moves", [], (moves) => moves.map((m) => (m.windowId === windowId ? { ...m, seen: true } : m)));
  await updateBadge(windowId);
}

// After tabs have been placed as you browse: focusIds are the tabs that loaded, and
// { moved, from } what organise() did. The popup lists recent moves, with Show and Undo.
export async function recordMove(windowId, focusIds, { moved, from }, settings) {
  const ids = moved.flatMap((g) => g.tabIds);
  const [active] = await browser.tabs.query({ windowId, active: true });
  // The message is only for the tab you're on: you can see it moved, but not where to.
  // Otherwise Show goes to the tab that loaded (the first, if several did).
  const yours = ids.includes(active?.id);
  const tabId = yours ? active.id : (ids.find((id) => focusIds.includes(id)) ?? ids[0]);
  const tab = await browser.tabs.get(tabId);
  const move = { id: crypto.randomUUID(), windowId, tabId, message: describeMove(tab, moved), tabs: from };
  for (const g of moved) {
    flash(g.groupId);
    // Not a group you're in already.
    if (settings.markGroups && active?.groupId !== g.groupId) await mark(g.groupId);
  }
  const buttons = [
    { label: "Show", message: { type: "show", moveId: move.id } },
    { label: "Undo", message: { type: "undo", moveId: move.id } },
  ];
  move.seen = settings.showToast && yours ? await showIn(active.id, move.message, buttons) : false;
  await sessionUpdate("moves", [], (moves) => [move, ...moves].slice(0, 10));
  await updateBadge(windowId);
}

// Show: points out the moved tab in its group, opening the group if it's collapsed. If it's
// the tab you're on, the tab bar scrolls to it; otherwise Show goes to it (Firefox scrolls
// there itself) and offers Back on the page. Either way the group blinks. Without moveId,
// the last move in windowId (the keyboard shortcut). Resolves to whether there was a tab.
export async function showMove(moveId, windowId) {
  const moves = await sessionGet("moves", []);
  const move = moveId ? moves.find((m) => m.id === moveId) : moves.find((m) => m.windowId === windowId);
  const tab = move && (await browser.tabs.get(move.tabId).catch(() => null));
  if (!tab) return false;
  const [from] = await browser.tabs.query({ windowId: tab.windowId, active: true });
  if (isGrouped(tab)) await expand(tab.groupId);
  if (from?.id === tab.id) await scrollTo(tab);
  else await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
  if (isGrouped(tab)) flash(tab.groupId);
  if (from && from.id !== tab.id) {
    const group = isGrouped(tab) ? plainTitle((await browser.tabGroups.get(tab.groupId)).title) : "";
    await showIn(tab.id, group ? `This is the tab Tabcat moved to ${group}` : "This is the tab Tabcat moved", [
      { label: "Back", message: { type: "back", tabId: from.id } },
    ]);
  }
  return true;
}

// Back: to the tab you were on before Show.
export async function goBack(tabId) {
  await browser.tabs.update(tabId, { active: true }).catch(() => {});
}

// Undo: takes the tabs out of their groups, back to where they were, and leaves them alone
// from then on.
export async function undoMove(moveId) {
  const move = (await sessionGet("moves", [])).find((m) => m.id === moveId);
  if (!move) return;
  await sessionUpdate("moves", [], (moves) => moves.filter((m) => m.id !== moveId));
  const tabs = (await Promise.all(move.tabs.map((t) => browser.tabs.get(t.id).catch(() => null)))).filter(Boolean);
  const ids = tabs.map((t) => t.id);
  await sessionUpdate("leftAlone", [], (left) => [...new Set([...left, ...ids])]);
  if (ids.length) {
    await browser.tabs.ungroup(ids);
    // Lowest first, so each lands where it was.
    for (const t of move.tabs.filter((t) => ids.includes(t.id)).toSorted((a, b) => a.index - b.index)) {
      await browser.tabs.move(t.id, { index: t.index });
    }
    // Landing between two tabs of a group would put them back in that group.
    await browser.tabs.ungroup(ids);
  }
  for (const groupId of new Set(tabs.filter(isGrouped).map((t) => t.groupId))) await unmark(groupId);
  await updateBadge(move.windowId);
}
