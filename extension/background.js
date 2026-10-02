import { DEFAULT_SETTINGS } from "./categories.js";
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

async function applyGroups(windowId, buckets) {
  if (browser.tabs.group && browser.tabGroups) {
    const existing = await browser.tabGroups.query({ windowId });
    for (const [key, tabIds] of Object.entries(buckets)) {
      const title = titleFor(key);
      const match = existing.find((g) => g.title === title);
      const groupId = await browser.tabs.group(
        match ? { tabIds, groupId: match.id } : { tabIds, createProperties: { windowId } },
      );
      if (!match) await browser.tabGroups.update(groupId, { title });
    }
    return "grouped";
  }

  // No tab groups API: move each bucket to the end in turn so same-category tabs sit together.
  for (const tabIds of Object.values(buckets)) {
    await browser.tabs.move(tabIds, { windowId, index: -1 });
  }
  return "sorted";
}

async function organiseWindow(windowId) {
  const settings = await getSettings();
  const provider = createProvider(settings);
  const tabs = (await browser.tabs.query({ windowId })).filter(isOrganisable);

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

  const mode = await applyGroups(windowId, buckets);
  return {
    mode,
    organised: tabs.length - skipped,
    skipped,
    groups: Object.fromEntries(Object.entries(buckets).map(([k, ids]) => [titleFor(k), ids.length])),
  };
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "organise") return organiseWindow(message.windowId);
});
