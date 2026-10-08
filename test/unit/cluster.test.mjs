// Pure helpers for finding similar tabs: no models, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { averageLinkage, averageSimilarity, isThin, representatives, tabText, withPageInfo } from "../../extension/cluster.js";

test("tabText adds URL path words", () => {
  assert.equal(
    tabText("Hotels", "https://www.booking.com/district/pt/lisbon/alfama.html"),
    "Hotels — district pt lisbon alfama html",
  );
});

test("tabText drops numeric ids and copes with empty paths and bad URLs", () => {
  assert.equal(tabText("Issue", "https://github.com/a/b/issues/482"), "Issue — a b issues");
  assert.equal(tabText("Home", "https://x.com/"), "Home");
  assert.equal(tabText("Odd", "not a url"), "Odd");
});

test("averageSimilarity averages dot products across the two sets", () => {
  const v = [[1, 0], [0, 1], [1, 0]];
  assert.equal(averageSimilarity(v, [0], [2]), 1);
  assert.equal(averageSimilarity(v, [0], [1, 2]), 0.5);
});

test("averageLinkage merges close vectors and stops at the threshold", () => {
  const v = [[1, 0], [0.99, 0.141], [0, 1], [0.141, 0.99], [0.707, 0.707]];
  const clusters = averageLinkage(v, [0, 1, 2, 3], 0.9).map((c) => c.sort()).sort();
  assert.deepEqual(clusters, [[0, 1], [2, 3]]);
  assert.equal(averageLinkage(v, [0, 1, 2, 3], 0.01).length, 1);
  assert.deepEqual(averageLinkage(v, [4], 0.5), [[4]]);
  assert.deepEqual(averageLinkage(v, [], 0.5), []);
});

// Re-averages every pair of clusters at every step: slow, but plainly right.
function naiveLinkage(vectors, indices, threshold) {
  let clusters = indices.map((i) => [i]);
  for (;;) {
    let best = null;
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const s = averageSimilarity(vectors, clusters[a], clusters[b]);
        if (s >= threshold && (!best || s > best.s)) best = { a, b, s };
      }
    }
    if (!best) return clusters;
    clusters[best.a] = clusters[best.a].concat(clusters[best.b]);
    clusters = clusters.filter((_, k) => k !== best.b);
  }
}

test("averageLinkage gives the same clusters as re-averaging at every step", () => {
  // Random unit vectors in 8 dimensions, from a fixed seed.
  let seed = 42;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const vectors = Array.from({ length: 60 }, () => {
    const v = Array.from({ length: 8 }, random);
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
  });
  const indices = vectors.map((_, i) => i);
  const canonical = (clusters) => clusters.map((c) => c.toSorted((a, b) => a - b).join(",")).sort();
  for (const threshold of [0.1, 0.25, 0.4]) {
    assert.deepEqual(canonical(averageLinkage(vectors, indices, threshold)), canonical(naiveLinkage(vectors, indices, threshold)));
  }
});

test("representatives: the members nearest the middle, best first", () => {
  const v = [[1, 0], [0.8, 0.6], [0, 1], [0.6, 0.8], [0.707, 0.707]];
  assert.deepEqual(representatives(v, [0, 2, 4], 1), [4]);
  assert.deepEqual(representatives(v, [0, 1, 2, 3, 4], 3).sort(), [1, 3, 4]);
  assert.deepEqual(representatives(v, [2, 0], 5), [2, 0]);
});

test("isThin: a bare site name or a few words", () => {
  assert.equal(isThin("YouTube"), true);
  assert.equal(isThin("BBC - Home"), true);
  assert.equal(isThin("Quick start: Feed, Ideas and Goals · bighelp — quick start"), false);
});

test("withPageInfo adds the description and keywords, if there are any", () => {
  assert.equal(withPageInfo("YouTube", { description: " Videos. ", keywords: "video, music" }), "YouTube — Videos. video, music");
  assert.equal(withPageInfo("YouTube", { description: "", keywords: "" }), "YouTube");
  assert.equal(withPageInfo("YouTube"), "YouTube");
});
