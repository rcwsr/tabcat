// Automatic grouping in real Firefox: bundled models, real tab groups, a group the user
// already made, and a second run that should change nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPING_HELDOUT } from "../fixtures/tabs.mjs";
import { launch } from "./firefox.mjs";

const TRIP = [
  ["trip", "Cheap flights London to Lisbon | Skyscanner", "www.skyscanner.net/routes/lond/lis/london-to-lisbon.html"],
  ["trip", "Hotels in Alfama, Lisbon - Booking.com", "www.booking.com/district/pt/lisbon/alfama.html"],
  ["trip", "THE 15 BEST Things to Do in Lisbon - Tripadvisor", "www.tripadvisor.co.uk/Attractions-g189158-Lisbon.html"],
];
const TABS = [...TRIP, ...GROUPING_HELDOUT];

test("automatic grouping in Firefox", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const urls = await ff.openTabs(TABS.map(([, title, url]) => [title, url]));
  const labelOf = Object.fromEntries(urls.map((u, i) => [u, TABS[i][0]]));

  // The user has already grouped two of the trip tabs.
  const [first, second] = await ff.organise({
    settings: { mode: "auto" },
    groups: [{ title: "My trip", urls: urls.slice(0, 2) }],
    runs: 2,
    toolbar: true,
  });
  assert.equal(first.error, undefined);

  const groups = {};
  for (const [url, title] of Object.entries(first.layout)) if (title) (groups[title] ??= []).push(labelOf[url]);
  t.diagnostic(JSON.stringify(groups));

  await t.test("the user's group keeps its tabs and takes in the matching one", () => {
    assert.deepEqual(groups["My trip"], ["trip", "trip", "trip"]);
  });

  await t.test("new groups are mostly one topic each", () => {
    const made = Object.entries(groups).filter(([title]) => title !== "My trip");
    assert.ok(made.length >= 5, `only ${made.length} groups`);
    for (const [title, labels] of made) {
      const top = Math.max(...labels.map((l) => labels.filter((m) => m === l).length));
      assert.ok(top / labels.length >= 2 / 3, `"${title}" is mixed: ${labels}`);
    }
  });

  await t.test("one-off tabs are left alone", () => {
    const grouped = Object.entries(first.layout).filter(([url, title]) => title && labelOf[url] === "solo");
    assert.ok(grouped.length <= 1, `${grouped.length} one-off tabs grouped`);
  });

  await t.test("group names are clean", () => {
    for (const title of Object.keys(groups)) {
      assert.ok(title && title !== "Tabs", `placeholder name "${title}"`);
      assert.doesNotMatch(title, /(^|\s)(\p{L}+)\s+\2(\s|$)/iu, `stutter in "${title}"`);
    }
  });

  await t.test("the toolbar button shows what happened", () => {
    assert.equal(first.badge, String(first.result.organised));
    assert.match(first.tooltip, /^Tav: grouped .*My trip 1/);
  });

  await t.test("a second run changes nothing", () => {
    assert.equal(second.error, undefined);
    assert.equal(second.result.organised, 0);
    assert.deepEqual(second.layout, first.layout);
    assert.equal(second.badge, "✓");
  });
});
