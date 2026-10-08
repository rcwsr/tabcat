// Measures how well tabs are grouped, and what it costs, for each way Tabcat can work:
// on this computer only, and with an AI service naming groups and placing the tabs this
// computer can't; plus an AI service doing all the grouping (a reference, not something
// Tabcat does). Runs the extension's own planning code (extension/plan.js) on the labelled
// tabs in test/fixtures/tabs.mjs, with the embedding model in Node.
//
//   npm run eval                       on this computer only
//   AI_URL=http://localhost:1234/v1 AI_MODEL=google/gemma-4-e4b npm run eval
//   AI_KEY for services that need one, VERBOSE=1 to list the groups, and a word to run
//   only the scenarios with it in their name (npm run eval -- categories).
//
// The labelled sets are small (24, 24 and 48 tabs), so read the numbers as signals. With a
// temperature above 0, a service answers differently each time: RUNS=3 averages three runs.
import { EXAMPLE_CATEGORIES } from "../extension/settings.js";
import { chat, namingMessages, parseNames } from "../extension/ai-service.js";
import { CATEGORY_TABS, GROUPING_HELDOUT, GROUPING_TRAIN } from "../test/fixtures/tabs.mjs";
import { browse, categoryScores, describeGroups, pairScores, threshold, tidy, windowOf } from "../test/model/simulate.mjs";

// ai-service.js asks Firefox before sending tab data off this computer.
globalThis.browser = { permissions: { contains: async () => true } };

// Tabcat asks for temperature 0 (see chat()); TEMPERATURE=1, say, shows how much a service's
// answers vary at another.
if (process.env.TEMPERATURE) {
  const { fetch } = globalThis;
  globalThis.fetch = (url, init) => fetch(url, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), temperature: Number(process.env.TEMPERATURE) }) });
}

const ai = process.env.AI_URL && { apiUrl: process.env.AI_URL, apiKey: process.env.AI_KEY ?? "", apiModel: process.env.AI_MODEL };

// Requests and tokens, per configuration.
let spent;
const spend = (usage) => {
  spent.requests++;
  spent.input += usage.input;
  spent.output += usage.output;
};

async function nameWithAi(tabs, offered) {
  const { text, usage } = await chat(ai, namingMessages(tabs, offered));
  spend(usage);
  return parseNames(text, tabs.length);
}

// The reference: the AI service sorts every tab itself, in one request.
async function aiOnly(win) {
  const lines = win.tabs.map((t, i) => `${i + 1}. ${t.title} (${new URL(t.url).hostname})`).join("\n");
  const categories = win.targets.filter((t) => t.about).map((t) => `- ${t.title}: ${t.about}`).join("\n");
  const system =
    "You sort browser tabs into groups. Reply with one line per tab, like `1: Trip to Lisbon`, giving the name of " +
    "the group it belongs in: one to three words, title case. Tabs about the same thing get the same name. " +
    (categories ? `Use one of these when it fits:\n${categories}\n` : "") +
    "A tab like nothing else gets the name `none`.";
  const { text, usage } = await chat(ai, [{ role: "system", content: system }, { role: "user", content: lines }]);
  spend(usage);
  const names = parseNames(text, win.tabs.length);
  for (const [name, ix] of Map.groupBy(win.tabs.keys(), (i) => names[i].toLowerCase())) {
    if (!name || name === "none") continue;
    const target = win.targets.find((t) => t.title.toLowerCase() === name);
    if (target) target.members.push(...ix);
    else win.targets.push({ title: name, members: ix });
  }
}

const RUNS = Number(process.env.RUNS ?? 1);
const CONFIGS = [
  { name: "on this computer", run: (scenario, win) => scenario.run(win) },
  ai && { name: "+ AI service", run: (scenario, win) => scenario.run(win, nameWithAi), runs: RUNS },
  ai && { name: "AI does it all", run: (scenario, win) => scenario.run === tidy && aiOnly(win), runs: RUNS },
].filter(Boolean);

const SCENARIOS = [
  { name: "Tidy, training tabs", rows: GROUPING_TRAIN, categories: {}, run: tidy },
  { name: "Tidy, held-out tabs", rows: GROUPING_HELDOUT, categories: {}, run: tidy },
  { name: "Tidy, categories", rows: CATEGORY_TABS, categories: EXAMPLE_CATEGORIES, run: tidy },
  { name: "As you browse, held-out tabs", rows: GROUPING_HELDOUT, categories: {}, run: browse },
  { name: "As you browse, categories", rows: CATEGORY_TABS, categories: EXAMPLE_CATEGORIES, run: browse },
];

// One run of a configuration on a scenario: its scores and costs, or nothing if it doesn't
// apply (the reference only sorts a whole window).
async function measure(scenario, config) {
  const win = await windowOf(scenario.rows, scenario.categories);
  spent = { requests: 0, input: 0, output: 0 };
  const start = performance.now();
  if ((await config.run(scenario, win)) === false) return null;
  const row = pairScores(win);
  if (Object.keys(scenario.categories).length) Object.assign(row, categoryScores(win));
  Object.assign(row, { groups: win.targets.filter((t) => t.members.length).length, ...spent, seconds: (performance.now() - start) / 1000 });
  if (process.env.VERBOSE) for (const line of describeGroups(win)) console.log(`  ${line}`);
  return row;
}

const average = (rows) => Object.fromEntries(Object.keys(rows[0]).map((k) => [k, +(rows.reduce((sum, r) => sum + r[k], 0) / rows.length).toFixed(2)]));

const only = process.argv[2];
for (const scenario of SCENARIOS.filter((s) => !only || s.name.toLowerCase().includes(only.toLowerCase()))) {
  const rows = [];
  for (const config of CONFIGS) {
    const runs = [];
    try {
      for (let n = 0; n < (config.runs ?? 1); n++) runs.push(await measure(scenario, config));
    } catch (err) {
      rows.push({ config: config.name, error: err.message });
      continue;
    }
    if (runs[0]) rows.push({ config: config.name, ...average(runs) });
  }
  console.log(`\n${scenario.name} (${scenario.rows.length} tabs, threshold ${threshold})`);
  console.table(rows);
}
