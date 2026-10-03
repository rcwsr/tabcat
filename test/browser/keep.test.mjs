// Keeping tabs organised in real Firefox: tabs joining or starting groups as they load, the
// toast and its Undo, and tabs you take out of a group staying out.
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
const CYCLING = [
  ["Men's Cycling Jerseys | Castelli", "www.castelli-cycling.com/GB/en/men/jerseys"],
  ["Road Bikes | Canyon GB", "www.canyon.com/en-gb/road-bikes/"],
];
const BAKING = [
  ["Easy sourdough bread recipe - BBC Good Food", "www.bbcgoodfood.com/recipes/sourdough-bread"],
  ["How to make a sourdough starter | King Arthur Baking", "www.kingarthurbaking.com/recipes/sourdough-starter"],
];
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

// Long enough for Tav to have acted if it was going to (it waits 2 s after a page loads).
const settle = () => sleep(3000);

test("keeping tabs organised (automatic mode)", { timeout: 300_000 }, async (t) => {
  const ff = await launch({ grantAllSites: true });
  t.after(() => ff.close());
  const urls = await ff.openTabs([...DEV, ...NEWS]);
  const dev = urls.slice(0, DEV.length);
  const news = urls.slice(DEV.length);
  await ff.organise({
    settings: { mode: "auto" }, // keepOrganised and newGroupForLoneTabs are on by default.
    groups: [
      { title: "Dev", urls: dev },
      { title: "News", urls: news },
    ],
    runs: 0,
  });
  const colours = await ff.command("colours");
  let rust, page;
  const toastText = () =>
    page.waitForFunction(() => document.getElementById("tav-toast")?.shadowRoot.querySelector(".text")?.textContent);

  await t.test("a tab you open joins its group once it loads, with a toast saying so", async () => {
    [rust] = await ff.openTabs([RUST]);
    page = await ff.show(rust);
    await waitForLayout(ff, (l) => l[rust] === "Dev", "the Rust tab to join Dev");
    assert.equal(await (await toastText()).jsonValue(), "Moved “The Rust Programming Language - Ownership” to Dev");
  });

  await t.test("Undo takes it back out, and it stays out", async () => {
    await page.evaluate(() => document.getElementById("tav-toast").shadowRoot.querySelector("button").click());
    await waitForLayout(ff, (l) => l[rust] === null, "Undo");
    await page.reload({ waitUntil: "load" });
    await settle();
    assert.equal((await ff.command("layout"))[rust], null);
  });

  await t.test("a tab that loads in the background joins its group", async () => {
    const [rates] = await ff.openTabs([RATES], { background: true });
    await waitForLayout(ff, (l) => l[rates] === "News", "the interest rates tab to join News");
  });

  await t.test("a tab you take out of a group stays out", async () => {
    await ff.command("ungroup", dev[0]);
    await (await ff.show(dev[0])).reload({ waitUntil: "load" });
    await settle();
    assert.equal((await ff.command("layout"))[dev[0]], null);
  });

  let cycling;
  await t.test("a tab that matches no group gets a new one", async () => {
    const [jerseys] = await ff.openTabs([CYCLING[0]]);
    page = await ff.show(jerseys);
    const layout = await waitForLayout(ff, (l) => l[jerseys], "the jerseys tab to get a group");
    cycling = layout[jerseys];
    assert.ok(!["Dev", "News"].includes(cycling), `went into ${cycling}`);
    assert.match(await (await toastText()).jsonValue(), new RegExp(`to a new group, ${cycling}$`));
  });

  await t.test("the next similar tab joins that new group", async () => {
    const [bikes] = await ff.openTabs([CYCLING[1]], { background: true });
    await waitForLayout(ff, (l) => l[bikes] === cycling, `the bikes tab to join ${cycling}`);
  });

  await t.test("with new groups for lone tabs off, a tab waits for a similar one", async () => {
    await ff.command("set", { newGroupForLoneTabs: false });
    const [bread] = await ff.openTabs([BAKING[0]], { background: true });
    await settle();
    assert.equal((await ff.command("layout"))[bread], null);
    const [starter] = await ff.openTabs([BAKING[1]]);
    page = await ff.show(starter);
    const layout = await waitForLayout(ff, (l) => l[starter] && l[bread] === l[starter], "the baking tabs to be grouped");
    assert.match(await (await toastText()).jsonValue(), new RegExp(`and 1 similar tab as ${layout[bread]}$`));
  });

  await t.test("the flashing leaves group colours as they were", async () => {
    await sleep(2000); // A blink takes 1.8 s.
    const now = await ff.command("colours");
    assert.deepEqual({ Dev: now.Dev, News: now.News }, colours);
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
