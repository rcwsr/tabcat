// Grouping quality on this computer, on labelled tabs with the default threshold, measured
// on pairs: precision = tab pairs grouped together that belong together, recall = the
// reverse. scripts/eval.mjs measures the same with an AI service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPING_HELDOUT, GROUPING_TRAIN } from "../fixtures/tabs.mjs";
import { browse, pairScores, tidy, windowOf } from "./simulate.mjs";

// Floors sit a little under the measured scores, so a real regression fails but noise doesn't.
for (const [name, rows, run, floor] of [
  // Measured: 0.81 / 0.65.
  ["Tidy, training tabs", GROUPING_TRAIN, tidy, { precision: 0.76, recall: 0.6 }],
  // Measured: 0.76 / 0.59.
  ["Tidy, held-out tabs", GROUPING_HELDOUT, tidy, { precision: 0.72, recall: 0.55 }],
  // Measured: 0.78 / 0.64.
  ["as you browse, held-out tabs", GROUPING_HELDOUT, browse, { precision: 0.72, recall: 0.58 }],
]) {
  test(`grouping: ${name}`, async (t) => {
    const win = await windowOf(rows);
    await run(win);
    const { precision, recall } = pairScores(win);
    t.diagnostic(`precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}`);
    assert.ok(precision >= floor.precision, `precision ${precision.toFixed(2)} < ${floor.precision}`);
    assert.ok(recall >= floor.recall, `recall ${recall.toFixed(2)} < ${floor.recall}`);
  });
}
