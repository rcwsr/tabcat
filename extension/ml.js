// On-device models, run inside the extension with transformers.js (vendored by
// `npm install`, see scripts/vendor.mjs). Firefox's own browser.trial.ml would need
// about:config switches and only allows one model per extension; Tabcat needs two.
// Models download from Hugging Face on first use and are cached by the browser.
// No tab data is sent anywhere.
import { env, pipeline } from "./vendor/transformers.min.js";

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = browser.runtime.getURL("vendor/");
// Extension pages aren't cross-origin isolated, so WebAssembly threads aren't available.
env.backends.onnx.wasm.numThreads = 1;

const MODELS = {
  // Sentence embeddings: tabs with similar titles get similar vectors.
  embedding: ["feature-extraction", "Xenova/all-MiniLM-L6-v2"],
  // Short topic names; the model Firefox's own smart tab groups use.
  topic: ["text2text-generation", "Mozilla/smart-tab-topic"],
};

const loaded = {};

// onProgress(text) is called while a model downloads, which only happens on first use.
function load(name, onProgress) {
  const [task, model] = MODELS[name];
  loaded[name] ??= pipeline(task, model, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p) => {
      if (p.status === "progress" && p.total > 1e6) onProgress?.(`Downloading ${model} (${Math.round(p.progress)}%)…`);
    },
  }).catch((err) => {
    delete loaded[name];
    throw new Error(`Couldn't load ${model}: ${err.message}`);
  });
  return loaded[name];
}

// One unit vector per text.
export async function embed(texts, onProgress) {
  const model = await load("embedding", onProgress);
  return (await model(texts, { pooling: "mean", normalize: true })).tolist();
}

// A short topic name for a prompt built by topicPrompt(), or "" if the model has none.
export async function topic(prompt, onProgress) {
  const model = await load("topic", onProgress);
  const [out] = await model(prompt, { max_new_tokens: 6 });
  return out?.generated_text?.trim() ?? "";
}
