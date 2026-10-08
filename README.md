<p align="center">
  <img src="docs/header.jpg" alt="Tabcat: AI-powered tab grouping">
</p>

# Tabcat

A Firefox extension that puts your tabs into tab groups and names them. It runs on your
computer: tab data stays there unless you connect your own [AI service](#ai-service).

## What it does

- **Groups tabs as you browse.** A couple of seconds after a page loads, Tabcat puts it in
  the group it fits best, or starts a new group with similar tabs.
- **Tidy tabs** (toolbar button) groups every tab that isn't in a group yet. Your own groups
  stay as they are, but can take in matching tabs.
- **Reorganise** breaks up every group in the window and sorts all the tabs again.
  **Undo reorganise** puts the old groups back.
- A tab you take out of a group stays out.

Tabcat finds related tabs and names the groups itself, using two small models that run
inside the extension: [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) to
find tabs that are alike, and [smart-tab-topic](https://huggingface.co/Mozilla/smart-tab-topic)
(the one Firefox's own tab grouping uses) to name them. They download from Hugging Face the
first time (about 80 MB).

- It goes by each tab's title and address. If a title says almost nothing (a home page titled
  "YouTube"), it also reads the page's description.
- A group made from a single page is named after its site, for example "Gmail". When a
  different page joins it, the group gets a new name based on all its tabs. It keeps the
  old name if you've renamed the group yourself.

## Your categories

Optional. Add groups you always want, like Work or Shopping, each with a sentence saying
what belongs in it (Settings has examples to start from). A tab that fits a category goes
into it; other tabs are grouped automatically as above. A group you made with the same name
as a category is that category. Groups you made yourself are left alone.

## Finding a tab that moved

- When Tabcat moves the tab you're on, a message at the bottom of the page says which group
  it went to. **Show** scrolls the tab bar to the tab (opening its group if it's collapsed)
  and makes the group blink; **Undo** puts it back.
- Tabs moved while you were on another are counted on the toolbar button. Its popup lists
  recent moves with Show, which goes to the tab (**Back** on that page returns you), and Undo.
- The group's name is marked with ● until you've been to it.
- **Alt+Shift+M** shows the last tab Tabcat moved (you can change the shortcut).

## AI service

Optional. You can connect any service with an OpenAI-compatible API: OpenAI, OpenRouter, or
a model on your own computer with Ollama (`http://localhost:11434/v1`) or LM Studio
(`http://localhost:1234/v1`). In Settings, enter the address (up to `/v1`) and an API key if
it needs one, then choose a model from the service's list. **Test** checks it with two
made-up tabs.

Tabcat still does what it's sure of on your computer: tabs clearly like a group or category
join it there. The tabs it isn't sure of go to the service, many in one request, with the
groups and categories they might belong in, and the service says which group each tab
belongs in (an existing one, or a new one it names). If the service can't be reached, Tabcat
does it all on your computer and says why. Settings shows how many requests and tokens it
has used.

The service receives the titles and website names (not the full address) of the tabs it's
asked about, plus a page's description when its title says little. If the address isn't on
your computer, it must use https, and Firefox will ask your permission to send tab data. The
key is stored in your Firefox profile and only sent to that address.

How it did on labelled test tabs (`npm run eval`; the AI service was Gemma 4 E4B in
LM Studio):

| Test | On this computer | With the AI service |
|---|---|---|
| Tidy 48 tabs into the example categories: right / wrong | 25 / 0 | 42 / 0, one request |
| Tidy 24 tabs: pairs grouped correctly / pairs found | 0.76 / 0.59 | 0.82 / 0.82, one request |
| 48 tabs into categories as they load: right / wrong | 24 / 0 | 36 / 0 |

## Settings

Open them from the toolbar popup → **Settings**. You can:

- turn off grouping as you browse, and only group when you click **Tidy tabs**
- stop a tab that fits nowhere from getting a group of its own
- set how alike tabs must be to share a group
- keep the tabs in each group in A–Z order, by title or by website
- turn off renaming groups as they grow
- add your categories
- turn off the message or the ● mark, and change the keyboard shortcut
- set up an AI service, with your own instructions for it (like "name groups in French")

## Permissions

- **Tabs and tab groups**: to read titles and addresses and move tabs.
- **Access to all websites**: to show the "Moved to…" message on the page, and
  to read page descriptions. You can turn it off in `about:addons`. Without it, moves are
  counted on the toolbar button and listed in the popup.
- **Send tab data** (asked only when you set up an AI service that isn't on your computer).

See the [privacy policy](PRIVACY.md).

## Installing

Firefox 142 or later. Install it from
**[addons.mozilla.org](https://addons.mozilla.org/en-GB/firefox/addon/tabcat/)**; Firefox
then keeps it up to date. Or load it yourself as below.

## Development

```sh
npm install      # also copies transformers.js and the ONNX runtime into extension/vendor/
npm start        # opens Firefox with the extension loaded
npm run lint
npm run build    # packages the extension into web-ext-artifacts/
```

To release: raise `version` in `extension/manifest.json`, then push a tag to match
(`git tag v0.2.0 && git push origin v0.2.0`). GitHub builds the add-on zip and a source zip,
submits the version to addons.mozilla.org (Mozilla reviews and signs it), and makes a GitHub
release with both zips. This needs the repo secrets `AMO_API_KEY` and `AMO_API_SECRET`. To
build without a release: Actions → Release → Run workflow → "build only".

Version numbers are shared across Mozilla's channels, so a version can't be both listed and
self-distributed. "self-distributed" in the same menu has Mozilla sign a version without
listing it, and attaches the signed `tabcat.xpi` to the release.

To load it by hand: `about:debugging` → This Firefox → Load Temporary Add-on →
`extension/manifest.json` (after `npm install`).

## Tests

```sh
npm test                 # unit tests (fast, offline)
npm run test:model       # grouping and category quality, with the real model in Node
npm run test:browser     # the real extension in headless Firefox
npm run test:all
```

The browser tests need Firefox 142 or later (set `FIREFOX` to its path if it isn't found).
They send Firefox's traffic through a local proxy that serves fake pages and plays the AI
service, so the only network access is downloading the models. The labelled test tabs are
in `test/fixtures/tabs.mjs`.

`npm run eval` measures grouping on the labelled tabs, on this computer and with an AI
service (`AI_URL=http://localhost:1234/v1 AI_MODEL=google/gemma-4-e4b npm run eval`), with
the requests and tokens it took. `VERBOSE=1` lists the groups; a word after it picks the
tests (`npm run eval -- categories`).

## Code

```
extension/
  background.js   events and messages
  organise.js     Tidy tabs, Reorganise and grouping tabs as they load
  plan.js         deciding where tabs go (no browser APIs)
  cluster.js      finding similar tabs (no browser APIs)
  naming.js       naming groups on this computer (no browser APIs)
  ml.js           the on-device models (transformers.js)
  ai-service.js   talking to your AI service
  layout.js       making groups, keeping them in order, Reorganise's Undo
  moves.js        finding moved tabs: the message, Show, ● marks, the badge, the shortcut
  toast.js        the "Moved to…" message
  session.js      what Tabcat remembers until Firefox closes
  settings.js     default settings and example categories
  options.*       the Settings page
  popup.*         the toolbar popup
  icons/          the toolbar and add-on icon
scripts/vendor.mjs  copies the model runtime into extension/vendor/ (not committed)
scripts/eval.mjs    measures grouping on the labelled tabs
test/             unit, model and browser tests, and labelled tabs
store/            text and icon for the addons.mozilla.org listing
```

## Licence

[MIT](LICENSE)
