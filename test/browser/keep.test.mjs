// Keeping tabs organised in real Firefox: tabs joining groups as you browse, the toast and
// its Undo, and tabs you take out of a group staying out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { CATEGORY_TABS } from "../fixtures/tabs.mjs";
import { launch } from "./firefox.mjs";

const tab = (title) => CATEGORY_TABS.find((row) => row[1].startsWith(title)).slice(1, 3);
const DEV = ["Array.prototype.map()", "python - How do I merge", "Issue #482", "tokio - crates.io"].map(tab);
const NEWS = ["Home - BBC News", "UK inflation falls", "Election results live"].map(tab);
const RUST = tab("The Rust Programming Language");
const STORM = tab("Storm warning");
// Automatic groups are by topic: this one matches the inflation and election stories.
const RATES = ["Bank of England holds interest rates as inflation eases - BBC News", "www.bbc.co.uk/news/business-68412345"];

// Polls the tab layout until check(layout) passes. The first move loads the model.
async function waitForLayout(ff, check, what) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const layout = await ff.command("layout");
    if (check(layout)) return layout;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(layout)}`);
    await sleep(500);
  }
}

// Long enough for Tav to have acted if it was going to (it waits 0.5–2 s).
const settle = () => sleep(3000);

test("keeping tabs organised (automatic mode)", { timeout: 300_000 }, async (t) => {
  const ff = await launch({ grantAllSites: true });
  t.after(() => ff.close());
  const urls = await ff.openTabs([...DEV, ...NEWS]);
  const dev = urls.slice(0, DEV.length);
  const news = urls.slice(DEV.length);
  await ff.organise({
    settings: { mode: "auto", keepOrganised: true },
    groups: [
      { title: "Dev", urls: dev },
      { title: "News", urls: news },
    ],
    runs: 0,
  });
  const colours = await ff.command("colours");
  let rust, front;

  await t.test("the tab you're on isn't moved", async () => {
    [rust] = await ff.openTabs([RUST]);
    await settle();
    assert.equal((await ff.command("layout"))[rust], null);
  });

  await t.test("switching away moves it into its group, with a toast saying so", async () => {
    front = await ff.show(news[0]);
    await waitForLayout(ff, (l) => l[rust] === "Dev", "the Rust tab to join Dev");
    const text = await front.waitForFunction(
      () => document.getElementById("tav-toast")?.shadowRoot.querySelector(".text")?.textContent,
    );
    assert.equal(await text.jsonValue(), "Moved “The Rust Programming Language - Ownership” to Dev");
  });

  await t.test("Undo takes it back out, and it stays out", async () => {
    await front.evaluate(() => document.getElementById("tav-toast").shadowRoot.querySelector("button").click());
    await waitForLayout(ff, (l) => l[rust] === null, "Undo");
    await ff.show(rust);
    await ff.show(news[0]);
    await settle();
    assert.equal((await ff.command("layout"))[rust], null);
  });

  await t.test("a tab that loads in the background joins its group", async () => {
    const [rates] = await ff.openTabs([RATES], { background: true });
    await waitForLayout(ff, (l) => l[rates] === "News", "the interest rates tab to join News");
  });

  await t.test("a tab you take out of a group stays out", async () => {
    await ff.command("ungroup", dev[0]);
    await ff.show(dev[0]);
    await ff.show(news[0]);
    await settle();
    assert.equal((await ff.command("layout"))[dev[0]], null);
  });

  await t.test("the flashing leaves group colours as they were", async () => {
    await sleep(2000); // A blink takes 1.8 s.
    assert.deepEqual(await ff.command("colours"), colours);
  });
});

test("keeping tabs organised (categories mode, no permission for toasts)", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  await ff.openTabs([NEWS[0]]);
  await ff.organise({ settings: { mode: "categories", provider: "tav", keepOrganised: true }, runs: 0 });

  const [storm] = await ff.openTabs([STORM], { background: true });
  await waitForLayout(ff, (l) => l[storm] === "News", "a News group for the storm tab");
  // The toast couldn't be shown, so the move is counted on the toolbar button.
  assert.equal(await ff.command("badge"), "1");
});
