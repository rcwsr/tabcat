# Store listing (addons.mozilla.org)

What to paste into each field when submitting Tabcat. Icon: `icon-128.png` in this folder
(the add-on itself uses the PNGs in `extension/icons/`).

## Name

Tabcat

## Summary (250 characters max)

Puts your tabs into tab groups and names them, as you browse. Runs on your computer: no
account, no tracking, and your tabs aren't sent anywhere unless you connect your own AI service.

## Description

Tabcat sorts your tabs into Firefox tab groups and gives each group a name.

**As you browse:** a couple of seconds after a tab loads, Tabcat puts it in the group it
fits best, or starts a new group with similar tabs. If it's the tab you're on, a message
at the bottom of the page says where it went: Show scrolls the tab bar to it, and Undo puts
it back.

**Tidy tabs:** one click groups every tab that isn't in a group yet. Your own groups stay
as they are.

**Reorganise:** breaks up every group in the window and sorts all the tabs again. Undo
puts the old groups back.

**Your categories (optional):** add groups you always want (Work, News, Shopping…) and
tabs that fit them go into them. Everything else is grouped automatically.

**A–Z order (optional):** keep the tabs in each group sorted by title or by website.

**Private:** grouping and naming are done by small AI models running inside the extension.
They download once (about 80 MB) the first time you use Tabcat. Your tabs aren't sent
anywhere.

**Optional:** connect an AI service of your own (OpenAI, OpenRouter, or a model on your
computer with Ollama or LM Studio) for better names and categories. Tabcat only asks it
about the tabs it isn't sure of, many in one request. Firefox asks your permission before
any tab data is sent.

Open source (MIT): https://github.com/rcwsr/tabcat

## Categories

Tabs

## Support

- Support site: https://github.com/rcwsr/tabcat/issues
- Homepage: https://github.com/rcwsr/tabcat

## License

MIT

## Privacy policy

Paste the contents of `PRIVACY.md`.

## Screenshots

At least one, 1280×800 is a good size. Suggested:
1. A window of tabs after Tidy tabs, with named groups.
2. The "Moved … to …" message with Show and Undo at the bottom of a page.
3. The toolbar popup.
4. The Settings page.

## Notes to reviewer

Tabcat groups tabs using machine-learning models that run inside the extension.

**Third-party code.** `vendor/` contains unmodified files from npm, copied in by
`scripts/vendor.mjs` during `npm install`:
- `vendor/transformers.min.js` from `@huggingface/transformers` 4.3.0 (`dist/`).
- `vendor/ort-wasm-simd-threaded.asyncify.mjs` and `.wasm` from the `onnxruntime-web`
  version that package depends on (1.31.0-dev.20260914-8d85527a0, `dist/`).

The linter's three warnings (Function constructor, dynamic import) are in these files.
Everything else is plain, unminified JavaScript with no build step.

To build: `npm ci && npm run build` (Node 24). The package is written to
`web-ext-artifacts/`.

**Remote content.** The models (`Xenova/all-MiniLM-L6-v2` and `Mozilla/smart-tab-topic`)
are downloaded from huggingface.co on first use and cached by the browser. They're model
weights and configuration (ONNX and JSON), not code. No code is loaded from outside the
package. `'wasm-unsafe-eval'` in the content security policy is needed to run the bundled
ONNX Runtime WebAssembly.

**Permissions.**
- `tabs`, `tabGroups`: read tab titles and addresses, and group tabs.
- `scripting` and access to all websites: show the "Moved … to …" message with Show and
  Undo on the page you're looking at (`toast.js`), and read a page's `<meta>` description,
  keywords and site name when its title says too little to group by. Nothing read is sent
  anywhere unless the user sets up an AI service.
- `storage`: settings, recent moves for Undo and Show, and AI service usage.
- `http://127.0.0.1/*`, `http://localhost/*`: an optional AI service on the user's own
  computer (Ollama, LM Studio), which still works if access to all websites is turned off.
- Optional data collection (`browsingActivity`, `websiteContent`): only requested when the
  user sets up an AI service that isn't on their computer. Tab titles, website names and
  some page descriptions are then sent to that service, and nowhere else.
- `commands`: Alt+Shift+M shows the last tab Tabcat moved.

**Testing.** Open some tabs on different topics, click the Tabcat toolbar button → Tidy
tabs. The first run downloads the models (about 80 MB), which takes a little while.
