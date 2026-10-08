// Your own AI service in real Firefox, played by the test server: naming groups, renaming
// one that grows, putting tabs in your categories, what it costs, and what happens when it
// can't be used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLE_CATEGORIES } from "../../extension/settings.js";
import { CATEGORY_TABS } from "../fixtures/tabs.mjs";
import { launch, perTab } from "./firefox.mjs";

const tab = (title) => CATEGORY_TABS.find((row) => row[1].startsWith(title)).slice(1, 3);
const TRIP = [
  ["Cheap flights London to Lisbon | Skyscanner", "www.skyscanner.net/routes/lond/lis/london-to-lisbon.html"],
  ["Hotels in Alfama, Lisbon - Booking.com", "www.booking.com/district/pt/lisbon/alfama.html"],
  ["THE 15 BEST Things to Do in Lisbon - Tripadvisor", "www.tripadvisor.co.uk/Attractions-g189158-Lisbon.html"],
];
const NEWS = ["UK inflation falls", "Election results live", "Storm warning"].map(tab);

// What the pretend service calls each tab.
const names = perTab((line) => {
  if (line.includes("Lisbon")) return "Trip to Lisbon";
  if (/bbc|guardian|reuters|sky/.test(line)) return "News";
  if (line.includes("Inbox")) return "Email";
  return "Something Else";
});

test("AI service", { timeout: 300_000 }, async (t) => {
  const ff = await launch();
  t.after(() => ff.close());
  const urls = await ff.openTabs([...TRIP, ...NEWS]);
  const trip = urls.slice(0, TRIP.length);
  const news = urls.slice(TRIP.length);
  ff.aiReply = names;
  const service = { useAi: true, apiUrl: `${ff.origin}/v1`, apiKey: "sk-test", apiModel: "test-model" };
  const [run] = await ff.organise({ settings: { ...service, markGroups: false } });
  assert.equal(run.error, undefined);

  await t.test("names the groups, all in one request", () => {
    t.diagnostic(JSON.stringify(run.layout));
    for (const url of trip) assert.equal(run.layout[url], "Trip to Lisbon");
    for (const url of news) assert.equal(run.layout[url], "News");
    assert.equal(ff.aiRequests.length, 1);
    const [request] = ff.aiRequests;
    assert.equal(request.model, "test-model");
    assert.equal(request.authorization, "Bearer sk-test");
    assert.match(request.messages[0].content, /one line per tab/);
    assert.equal(run.result.warning, undefined);
  });

  await t.test("counts what it costs", async () => {
    const { aiUsage } = await ff.command("local");
    assert.deepEqual({ ...aiUsage, since: typeof aiUsage.since }, { requests: 1, input: 100, output: 10, since: "number" });
  });

  await t.test("a group named after one page is named again when another joins", async () => {
    ff.aiRequests.length = 0;
    // A single page with nowhere to go is named after its site, without asking.
    const [personal] = await ff.openTabs([["Inbox - sam.jones@gmail.com - Gmail", "mail.google.com/mail/u/0/", { "og:site_name": "Gmail" }]]);
    await ff.waitForLayout((l) => l[personal] === "Gmail", "the inbox to get a group named after its site");
    assert.equal(ff.aiRequests.length, 0);
    const [work] = await ff.openTabs([["Inbox (3) - sam@example.com - Gmail", "mail.google.com/mail/u/1/"]], { background: true });
    await ff.waitForLayout((l) => l[work] === "Email" && l[personal] === "Email", "the second inbox to join and the group to be renamed");
  });

  await t.test("puts tabs in your categories", async () => {
    ff.aiRequests.length = 0;
    await ff.command("set", { categories: { News: EXAMPLE_CATEGORIES.News, Dev: EXAMPLE_CATEGORIES.Dev } });
    const result = await ff.command("send", { type: "reorganise" });
    assert.equal(result.warning, undefined);
    const layout = await ff.command("layout");
    for (const url of news) assert.equal(layout[url], "News");
    for (const url of trip) assert.equal(layout[url], "Trip to Lisbon");
    // Your categories are offered with what belongs in them.
    assert.ok(ff.aiRequests.length >= 1);
    for (const request of ff.aiRequests) assert.match(request.messages[0].content, /\n- News: News sites, articles and current affairs/);
  });

  await t.test("a tab that loads while Reorganise waits for the service is placed after it", async () => {
    ff.aiRequests.length = 0;
    // The first request takes longer than a tab takes to load and settle.
    ff.aiReply = (request) => new Promise((resolve) => setTimeout(() => resolve(names(request)), 6000));
    const reorganised = ff.command("send", { type: "reorganise" });
    while (!ff.aiRequests.length) await new Promise((resolve) => setTimeout(resolve, 50));
    ff.aiReply = names;
    const [late] = await ff.openTabs([["Markets rally as rates hold - Reuters", "www.reuters.com/markets/rates-hold"]], { background: true });
    assert.equal((await reorganised).warning, undefined);
    await ff.waitForLayout((l) => l[late] === "News", "the tab to be placed after Reorganise");
  });

  await t.test("if it can't be reached, this computer does it all and says why", async () => {
    await ff.command("set", { apiUrl: "http://127.0.0.1:9/v1" });
    const result = await ff.command("send", { type: "reorganise" });
    assert.match(result.warning, /Can't reach the AI service at http:\/\/127\.0\.0\.1:9\/v1/);
    assert.ok(Object.values(await ff.command("layout")).filter(Boolean).length >= 3, "tabs weren't grouped");
    assert.match((await ff.command("session")).aiWarning, /Can't reach/);
  });

  await t.test("tab data isn't sent off this computer without permission", async () => {
    ff.aiRequests.length = 0;
    await ff.command("set", { apiUrl: "https://ai.example.com/v1" });
    const result = await ff.command("send", { type: "reorganise" });
    assert.match(result.warning, /isn't allowed to send tab data/);
    assert.equal(ff.aiRequests.length, 0);
  });
});
