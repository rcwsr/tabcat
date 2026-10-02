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
  provider: "laya",
  layaUrl: "http://127.0.0.1:8918",
  jevApiKey: "",
  // Tabs below this confidence are left where they are.
  minConfidence: 0.5,
  categories: DEFAULT_CATEGORIES,
};
