<img src="extension/icons/tabcat.svg" width="96" alt="Tabcat icon">

# Tabcat

A Firefox extension that puts your tabs into tab groups and names them. It runs on your
computer: tab data stays there unless you connect your own [AI service](#ai-service).

## What it does

- **Groups tabs as you browse.** A couple of seconds after a tab loads, Tabcat puts it in the
  group it fits best, or starts a new group with similar tabs. A message at the bottom of the
  page says where it went, with **Undo**.
- **Tidy tabs** (toolbar button) groups every tab that isn't in a group yet. Your own groups
  stay as they are, but can take in matching tabs.
- **Reorganise** breaks up every group in the window and sorts all the tabs again.
  **Undo reorganise** puts the old groups back.
- A tab you take out of a group stays out.

## Two ways to group

**Automatically** (the default). Tabcat finds related tabs and names the groups itself, using
two small models that run inside the extension:
[all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) to find tabs that are alike,
and [smart-tab-topic](https://huggingface.co/Mozilla/smart-tab-topic) (the one Firefox's own
tab grouping uses) to name them. They download from Hugging Face the first time (about 80 MB).

- It goes by each tab's title and address. If a title says almost nothing (a home page titled
  "YouTube"), it also reads the page's description.
- A group made from a single page is named after its site, for example "Gmail". When a
  different page joins it, the group gets a new name based on all its tabs. It keeps the
  old name if you've renamed the group yourself.

**Into your categories.** You list categories (Work, News, Shopping…) with a sentence
describing each, and each tab goes into the one it fits. A tab that doesn't clearly fit
stays put. Groups you made yourself are left alone. You can choose what does the sorting:

- **Built into Tabcat** (default): the same model as above.
- **Firefox's built-in AI**: the same model, run by Firefox. This is experimental: it needs
  a permission (Settings has a button) and `browser.ml.enable` and `extensions.ml.enabled`
  set to `true` in `about:config`.
- **Laya**: a local decision model. You need to run [layad](https://github.com/rcwsr/layad)
  (`brew tap rcwsr/tap && brew install layad && brew services start layad`). It places
  fewer tabs, but it gets more of them right.
- **My AI service**: see below.

How each one did on 48 test tabs with the default categories:

| Model | Tabs placed | Placed correctly |
|---|---|---|
| Built into Tabcat | 43 | 36 |
| Firefox's built-in AI | 45 | 36 |
| Laya | 30 | 28 |
| AI service (Gemma 4 E4B in LM Studio) | 48 | 44 |

## AI service

You can connect any service with an OpenAI-compatible API: OpenAI, OpenRouter, or a model
on your own computer with Ollama (`http://localhost:11434/v1`) or LM Studio
(`http://localhost:1234/v1`). In Settings, enter the address (up to `/v1`), an API key if it
needs one, and the model name. Then either:

- tick **Name groups with my AI service**. Tabs are still grouped on your computer; only
  the names come from the service, or
- choose **My AI service** to sort tabs into your categories.

The service receives the titles, addresses (without the query string) and page descriptions
of the tabs it names or sorts. If the address isn't on your computer, it must use https, and
Firefox will ask your permission to send tab data. The key is stored in your Firefox profile
and only sent to that address.

## Settings

Open them from the toolbar popup → **Settings**. You can:

- choose automatic grouping or your categories
- turn off grouping as you browse, and only group when you click **Tidy tabs**
- stop a tab that matches nothing from getting a group of its own
- set how alike tabs must be to share a group (automatic) or how sure the model must be
  (categories)
- turn off renaming groups when they grow
- edit your categories
- set up an AI service

## Permissions

- **Tabs and tab groups**: to read titles and addresses and move tabs.
- **Access to all websites**: to show the "Moved to…" message on the page you're on, and
  to read page descriptions. You can turn it off in `about:addons`. Without it, moves are
  counted on the toolbar button and listed in the popup with Undo.
- **Send tab data** (asked only when you set up a remote AI service).
- **Firefox's built-in AI** (asked only if you choose it).

See the [privacy policy](PRIVACY.md).

## Installing

Firefox 142 or later. Release Firefox only installs signed add-ons, so use a build signed by
addons.mozilla.org, or load it yourself as below.

## Development

```sh
npm install      # also copies transformers.js and the ONNX runtime into extension/vendor/
npm start        # opens Firefox with the extension loaded
npm run lint
npm run build    # packages the extension into web-ext-artifacts/
```

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
service, so the only network access is downloading the models. The Laya test is skipped
unless layad is running. The labelled test tabs are in `test/fixtures/tabs.mjs`.

## Code

```
extension/
  background.js   grouping, keeping tabs organised, undo
  cluster.js      clustering and naming helpers (no browser APIs)
  ml.js           the on-device models (transformers.js)
  providers.js    what sorts tabs into categories
  ai-service.js   talking to your AI service
  firefox-ml.js   Firefox's built-in AI
  toast.js        the "Moved to…" message
  options.*       the Settings page
  popup.*         the toolbar popup
  settings.js     default settings and categories
  icons/          the toolbar and add-on icon
scripts/vendor.mjs  copies the model runtime into extension/vendor/ (not committed)
test/             unit, model and browser tests, and labelled tabs
store/            text and icon for the addons.mozilla.org listing
```

## Licence

[MIT](LICENSE)
