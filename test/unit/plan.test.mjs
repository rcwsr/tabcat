// Deciding where tabs go (plan.js), with made-up vectors and a pretend AI service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TABS_PER_CLUSTER, TABS_PER_REQUEST, closeness, cluster, commonest, match, nearTargets, place } from "../../extension/plan.js";

const DIM = 32;
const unit = (v) => {
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};
// A unit vector along axis k, nudged towards axis k + 1: tabs on the same axis are alike
// (similarity above 0.9), tabs two or more axes apart have nothing in common.
const along = (k, nudge = 0) => unit(Array.from({ length: DIM }, (_, d) => (d === k ? 1 : d === k + 1 ? nudge : 0)));
const tab = (title, url) => ({ title, url, text: title });

// A window: a Rust group (tab 0) and four loose tabs: one about Rust, two about a trip to
// Lisbon and a recipe.
function window() {
  const tabs = [
    tab("Rust ownership and borrowing explained", "https://doc.rust-lang.org/book/ch04.html"),
    tab("Tokio async runtime for Rust", "https://crates.io/crates/tokio"),
    tab("Cheap flights London to Lisbon", "https://www.skyscanner.net/lis"),
    tab("Hotels in the Alfama district of Lisbon", "https://www.booking.com/alfama"),
    tab("Easy chicken tikka masala recipe", "https://www.bbcgoodfood.com/tikka"),
  ];
  const vectors = [along(0), along(0, 0.1), along(4), along(4, 0.2), along(8)];
  const targets = [{ title: "Rust", members: [0] }];
  return { tabs, vectors, targets, focus: [1, 2, 3, 4], threshold: 0.25, lone: true, nameLocally };
}

async function nameLocally(ix) {
  const sorted = ix.toSorted((a, b) => a - b);
  return { title: `Local ${sorted.join("+")}`, onePage: ix.length === 1 };
}

// A pretend AI service: answers with names(tabs, offered) and remembers what it was asked.
function service(names) {
  const calls = [];
  const nameWithAi = async (tabs, offered) => {
    calls.push({ titles: tabs.map((t) => t.title), offered });
    return names(tabs, offered);
  };
  return { calls, nameWithAi };
}

// place()'s result with tab indices in order, to compare.
const sorted = ({ joins, created, skipped, warning }) => ({
  joins: Object.fromEntries([...joins].map(([t, ix]) => [t, ix.toSorted((a, b) => a - b)])),
  created: created.map((c) => ({ ...c, tabs: c.tabs.toSorted((a, b) => a - b) })).sort((a, b) => a.title.localeCompare(b.title)),
  skipped: skipped.toSorted((a, b) => a - b),
  warning,
});

test("closeness: to a group's tabs or a category's description, whichever is closer", () => {
  const { tabs, vectors } = window();
  assert.ok(closeness(tabs, vectors, 1, { members: [0] }) > 0.9);
  assert.equal(closeness(tabs, vectors, 1, { members: [1] }), -1);
  assert.ok(closeness(tabs, vectors, 4, { members: [0], vector: along(8) }) > 0.99);
});

test("closeness: a thin tab only goes by tabs on its own site", () => {
  const tabs = [tab("YouTube", "https://www.youtube.com/"), tab("Watch later playlist on YouTube today", "https://www.youtube.com/later"), tab("Videos about cats and dogs", "https://vimeo.com/cats")];
  const vectors = [along(0), along(0, 0.1), along(0)];
  assert.ok(closeness(tabs, vectors, 0, { members: [1, 2] }) > 0.9);
  assert.equal(closeness(tabs, vectors, 0, { members: [2] }), -1);
  // A category knows what YouTube is.
  assert.ok(closeness(tabs, vectors, 0, { members: [2], vector: along(0) }) > 0.99);
});

test("match: each tab into the closest target past the threshold, the rest left over", () => {
  const { tabs, vectors } = window();
  const targets = [{ title: "Rust", members: [0] }, { title: "Food", about: "Recipes", vector: along(8), members: [] }];
  const { joins, rest } = match(tabs, vectors, targets, [1, 2, 3, 4], 0.25);
  assert.deepEqual([...joins], [[0, [1]], [1, [4]]]);
  assert.deepEqual(rest, [2, 3]);
});

test("cluster: alike tabs together; thin tabs only with thin tabs from their site", () => {
  const tabs = [
    tab("Cheap flights London to Lisbon", "https://www.skyscanner.net/lis"),
    tab("Hotels in the Alfama district of Lisbon", "https://www.booking.com/alfama"),
    tab("YouTube", "https://www.youtube.com/"),
    tab("Subscriptions", "https://www.youtube.com/feed/subscriptions"),
    tab("BBC Home", "https://www.bbc.co.uk/"),
  ];
  const vectors = [along(0), along(0, 0.2), along(4), along(8), along(4)];
  const clusters = cluster(tabs, vectors, [0, 1, 2, 3, 4], 0.25).map((c) => c.toSorted().join(",")).sort();
  assert.deepEqual(clusters, ["0,1", "2,3", "4"]);
});

test("nearTargets: targets within reach, closest first, at most `limit`", () => {
  const { tabs, vectors } = window();
  const targets = [{ title: "A", members: [2] }, { title: "B", members: [0] }, { title: "C", members: [4] }];
  assert.deepEqual(nearTargets(tabs, vectors, targets, [1], 0.2), [1]);
  assert.deepEqual(nearTargets(tabs, vectors, targets, [3], -1, 2), [0, 1]);
});

test("commonest: the most common name, ignoring case", () => {
  assert.equal(commonest(["Rust", "Go", "rust"]), "Rust");
  assert.equal(commonest([]), undefined);
});

test("place on this computer: joins what fits, groups the rest and names them", async () => {
  const result = sorted(await place(window()));
  assert.deepEqual(result, {
    joins: { 0: [1] },
    created: [
      { title: "Local 2+3", tabs: [2, 3], onePage: false },
      { title: "Local 4", tabs: [4], onePage: true },
    ],
    skipped: [],
    warning: undefined,
  });
});

test("place: without lone, a tab like nothing else is skipped", async () => {
  const result = sorted(await place({ ...window(), lone: false }));
  assert.deepEqual(result.created.map((c) => c.title), ["Local 2+3"]);
  assert.deepEqual(result.skipped, [4]);
});

test("place: partners join a focus tab's new group, but aren't grouped or skipped by themselves", async () => {
  const brought = sorted(await place({ ...window(), focus: [2], partners: [3, 4], lone: false }));
  assert.deepEqual(brought.created, [{ title: "Local 2+3", tabs: [2, 3], onePage: false }]);
  assert.deepEqual(brought.skipped, []);
  const alone = sorted(await place({ ...window(), focus: [4], partners: [2, 3], lone: false }));
  assert.deepEqual(alone.created, []);
  assert.deepEqual(alone.skipped, [4]);
});

test("place with an AI service: it names new groups, and a single page goes along with a request", async () => {
  const { calls, nameWithAi } = service((tabs) => tabs.map((t) => (t.title.includes("Lisbon") ? "Trip to Lisbon" : "Recipes")));
  const result = sorted(await place({ ...window(), nameWithAi }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].titles.toSorted(), ["Cheap flights London to Lisbon", "Easy chicken tikka masala recipe", "Hotels in the Alfama district of Lisbon"]);
  assert.deepEqual(calls[0].offered, []);
  assert.deepEqual(result.joins, { 0: [1] });
  assert.deepEqual(result.created, [
    { title: "Recipes", tabs: [4], onePage: true },
    { title: "Trip to Lisbon", tabs: [2, 3], onePage: false },
  ]);
});

test("place with an AI service: a single page with nowhere to go isn't asked about by itself", async () => {
  const { calls, nameWithAi } = service((tabs) => tabs.map(() => "Recipes"));
  const result = sorted(await place({ ...window(), focus: [4], nameWithAi }));
  assert.equal(calls.length, 0);
  assert.deepEqual(result.created, [{ title: "Local 4", tabs: [4], onePage: true }]);
});

test("place with an AI service: it can split a cluster, and an existing group's name joins it", async () => {
  const { nameWithAi } = service((tabs) => tabs.map((t) => (t.title.includes("flights") ? "rust" : t.title.includes("Hotels") ? "Hotels" : "Recipes")));
  const result = sorted(await place({ ...window(), nameWithAi }));
  assert.deepEqual(result.joins, { 0: [1, 2] });
  assert.deepEqual(result.created.map((c) => [c.title, c.tabs]), [["Hotels", [3]], ["Recipes", [4]]]);
  const strict = sorted(await place({ ...window(), lone: false, nameWithAi }));
  assert.deepEqual(strict.created, []);
  assert.deepEqual(strict.skipped, [3, 4]);
});

test("place with an AI service: a tab just short of a group is asked about, with the group's examples", async () => {
  const { tabs, vectors, targets } = window();
  tabs.push(tab("Systems programming language comparison", "https://example.com/langs"));
  // 0.22 from the Rust group: short of the threshold, but within NEAR of it.
  vectors.push(unit(Array.from({ length: DIM }, (_, d) => (d === 0 ? 0.22 : d === 20 ? Math.sqrt(1 - 0.22 ** 2) : 0))));
  const { calls, nameWithAi } = service((asked) => asked.map(() => "Rust"));
  const result = sorted(await place({ ...window(), tabs, vectors, targets, focus: [5], lone: false, nameWithAi }));
  assert.deepEqual(calls[0].offered, [{ name: "Rust", about: undefined, examples: ["Rust ownership and borrowing explained"] }]);
  assert.deepEqual(result.joins, { 0: [5] });
});

test("place with an AI service: a tab anywhere near a category is asked about, with every category offered", async () => {
  const w = window();
  // 0.18 from the recipe: short of the threshold, but within CATEGORY_NEAR of it.
  const cooking = unit(Array.from({ length: DIM }, (_, d) => (d === 8 ? 0.18 : d === 20 ? Math.sqrt(1 - 0.18 ** 2) : 0)));
  w.targets.push({ title: "Cooking", about: "Recipes and food", vector: cooking, members: [] });
  w.targets.push({ title: "Shopping", about: "Online shops", vector: along(12), members: [] });
  const { calls, nameWithAi } = service(() => ["Cooking"]);
  const result = sorted(await place({ ...w, focus: [4], lone: false, nameWithAi }));
  assert.deepEqual(calls[0].offered.map((o) => o.name), ["Cooking", "Shopping"]);
  assert.deepEqual(calls[0].offered[1], { name: "Shopping", about: "Online shops", examples: [] });
  assert.deepEqual(result.joins, { 1: [4] });
});

test("place with an AI service: a lone tab nowhere near a category isn't asked about", async () => {
  const w = window();
  w.targets.push({ title: "Shopping", about: "Online shops", vector: along(12), members: [] });
  const { calls, nameWithAi } = service(() => ["Shopping"]);
  const result = sorted(await place({ ...w, focus: [4], lone: false, nameWithAi }));
  assert.equal(calls.length, 0);
  assert.deepEqual(result.skipped, [4]);
});

test("place with an AI service: a big cluster is shown in part, and the rest go with most of it", async () => {
  const tabs = Array.from({ length: 12 }, (_, i) => tab(`Pull request number ${"abcdefghijkl"[i]} on our repository`, `https://github.com/a/b/pull/${i}`));
  const vectors = tabs.map((_, i) => along(0, i / 40));
  const { calls, nameWithAi } = service((asked) => asked.map((_, k) => (k === 0 ? "" : "Code Review")));
  const result = sorted(await place({ tabs, vectors, targets: [], focus: tabs.map((_, i) => i), threshold: 0.25, lone: true, nameWithAi, nameLocally }));
  assert.equal(calls[0].titles.length, TABS_PER_CLUSTER);
  assert.deepEqual(result.created, [{ title: "Code Review", tabs: tabs.map((_, i) => i), onePage: false }]);
});

test("place with an AI service: whole clusters per request, at most TABS_PER_REQUEST tabs", async () => {
  const tabs = [];
  const vectors = [];
  for (let c = 0; c < 8; c++) {
    for (let i = 0; i < TABS_PER_CLUSTER; i++) {
      tabs.push(tab(`Topic ${c} page ${"abcdefgh"[i]} with enough words`, `https://site${c}.com/${i}`));
      vectors.push(along(c * 2, i / 40));
    }
  }
  const { calls, nameWithAi } = service((asked) => asked.map((t) => `Topic ${t.title.split(" ")[1]}`));
  const result = await place({ tabs, vectors, targets: [], focus: tabs.map((_, i) => i), threshold: 0.25, lone: true, nameWithAi, nameLocally });
  const perRequest = Math.floor(TABS_PER_REQUEST / TABS_PER_CLUSTER) * TABS_PER_CLUSTER;
  assert.deepEqual(calls.map((c) => c.titles.length), [perRequest, tabs.length - perRequest]);
  assert.equal(result.created.length, 8);
});

test("place: when the AI service fails, this computer does it all and says why", async () => {
  const nameWithAi = async () => {
    throw new Error("The AI service said: 401 Unauthorized");
  };
  const result = sorted(await place({ ...window(), nameWithAi }));
  assert.equal(result.warning, "The AI service said: 401 Unauthorized");
  assert.deepEqual(result.created.map((c) => c.title), ["Local 2+3", "Local 4"]);
});
