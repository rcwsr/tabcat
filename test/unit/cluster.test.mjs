// Pure helpers: no models, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  averageLinkage,
  averageSimilarity,
  choiceText,
  chooseBySimilarity,
  isThin,
  nameCandidates,
  sharedKeywords,
  tabText,
  topicPrompt,
  withPageInfo,
} from "../../extension/cluster.js";

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

test("sharedKeywords keeps words in two or more titles, skipping stop words and numbers", () => {
  assert.deepEqual(sharedKeywords(["Lisbon flights", "Hotels in Lisbon", "Weather"]), ["lisbon"]);
  assert.deepEqual(sharedKeywords(["The 2026 guide", "The 2026 list"]), []);
  assert.deepEqual(sharedKeywords(["Café Lisboa", "Café Porto"]), ["café"]);
});

test("topicPrompt matches the format smart-tab-topic was trained on", () => {
  assert.equal(topicPrompt(["a", "b"], ["k"]), "Topic from keywords: k. titles: \na \nb");
});

test("nameCandidates: topic first, deduplicated case-insensitively, at most 8", () => {
  assert.deepEqual(nameCandidates("Rust", ["rust", "tokio"], ["a.com", "b.com"]), ["Rust", "Tokio"]);
  assert.deepEqual(nameCandidates("none", [], ["www.bbc.co.uk", "www.bbc.co.uk"]), ["bbc.co.uk"]);
  assert.deepEqual(nameCandidates("", [], ["a.com", "b.com"]), []);
  assert.equal(nameCandidates("T", "abcdefghij".split(""), []).length, 8);
});

test("nameCandidates collapses repeated words from the topic model", () => {
  assert.deepEqual(nameCandidates("Tax Tax", [], []), ["Tax"]);
  assert.equal(nameCandidates("Café café Paris", [], [])[0], "Café Paris");
  assert.equal(nameCandidates("Taxi Tax", [], [])[0], "Taxi Tax");
});

test("choiceText is the title and the site", () => {
  assert.equal(choiceText({ title: "Home - BBC News", url: "www.bbc.co.uk/news" }), "Home - BBC News (bbc.co.uk)");
  assert.equal(choiceText({ title: "x" }), "x");
});

test("chooseBySimilarity picks the nearest option with probabilities that sum to 1", () => {
  const { choice, probabilities } = chooseBySimilarity([1, 0], { a: [1, 0], b: [0, 1], c: [0.6, 0.8] }, 0.1);
  assert.equal(choice, "a");
  assert.ok(Math.abs(Object.values(probabilities).reduce((x, y) => x + y) - 1) < 1e-9);
  assert.ok(probabilities.a > probabilities.c && probabilities.c > probabilities.b);
});

test("chooseBySimilarity: lower temperature is more confident", () => {
  const options = { a: [1, 0], b: [0.8, 0.6] };
  const sharp = chooseBySimilarity([1, 0], options, 0.01).probabilities.a;
  const soft = chooseBySimilarity([1, 0], options, 1).probabilities.a;
  assert.ok(sharp > 0.99 && soft < 0.6);
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
