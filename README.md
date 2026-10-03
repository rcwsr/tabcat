# Tav

A Firefox extension that sorts your tabs into groups, on your own computer.

By default it finds the groups itself: small AI models running inside the extension
([transformers.js](https://github.com/huggingface/transformers.js)) spot related tabs and
name them. Nothing else to install. Or you can define your own categories and have each tab
sorted into one. Either way tab data never leaves your machine.

## Installing

Tav ships as a single `.xpi` with everything it needs, including the model runtime. The
models themselves download on first use.

1. Install the `.xpi` in Firefox 142+. Release Firefox only installs signed add-ons, so
   this needs a build signed by addons.mozilla.org.
2. Only if you want Laya for categories mode: install and start [layad](https://github.com/rcwsr/layad):

   ```sh
   brew tap rcwsr/tap && brew install layad && brew services start layad
   layad status
   ```

3. Click the Tav toolbar button → **Tidy tabs**.

## Settings

Popup → **Settings** (or `about:addons` → Tav → Preferences) to choose automatic grouping
or your own categories, how strict automatic grouping is, the categories and the minimum
confidence below which tabs are left alone, and which model sorts into categories.

## Keeping tabs organised

Turn on **Keep tabs organised** in Settings and Tav puts new tabs into a matching group as
you browse, without you clicking anything:

- When a tab finishes loading in the background, or you switch away from a tab, Tav moves
  it into the group it matches best. In automatic mode that's an existing group it's close
  to; in categories mode it's its category's group. Tabs that match nothing stay put.
- It never moves the tab you're looking at, and a tab you take out of a group (or Undo)
  stays out.
- The group the tab went into blinks, and a message at the bottom of the page you're on
  says "Moved "…" to Dev" with **Undo**. Firefox doesn't let extensions animate the tab
  bar or draw over the browser window, so these are the closest it allows.
- The message needs permission to add it to websites, which Tav asks for when you turn
  this on. Tav only adds the message; it doesn't read pages. Where the message can't
  appear (Firefox's own pages, PDFs, or without the permission), the Tav button shows a
  count and the popup lists recent moves with Undo.

## How automatic grouping works

1. Each tab's title and URL path are turned into a vector by
   [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2).
2. Ungrouped tabs join an existing group (yours or Tav's) if they're close enough to it.
3. The rest are clustered (average linkage on cosine similarity). Clusters of two or more
   become new groups; lone tabs are left alone.
4. Each new group gets a name from
   [smart-tab-topic](https://huggingface.co/Mozilla/smart-tab-topic) (the model Firefox's
   own tab grouping uses), falling back to shared title words or the site.

The models (about 80 MB) download from Hugging Face the first time you organise and are
cached after that. Automatic mode doesn't use Firefox's built-in `browser.trial.ml`: it
needs about:config switches and only allows one model per extension.

## Categories mode

Each tab is sorted into the category it matches best, or left alone if no category is a
confident match. Tabs in groups you made yourself (any group not named after a category)
stay where they are.

Three models can do the sorting (Settings → Model):

- **Built into Tav** (default): the same embedding model automatic mode uses. The tab's
  title and site are compared with each category's description and the closest wins.
- **Firefox's built-in AI**: the same model and method, run by Firefox's experimental
  `browser.trial.ml` instead. Needs a permission (Settings has a button) and
  `browser.ml.enable` + `extensions.ml.enabled` set to `true` in `about:config`.
- **[Laya](https://github.com/receptron/laya) via layad**: a typed decision model running
  as a local service. Its confidence is more reliable, so fewer wrong guesses get through.

Measured in Firefox on 48 labelled tabs with the default categories, at the default 0.5
minimum confidence:

| Model | Tabs placed | Placed correctly |
|---|---|---|
| Built into Tav | 43 | 32 |
| Firefox's built-in AI | 46 | 35 |
| Laya | 31 | 28 |

Tav's and Firefox's copies of the model run on different runtimes, so a few tabs near the
cut-off land differently (45 of 48 matched).

## Development

```sh
npm install      # also copies transformers.js + the ONNX wasm runtime into extension/vendor/
npm start        # runs Firefox with the extension loaded
npm run lint
npm run build    # self-contained package in web-ext-artifacts/
```

Or load it by hand: `about:debugging` → This Firefox → Load Temporary Add-on →
`extension/manifest.json` (after `npm install`).

## Tests

```sh
npm test                 # unit tests for the pure helpers (instant, offline)
npm run test:model       # grouping and categories quality floors, using the real model in Node
npm run test:browser     # headless Firefox with the real extension
npm run test:all
```

The browser tests need Firefox 142+ (set `FIREFOX` to its binary if it isn't in the default
place). They give tabs real hostnames by sending Firefox's traffic through a local proxy, so
they don't touch the network apart from downloading the models. Laya's test is skipped unless
layad is running. Labelled tabs for all of them are in `test/fixtures/tabs.mjs`.

## Layout

```
extension/   Firefox MV3 extension
  background.js   organises a window (automatic or by category)
  cluster.js      clustering and naming helpers (no browser APIs)
  ml.js           on-device models via transformers.js
  providers.js    categories-mode models: on-device embeddings / Laya (layad) / Jev (stub)
  firefox-ml.js   Firefox's built-in AI (browser.trial.ml)
  toast.js        the "Moved … — Undo" message shown in pages
  settings.js     default categories and settings
  vendor/         transformers.js + ONNX runtime, copied in by `npm install` (not committed;
                  included in the built package)
scripts/vendor.mjs  copies the model runtime into extension/vendor/
test/
  unit/           pure helpers
  model/          quality floors with the real model, in Node
  browser/        headless Firefox with the real extension
  fixtures/       labelled tabs
```

## Testing the model directly

With Laya, Tav sends a request like this for each tab:

```sh
curl -s http://127.0.0.1:8918/ai/run -H 'Content-Type: application/json' -d '{
  "state": { "title": "Array.prototype.map() - MDN", "url": "developer.mozilla.org/en-US/docs/..." },
  "questions": { "category": { "type": "choice", "instructions": "Which category?",
    "criteria": { "dev": "Programming docs", "news": "News", "shopping": "Shops" } } }
}'
```

## Switching to Jev

layad speaks the Jev wire format, so `JevProvider.decide()` in `extension/providers.js`
is the same `{ state, questions }` request to the hosted endpoint plus an API key. Add the
API host to `host_permissions`, update `data_collection_permissions` (tab data would then
leave the machine), and set `provider: "jev"` in settings.
