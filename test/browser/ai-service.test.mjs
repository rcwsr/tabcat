// The user's own AI service in real Firefox, played by the test server: naming groups in
// automatic mode, then sorting into categories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { CATEGORY_TABS } from "../fixtures/tabs.mjs";
import { launch } from "./firefox.mjs";

const tab = (title) => CATEGORY_TABS.find((row) => row[1].startsWith(title)).slice(1, 3);
const TRIP = [
  ["Cheap flights London to Lisbon | Skyscanner", "www.skyscanner.net/routes/lond/lis/london-to-lisbon.html"],
  ["Hotels in Alfama, Lisbon - Booking.com", "www.booking.com/district/pt/lisbon/alfama.html", { description: "Book a hotel in Alfama, Lisbon's oldest district." }],
  ["THE 15 BEST Things to Do in Lisbon - Tripadvisor", "www.tripadvisor.co.uk/Attractions-g189158-Lisbon.html"],
];
const NEWS = ["Home - BBC News", "UK inflation falls", "Election results live"].map(tab);

const lastMessage = (request) => request.messages.at(-1).content;

async function waitForLayout(ff, check, what) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const layout = await ff.command("layout");
    if (check(layout)) return layout;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(layout)}`);
    await sleep(500);
  }
}

test("AI service", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const urls = await ff.openTabs([...TRIP, ...NEWS]);
  const trip = urls.slice(0, TRIP.length);
  const news = urls.slice(TRIP.length);
  ff.aiReply = (request) => (lastMessage(request).includes("Lisbon") ? '"Trip to Lisbon"' : "Headlines");
  const settings = { apiUrl: `${ff.origin}/v1`, apiKey: "sk-test", apiModel: "test-model" };
  const [run] = await ff.organise({ settings: { mode: "auto", nameWithAi: true, ...settings } });
  assert.equal(run.error, undefined);

  await t.test("names the groups", () => {
    t.diagnostic(JSON.stringify(run.layout));
    for (const url of trip) assert.equal(run.layout[url], "Trip to Lisbon");
    // Which news tabs go together is up to grouping on this computer.
    for (const url of news) assert.match(run.layout[url], /^Headlines( \d)?$/);
  });

  await t.test("with the model, key and page descriptions", () => {
    // One request per group.
    assert.equal(ff.aiRequests.length, new Set(Object.values(run.layout)).size);
    for (const request of ff.aiRequests) {
      assert.equal(request.model, "test-model");
      assert.equal(request.authorization, "Bearer sk-test");
    }
    assert.match(lastMessage(ff.aiRequests.find((r) => lastMessage(r).includes("Lisbon"))), /Lisbon's oldest district/);
  });

  await t.test("a group named from one page is named again when another joins", async () => {
    // Each line of tabs in the prompt starts "- ".
    const tabCount = (request) => lastMessage(request).split("\n").filter((l) => l.startsWith("- ")).length;
    ff.aiReply = (request) => (tabCount(request) === 1 ? "Personal Email" : "Email");
    const [personal] = await ff.openTabs([["Inbox - robincawser@gmail.com - Gmail", "mail.google.com/mail/u/0/"]]);
    await waitForLayout(ff, (l) => l[personal] === "Personal Email", "the inbox to get a group");
    const [work] = await ff.openTabs([["Inbox - robin@cwsr.dev - Cwsr.dev Mail", "mail.google.com/mail/u/1/"]]);
    await waitForLayout(ff, (l) => l[work] === "Email" && l[personal] === "Email", "the work inbox to join and the group to be renamed");
  });

  await t.test("sorts into categories", async () => {
    ff.aiRequests.length = 0;
    ff.aiReply = (request) => (/bbc|reuters|guardian/.test(lastMessage(request)) ? "News." : "none");
    await ff.command("set", { mode: "categories", provider: "ai" });
    const result = await ff.command("send", { type: "reorganise" });
    assert.equal(result.skippedBecause, "no category fits");
    const layout = await ff.command("layout");
    for (const url of news) assert.equal(layout[url], "News");
    for (const url of trip) assert.equal(layout[url], null);
    // Everything but the news, the inboxes included.
    const all = Object.keys(layout);
    assert.equal(result.skipped, all.length - news.length);
    assert.equal(ff.aiRequests.length, all.length);
    assert.match(ff.aiRequests[0].messages[0].content, /- dev: Programming/);
  });

  await t.test("an unreachable service is reported", async () => {
    await ff.command("set", { apiUrl: "http://127.0.0.1:9/v1" });
    await assert.rejects(ff.command("send", { type: "reorganise" }), /Can't reach the AI service at http:\/\/127\.0\.0\.1:9\/v1/);
  });

  await t.test("tab data isn't sent off this computer without permission", async () => {
    await ff.command("set", { apiUrl: "https://ai.example.com/v1" });
    await assert.rejects(ff.command("send", { type: "reorganise" }), /isn't allowed to send tab data/);
  });
});
