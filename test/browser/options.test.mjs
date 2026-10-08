// The settings page in Firefox, served over http with the extension APIs stubbed (BiDi
// can't open moz-extension:// pages). The steps share one page and run in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launch, perTab } from "./firefox.mjs";

// Runs in the page before options.js. The stubs keep their state in sessionStorage so it
// survives a reload.
function stubBrowserApis() {
  let session;
  try {
    session = sessionStorage;
  } catch {
    return; // about:blank
  }
  const load = () => JSON.parse(session.getItem("stub") ?? "{}");
  const save = (store) => session.setItem("stub", JSON.stringify(store));
  window.browser = {
    storage: {
      local: {
        async get(defaults) {
          return { ...structuredClone(defaults), ...load() };
        },
        async set(values) {
          save({ ...load(), ...values });
        },
        async remove(keys) {
          const store = load();
          for (const key of [keys].flat()) delete store[key];
          save(store);
        },
      },
      session: { get: async (defaults) => ({ ...defaults, ...JSON.parse(session.getItem("session") ?? "{}") }) },
    },
    // Granted permissions are remembered one by one; set sessionStorage "deny" to refuse.
    permissions: {
      async contains(p) {
        return session.getItem(`granted ${JSON.stringify(p)}`) === "1";
      },
      async request(p) {
        if (session.getItem("deny")) return false;
        session.setItem(`granted ${JSON.stringify(p)}`, "1");
        return true;
      },
    },
    commands: {
      getAll: async () => [{ name: "show-last-move", shortcut: "Alt+Shift+M" }],
      openShortcutSettings() {},
    },
  };
}

test("settings page", { timeout: 120_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const [page] = await ff.browser.pages();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(stubBrowserApis);
  const open = async () => {
    await page.waitForFunction(() => document.getElementById("usage")?.textContent);
  };
  await page.goto(`${ff.origin}/ext/options.html`);
  await open();

  const hidden = (selector) => page.$eval(selector, (e) => e.hidden);
  const checked = (selector) => page.$eval(selector, (e) => e.checked);
  const value = (selector) => page.$eval(selector, (e) => e.value);
  const text = (selector) => page.$eval(selector, (e) => e.textContent);
  const stored = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("stub") ?? "{}"));
  const categories = () => page.$$eval(".category", (rows) => rows.map((r) => [r.querySelector(".key").value, r.querySelector(".criteria").value]));
  // Lets click handlers that await the (stubbed) permissions API finish.
  const settleClicks = () => page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  const save = async () => {
    await page.evaluate(() => (document.getElementById("status").textContent = ""));
    await page.click("button[type=submit]");
    await page.waitForFunction(() => document.getElementById("status").textContent);
    return page.$eval("#status", (e) => ({ error: e.className === "error", text: e.textContent }));
  };

  await t.test("shows the defaults", async () => {
    for (const id of ["#keepOrganised", "#newGroupForLoneTabs", "#renameGrowingGroups", "#showToast", "#markGroups"]) {
      assert.equal(await checked(id), true, id);
    }
    assert.equal(await checked("#useAi"), false);
    assert.equal(await hidden("#aiSettings"), true);
    assert.equal(await value("#groupingThreshold"), "0.25");
    assert.equal(await value("#tabOrder"), "added");
    assert.deepEqual(await categories(), []);
    assert.equal(await text("#shortcutKey"), "Alt+Shift+M");
    assert.equal(await text("#usage"), "No requests yet.");
  });

  await t.test("a note shows only if website access is off", async () => {
    // The stub hasn't granted it, as if it had been turned off in about:addons.
    assert.equal(await hidden("#toastStatus"), false);
    // Granted (as it is at install): no note.
    await page.evaluate(() => sessionStorage.setItem(`granted ${JSON.stringify({ origins: ["<all_urls>"] })}`, "1"));
    await page.click("#showToast");
    await page.click("#showToast");
    await settleClicks();
    assert.equal(await hidden("#toastStatus"), true);
  });

  await t.test("saves the grouping settings", async () => {
    await page.click("#newGroupForLoneTabs");
    await page.click("#markGroups");
    await page.$eval("#groupingThreshold", (e) => (e.value = "0.3"));
    await page.select("#tabOrder", "title");
    assert.deepEqual(await save(), { error: false, text: "Saved." });
    const s = await stored();
    assert.deepEqual([s.newGroupForLoneTabs, s.markGroups, s.groupingThreshold, s.tabOrder, s.keepOrganised], [false, false, 0.3, "title", true]);
  });

  await t.test("adds the example categories and your own", async () => {
    await page.click("#addCategory"); // An empty row, replaced by the examples.
    await page.click("#addExamples");
    assert.deepEqual((await categories()).map(([name]) => name), ["Work", "Dev", "News", "Shopping", "Social", "Media", "Reference"]);
    await page.click("#addCategory");
    await page.type(".category:last-child .key", "Gaming");
    await page.type(".category:last-child .criteria", "Video games, game stores and esports");
    await page.click(".category .remove"); // Work
    assert.deepEqual(await save(), { error: false, text: "Saved." });
    const s = await stored();
    assert.deepEqual(Object.keys(s.categories), ["Dev", "News", "Shopping", "Social", "Media", "Reference", "Gaming"]);
    assert.equal(s.categories.Gaming, "Video games, game stores and esports");
    // Adding the examples again doesn't repeat them.
    await page.click("#addExamples");
    assert.equal((await categories()).length, 8);
    await page.click(".category:last-child .remove"); // Work, added back
  });

  await t.test("rejects categories it can't use", async () => {
    await page.$eval(".category:last-child .key", (e) => (e.value = "DEV"));
    assert.deepEqual(await save(), { error: true, text: "There are two categories called “DEV”." });
    await page.$eval(".category:last-child .key", (e) => (e.value = "Gaming"));
    await page.$eval(".category:last-child .criteria", (e) => (e.value = ""));
    assert.deepEqual(await save(), { error: true, text: "Every category needs a name and a description." });
    await page.type(".category:last-child .criteria", "Video games");
    assert.deepEqual(await save(), { error: false, text: "Saved." });
  });

  await t.test("the AI service: shown when turned on, and asks to send tab data unless it's on this computer", async () => {
    const SEND = `granted ${JSON.stringify({ data_collection: ["browsingActivity", "websiteContent"] })}`;
    await page.click("#useAi");
    assert.equal(await hidden("#aiSettings"), false);
    await page.$eval("#apiUrl", (e) => (e.value = "http://localhost:11434/v1"));
    assert.deepEqual(await save(), { error: true, text: "Choose the AI service's model." });
    await page.type("#apiModel", "llama3.2");
    assert.deepEqual(await save(), { error: false, text: "Saved." });
    assert.equal(await page.evaluate((k) => sessionStorage.getItem(k), SEND), null);

    await page.$eval("#apiUrl", (e) => (e.value = "http://api.example.com/v1"));
    assert.match((await save()).text, /must start with https/);
    await page.$eval("#apiUrl", (e) => (e.value = "https://api.example.com/v1/"));
    await page.type("#apiKey", "sk-test");
    await page.type("#apiPrompt", " Name groups in French. ");
    await page.evaluate(() => sessionStorage.setItem("deny", "1"));
    assert.deepEqual(await save(), { error: true, text: "Not saved: Tabcat needs your permission to send tab data to your AI service." });
    assert.equal((await stored()).apiUrl, "http://localhost:11434/v1");
    await page.evaluate(() => sessionStorage.removeItem("deny"));
    assert.deepEqual(await save(), { error: false, text: "Saved." });
    assert.equal(await page.evaluate((k) => sessionStorage.getItem(k), SEND), "1");
    const s = await stored();
    assert.deepEqual([s.useAi, s.apiUrl, s.apiKey, s.apiModel, s.apiPrompt], [true, "https://api.example.com/v1", "sk-test", "llama3.2", "Name groups in French."]);
  });

  await t.test("Test sends made-up tabs and shows the name the service gave", async () => {
    ff.aiReply = perTab(() => "Trip to Lisbon");
    await page.$eval("#apiUrl", (e) => (e.value = `${location.origin}/v1`));
    await page.click("#testAi");
    await page.waitForFunction(() => document.getElementById("testResult").textContent !== "Testing…");
    assert.match(await text("#testResult"), /^It works: it named two tabs about a trip to Lisbon “Trip to Lisbon” \(\d+\.\d s\)\.$/);
    const [request] = ff.aiRequests;
    assert.match(request.messages[1].content, /Skyscanner/);
    assert.match(request.messages[0].content, /Name groups in French\.$/);
    assert.equal(request.authorization, "Bearer sk-test");

    ff.aiReply = () => "I can't help with that.";
    await page.click("#testAi");
    await page.waitForFunction(() => document.getElementById("testResult").textContent !== "Testing…");
    assert.equal(await text("#testResult"), "It answered, but not with a name: “I can't help with that.”");
  });

  await t.test("lists the service's models to choose from, or has you type one if it can't", async () => {
    const setAddress = (url) =>
      page.$eval("#apiUrl", (e, url) => {
        e.value = url;
        e.dispatchEvent(new Event("change"));
      }, url);
    const options = () => page.$$eval("#modelList option", (os) => os.map((o) => o.value));
    await setAddress(`${ff.origin}/v1`);
    await page.waitForFunction(() => !document.getElementById("modelList").hidden);
    assert.equal(await hidden("#apiModel"), true);
    // The saved model first, though the service doesn't list it; no embedding models.
    assert.deepEqual(await options(), ["llama3.2", "gemma-3-4b", "llama-3.1-8b"]);
    assert.equal(await value("#modelList"), "llama3.2");
    await page.select("#modelList", "gemma-3-4b");
    assert.deepEqual(await save(), { error: false, text: "Saved." });
    assert.equal((await stored()).apiModel, "gemma-3-4b");

    await setAddress(`${ff.origin}/nothing/v1`);
    await page.waitForFunction(() => !document.getElementById("modelProblem").hidden);
    assert.equal(await text("#modelProblem"), "Couldn't list the models: error 404");
    assert.equal(await hidden("#modelList"), true);
    assert.equal(await hidden("#apiModel"), false);
    assert.equal(await value("#apiModel"), "gemma-3-4b");
    await setAddress(`${ff.origin}/v1`);
    await page.waitForFunction(() => !document.getElementById("modelList").hidden);
    assert.equal(await hidden("#modelProblem"), true);
    assert.equal(await hidden("#modelSearch"), true);
  });

  await t.test("a long list of models can be searched", async () => {
    const short = ff.aiModels;
    ff.aiModels = [...short, ...Array.from({ length: 30 }, (_, i) => `vendor/model-${i}`), "meta-llama/llama-3.3-70b"];
    try {
      await page.$eval("#apiKey", (e) => e.dispatchEvent(new Event("change")));
      await page.waitForFunction(() => !document.getElementById("modelSearch").hidden);
      await page.type("#modelSearch", "LLAMA");
      // The chosen model stays at the top, whatever the search.
      assert.deepEqual(await page.$$eval("#modelList option", (os) => os.map((o) => o.value)), ["gemma-3-4b", "llama-3.1-8b", "meta-llama/llama-3.3-70b"]);
      await page.select("#modelList", "meta-llama/llama-3.3-70b");
      assert.equal(await value("#apiModel"), "meta-llama/llama-3.3-70b");
    } finally {
      ff.aiModels = short;
    }
  });

  await t.test("shows what the service has cost, and resets it", async () => {
    const since = new Date(2026, 9, 1).getTime();
    await page.evaluate((since) => {
      const store = JSON.parse(sessionStorage.getItem("stub"));
      sessionStorage.setItem("stub", JSON.stringify({ ...store, aiUsage: { requests: 3, input: 1200, output: 50, since } }));
      sessionStorage.setItem("session", JSON.stringify({ aiWarning: "Can't reach the AI service at https://api.example.com/v1." }));
    }, since);
    await page.reload();
    await open();
    assert.match(await text("#usage"), /^Since (1 October|October 1): 3 requests, 1,200 tokens sent and 50 received\.$/);
    assert.match(await text("#aiWarning"), /couldn't be used, so this computer did it all: Can't reach/);
    await page.click("#resetUsage");
    await page.waitForFunction(() => document.getElementById("usage").textContent === "No requests yet.");
    assert.equal((await stored()).aiUsage, undefined);
  });

  await t.test("a reload shows what was saved", async () => {
    assert.equal(await value("#groupingThreshold"), "0.3");
    assert.equal(await value("#tabOrder"), "title");
    assert.equal(await checked("#markGroups"), false);
    assert.equal(await checked("#useAi"), true);
    assert.equal((await categories()).at(-1)[0], "Gaming");
  });

  await t.test("reset restores the defaults without saving", async () => {
    await page.click("#reset");
    assert.deepEqual(await categories(), []);
    assert.equal(await value("#tabOrder"), "added");
    assert.equal(await hidden("#aiSettings"), true);
    assert.match(await text("#status"), /Defaults restored/);
    assert.ok((await stored()).categories.Gaming);
  });

  await t.test("settings from Tabcat 0.1 are brought up to date", async () => {
    await page.evaluate(() =>
      sessionStorage.setItem("stub", JSON.stringify({ mode: "categories", provider: "ai", layaUrl: "http://127.0.0.1:8918", categories: { dev: "Code", other: "Anything" } })),
    );
    await page.reload();
    await open();
    assert.deepEqual(await categories(), [["Dev", "Code"]]);
    assert.equal(await checked("#useAi"), true);
    assert.deepEqual(await stored(), { categories: { Dev: "Code" }, useAi: true });
  });

  await t.test("no page errors", () => {
    assert.deepEqual(errors, []);
  });
});
