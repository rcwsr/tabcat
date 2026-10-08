// Sorting a window's tabs: gathering what's known about them, deciding where they go
// (plan.js) and grouping them (layout.js). Tidy tabs, Reorganise and placing tabs as they
// load all come through here.
import { chat, namingMessages, parseNames } from "./ai-service.js";
import { isThin, representatives, tabText, withPageInfo } from "./cluster.js";
import { MARK, applyGroups, isGrouped, isOrganisable, plainTitle, setOnePage, sortGroup } from "./layout.js";
import { embed, topic } from "./ml.js";
import { nameCandidates, namingInputs, siteName, topicPrompt, uniqueName } from "./naming.js";
import { TABS_PER_CLUSTER, commonest, place } from "./plan.js";
import { sessionGet, sessionUpdate } from "./session.js";
import { aiService } from "./settings.js";

// Tells the popup, if it's open, what's taking so long.
export function progress(text) {
  browser.runtime.sendMessage({ type: "progress", text }).catch(() => {});
}

// The page's <meta> description, keywords and site name. Needs the permission for websites
// (the same one as the toast); if it's been turned off, or on pages scripts can't reach,
// there's none. Used for grouping thin tabs and for naming groups.
const pageInfoCache = new Map(); // "tabId url" -> { description, keywords, site }
async function pageInfo(tab) {
  if (tab.status !== "complete") return null;
  const key = `${tab.id} ${tab.url}`;
  if (!pageInfoCache.has(key)) {
    if (pageInfoCache.size > 500) pageInfoCache.clear();
    try {
      const [{ result }] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const meta = (selector) => document.querySelector(selector)?.content ?? "";
          return {
            description: meta('meta[name="description" i]') || meta('meta[property="og:description"]'),
            keywords: meta('meta[name="keywords" i]'),
            site: meta('meta[property="og:site_name"]') || meta('meta[name="application-name" i]'),
          };
        },
      });
      pageInfoCache.set(key, result);
    } catch {
      return null; // Not remembered: a page mid-navigation can be read once it's loaded.
    }
  }
  return pageInfoCache.get(key);
}

// What's known about each tab, as plan.js wants it: { id, title, url, status, groupId, text,
// description, keywords, site }.
// text is what the embedding model sees. Tabs whose text is thin (a home page titled with
// just the site's name) get their page's description added; for other tabs it made
// grouping worse, so they're left as they are.
function describe(tabs) {
  return Promise.all(
    tabs.map(async (tab) => {
      const entry = { id: tab.id, title: tab.title ?? "", url: tab.url, status: tab.status, groupId: tab.groupId ?? -1 };
      entry.text = tabText(entry.title, tab.url);
      if (isThin(entry.text)) {
        const info = await pageInfo(tab);
        if (info) Object.assign(entry, info, { text: withPageInfo(entry.text, info) });
      }
      return entry;
    }),
  );
}

// Vectors, by the text embedded. They're kept in storage.session too, because Firefox
// suspends the background page when it's idle, and embedding a window of tabs again takes
// seconds. At most MAX_VECTORS, oldest dropped first.
const MAX_VECTORS = 2000;
const vectorMemory = new Map();
const encode = (vector) => new Uint8Array(new Float32Array(vector).buffer).toBase64();
const decode = (text) => Array.from(new Float32Array(Uint8Array.fromBase64(text).buffer));

async function vectorsFor(texts, onProgress) {
  if (vectorMemory.size > MAX_VECTORS) vectorMemory.clear();
  let missing = [...new Set(texts.filter((t) => !vectorMemory.has(t)))];
  if (missing.length) {
    const stored = await sessionGet("vectors", {});
    for (const t of missing) if (stored[t]) vectorMemory.set(t, decode(stored[t]));
    missing = missing.filter((t) => !vectorMemory.has(t));
  }
  if (missing.length) {
    const vectors = await embed(missing, onProgress);
    missing.forEach((t, i) => vectorMemory.set(t, vectors[i]));
    await sessionUpdate("vectors", {}, (stored) => {
      const all = { ...stored };
      missing.forEach((t, i) => (all[t] = encode(vectors[i])));
      const keys = Object.keys(all);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_VECTORS))) delete all[key];
      return all;
    });
  }
  return texts.map((t) => vectorMemory.get(t));
}

// The window's groups and your categories, as plan.js wants them. A category with a group
// of the same name in the window is that group.
async function targetsFor(windowId, tabs, categories, onProgress) {
  const groups = await browser.tabGroups.query({ windowId });
  const targets = groups.map((g) => ({
    groupId: g.id,
    title: plainTitle(g.title),
    members: tabs.flatMap((t, i) => (t.groupId === g.id ? [i] : [])),
  }));
  const entries = Object.entries(categories);
  const vectors = await vectorsFor(entries.map(([, about]) => about), onProgress);
  entries.forEach(([name, about], k) => {
    const group = targets.find((t) => t.groupId !== undefined && t.title.toLowerCase() === name.toLowerCase());
    if (group) Object.assign(group, { about, vector: vectors[k] });
    else targets.push({ title: name, about, vector: vectors[k], members: [] });
  });
  return targets;
}

// A name for a group on this computer, not in `taken`: a group of one page (or copies of
// it) is named after its site, since the small topic model names a single page badly
// ("Appliances" for a pack of washers); others by the topic model, from their titles and
// pages' descriptions and keywords. Resolves to { title, onePage }.
async function nameLocally(tabs, ix, taken, onProgress) {
  const pages = await Promise.all(ix.map(async (i) => ({ ...tabs[i], ...(await pageInfo(tabs[i])) })));
  const { lines, keywords } = namingInputs(pages);
  const onePage = lines.length === 1;
  let base;
  if (onePage) base = siteName(pages[0].site, pages[0].url);
  else {
    const hosts = pages.map((p) => new URL(p.url).hostname);
    base = nameCandidates(await topic(topicPrompt(lines, keywords), onProgress), keywords, hosts)[0] ?? "Tabs";
  }
  return { title: uniqueName(base, taken), onePage };
}

// Requests and tokens used by the AI service, shown in Settings.
let counting = Promise.resolve();
function countUsage({ input, output }) {
  counting = counting
    .then(async () => {
      const { aiUsage } = await browser.storage.local.get({ aiUsage: { requests: 0, input: 0, output: 0, since: Date.now() } });
      const { requests, input: sent, output: received } = aiUsage;
      await browser.storage.local.set({ aiUsage: { ...aiUsage, requests: requests + 1, input: sent + input, output: received + output } });
    })
    .catch(() => {});
  return counting;
}

// Asks the AI service which group each tab belongs in (see namingMessages).
async function askAi(settings, tabs, groups) {
  const { text, usage } = await chat(settings, namingMessages(tabs, groups, settings.apiPrompt));
  await countUsage(usage);
  return parseNames(text, tabs.length);
}

// After tabs join a group named after one page: if it now has a different page too, names
// it again from all its tabs (ix), unless you've renamed it or renameGrowingGroups is off.
// Resolves to the new title, if there is one.
async function renameIfOutgrown(groupId, tabs, vectors, ix, settings, onProgress) {
  const named = (await sessionGet("onePage", {}))[groupId];
  if (!named) return;
  const group = await browser.tabGroups.get(groupId);
  if (plainTitle(group.title) === named && new Set(ix.map((i) => tabs[i].title)).size < 2) return;
  await setOnePage(groupId, null);
  if (plainTitle(group.title) !== named || !settings.renameGrowingGroups) return;
  let title;
  if (aiService(settings)) {
    const shown = representatives(vectors, ix, TABS_PER_CLUSTER);
    title = commonest((await askAi(settings, shown.map((i) => tabs[i]), []).catch(() => [])).filter(Boolean));
  }
  title ||= (await nameLocally(tabs, ix, new Set(), onProgress)).title;
  const others = (await browser.tabGroups.query({ windowId: group.windowId })).filter((g) => g.id !== groupId);
  title = uniqueName(title, new Set(others.map((g) => plainTitle(g.title))));
  // Keep the mark, if the group has one (see moves.js).
  await browser.tabGroups.update(groupId, { title: group.title.startsWith(MARK) ? MARK + title : title });
  return title;
}

// Sorts some of a window's tabs:
// - focusIds: the tabs to place (Tidy: every ungrouped tab; as you browse: tabs that have
//   just loaded).
// - partnerIds: loose tabs that may go into a new group with them.
// - lone: whether a tab like nothing else gets a group of its own.
// Resolves to { moved: [{ groupId, title, tabIds, created }], from: [{ id, index }] (where
// the moved tabs were), skipped, warning }, warning being why the AI service couldn't be
// used, if it couldn't (this computer did it all).
export async function organise(windowId, settings, { focusIds, partnerIds = [], lone, onProgress }) {
  const tabs = await describe((await browser.tabs.query({ windowId })).filter(isOrganisable));
  const at = new Map(tabs.map((t, i) => [t.id, i]));
  const focus = focusIds.flatMap((id) => at.get(id) ?? []);
  if (!focus.length) return { moved: [], from: [], skipped: 0 };
  const vectors = await vectorsFor(tabs.map((t) => t.text), onProgress);
  const targets = await targetsFor(windowId, tabs, settings.categories, onProgress);

  const result = await place({
    tabs,
    vectors,
    targets,
    focus,
    partners: partnerIds.flatMap((id) => at.get(id) ?? []),
    threshold: settings.groupingThreshold,
    lone,
    nameWithAi: aiService(settings) && ((items, offered) => askAi(settings, items, offered)),
    nameLocally: (ix, taken) => nameLocally(tabs, ix, taken, onProgress),
  });

  // Deciding can take a while (an AI service, a model download): leave tabs that have been
  // grouped, closed or sent to another page since, and make groups that have been closed
  // again.
  const now = new Map((await browser.tabs.query({ windowId })).map((t) => [t.id, t]));
  const still = (i) => now.get(tabs[i].id)?.url === tabs[i].url && !isGrouped(now.get(tabs[i].id));
  const open = new Set((await browser.tabGroups.query({ windowId })).map((g) => g.id));
  const groupings = [
    ...[...result.joins].map(([t, ix]) => ({ ...targets[t], ix })),
    ...result.created.map(({ title, tabs: ix, onePage }) => ({ title, onePage, ix, members: [] })),
  ]
    .map((g) => ({ ...g, groupId: open.has(g.groupId) ? g.groupId : undefined, ix: g.ix.filter(still) }))
    .filter((g) => g.ix.length);
  // Where they were, for Undo.
  const from = groupings.flatMap((g) => g.ix.map((i) => ({ id: tabs[i].id, index: now.get(tabs[i].id).index })));
  const moved = await applyGroups(
    windowId,
    groupings.map((g) => ({ ...g, tabIds: g.ix.map((i) => tabs[i].id) })),
    settings,
  );
  for (const [n, g] of groupings.entries()) {
    if (moved[n].created) continue;
    const title = await renameIfOutgrown(moved[n].groupId, tabs, vectors, [...g.members, ...g.ix], settings, onProgress);
    if (title) moved[n].title = title;
  }
  if (aiService(settings)) await browser.storage.session.set({ aiWarning: result.warning ?? null });
  return { moved, from, skipped: result.skipped.length, warning: result.warning };
}

// Tidy tabs: every ungrouped tab in the window is placed. Resolves to a summary for the
// popup: { organised, skipped, groups: { title: tabs }, warning }.
export async function tidyWindow(windowId, settings) {
  const loose = (await browser.tabs.query({ windowId })).filter((t) => isOrganisable(t) && !isGrouped(t));
  const { moved, skipped, warning } = await organise(windowId, settings, {
    focusIds: loose.map((t) => t.id),
    lone: settings.newGroupForLoneTabs,
    onProgress: progress,
  });
  // With A–Z order, groups whose tabs you've moved around are put back in order too.
  for (const group of await browser.tabGroups.query({ windowId })) await sortGroup(group.id, settings.tabOrder);
  return {
    organised: moved.reduce((n, g) => n + g.tabIds.length, 0),
    skipped,
    groups: Object.fromEntries(moved.map((g) => [g.title, g.tabIds.length])),
    warning,
  };
}

// As you browse: tabs that have just loaded (tabIds) are placed together. Loose tabs can
// join them in a new group, but not the one you're on, or ones you took out of a group.
export async function placeLoaded(windowId, tabIds, settings) {
  const leftAlone = await sessionGet("leftAlone", []);
  const tabs = (await browser.tabs.query({ windowId })).filter((t) => isOrganisable(t) && !isGrouped(t) && !leftAlone.includes(t.id));
  const focus = tabs.filter((t) => tabIds.includes(t.id) && t.status === "complete");
  const partners = tabs.filter((t) => !tabIds.includes(t.id) && !t.active);
  return organise(windowId, settings, {
    focusIds: focus.map((t) => t.id),
    partnerIds: partners.map((t) => t.id),
    lone: settings.newGroupForLoneTabs,
  });
}
