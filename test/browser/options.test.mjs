// The settings page in Firefox, served over http with browser.storage and
// browser.permissions stubbed (BiDi can't open moz-extension:// pages). The steps share
// one page and run in order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./firefox.mjs";

// Runs in the page before options.js. The stubs keep their state in sessionStorage so it
// survives a reload.
function stubBrowserApis() {
  let session;
  try {
    session = sessionStorage;
  } catch {
    return; // about:blank
  }
  const store = JSON.parse(session.getItem("stub") ?? "{}");
  window.browser = {
    storage: {
      local: {
        async get(defaults) {
          return { ...structuredClone(defaults), ...structuredClone(store) };
        },
        async set(values) {
          Object.assign(store, values);
          session.setItem("stub", JSON.stringify(store));
        },
      },
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
  };
}

test("settings page", { timeout: 120_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const [page] = await ff.browser.pages();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(stubBrowserApis);
  await page.goto(`${ff.origin}/ext/options.html`);
  await page.waitForSelector(".category");

  const hidden = (selector) => page.$eval(selector, (e) => e.hidden);
  const text = (selector) => page.$eval(selector, (e) => e.textContent);
  const stored = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("stub") ?? "{}"));
  const setRange = (id, value) =>
    page.evaluate((id, value) => {
      const range = document.getElementById(id);
      range.value = value;
      range.dispatchEvent(new Event("input"));
    }, id, value);
  // Lets click handlers that await the (stubbed) permissions API finish.
  const settleClicks = () => page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  const save = async () => {
    await page.evaluate(() => (document.getElementById("status").textContent = ""));
    await page.click("button[type=submit]");
    await page.waitForFunction(() => document.getElementById("status").textContent);
    return page.$eval("#status", (e) => ({ error: e.className === "error", text: e.textContent }));
  };

  await t.test("shows the defaults", async () => {
    assert.equal((await page.$$(".category")).length, 8);
    assert.equal(await page.$eval("#layaUrl", (e) => e.value), "http://127.0.0.1:8918");
    assert.equal(await text("#minConfidenceValue"), "0.50");
    assert.equal(await text("#groupingThresholdValue"), "0.25");
  });

  await t.test("starts in automatic mode with category and model settings hidden", async () => {
    assert.ok(await page.$eval("input[name=mode][value=auto]", (e) => e.checked));
    assert.equal(await hidden("#autoSettings"), false);
    assert.equal(await hidden("#categorySettings"), true);
    assert.equal(await hidden("#modelSettings"), true);
  });

  await t.test("saves automatic mode and strictness", async () => {
    await setRange("groupingThreshold", "0.3");
    assert.equal(await text("#groupingThresholdValue"), "0.30");
    assert.deepEqual(await save(), { error: false, text: "Saved." });
    const s = await stored();
    assert.equal(s.mode, "auto");
    assert.equal(s.groupingThreshold, 0.3);
  });

  await t.test("keeping tabs organised is on, with a note only if website access is off", async () => {
    assert.equal(await page.$eval("#keepOrganised", (e) => e.checked), true);
    assert.equal(await page.$eval("#newGroupForLoneTabs", (e) => e.checked), true);
    // The stub hasn't granted it, as if it had been turned off in about:addons.
    assert.equal(await hidden("#toastStatus"), false);
    assert.match(await text("#toastStatus"), /listed in Tabcat's popup/);
    assert.equal(await page.$("#allowToasts"), null);
    // Granted (as it is at install): no note.
    await page.evaluate(() => sessionStorage.setItem(`granted ${JSON.stringify({ origins: ["<all_urls>"] })}`, "1"));
    await page.click("#keepOrganised");
    await page.click("#keepOrganised");
    await settleClicks();
    assert.equal(await hidden("#toastStatus"), true);
  });

  await t.test("saves the keep-organised settings", async () => {
    await page.click("#newGroupForLoneTabs");
    await page.click("#keepOrganised");
    assert.equal(await hidden("#toastStatus"), true);
    assert.deepEqual(await save(), { error: false, text: "Saved." });
    const s = await stored();
    assert.equal(s.keepOrganised, false);
    assert.equal(s.newGroupForLoneTabs, false);
  });

  await t.test("categories mode shows categories and the model, defaulting to Tabcat's", async () => {
    await page.click("input[name=mode][value=categories]");
    assert.equal(await hidden("#autoSettings"), true);
    assert.equal(await hidden("#categorySettings"), false);
    assert.equal(await hidden("#modelSettings"), false);
    assert.equal(await page.$eval("#provider", (e) => e.value), "tabcat");
    assert.equal(await hidden("#tabcatHint"), false);
    assert.equal(await hidden("#layaSettings"), true);
    assert.equal(await hidden("#firefoxSettings"), true);
  });

  await t.test("Firefox's built-in AI asks for permission", async () => {
    await page.select("#provider", "firefox");
    assert.equal(await hidden("#firefoxSettings"), false);
    assert.equal(await hidden("#layaSettings"), true);
    assert.match(await text("#firefoxStatus"), /needs your permission/);
    await page.click("#allowFirefox");
    await page.waitForFunction(() => document.getElementById("allowFirefox").hidden);
    assert.match(await text("#firefoxStatus"), /is allowed/);
  });

  await t.test("the layad URL is only checked when Laya is chosen", async () => {
    await page.$eval("#layaUrl", (e) => (e.value = "not a url"));
    assert.deepEqual(await save(), { error: false, text: "Saved." });
    assert.equal((await stored()).provider, "firefox");
    await page.select("#provider", "laya");
    assert.equal(await hidden("#layaSettings"), false);
    assert.equal(await hidden("#firefoxSettings"), true);
    // The field is type=url, so Firefox itself refuses to submit.
    assert.equal(await page.$eval("#layaUrl", (e) => e.validity.valid), false);
    await page.$eval("#layaUrl", (e) => (e.value = "https://example.com"));
    assert.deepEqual(await save(), { error: true, text: "layad URL must be http://127.0.0.1:<port>." });
    await page.$eval("#layaUrl", (e) => (e.value = "http://127.0.0.1:8918/"));
  });

  await t.test("edits categories and confidence", async () => {
    await setRange("minConfidence", "0.3");
    assert.equal(await text("#minConfidenceValue"), "0.30");
    await page.click("#addCategory");
    const rows = await page.$$(".category");
    await rows.at(-1).$eval(".key", (e) => (e.value = "Gaming"));
    await rows.at(-1).$eval(".criteria", (e) => (e.value = "Video games, game stores and esports"));
    await (await rows[0].$(".remove")).click(); // "work"
    assert.deepEqual(await save(), { error: false, text: "Saved." });
    const s = await stored();
    assert.equal(s.provider, "laya");
    assert.equal(s.layaUrl, "http://127.0.0.1:8918");
    assert.equal(s.minConfidence, 0.3);
    assert.deepEqual(Object.keys(s.categories), ["dev", "news", "shopping", "social", "media", "reference", "other", "Gaming"]);
  });

  await t.test("a reload shows what was saved", async () => {
    await page.reload();
    await page.waitForSelector(".category");
    assert.equal(await text("#minConfidenceValue"), "0.30");
    assert.ok((await page.$$eval(".category .key", (es) => es.map((e) => e.value))).includes("Gaming"));
    assert.ok(await page.$eval("input[name=mode][value=categories]", (e) => e.checked));
    assert.equal(await page.$eval("#provider", (e) => e.value), "laya");
  });

  await t.test("rejects bad categories", async () => {
    await page.$eval(".category .key", (e) => (e.value = "GAMING"));
    assert.deepEqual(await save(), { error: true, text: 'Duplicate category "Gaming".' });
    // Empty names and descriptions are caught by the browser: both fields are required.
    await page.$eval(".category .criteria", (e) => (e.value = ""));
    assert.equal(await page.$eval(".category .criteria", (e) => e.validity.valid), false);
  });

  await t.test("reset restores the defaults without saving", async () => {
    await page.click("#reset");
    assert.equal((await page.$$(".category")).length, 8);
    assert.match(await text("#status"), /Defaults restored/);
    assert.ok((await stored()).categories.Gaming);
  });

  await t.test("no page errors", () => {
    assert.deepEqual(errors, []);
  });
});
