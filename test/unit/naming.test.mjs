// Naming groups on this computer: the pure helpers around the topic model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nameCandidates, namingInputs, sharedKeywords, siteName, topicPrompt, uniqueName } from "../../extension/naming.js";

test("sharedKeywords keeps words in two or more titles, skipping stop words and numbers", () => {
  assert.deepEqual(sharedKeywords(["Lisbon flights", "Hotels in Lisbon", "Weather"]), ["lisbon"]);
  assert.deepEqual(sharedKeywords(["The 2026 guide", "The 2026 list"]), []);
  assert.deepEqual(sharedKeywords(["Café Lisboa", "Café Porto"]), ["café"]);
  // Two copies of one page share every word, which says nothing about a group.
  assert.deepEqual(sharedKeywords(["Show the move message · Pull Request #17", "Show the move message · Pull Request #17"]), []);
});

test("namingInputs: each title once with its description, shared words then the pages' keywords", () => {
  const pr = { title: "Show the move message · Pull Request #17", description: "Contribute on GitHub." };
  assert.deepEqual(namingInputs([pr, { ...pr, description: "" }]), {
    lines: ["Show the move message · Pull Request #17 — Contribute on GitHub."],
    keywords: [],
  });
  assert.deepEqual(
    namingInputs([
      { title: "Lisbon flights", keywords: "Travel, Flights, Cheap, Deals" },
      { title: "Hotels in Lisbon" },
    ]),
    { lines: ["Lisbon flights", "Hotels in Lisbon"], keywords: ["lisbon", "travel", "flights", "cheap"] },
  );
});

test("siteName: the name the site gives itself, else its hostname", () => {
  assert.equal(siteName("OpenRouter", "https://openrouter.ai/settings"), "OpenRouter");
  assert.equal(siteName(" ", "https://www.screwfix.com/p/1"), "screwfix.com");
  assert.equal(siteName(undefined, "https://mail.google.com/mail/u/0/"), "mail.google.com");
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
  assert.equal(nameCandidates("sourdough Recipe", [], [])[0], "Sourdough Recipe");
});

test("uniqueName numbers a name that's taken, ignoring case", () => {
  assert.equal(uniqueName("Rust", new Set()), "Rust");
  assert.equal(uniqueName("Rust", new Set(["rust"])), "Rust 2");
  assert.equal(uniqueName("Rust", ["Rust", "Rust 2"]), "Rust 3");
});
