// Categories mode with the on-device model, on labelled tabs and the default categories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../extension/categories.js";
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

  // Measured: 37/48 right; 43 placed, 34 right. Laya scored 36/48; 31 placed, 28 right.
  assert.ok(right >= 35, `only ${right}/48 right`);
  assert.ok(placedRight >= 31, `only ${placedRight} placed correctly`);
  assert.ok(placedRight / placed.length >= 0.75, `precision ${(placedRight / placed.length).toFixed(2)}`);
});
