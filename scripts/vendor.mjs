// Copies the on-device ML runtime into extension/vendor/ (gitignored): transformers.js
// and the ONNX Runtime WebAssembly build it loads. Runs after `npm install`.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "extension", "vendor");
// Both entry points live in the packages' dist/ folders.
const transformersEntry = require.resolve("@huggingface/transformers");
const transformers = dirname(transformersEntry);
// transformers.js pins its own onnxruntime-web, so resolve it from there to get matching files.
const ort = dirname(createRequire(transformersEntry).resolve("onnxruntime-web"));

mkdirSync(out, { recursive: true });
for (const [dir, file] of [
  [transformers, "transformers.min.js"],
  [ort, "ort-wasm-simd-threaded.asyncify.mjs"],
  [ort, "ort-wasm-simd-threaded.asyncify.wasm"],
]) {
  copyFileSync(join(dir, file), join(out, file));
  console.log(`vendored ${file}`);
}
