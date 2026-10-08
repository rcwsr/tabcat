// Your categories in real Firefox, on this computer: tabs going into the right category or
// a group of their own, a group named like a category being that category, and your own
// groups left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_CATEGORIES } from "../../extension/settings.js";
import { CATEGORY_TABS } from "../fixtures/tabs.mjs";
import { launch } from "./firefox.mjs";

const CATEGORY = Object.fromEntries(Object.keys(EXAMPLE_CATEGORIES).map((name) => [name.toLowerCase(), name]));

test("categories in Firefox", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const urls = await ff.openTabs(CATEGORY_TABS.map(([, title, url]) => [title, url]));
  const [first, second] = await ff.organise({ settings: { categories: EXAMPLE_CATEGORIES }, runs: 2 });
  assert.equal(first.error, undefined);

  await t.test("tabs go into their category or a group of their own, not the wrong category", () => {
    const inCategory = urls.filter((u) => Object.values(CATEGORY).includes(first.layout[u]));
    const right = inCategory.filter((u) => first.layout[u] === CATEGORY[CATEGORY_TABS[urls.indexOf(u)][0]]);
    t.diagnostic(`${inCategory.length} in a category, ${right.length} right`);
    // Measured in Node: 25 right, none wrong.
    assert.ok(right.length >= 21, `only ${right.length} right`);
    assert.ok(inCategory.length - right.length <= 1, `${inCategory.length - right.length} in the wrong category`);
    assert.ok(urls.every((u) => first.layout[u]), "a tab wasn't grouped");
  });

  await t.test("a second run changes nothing", () => {
    assert.equal(second.error, undefined);
    assert.deepEqual(second.layout, first.layout);
  });
});

test("a group named like a category is that category, and your own groups are left alone", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const tabs = CATEGORY_TABS.filter(([label]) => label === "dev" || label === "news");
  const urls = await ff.openTabs(tabs.map(([, title, url]) => [title, url]));
  const news = urls.filter((_, i) => tabs[i][0] === "news");
  // A group of your own with a dev and a news tab, and a "news" group with one news tab.
  const mine = [urls[0], news[0]];
  const [run] = await ff.organise({
    settings: { categories: { News: EXAMPLE_CATEGORIES.News } },
    groups: [
      { title: "Reading list", urls: mine },
      { title: "news", urls: [news[1]] },
    ],
  });
  assert.equal(run.error, undefined);
  t.diagnostic(JSON.stringify(run.layout));
  for (const url of mine) assert.equal(run.layout[url], "Reading list", `${url} left your group`);
  // The other news tabs join the group you made, rather than a second one.
  for (const url of news.slice(1)) assert.match(run.layout[url], /^news$/);
});
