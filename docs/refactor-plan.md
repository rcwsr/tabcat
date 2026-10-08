# Tabcat refactor: what changed and why

## The brief

1. One way of grouping: automatic, with optional categories of your own. No more
   "automatic" vs "categories" modes.
2. Re-evaluate how tabs are grouped and named. Use a decision model (Laya, Jev) only where
   it measurably helps; if it does, replace the Laya-only setting with a decision model you
   configure like the AI service.
3. Work well with 10s and 100s of tabs: as few requests and tokens as possible, fast, and
   good groups.
4. Keep the toast, and make it easy to find where a tab went.
5. A simpler settings page with plain descriptions.
6. An option to keep tabs in A–Z order within a group.

Ideas added along the way, all built:

7. **Tabs that load together are placed together** (restoring a session, opening a folder
   of bookmarks): one pass of the model and at most one request, not one per tab.
8. **Vectors are kept in `storage.session`**, so the background page being suspended
   doesn't mean embedding the whole window again.
9. **Faster clustering**: average linkage with Lance–Williams updates on a similarity
   matrix computed once (O(n²) per merge instead of re-averaging members on every
   comparison). Same result as the naive version (a unit test checks).
10. **The AI service is only asked about what this computer isn't sure of**, many tabs in
    one request, and a big cluster is shown in part (8 tabs nearest its middle).
11. **One request names every new group** and says which tabs belong in an existing group
    or category.
12. **The toast is only for the tab you're on**, and its **Show** points that tab out: it
    opens the group if it's collapsed, scrolls the tab bar to the tab and blinks the group's
    colour. There's no API to scroll the tab bar, but Firefox scrolls it to the current tab
    whenever that tab moves, so Show moves it one place along in its group and straight back
    (a group of one moves past its neighbour and back). Checked in Firefox 157 by measuring
    the tab bar's scroll position; moving a group to where it already is doesn't scroll.
    In the popup, Show switches to a moved tab, with **Back** on the page you land on. The
    group's name is marked with ● until you've been to it.
13. **Alt+Shift+M** shows the last tab Tabcat moved.
14. **AI usage in Settings**: requests and tokens, with a reset.
15. **A Test button** for the AI service, which sends two made-up tabs, not yours.
16. **If the AI service can't be used**, this computer does it all and the popup and
    Settings say why, rather than failing.
17. **Your own instructions for the AI service** ("name groups in French").
18. **The toolbar badge** counts moves the toast didn't show: tabs you weren't on, and
    pages it can't be shown on (website access turned off, about: pages, PDFs).

## How tabs are placed now (`extension/plan.js`)

One planner for Tidy, Reorganise and tabs as they load:

1. **Targets** are the window's groups plus your categories. A category with a group of the
   same name (ignoring case) is that group.
2. A tab at least `groupingThreshold` (0.25) close to a target joins the closest, on this
   computer. Closeness to a group is the average similarity to its tabs; to a category,
   similarity to its description and the tabs already in it.
3. The rest are clustered (average linkage at the same threshold). Thin tabs (a home page
   titled "YouTube") only cluster with tabs from the same site.
4. **Without an AI service**, clusters become groups named on this computer: a single page
   after its site ("Gmail"), others by smart-tab-topic, falling back to shared keywords.
5. **With an AI service**, the clusters' tabs go to it in one request (at most 60 tabs a
   request), side by side, with the groups they're near and your categories (with a few
   example titles each). It names the group each tab belongs in. An existing name joins it,
   and tabs given the same new name become a group. Naming tabs rather than clusters lets it
   split a cluster that's wrong, for about the same tokens.
   - It's only asked when it can do better than this computer: a cluster of different
     pages (to name it), or one that might belong in a group (within 0.05 of the threshold)
     or a category (within 0.10). A lone single page with nowhere to go is named after its
     site without a request, but rides along in a request that's made anyway.
6. A group named after one page is named again when a different page joins (unless you've
   renamed it).

## Decisions, with measurements

Measured with `npm run eval` on the labelled tabs in `test/fixtures/tabs.mjs` (24 + 24
tabs for grouping, 48 for categories), running the extension's own planner in Node. The
sets are small, so these are signals.

**The decision model (Laya / Jev) was dropped.** Asking a decision model about tabs just
short of the threshold, or about every category decision, lost more right answers than it
gained compared with the threshold alone, and an AI service seeing those tabs in new groups
did better than either. With nothing to gain, there's no decision model setting, and the
Laya dependency is gone.

**Firefox's built-in AI was dropped.** It runs the same model as the bundled one with the
same results, but needs about:config switches and a permission.

**On this computer vs with an AI service** (Gemma 4 E4B in LM Studio, temperature 0):

| Test | On this computer | With the AI service | Requests (input tokens) |
|---|---|---|---|
| Tidy, 24 tabs: pair precision / recall | 0.81 / 0.65 | 0.82 / 0.69 | 1 (610) |
| Tidy, 24 held-out tabs | 0.76 / 0.59 | 0.82 / 0.82 | 1 (619) |
| Tidy, 48 tabs into categories: right / wrong / intruders | 25 / 0 / 0 | 42 / 0 / 4 | 1 (693) |
| As you browse, 24 held-out tabs | 0.78 / 0.64 | 0.82 / 0.64 | 7 (1265) |
| As you browse, 48 tabs into categories | 24 / 0 / 0 | 36 / 0 / 2 | 15 (6111) |

The AI service's biggest gain is categories: it puts far more tabs in the right one, still
with none in the wrong one. For plain grouping it gives better names and finds more of the
tabs that belong together.

Asking the service to sort every tab itself (`AI does it all` in the eval, a reference) did
better on the training tabs (0.85 / 0.85) and about the same on the others, for similar
tokens on one window. But as you browse it would mean a request for every tab that loads,
it sends every tab off your computer, and nothing is grouped when the service is down.
Tabcat keeps what this computer is sure of and asks about the rest.

**A lone page goes along with a request that's made anyway.** It costs a line (about 150
more input tokens for 24 tabs) and lets the service put it with pages this computer didn't
see were alike. Tidy on the held-out tabs went from 0.88 / 0.68 to 0.82 / 0.82, and on the
training tabs from 0.81 / 0.65 to 0.82 / 0.69. A lone page alone still makes no request.

**A tab is only asked about if it's anywhere near a category.** At first, every tab went to
the service when you had categories, since it might belong in one. As you browse into the
example categories that was 22 requests for 48 tabs, with 38 right and 3 intruders. Asking
only about tabs within 0.10 of the threshold of a category took 15 requests and 30% fewer
tokens, with 36–38 right (over two runs) and 2 intruders. Within 0.15 saved nothing: nearly
every tab is that close to some category.

**Tabcat asks the service for temperature 0.** At Gemma's default the same request's
answers varied a lot: sorting every tab itself, it put 42 of 48 tabs in the right category
one run and 9 the next, and scored 0.89 / 0.62 on 24 tabs one run and 0.52 / 1.0 the next.
At 0, Tidy's answers were the same every run, and as you browse they changed by a tab or
two out of 48. Services that only take their default (OpenAI's reasoning models) say so,
and are asked again without it.

## Settings

- **Grouping**: group tabs as they load (on); give a tab that fits nowhere a group of its
  own (on); how alike tabs must be (Looser … Stricter, 0.15–0.40, default 0.25); order of
  tabs in a group (as added / A–Z by title / A–Z by website); rename a group as it grows
  (on).
- **Your categories** (optional, none by default, with examples one click away): a name and
  what belongs.
- **Finding moved tabs**: the message on the page (on); mark the group with ● until you've
  been to it (on); the keyboard shortcut.
- **AI service** (optional): address, key, model (chosen from the service's list, with a
  search box when it's long, or typed if it can't list them), your instructions; Test; usage.

Removed: the mode switch, the "other" catch-all category, Laya, Firefox's built-in AI, the
category confidence setting (categories use the grouping threshold).

Settings from 0.1 are migrated: categories are kept for people who used categories mode
(without "other"; the old defaults if they never changed them), and dropped for people who
didn't. The AI service is turned on for people who used it for naming or categories.

## Code

Pure modules (no browser APIs; tested in Node and used by `scripts/eval.mjs`): `plan.js`,
`cluster.js`, `naming.js`, and the prompts and parsing in `ai-service.js`.

Browser side: `organise.js` (gathers tabs, page info and vectors, runs the plan, applies
it), `layout.js` (groups, A–Z order, Reorganise's snapshot), `moves.js` (toast, Show/Back,
marks, badge, shortcut), `session.js`, and `background.js` (events and messages only).

## Tests

- Unit: clustering (Lance–Williams matches the naive version), planning (with a pretend AI
  service), naming, prompts and parsing, settings migration, A–Z order.
- Model (Node, real embeddings): grouping quality floors, and categories through the
  planner (Tidy and as you browse).
- Browser (real headless Firefox): Tidy, Reorganise and Undo, as you browse (toast, Show
  on the toast and in the popup, Back, Undo, marks, the badge, the shortcut, A–Z order,
  colours), categories, the AI service (one
  request, renaming, categories, usage, falling back), the settings page and the popup.
