# Tav

A Firefox extension that sorts your tabs into groups using a typed decision model.
Development runs on [Laya](https://github.com/receptron/laya) locally, so tab data never
leaves your machine. The provider is swappable for TypeSafe Jev (or similar) later.

## Layout

```
extension/   Firefox MV3 extension
  background.js   classifies tabs and groups them
  providers.js    LayaProvider (local layad) / JevProvider (stub)
  categories.js   default categories and settings
```

## Running

1. Install and start [layad](https://github.com/rcwsr/layad), which keeps the Laya model
   resident and serves it on `http://127.0.0.1:8918`:

   ```sh
   brew tap rcwsr/tap && brew install layad && brew services start layad
   layad status
   ```

2. Load the extension in Firefox 142+:
   `about:debugging` → This Firefox → Load Temporary Add-on → pick `extension/manifest.json`.
   Or run `npx web-ext run -s extension`.

3. Click the Tav toolbar button → **Organise this window**.

## Settings

Popup → **Settings** (or `about:addons` → Tav → Preferences) to edit the categories,
the minimum confidence below which tabs are left alone, and the layad URL.

## Testing the model directly

Tav sends a request like this for each tab:

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
