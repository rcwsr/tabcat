// Categories mode in real Firefox with each model: Tav's bundled one, Firefox's built-in AI
// and Laya (skipped unless layad is running).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../extension/settings.js";
import { CATEGORY_TABS } from "../fixtures/tabs.mjs";
import { launch } from "./firefox.mjs";

const groupTitle = (key) => key.charAt(0).toUpperCase() + key.slice(1);

async function layadRunning() {
  try {
    await fetch(DEFAULT_SETTINGS.layaUrl, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

// Floors sit a little under what each model scored on these tabs. Tav's model placed 43
// (32 right), Firefox's 46 (35 right): same model and weights, but the runtimes differ
// slightly, which flips tabs near the cut-off. Laya placed 31 (28 right).
const MODELS = [
  { provider: "tav", floor: { right: 30, precision: 0.7 } },
  { provider: "firefox", floor: { right: 30, precision: 0.7 }, firefoxML: true },
  { provider: "laya", floor: { right: 25, precision: 0.8 }, needsLayad: true },
];

const layouts = {};

for (const { provider, floor, firefoxML, needsLayad } of MODELS) {
  const skip = needsLayad && !(await layadRunning()) && "layad isn't running";
  test(`categories mode with ${provider}`, { skip, timeout: 300_000 }, async (t) => {
    const ff = await launch({ firefoxML });
    t.after(() => ff.close());
    const urls = await ff.openTabs(CATEGORY_TABS.map(([, title, url]) => [title, url]));
    const [first, second] = await ff.organise({ settings: { mode: "categories", provider }, runs: 2 });
    assert.equal(first.error, undefined);

    const placed = urls.filter((u) => first.layout[u]);
    const right = urls.filter((u, i) => first.layout[u] === groupTitle(CATEGORY_TABS[i][0]));
    t.diagnostic(`placed ${placed.length}, ${right.length} right`);
    assert.ok(right.length >= floor.right, `only ${right.length} placed correctly`);
    assert.ok(right.length / placed.length >= floor.precision, `precision ${(right.length / placed.length).toFixed(2)}`);

    assert.equal(second.error, undefined);
    assert.deepEqual(second.layout, first.layout, "second run moved tabs");
    layouts[provider] = first.layout;
  });
}

test("Tav's model and Firefox's built-in AI mostly agree", (t) => {
  if (!layouts.tav || !layouts.firefox) return t.skip("needs both runs above");
  const urls = Object.keys(layouts.tav);
  const same = urls.filter((u) => layouts.firefox[u] === layouts.tav[u]).length;
  t.diagnostic(`${same}/${urls.length} tabs placed the same`);
  assert.ok(same / urls.length >= 0.85, `only ${same}/${urls.length} tabs placed the same`);
});

test("categories mode leaves the user's own groups alone", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const tabs = CATEGORY_TABS.filter(([label]) => label === "dev" || label === "news");
  const urls = await ff.openTabs(tabs.map(([, title, url]) => [title, url]));
  // A group of the user's own with a dev and a news tab, and a stray dev tab in "News".
  const mine = [urls[0], urls.find((u, i) => tabs[i][0] === "news")];
  const stray = urls[1];
  const [run] = await ff.organise({
    settings: { mode: "categories", provider: "tav" },
    groups: [
      { title: "Reading list", urls: mine },
      { title: "News", urls: [stray] },
    ],
  });
  assert.equal(run.error, undefined);
  for (const url of mine) assert.equal(run.layout[url], "Reading list", `${url} left the user's group`);
  // Groups named after a category are Tav's to sort.
  assert.equal(run.layout[stray], "Dev");
});
