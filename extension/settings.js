// Default buckets. Keys become group titles; values are the criteria text the
// model reads when choosing, so describe what belongs rather than just naming it.
export const DEFAULT_CATEGORIES = {
  work: "Work tools: email, calendars, documents, spreadsheets, project management",
  dev: "Programming: documentation, code hosting, issue trackers, Stack Overflow, technical references",
  news: "News sites, articles and current affairs",
  shopping: "Online shops and brands: clothing, shoes, electronics, product pages, deals, baskets and orders",
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
  // Group tabs as they load (and offer Undo), not only when asked.
  keepOrganised: true,
  // With keepOrganised in automatic mode: a tab that matches no group and no other loose
  // tab gets a group of its own instead of being left alone.
  newGroupForLoneTabs: true,
  // Automatic mode: name groups with the AI service below instead of the on-device model.
  nameWithAi: false,
  // An OpenAI-compatible AI service (see ai-service.js): its address (up to /v1), key and model.
  apiUrl: "",
  apiKey: "",
  apiModel: "",
  // Categories mode: "tabcat" (bundled on-device model), "firefox" (Firefox's built-in AI),
  // "laya" or "ai" (the AI service above).
  provider: "tabcat",
  layaUrl: "http://127.0.0.1:8918",
  jevApiKey: "",
  // Categories mode: tabs below this confidence are left where they are.
  minConfidence: 0.5,
  categories: DEFAULT_CATEGORIES,
};
