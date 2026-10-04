import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryMessages, checkService, isLocal, namingMessages, parseCategory, parseName } from "../../extension/ai-service.js";

const CATEGORIES = { dev: "Programming", news: "News sites", Gaming: "Video games" };

test("parseName takes the first line, without quotes, labels or thinking", () => {
  assert.equal(parseName("Trip to Lisbon"), "Trip to Lisbon");
  assert.equal(parseName('"Trip to Lisbon".\nThese tabs are about…'), "Trip to Lisbon");
  assert.equal(parseName("Name: **Rust**"), "Rust");
  assert.equal(parseName("<think>Hmm, flights.</think>\nTravel"), "Travel");
  assert.equal(parseName("x".repeat(41)), "");
});

test("parseCategory matches a category case-insensitively, or none", () => {
  assert.equal(parseCategory("News.", CATEGORIES), "news");
  assert.equal(parseCategory("gaming", CATEGORIES), "Gaming");
  assert.equal(parseCategory("Category: dev", CATEGORIES), "dev");
  assert.equal(parseCategory("none", CATEGORIES), null);
  assert.equal(parseCategory("Sport", CATEGORIES), null);
});

test("the prompts include each tab's title, address and description", () => {
  const tabs = [{ title: "Hotels in Alfama", url: "www.booking.com/alfama", description: "Lisbon's oldest district" }];
  assert.equal(namingMessages(tabs)[1].content, "Tabs in the group:\n- Hotels in Alfama (www.booking.com/alfama)\n  Lisbon's oldest district");
  const [system, user] = categoryMessages(tabs[0], CATEGORIES);
  assert.match(system.content, /- dev: Programming\n- news: News sites\n- Gaming: Video games$/);
  assert.match(user.content, /Hotels in Alfama/);
});

test("checkService wants https, except on this computer, and a model", () => {
  assert.deepEqual(checkService({ url: " https://api.openai.com/v1/ ", key: " sk ", model: "gpt" }), {
    url: "https://api.openai.com/v1",
    key: "sk",
    model: "gpt",
  });
  assert.equal(checkService({ url: "http://localhost:11434/v1", key: "", model: "llama3" }).url, "http://localhost:11434/v1");
  assert.throws(() => checkService({ url: "http://example.com/v1", key: "", model: "m" }), /https/);
  assert.throws(() => checkService({ url: "nope", key: "", model: "m" }), /valid URL/);
  assert.throws(() => checkService({ url: "https://example.com/v1", key: "", model: " " }), /model/);
});

test("isLocal", () => {
  assert.ok(isLocal("http://127.0.0.1:1234/v1"));
  assert.ok(isLocal("http://localhost:11434/v1"));
  assert.ok(!isLocal("https://api.openai.com/v1"));
  assert.ok(!isLocal("https://localhost.example.com/v1"));
});
