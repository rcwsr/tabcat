// Grouping as you browse in real Firefox: tabs joining or starting groups as they load,
// finding them again (the message's Show, the popup's Show and Back, the mark on the group,
// the toolbar badge), Undo, tabs you take out of a group staying out, and A–Z order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { EXAMPLE_CATEGORIES } from "../../extension/settings.js";
import { CATEGORY_TABS } from "../fixtures/tabs.mjs";
import { launch } from "./firefox.mjs";

const tab = (title) => CATEGORY_TABS.find((row) => row[1].startsWith(title)).slice(1, 3);
const DEV = ["Array.prototype.map()", "python - How do I merge", "Issue #482", "tokio - crates.io"].map(tab);
const NEWS = ["Home - BBC News", "UK inflation falls", "Election results live"].map(tab);
const RUST = tab("The Rust Programming Language");
const STORM = tab("Storm warning");
const CYCLING = [
  ["Men's Cycling Jerseys | Castelli", "www.castelli-cycling.com/GB/en/men/jerseys", { "og:site_name": "Castelli" }],
  ["Road Bikes | Canyon GB", "www.canyon.com/en-gb/road-bikes/"],
];
const BAKING = [
  ["Easy sourdough bread recipe - BBC Good Food", "www.bbcgoodfood.com/recipes/sourdough-bread"],
  ["How to make a sourdough starter | King Arthur Baking", "www.kingarthurbaking.com/recipes/sourdough-starter"],
];
// Groups are by topic: this one matches the inflation and election stories.
const RATES = ["Bank of England holds interest rates as inflation eases - BBC News", "www.bbc.co.uk/news/business-68412345"];

// Long enough for Tabcat to have acted if it was going to (it waits 2 s after a page loads).
const settle = () => sleep(3000);

// The message on a page: { text, buttons } once it's showing.
async function toastOn(page) {
  await page.waitForFunction(() => document.getElementById("tabcat-toast")?.shadowRoot.querySelector(".text")?.textContent);
  return page.evaluate(() => {
    const root = document.getElementById("tabcat-toast").shadowRoot;
    return { text: root.querySelector(".text").textContent, buttons: [...root.querySelectorAll("button")].map((b) => b.textContent) };
  });
}

const click = (page, label) =>
  page.evaluate((label) => {
    const buttons = [...document.getElementById("tabcat-toast").shadowRoot.querySelectorAll("button")];
    buttons.find((b) => b.textContent === label).click();
  }, label);

// Show on the message, on the tab you're on: its group opens, and you stay on it. Firefox
// scrolls the tab bar to the tab you're on when that tab moves (headless Firefox can't show
// that), so Show moves it and puts it straight back.
async function showHere(ff, page, url, group) {
  assert.equal((await ff.command("collapse", group))[group], true);
  const order = await ff.command("order");
  await ff.command("moved");
  await click(page, "Show");
  const moves = [];
  const deadline = Date.now() + 5000;
  while (moves.length < 2 && Date.now() < deadline) {
    moves.push(...(await ff.command("moved")));
    await sleep(100);
  }
  await sleep(500);
  moves.push(...(await ff.command("moved")));
  assert.ok(moves.length >= 2, "the tab didn't move");
  assert.ok(moves.some(([u]) => u === url), `moved ${JSON.stringify(moves)}`);
  assert.deepEqual(await ff.command("order"), order);
  assert.equal((await ff.command("collapse"))[group], false);
  assert.equal(await ff.command("active"), url);
}

test("grouping as you browse", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const urls = await ff.openTabs([...DEV, ...NEWS]);
  const dev = urls.slice(0, DEV.length);
  const news = urls.slice(DEV.length);
  await ff.organise({
    // On by default: grouping as you browse, new groups for lone tabs, the message and marks.
    settings: { markGroups: false },
    groups: [
      { title: "Dev", urls: dev },
      { title: "News", urls: news },
    ],
    runs: 0,
  });
  const colours = await ff.command("colours");
  let rust, page;

  await t.test("a tab you open joins its group once it loads, with a message saying so", async () => {
    [rust] = await ff.openTabs([RUST]);
    page = await ff.show(rust);
    await ff.waitForLayout((l) => l[rust] === "Dev", "the Rust tab to join Dev");
    assert.deepEqual(await toastOn(page), { text: "Moved “The Rust Programming Language - Ownership” to Dev", buttons: ["Show", "Undo"] });
  });

  await t.test("Undo takes it back out, and it stays out", async () => {
    await click(page, "Undo");
    await ff.waitForLayout((l) => l[rust] === null, "Undo");
    await page.reload({ waitUntil: "load" });
    await settle();
    assert.equal((await ff.command("layout"))[rust], null);
  });

  let rates;
  await t.test("a tab that loads in the background joins its group, counted on the toolbar button", async () => {
    [rates] = await ff.openTabs([RATES], { background: true });
    await ff.waitForLayout((l) => l[rates] === "News", "the interest rates tab to join News");
    // That's set just after the tab is grouped, so wait for it.
    const deadline = Date.now() + 10_000;
    let badge;
    while ((badge = await ff.command("badge")) !== "1" && Date.now() < deadline) await sleep(200);
    assert.equal(badge, "1");
    // The message is only for the tab you're on.
    assert.equal(await page.evaluate(() => Boolean(document.getElementById("tabcat-toast"))), false);
  });

  await t.test("Show in the popup goes to it, and Back on that tab goes back", async () => {
    const [move] = (await ff.command("session")).moves;
    assert.match(move.message, /^Moved “Bank of England holds interest rates/);
    assert.equal(await ff.command("send", { type: "show", moveId: move.id }), true);
    assert.equal(await ff.command("active"), rates);
    const there = ff.page(rates);
    assert.deepEqual(await toastOn(there), { text: "This is the tab Tabcat moved to News", buttons: ["Back"] });
    await click(there, "Back");
    const deadline = Date.now() + 5000;
    while ((await ff.command("active")) !== rust && Date.now() < deadline) await sleep(100);
    assert.equal(await ff.command("active"), rust);
  });

  let storm;
  await t.test("the group a tab went to is marked until you go to it", async () => {
    await ff.command("set", { markGroups: true });
    [storm] = await ff.openTabs([STORM], { background: true });
    const marked = (await ff.waitForLayout((l) => l[storm]?.startsWith("● "), "the storm tab's group to be marked"))[storm];
    await ff.show(storm);
    await ff.waitForLayout((l) => l[storm] === marked.slice(2), "the mark to go");
    await ff.show(rust);
    await ff.command("set", { markGroups: false });
  });

  await t.test("the keyboard shortcut goes to the last tab moved", async () => {
    assert.equal(await ff.command("send", { type: "show" }), true);
    assert.equal(await ff.command("active"), storm);
    await ff.show(rust);
  });

  await t.test("a tab you take out of a group stays out", async () => {
    await ff.command("ungroup", dev[0]);
    await (await ff.show(dev[0])).reload({ waitUntil: "load" });
    await settle();
    assert.equal((await ff.command("layout"))[dev[0]], null);
  });

  let jerseys;
  await t.test("a tab that matches no group gets a new one, named after its site", async () => {
    [jerseys] = await ff.openTabs([CYCLING[0]]);
    page = await ff.show(jerseys);
    const layout = await ff.waitForLayout((l) => l[jerseys], "the jerseys tab to get a group");
    assert.equal(layout[jerseys], "Castelli");
    assert.match((await toastOn(page)).text, /to a new group, Castelli$/);
  });

  await t.test("Show on the message points out a tab in a group of its own", async () => {
    await showHere(ff, page, jerseys, "Castelli");
  });

  await t.test("the next similar tab joins that new group, which is named again", async () => {
    const [bikes] = await ff.openTabs([CYCLING[1]], { background: true });
    // The new name comes a moment after the move.
    const joined = (l) => l[bikes] && l[bikes] === l[jerseys] && l[bikes] !== "Castelli";
    const cycling = (await ff.waitForLayout(joined, "the bikes tab to join the jerseys tab, and a new name"))[bikes];
    t.diagnostic(cycling);
    assert.ok(!["Dev", "News"].includes(cycling), `went into ${cycling}`);
  });

  await t.test("with new groups for lone tabs off, a tab waits for a similar one", async () => {
    await ff.command("set", { newGroupForLoneTabs: false });
    const [bread] = await ff.openTabs([BAKING[0]], { background: true });
    await settle();
    assert.equal((await ff.command("layout"))[bread], null);
    const [starter] = await ff.openTabs([BAKING[1]]);
    page = await ff.show(starter);
    const layout = await ff.waitForLayout((l) => l[starter] && l[bread] === l[starter], "the baking tabs to be grouped");
    assert.match((await toastOn(page)).text, new RegExp(`and 1 similar tab as ${layout[bread]}$`));
    await showHere(ff, page, starter, layout[starter]);
  });

  await t.test("with A–Z order, a tab joins its group in order, and moves when its title changes", async () => {
    await ff.command("set", { tabOrder: "title" });
    const devOrder = async () => {
      const [layout, order] = [await ff.command("layout"), await ff.command("order")];
      return order.filter((u) => layout[u] === "Dev");
    };
    // Sorts between the Stack Overflow question and tokio.
    const ERRORS = ["The Rust Programming Language - Error Handling", "doc.rust-lang.org/book/ch09-00-error-handling.html"];
    const titleOf = Object.fromEntries([...DEV, ERRORS].map(([title, url]) => [new URL(`http://${url}`).href, title]));
    const inOrder = (members) => members.every((u, i) => i === 0 || titleOf[members[i - 1]].localeCompare(titleOf[u]) <= 0);
    // dev[0] was taken out, so Dev has three tabs, sorted when A–Z was chosen.
    const deadline = Date.now() + 10_000;
    while (!inOrder(await devOrder()) && Date.now() < deadline) await sleep(200);
    assert.ok(inOrder(await devOrder()), "Dev isn't in order");
    const [errors] = await ff.openTabs([ERRORS], { background: true });
    await ff.waitForLayout((l) => l[errors] === "Dev", "the Rust book page to join Dev");
    assert.ok(inOrder(await devOrder()), "the new tab isn't in order");
    // A tab in the group goes to another page, whose title sorts first.
    const [first, ...rest] = await devOrder();
    const last = rest.at(-1);
    const moved = await ff.navigate(last, ["AAA guide to async Rust", "tokio.rs/tokio/tutorial"]);
    titleOf[moved] = "AAA guide to async Rust";
    await ff.waitForLayout((l) => l[moved] === "Dev", "the tab to stay in Dev");
    const until = Date.now() + 10_000;
    while ((await devOrder())[0] !== moved && Date.now() < until) await sleep(200);
    assert.deepEqual((await devOrder()).slice(0, 2), [moved, first]);
    await ff.command("set", { tabOrder: "added" });
  });

  await t.test("the flashing leaves group colours as they were", async () => {
    await sleep(2000); // A blink takes 1.8 s.
    const now = await ff.command("colours");
    assert.deepEqual({ Dev: now.Dev, News: now.News }, colours);
    // Showing a tab twice in quick succession blinks its group once.
    await ff.command("send", { type: "show" });
    await ff.command("send", { type: "show" });
    await sleep(2000);
    assert.deepEqual(await ff.command("colours"), now);
  });
});

test("grouping as you browse into a category, with website access turned off", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  await ff.openTabs([NEWS[0]]);
  await ff.organise({ settings: { categories: { News: EXAMPLE_CATEGORIES.News } }, runs: 0 });
  // Website access is granted at install; here it's been turned off in about:addons.
  assert.equal(await ff.command("allSites"), true);
  assert.equal(await ff.command("allSites", false), false);

  const [storm] = await ff.openTabs([STORM]);
  await ff.show(storm);
  await ff.waitForLayout((l) => /^(● )?News$/.test(l[storm] ?? ""), "a News group for the storm tab");
  // The message couldn't be shown on the tab, so the move is counted on the toolbar button.
  // That's set just after the tab is grouped, so wait for it.
  const deadline = Date.now() + 10_000;
  let badge;
  while ((badge = await ff.command("badge")) !== "1" && Date.now() < deadline) await sleep(200);
  assert.equal(badge, "1");
  // Opening the popup clears it.
  await ff.command("send", { type: "seen" });
  assert.equal(await ff.command("badge"), "");
});

// A home page titled with just the site's name ("YouTube") scores close to anything: it
// joined a group of two copies of bighelp.app's quick start. Its description is used
// when it can be read; when it can't, such a tab only joins tabs from the same site.
const BIGHELP = [
  ["Quick start: Feed, Ideas and Goals · bighelp", "bighelp.app/quick-start"],
  ["Quick start: Feed, Ideas and Goals · bighelp", "bighelp.app/quick-start?again"],
];
const YOUTUBE_META = {
  description: "Enjoy the videos and music that you love, upload original content and share it all with friends, family and the world on YouTube.",
  keywords: "video, sharing, camera phone, video phone, free, upload",
};

test("a home page with a bare title isn't pulled into an unrelated group", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const bighelp = await ff.openTabs(BIGHELP);
  await ff.organise({ settings: { markGroups: false }, groups: [{ title: "Bighelp", urls: bighelp }], runs: 0 });
  let youtube;

  await t.test("without a description, it only joins tabs from the same site", async () => {
    [youtube] = await ff.openTabs([["YouTube", "www.youtube.com/?no-description"]], { background: true });
    // A group of its own (newGroupForLoneTabs is on by default), not Bighelp.
    const layout = await ff.waitForLayout((l) => l[youtube], "the YouTube tab to get a group");
    assert.notEqual(layout[youtube], "Bighelp");
  });

  await t.test("with the page's description", async () => {
    await ff.command("ungroup", youtube); // Now only Bighelp is left.
    const [described] = await ff.openTabs([["YouTube", "www.youtube.com/", YOUTUBE_META]], { background: true });
    const layout = await ff.waitForLayout((l) => l[described], "the described YouTube tab to get a group");
    assert.notEqual(layout[described], "Bighelp");
  });
});
