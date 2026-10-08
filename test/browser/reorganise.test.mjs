// Reorganise in real Firefox: every group, the user's included, broken up and sorted again,
// and its Undo putting the old groups back as they were.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORY_TABS } from "../fixtures/tabs.mjs";
import { launch } from "./firefox.mjs";

const tab = (title) => CATEGORY_TABS.find((row) => row[1].startsWith(title)).slice(1, 3);
const DEV = ["Array.prototype.map()", "python - How do I merge", "Issue #482", "tokio - crates.io"].map(tab);
const NEWS = ["Home - BBC News", "UK inflation falls", "Election results live"].map(tab);

test("reorganise and undo", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const urls = await ff.openTabs([...DEV, ...NEWS]);
  const dev = urls.slice(0, DEV.length);
  const news = urls.slice(DEV.length);
  // The user's own groups, each a mix of topics, and a tab they took out of a group.
  await ff.organise({
    settings: {},
    groups: [
      { title: "Mixed", urls: [dev[0], dev[1], news[0]] },
      { title: "My stuff", urls: [news[1], dev[2]] },
      { title: "Spare", urls: [news[2]] },
    ],
    runs: 0,
  });
  await ff.command("ungroup", news[2]);
  const before = {
    layout: await ff.command("layout"),
    order: await ff.command("order"),
    colours: await ff.command("colours"),
    leftAlone: (await ff.command("session")).leftAlone,
  };
  assert.equal(before.leftAlone.length, 1);

  await t.test("if sorting fails, the groups are put back", async () => {
    await ff.command("breakGrouping");
    await assert.rejects(ff.command("send", { type: "reorganise" }), /couldn't make the group/);
    assert.deepEqual(await ff.command("layout"), before.layout);
    assert.deepEqual(await ff.command("order"), before.order);
    assert.deepEqual(await ff.command("colours"), before.colours);
    assert.deepEqual((await ff.command("session")).leftAlone, before.leftAlone);
    assert.equal(await ff.command("send", { type: "canUndoReorganise" }), false);
  });

  await t.test("breaks up every group and sorts all the tabs", async () => {
    const result = await ff.command("send", { type: "reorganise" });
    assert.equal(result.canUndo, true);
    const layout = await ff.command("layout");
    t.diagnostic(JSON.stringify(layout));
    const titles = new Set(Object.values(layout));
    for (const old of ["Mixed", "My stuff"]) assert.ok(!titles.has(old), `${old} is still there`);
    // New groups by topic: none mixes dev and news tabs any more.
    const groups = Map.groupBy(urls.filter((u) => layout[u]), (u) => layout[u]);
    assert.ok(groups.size >= 2, "fewer than two groups");
    for (const [title, members] of groups) {
      assert.ok(members.every((u) => dev.includes(u)) || members.every((u) => news.includes(u)), `${title} mixes topics`);
    }
    // The tab taken out of a group is sorted too.
    assert.ok(layout[news[2]] === null || groups.get(layout[news[2]]).length > 1);
    assert.deepEqual((await ff.command("session")).leftAlone, []);
    assert.equal(await ff.command("send", { type: "canUndoReorganise" }), true);
  });

  await t.test("Undo puts the old groups back", async () => {
    assert.deepEqual(await ff.command("send", { type: "undoReorganise" }), { restored: true });
    assert.deepEqual(await ff.command("layout"), before.layout);
    assert.deepEqual(await ff.command("order"), before.order);
    assert.deepEqual(await ff.command("colours"), before.colours);
    // The tab taken out of a group is still to be left alone.
    assert.deepEqual((await ff.command("session")).leftAlone, before.leftAlone);
    assert.equal(await ff.command("send", { type: "canUndoReorganise" }), false);
    assert.deepEqual(await ff.command("send", { type: "undoReorganise" }), { restored: false });
  });
});
