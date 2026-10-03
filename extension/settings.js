// Default buckets. Keys become group titles; values are the criteria text the
// model reads when choosing, so describe what belongs rather than just naming it.
export const DEFAULT_CATEGORIES = {
  work: "Work tools: email, calendars, documents, spreadsheets, project management",
  dev: "Programming: documentation, code hosting, issue trackers, Stack Overflow, technical references",
  news: "News sites, articles and current affairs",
  shopping: "Online shops, product pages, deals and orders",
  social: "Social media, forums, community sites and chat",
  media: "Video, music, streaming and podcasts",
  reference: "Wikipedia, research papers, tutorials and learning material",
  other: "Anything that does not clearly fit another category",
};

export const DEFAULT_SETTINGS = {
  // "auto": find and name groups from the tabs themselves. "categories": sort into DEFAULT_CATEGORIES.
  mode: "auto",
  // Auto mode: how similar tabs must be (average cosine similarity) to share a group.
  // 0.25 was the best precision/recall balance on two labelled sets of 24 tabs.
  groupingThreshold: 0.25,
  // Put new tabs into a matching group as you browse (and offer Undo), not only when asked.
  keepOrganised: false,
  // Categories mode: "tav" (bundled on-device model), "firefox" (Firefox's built-in AI) or "laya".
  provider: "tav",
  layaUrl: "http://127.0.0.1:8918",
  jevApiKey: "",
  // Categories mode: tabs below this confidence are left where they are.
  minConfidence: 0.5,
  categories: DEFAULT_CATEGORIES,
};
