// Example categories, offered on the settings page (there are none until you add some).
// The text is what Tabcat compares tabs with, so it says what belongs rather than just
// naming it.
export const EXAMPLE_CATEGORIES = {
  Work: "Work tools: email, calendars, documents, spreadsheets, project management",
  Dev: "Programming: documentation, code hosting, issue trackers, Stack Overflow, technical references",
  News: "News sites, articles and current affairs",
  Shopping: "Online shops and brands: clothing, shoes, electronics, product pages, deals, baskets and orders",
  Social: "Social media, forums, community sites and chat",
  Media: "Video, music, streaming and podcasts",
  Reference: "Wikipedia, research papers, tutorials and learning material",
};

export const DEFAULT_SETTINGS = {
  // Group tabs a moment after they load, not only when you press Tidy tabs.
  keepOrganised: true,
  // As you browse: a tab like nothing else gets a group of its own, rather than waiting
  // for a similar tab.
  newGroupForLoneTabs: true,
  // How alike tabs must be (average cosine similarity of their embeddings) to share a
  // group, or for a tab to go into a category. 0.25 was the best precision/recall balance
  // on two labelled sets of 24 tabs, and placed no tab in the wrong category of 48.
  groupingThreshold: 0.25,
  // The order of tabs in a group: "added" (as they were added), "title" (A–Z by title) or
  // "site" (A–Z by website, then title).
  tabOrder: "added",
  // When a different page joins a group named after one page, name it again.
  renameGrowingGroups: true,
  // Your categories: { name: what belongs }. The name is the group's title.
  categories: {},
  // Finding moved tabs: the message when the tab you're on moves, and a mark on the group's title
  // until you've seen the tab.
  showToast: true,
  markGroups: true,
  // An OpenAI-compatible AI service (see ai-service.js), asked to name new groups and to
  // place tabs this computer can't: its address (up to /v1), key and model, and your own
  // instructions, added after Tabcat's (like "Name groups in French").
  useAi: false,
  apiUrl: "",
  apiKey: "",
  apiModel: "",
  apiPrompt: "",
};

// Settings from before there was one way of grouping (Tabcat 0.1), as they'd be now:
// - Categories are kept by people who sorted tabs into them (without the catch-all
//   "other": tabs that fit no category are grouped automatically now), and dropped by
//   people who didn't use them.
// - The AI service is used if it named groups or sorted tabs into categories.
// - Laya, Firefox's built-in AI and the minimum confidence are gone.
// Returns { settings, remove: [keys no longer used] }.
export function migrate(stored) {
  if (!("mode" in stored)) return { settings: {}, remove: [] };
  const categories = {};
  if (stored.mode === "categories") {
    // Saved by the settings page; the defaults were these examples (and "other").
    for (const [key, about] of Object.entries(stored.categories ?? EXAMPLE_CATEGORIES)) {
      if (key.toLowerCase() === "other") continue;
      categories[key.charAt(0).toUpperCase() + key.slice(1)] = about;
    }
  }
  const useAi = stored.mode === "categories" ? stored.provider === "ai" : Boolean(stored.nameWithAi);
  return {
    settings: { categories, useAi },
    remove: ["mode", "provider", "layaUrl", "jevApiKey", "minConfidence", "nameWithAi"],
  };
}

// The settings, with defaults for anything not saved, migrated first if they're old.
export async function loadSettings() {
  const stored = await browser.storage.local.get(null);
  const { settings, remove } = migrate(stored);
  if (remove.length) {
    await browser.storage.local.set(settings);
    await browser.storage.local.remove(remove);
  }
  const saved = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).filter((k) => k in stored).map((k) => [k, stored[k]]));
  return { ...DEFAULT_SETTINGS, ...saved, ...settings };
}

// Whether the AI service is set up and turned on.
export const aiService = (settings) => settings.useAi && settings.apiUrl && settings.apiModel;
