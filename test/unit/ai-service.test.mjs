import { test } from "node:test";
import assert from "node:assert/strict";
import { chat, checkService, cleanName, describeTab, isLocal, listModels, namingMessages, parseNames } from "../../extension/ai-service.js";

test("describeTab: the title and site, plus the description when the title says little", () => {
  assert.equal(describeTab({ title: "Hotels in Alfama, Lisbon", url: "https://www.booking.com/alfama", description: "Old town" }), "Hotels in Alfama, Lisbon (booking.com)");
  assert.equal(describeTab({ title: "YouTube", url: "www.youtube.com/", description: " Videos and music. " }), "YouTube (youtube.com) — Videos and music.");
  assert.equal(describeTab({ title: "x".repeat(120), url: "https://a.com" }).length, "x".repeat(89).length + "… (a.com)".length);
});

test("namingMessages numbers the tabs, and lists existing groups with what belongs and examples", () => {
  const tabs = [
    { title: "Cheap flights to Lisbon", url: "https://www.skyscanner.net/lis" },
    { title: "The Rust Book", url: "https://doc.rust-lang.org/book/" },
  ];
  const [system, user] = namingMessages(tabs, [
    { name: "Dev", about: "Programming", examples: ["tokio - crates.io", "MDN"] },
    { name: "Trip to Lisbon", examples: [] },
  ]);
  assert.equal(user.content, "Tabs:\n1. Cheap flights to Lisbon (skyscanner.net)\n2. The Rust Book (doc.rust-lang.org)");
  assert.match(system.content, /already exist[\s\S]*\n- Dev: Programming \(like tokio - crates\.io; MDN\)\n- Trip to Lisbon\n/);
  assert.match(system.content, /one line per tab/);
  assert.doesNotMatch(namingMessages(tabs)[0].content, /already exist/);
});

test("the user's instructions come after Tabcat's, if there are any", () => {
  const tabs = [{ title: "Hotels in Alfama", url: "www.booking.com/alfama" }];
  assert.match(namingMessages(tabs, [], " Name groups in French. ")[0].content, /\n\nThe user's instructions:\nName groups in French\.$/);
  assert.equal(namingMessages(tabs, [], "  ")[0].content, namingMessages(tabs)[0].content);
});

test("cleanName strips labels, quotes, markdown and control tokens", () => {
  assert.equal(cleanName('"Trip to Lisbon".'), "Trip to Lisbon");
  assert.equal(cleanName("Name: **Rust**"), "Rust");
  assert.equal(cleanName("Rust<channel|>"), "Rust");
  assert.equal(cleanName("x".repeat(41)), "");
});

test("parseNames: one per tab, by number, after any thinking", () => {
  assert.deepEqual(parseNames("1: Trip to Lisbon\n2. Rust\n3) Trip to Lisbon", 3), ["Trip to Lisbon", "Rust", "Trip to Lisbon"]);
  assert.deepEqual(parseNames("<think>1: Wrong</think>\n- 2: Rust\n9: Out of range\nSure!", 2), ["", "Rust"]);
  // The first answer for a tab counts.
  assert.deepEqual(parseNames("1: Rust\n1: Go", 1), ["Rust"]);
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

test("chat asks for the likeliest answer, and stops asking a service that only takes its default", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    if (body.model === "o4-mini" && "temperature" in body) {
      return Response.json({ error: { message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported." } }, { status: 400 });
    }
    return Response.json({ choices: [{ message: { content: "1: Rust" } }], usage: { prompt_tokens: 20, completion_tokens: 3 } });
  });
  const messages = [{ role: "user", content: "Tabs:\n1. Tokio (crates.io)" }];
  const local = { apiUrl: "http://localhost:1234/v1", apiModel: "gemma" };
  assert.deepEqual(await chat(local, messages), { text: "1: Rust", usage: { input: 20, output: 3 } });
  assert.equal(sent[0].temperature, 0);

  sent.length = 0;
  const picky = { apiUrl: "http://localhost:8080/v1", apiModel: "o4-mini" };
  assert.equal((await chat(picky, messages)).text, "1: Rust");
  assert.deepEqual(sent.map((b) => "temperature" in b), [true, false]);
  // It remembers.
  sent.length = 0;
  await chat(picky, messages);
  assert.deepEqual(sent.map((b) => "temperature" in b), [false]);
});

test("chat reports the service's own error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }));
  await assert.rejects(chat({ apiUrl: "http://localhost:1234/v1", apiModel: "m" }, []), /^Error: AI service: Invalid API key$/);
});

test("listModels: the ones that can chat, A–Z, asked for with the key", async (t) => {
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    asked.push([url, init.method, init.headers.Authorization]);
    const ids = ["llama3.2:latest", "nomic-embed-text", "gpt-4.1-mini", "whisper-1", "gemma-3-12b", "gemma-3-4b", "gpt-4.1-mini"];
    return Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model" })) });
  });
  assert.deepEqual(await listModels({ apiUrl: "https://api.example.com/v1", apiKey: "sk" }), ["gemma-3-4b", "gemma-3-12b", "gpt-4.1-mini", "llama3.2:latest"]);
  assert.deepEqual(asked, [["https://api.example.com/v1/models", "GET", "Bearer sk"]]);
});

test("listModels reports the service's own error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "Invalid API key" } }, { status: 401 }));
  await assert.rejects(listModels({ apiUrl: "https://api.example.com/v1", apiKey: "x" }), /^Error: Invalid API key$/);
});
