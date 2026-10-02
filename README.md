# Tav

A Firefox extension that sorts your tabs into groups, on your own computer.

By default it finds the groups itself: small AI models running inside the extension
([transformers.js](https://github.com/huggingface/transformers.js)) spot related tabs and
suggest names, and [Laya](https://github.com/receptron/laya) (via layad) picks the best
name. Or you can define your own categories and let Laya sort each tab into one. Either way
tab data never leaves your machine. The provider is swappable for TypeSafe Jev later.

## How automatic grouping works

1. Each tab's title and URL path are turned into a vector by
   [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2).
2. Ungrouped tabs join an existing group (yours or Tav's) if they're close enough to it.
3. The rest are clustered (average linkage on cosine similarity). Clusters of two or more
   become new groups; lone tabs are left alone.
4. Each new group gets a name from
   [smart-tab-topic](https://huggingface.co/Mozilla/smart-tab-topic) (the model Firefox's
   own tab grouping uses), shared title words, or the site. Laya picks among them. Without
   layad, the topic model's name is used.

The models (about 80 MB) download from Hugging Face the first time you organise and are
cached after that. Firefox's built-in `browser.trial.ml` isn't used because it needs
about:config switches and only allows one model per extension.

## Layout

```
extension/   Firefox MV3 extension
  background.js   organises a window (automatic or by category)
  cluster.js      clustering and naming helpers (no browser APIs)
  ml.js           on-device models via transformers.js
  providers.js    LayaProvider (local layad) / JevProvider (stub)
  categories.js   default categories and settings
  vendor/         transformers.js + ONNX runtime, copied in by `npm install` (not committed;
                  included in the built package)
scripts/vendor.mjs
```

## Installing

Tav ships as a single `.xpi` with everything it needs, including the model runtime. The
models themselves download on first use.

1. Install the `.xpi` in Firefox 142+. Release Firefox only installs signed add-ons, so
   this needs a build signed by addons.mozilla.org.
2. Optional: install and start [layad](https://github.com/rcwsr/layad) so Laya picks group
   names (it's required for categories mode):

   ```sh
   brew tap rcwsr/tap && brew install layad && brew services start layad
   layad status
   ```

3. Click the Tav toolbar button → **Organise this window**.

## Development

```sh
npm install      # also copies transformers.js + the ONNX wasm runtime into extension/vendor/
npm start        # runs Firefox with the extension loaded
npm run lint
npm run build    # self-contained package in web-ext-artifacts/
```

Or load it by hand: `about:debugging` → This Firefox → Load Temporary Add-on →
`extension/manifest.json` (after `npm install`).

## Settings

Popup → **Settings** (or `about:addons` → Tav → Preferences) to choose automatic grouping
or your own categories, how strict automatic grouping is, the categories and the minimum
confidence below which tabs are left alone, and the layad URL.

## Testing the model directly

In categories mode Tav sends a request like this for each tab:

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
