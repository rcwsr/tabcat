// Tab groups in a window: making them, ordering their tabs, and Reorganise's snapshot for
// Undo.
import { sessionGet, sessionUpdate } from "./session.js";

export const isOrganisable = (tab) => !tab.pinned && /^https?:/.test(tab.url ?? "");
export const isGrouped = (tab) => tab.groupId !== undefined && tab.groupId !== -1;

// The mark on a group's title while it has a moved tab you haven't seen (see moves.js).
// Everything else that reads group titles goes by the title without it.
export const MARK = "● ";
export const plainTitle = (title = "") => (title.startsWith(MARK) ? title.slice(MARK.length) : title);

const site = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

// Tabs in A–Z order: by title ("title"), or by website and then title ("site").
export function sortTabs(tabs, order) {
  const byTitle = (a, b) => collator.compare(a.title ?? "", b.title ?? "");
  const compare = order === "site" ? (a, b) => collator.compare(site(a.url), site(b.url)) || byTitle(a, b) : byTitle;
  return tabs.toSorted(compare);
}

// Puts a group's tabs in order (see sortTabs), unless they already are. Moving a group's
// tabs to where it starts keeps them in it.
export async function sortGroup(groupId, order) {
  if (order !== "title" && order !== "site") return;
  const { windowId } = await browser.tabGroups.get(groupId);
  const tabs = (await browser.tabs.query({ windowId })).filter((t) => t.groupId === groupId);
  const sorted = sortTabs(tabs, order);
  if (sorted.every((t, i) => t.id === tabs[i].id)) return;
  await browser.tabs.move(sorted.map((t) => t.id), { index: tabs[0].index });
}

// Groups named after one page, until they're named again: { groupId: title }.
export async function setOnePage(groupId, title) {
  await sessionUpdate("onePage", {}, (named) => {
    const { [groupId]: _, ...others } = named;
    return title ? { ...others, [groupId]: title } : others;
  });
}

// Puts tabs into groups: [{ groupId, title, tabIds, onePage }], joining the group with
// groupId, or making one titled `title` without it. Returns them with the groupId.
export async function applyGroups(windowId, groupings, { tabOrder }) {
  const applied = [];
  for (const { groupId, title, tabIds, onePage } of groupings) {
    const id = await browser.tabs.group(groupId === undefined ? { tabIds, createProperties: { windowId } } : { tabIds, groupId });
    if (groupId === undefined) {
      await browser.tabGroups.update(id, { title });
      if (onePage) await setOnePage(id, title);
    }
    await sortGroup(id, tabOrder);
    applied.push({ groupId: id, title, tabIds, created: groupId === undefined });
  }
  return applied;
}

// Lets the onUpdated events from our own ungrouping arrive while a run still counts as
// running, so they aren't taken for you pulling tabs out of groups.
export const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

// Reorganise starts over, so the layout before is kept (per window, until the next Tidy or
// Reorganise) for Undo.
export async function setSnapshot(windowId, snapshot) {
  await sessionUpdate("reorganised", {}, ({ [windowId]: _, ...others }) => (snapshot ? { ...others, [windowId]: snapshot } : others));
}

export async function takeSnapshot(windowId, tabs) {
  const groups = await browser.tabGroups.query({ windowId });
  const leftAlone = await sessionGet("leftAlone", []);
  const ids = tabs.map((t) => t.id);
  await setSnapshot(windowId, {
    tabs: tabs.map((t) => ({ id: t.id, index: t.index, group: isGrouped(t) ? groups.findIndex((g) => g.id === t.groupId) : null })),
    groups: groups.map(({ title, color, collapsed }) => ({ title: plainTitle(title), color, collapsed })),
    leftAlone: leftAlone.filter((id) => ids.includes(id)),
  });
}

// Puts back the layout from before Reorganise, for the tabs that are still open.
export async function restoreSnapshot(windowId) {
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
  await sessionUpdate("leftAlone", [], (ids) => [...new Set([...ids, ...snapshot.leftAlone])]);
  return { restored: true };
}
