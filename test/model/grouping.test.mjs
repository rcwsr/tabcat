// Automatic grouping quality on labelled tabs, with the default threshold. Measures pairs:
// precision = tab pairs grouped together that belong together, recall = the reverse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../../extension/settings.js";
import { averageLinkage, tabText } from "../../extension/cluster.js";
import { GROUPING_HELDOUT, GROUPING_TRAIN } from "../fixtures/tabs.mjs";
import { embed } from "./embed.mjs";

async function pairScores(tabs) {
  const vectors = await embed(tabs.map(([, title, url]) => tabText(title, `https://${url}`)));
  const clusters = averageLinkage(vectors, tabs.map((_, i) => i), DEFAULT_SETTINGS.groupingThreshold);
  const clusterOf = [];
  clusters.forEach((c, k) => c.forEach((i) => (clusterOf[i] = k)));
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < tabs.length; i++) {
    for (let j = i + 1; j < tabs.length; j++) {
      const belong = tabs[i][0] === tabs[j][0] && tabs[i][0] !== "solo";
      const grouped = clusterOf[i] === clusterOf[j];
      tp += belong && grouped;
      fp += !belong && grouped;
      fn += belong && !grouped;
    }
  }
  return { precision: tp / (tp + fp), recall: tp / (tp + fn) };
}

// Floors sit a little under the measured scores, so a real regression fails but noise doesn't.
for (const [name, tabs, floor] of [
  ["training tabs", GROUPING_TRAIN, { precision: 0.78, recall: 0.68 }],
  ["held-out tabs", GROUPING_HELDOUT, { precision: 0.74, recall: 0.6 }],
]) {
  test(`grouping ${name}`, async (t) => {
    const { precision, recall } = await pairScores(tabs);
    t.diagnostic(`precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}`);
    assert.ok(precision >= floor.precision, `precision ${precision.toFixed(2)} < ${floor.precision}`);
    assert.ok(recall >= floor.recall, `recall ${recall.toFixed(2)} < ${floor.recall}`);
  });
}
