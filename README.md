# Taby

A Firefox extension that sorts your tabs into groups using a typed decision model.
Development runs on [Laya](https://github.com/receptron/laya) locally, so tab data never
leaves your machine. The provider is swappable for TypeSafe Jev (or similar) later.

## Layout

```
extension/   Firefox MV3 extension
  background.js   classifies tabs and groups them
  providers.js    LayaProvider (local helper) / JevProvider (stub)
  categories.js   default categories and settings
helper/      Node server wrapping Laya on http://127.0.0.1:7357
```

## Running

1. Start the helper (Node 20+):

   ```sh
   cd helper
   npm install
   npm start
   ```

   The first run downloads ~1.7 GB of model weights to `~/.cache/receptron-laya`.
   Check it with `curl http://127.0.0.1:7357/health`.

2. Load the extension in Firefox 142+:
   `about:debugging` → This Firefox → Load Temporary Add-on → pick `extension/manifest.json`.
   Or run `npx web-ext run -s extension`.

3. Click the Taby toolbar button → **Organise this window**.

## Testing the helper directly

```sh
curl -s http://127.0.0.1:7357/system-one -H 'Content-Type: application/json' -d '{
  "state": { "title": "Array.prototype.map() - MDN", "url": "developer.mozilla.org/en-US/docs/..." },
  "questions": { "category": { "type": "choice", "instructions": "Which category?",
    "criteria": { "dev": "Programming docs", "news": "News", "shopping": "Shops" } } }
}'
```

## Switching to Jev

Implement `JevProvider.decide()` in `extension/providers.js` with the same
`{ state, questions }` payload, add the API host to `host_permissions`, and set
`provider: "jev"` in settings.
