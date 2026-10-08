import { test } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_CATEGORIES, aiService, migrate } from "../../extension/settings.js";
import { sortTabs } from "../../extension/layout.js";

const OLD_KEYS = ["mode", "provider", "layaUrl", "jevApiKey", "minConfidence", "nameWithAi"];

test("migrate leaves current settings alone", () => {
  assert.deepEqual(migrate({ keepOrganised: false, categories: { Dev: "Code" } }), { settings: {}, remove: [] });
});

test("migrate: categories mode keeps its categories (without other) and its AI service", () => {
  const stored = { mode: "categories", provider: "ai", categories: { dev: "Code", news: "News", other: "Anything else" } };
  assert.deepEqual(migrate(stored), { settings: { categories: { Dev: "Code", News: "News" }, useAi: true }, remove: OLD_KEYS });
  // Never saved: they were using the defaults, which are the examples now.
  assert.deepEqual(migrate({ mode: "categories", provider: "laya" }).settings, { categories: EXAMPLE_CATEGORIES, useAi: false });
});

test("migrate: automatic mode drops the categories and keeps AI naming", () => {
  assert.deepEqual(migrate({ mode: "auto", nameWithAi: true, categories: { dev: "Code" } }).settings, { categories: {}, useAi: true });
  assert.deepEqual(migrate({ mode: "auto" }).settings, { categories: {}, useAi: false });
});

test("aiService: turned on, with an address and a model", () => {
  assert.ok(aiService({ useAi: true, apiUrl: "http://localhost:1234/v1", apiModel: "gemma" }));
  assert.ok(!aiService({ useAi: false, apiUrl: "http://localhost:1234/v1", apiModel: "gemma" }));
  assert.ok(!aiService({ useAi: true, apiUrl: "", apiModel: "gemma" }));
});

test("sortTabs: A–Z by title, ignoring case and counting numbers as numbers", () => {
  const tabs = ["part 10", "Part 2", "apple", "Banana"].map((title, id) => ({ id, title }));
  assert.deepEqual(sortTabs(tabs, "title").map((t) => t.title), ["apple", "Banana", "Part 2", "part 10"]);
});

test("sortTabs: by website (without www.), then title", () => {
  const tabs = [
    { title: "B", url: "https://www.zoo.com/" },
    { title: "Z", url: "https://apple.com/" },
    { title: "A", url: "https://zoo.com/x" },
  ];
  assert.deepEqual(sortTabs(tabs, "site").map((t) => t.title), ["Z", "A", "B"]);
});
