// Categories mode with the on-device model, on labelled tabs and the default categories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../extension/settings.js";
import { choiceText, chooseBySimilarity } from "../../extension/cluster.js";
import { CATEGORY_TABS } from "../fixtures/tabs.mjs";
import { embed } from "./embed.mjs";

test("on-device categories: accuracy and confidence", async (t) => {
  const { categories, minConfidence } = DEFAULT_SETTINGS;
  const keys = Object.keys(categories);
  const vectors = await embed(Object.values(categories));
  const options = Object.fromEntries(keys.map((k, i) => [k, vectors[i]]));
  const tabs = await embed(CATEGORY_TABS.map(([, title, url]) => choiceText({ title, url })));
  const results = tabs.map((v, i) => {
    const { choice, probabilities } = chooseBySimilarity(v, options);
    return { label: CATEGORY_TABS[i][0], choice, confidence: probabilities[choice] };
  });

  const right = results.filter((r) => r.choice === r.label).length;
  const placed = results.filter((r) => r.confidence >= minConfidence);
  const placedRight = placed.filter((r) => r.choice === r.label).length;
  t.diagnostic(`top-1 ${right}/${results.length}; at ${minConfidence}: placed ${placed.length}, ${placedRight} right`);

  // Measured: 39/48 right; 43 placed, 36 right. Laya scored 36/48; 30 placed, 28 right.
  assert.ok(right >= 35, `only ${right}/48 right`);
  assert.ok(placedRight >= 34, `only ${placedRight} placed correctly`);
  assert.ok(placedRight / placed.length >= 0.75, `precision ${(placedRight / placed.length).toFixed(2)}`);
});

// A brand's shop whose title doesn't say "shop". Went to "other" (0.6) until the shopping
// description mentioned brands and clothing; the page's meta description and keywords
// didn't help (they pushed it further towards "other").
test("on-device categories: a clothing brand's shop is shopping", async () => {
  const { categories } = DEFAULT_SETTINGS;
  const keys = Object.keys(categories);
  const vectors = await embed(Object.values(categories));
  const options = Object.fromEntries(keys.map((k, i) => [k, vectors[i]]));
  const [tab] = await embed([choiceText({ title: "The World's Finest Cycling Clothing and Accessories | Rapha", url: "rapha.cc/gb/en" })]);
  const { choice, probabilities } = chooseBySimilarity(tab, options);
  assert.equal(choice, "shopping");
  assert.ok(probabilities.shopping >= 0.8, `confidence ${probabilities.shopping.toFixed(2)}`);
});
