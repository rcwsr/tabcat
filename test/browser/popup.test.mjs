// The popup in Firefox, served over http with the extension APIs stubbed (BiDi can't open
// moz-extension:// pages). The background page's answers are canned; window.sent records
// what the popup asked it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./firefox.mjs";

// Runs in the page before popup.js.
function stubBrowserApis() {
  if (location.protocol === "about:") return;
  const session = {
    moves: [
      { id: 2, windowId: 1, message: "Moved “Tokio” to Dev", tabs: [], seen: false },
      { id: 1, windowId: 1, message: "Grouped “BBC News” and 1 similar tab as News", tabs: [], seen: true },
      { id: 3, windowId: 9, message: "Another window's move", tabs: [], seen: false },
    ],
  };
  let snapshot = false;
  window.sent = [];
  window.badge = "1";
  const answers = {
    organise: () => ({ groups: { Dev: 2 }, skipped: 1 }),
    reorganise: () => ((snapshot = true), { groups: { Dev: 3, News: 2 }, skipped: 0, canUndo: true }),
    undoReorganise: () => ((snapshot = false), { restored: true }),
    canUndoReorganise: () => snapshot,
    undo: ({ moveId }) => void (session.moves = session.moves.filter((m) => m.id !== moveId)),
  };
  window.browser = {
    runtime: {
      async sendMessage(message) {
        if (message.type !== "canUndoReorganise") window.sent.push(message);
        return answers[message.type](message);
      },
      onMessage: { addListener() {} },
      openOptionsPage() {},
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    storage: {
      session: {
        get: async (defaults) => ({ ...defaults, ...structuredClone(session) }),
        set: async (values) => Object.assign(session, values),
      },
      local: { get: async (defaults) => defaults },
    },
    action: { setBadgeText: async ({ text }) => (window.badge = text) },
  };
}

test("popup", { timeout: 120_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const [page] = await ff.browser.pages();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(stubBrowserApis);
  await page.goto(`${ff.origin}/ext/popup.html`);
  await page.waitForSelector(".move");

  const hidden = (selector) => page.$eval(selector, (e) => e.hidden);
  const sent = () => page.evaluate(() => window.sent.map((m) => m.type));
  const statusSays = (expected) => page.waitForFunction((s) => document.getElementById("status").textContent === s, {}, expected);

  await t.test("lists this window's recent moves and clears the badge", async () => {
    assert.deepEqual(await page.$$eval(".move span", (es) => es.map((e) => e.textContent)), [
      "Moved “Tokio” to Dev",
      "Grouped “BBC News” and 1 similar tab as News",
    ]);
    assert.equal(await page.evaluate(() => window.badge), "");
  });

  await t.test("Undo on a move undoes just that one", async () => {
    await page.click(".move button");
    await page.waitForFunction(() => document.querySelectorAll(".move").length === 1);
    assert.deepEqual(await page.evaluate(() => window.sent), [{ type: "undo", moveId: 2 }]);
  });

  await t.test("Tidy tabs shows what it did, with no Undo", async () => {
    assert.equal(await hidden("#undoReorganise"), true);
    await page.click("#organise");
    await statusSays("Dev: 2\nLeft alone: 1");
    assert.equal(await hidden("#undoReorganise"), true);
  });

  await t.test("Reorganise, then Undo reorganise", async () => {
    await page.click("#reorganise");
    await statusSays("Dev: 3\nNews: 2");
    await page.waitForFunction(() => !document.getElementById("undoReorganise").hidden);
    await page.click("#undoReorganise");
    await statusSays("Groups put back.");
    await page.waitForFunction(() => document.getElementById("undoReorganise").hidden);
    assert.deepEqual(await sent(), ["undo", "organise", "reorganise", "undoReorganise"]);
    assert.equal(await page.$eval("#organise", (e) => e.disabled), false);
  });

  await t.test("no page errors", () => {
    assert.deepEqual(errors, []);
  });
});
