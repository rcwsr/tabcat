// Your categories on this computer, with the example categories, on labelled tabs: tabs
// should go into the right category or none, never the wrong one. Tabs that fit no category
// ("other") should stay out of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_CATEGORIES } from "../../extension/settings.js";
import { tabText } from "../../extension/cluster.js";
import { match } from "../../extension/plan.js";
import { CATEGORY_TABS } from "../fixtures/tabs.mjs";
import { embed } from "./embed.mjs";
import { browse, categoryScores, threshold, tidy, windowOf } from "./simulate.mjs";

// Measured: Tidy 25 right, as you browse 24 (of 42), none wrong and no intruders. The rest
// go into groups of their own; an AI service puts most of them in their category.
for (const [name, run] of [["Tidy", tidy], ["as you browse", browse]]) {
  test(`categories: ${name}`, async (t) => {
    const win = await windowOf(CATEGORY_TABS, EXAMPLE_CATEGORIES);
    await run(win);
    const { right, wrong, intruders } = categoryScores(win);
    t.diagnostic(`${right} right, ${wrong} wrong, ${intruders} intruders`);
    assert.ok(right >= 21, `only ${right} right`);
    assert.ok(wrong <= 1, `${wrong} wrong`);
    assert.ok(intruders <= 1, `${intruders} intruders`);
  });
}

// A brand's shop whose title doesn't say "shop". Went to "other" until the shopping
// description mentioned brands and clothing.
test("categories: a clothing brand's shop is Shopping", async () => {
  const url = "https://rapha.cc/gb/en";
  const title = "The World's Finest Cycling Clothing and Accessories | Rapha";
  const tabs = [{ title, url, text: tabText(title, url) }];
  const entries = Object.entries(EXAMPLE_CATEGORIES);
  const [vector, ...categoryVectors] = await embed([tabs[0].text, ...entries.map(([, about]) => about)]);
  const targets = entries.map(([title, about], i) => ({ title, about, vector: categoryVectors[i], members: [] }));
  const { joins } = match(tabs, [vector], targets, [0], threshold);
  assert.deepEqual([...joins].map(([t]) => targets[t].title), ["Shopping"]);
});
