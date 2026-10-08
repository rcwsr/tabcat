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
    aiWarning: "Can't reach the AI service at https://api.example.com/v1.",
  };
  let snapshot = false;
  window.sent = [];
  window.wasClosed = false;
  window.close = () => (window.wasClosed = true);
  const answers = {
    organise: () => ({ organised: 3, groups: { Dev: 2, "Trip to Lisbon": 1 }, skipped: 1 }),
    reorganise: () => ((snapshot = true), { organised: 5, groups: { Dev: 3, News: 2 }, skipped: 0, canUndo: true }),
    undoReorganise: () => ((snapshot = false), { restored: true }),
    canUndoReorganise: () => snapshot,
    undo: ({ moveId }) => void (session.moves = session.moves.filter((m) => m.id !== moveId)),
    show: () => true,
    seen: () => undefined,
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
    storage: { session: { get: async (defaults) => ({ ...defaults, ...structuredClone(session) }) } },
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
  const sent = () => page.evaluate(() => window.sent);
  const statusSays = (expected) => page.waitForFunction((s) => document.getElementById("status").textContent === s, {}, expected);

  await t.test("lists this window's recent moves, and tells the background page they've been seen", async () => {
    assert.deepEqual(await page.$$eval(".move span", (es) => es.map((e) => e.textContent)), [
      "Moved “Tokio” to Dev",
      "Grouped “BBC News” and 1 similar tab as News",
    ]);
    assert.deepEqual(await page.$$eval(".move:first-of-type button", (es) => es.map((e) => e.textContent)), ["Show", "Undo"]);
    assert.deepEqual(await sent(), [{ type: "seen", windowId: 1 }]);
  });

  await t.test("says when the AI service couldn't be used", async () => {
    assert.equal(await hidden("#warning"), false);
    assert.match(await page.$eval("#warning", (e) => e.textContent), /couldn't be used, so this computer did it all: Can't reach/);
  });

  await t.test("Show goes to the tab and closes the popup", async () => {
    await page.evaluate(() => (window.sent.length = 0));
    await page.click(".move button");
    await page.waitForFunction(() => window.wasClosed);
    assert.deepEqual(await sent(), [{ type: "show", moveId: 2 }]);
  });

  await t.test("Undo on a move undoes just that one", async () => {
    await page.evaluate(() => (window.sent.length = 0));
    await page.click(".move button:last-child");
    await page.waitForFunction(() => document.querySelectorAll(".move").length === 1);
    assert.deepEqual((await sent())[0], { type: "undo", moveId: 2 });
  });

  await t.test("Tidy tabs shows what it did, with no Undo", async () => {
    assert.equal(await hidden("#undoReorganise"), true);
    await page.click("#organise");
    await statusSays("Dev: 2 tabs\nTrip to Lisbon: 1 tab\nLeft 1 tab on its own: nothing like it yet.");
    assert.equal(await hidden("#undoReorganise"), true);
    // It worked this time.
    assert.equal(await hidden("#warning"), true);
  });

  await t.test("Reorganise, then Undo reorganise", async () => {
    await page.evaluate(() => (window.sent.length = 0));
    await page.click("#reorganise");
    await statusSays("Dev: 3 tabs\nNews: 2 tabs");
    await page.waitForFunction(() => !document.getElementById("undoReorganise").hidden);
    await page.click("#undoReorganise");
    await statusSays("Groups put back.");
    await page.waitForFunction(() => document.getElementById("undoReorganise").hidden);
    assert.deepEqual((await sent()).map((m) => m.type), ["reorganise", "undoReorganise"]);
    assert.equal(await page.$eval("#organise", (e) => e.disabled), false);
  });

  await t.test("no page errors", () => {
    assert.deepEqual(errors, []);
  });
});
