// Runs the models (see ml.js, which starts and stops this worker). They live in a worker so
// that stopping it frees the ONNX runtime's WebAssembly memory for certain: when they ran in
// the background page, every time Firefox suspended and woke that page the old runtime stayed
// behind in a ghost window, and a few GB later Firefox ran out of memory.
import { env, pipeline } from "./vendor/transformers.min.js";

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL("vendor/", import.meta.url).href;
// Extension pages aren't cross-origin isolated, so WebAssembly threads aren't available.
env.backends.onnx.wasm.numThreads = 1;

const MODELS = {
  // Sentence embeddings: tabs with similar titles get similar vectors.
  embedding: ["feature-extraction", "Xenova/all-MiniLM-L6-v2"],
  // Short topic names; the model Firefox's own smart tab groups use.
  topic: ["text2text-generation", "Mozilla/smart-tab-topic"],
};

const loaded = {};

// progress(text) is called while a model downloads, which only happens on first use.
function load(name, progress) {
  const [task, model] = MODELS[name];
  loaded[name] ??= pipeline(task, model, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p) => {
      if (p.status === "progress" && p.total > 1e6) progress(`Downloading ${model} (${Math.round(p.progress)}%)…`);
    },
  }).catch((err) => {
    delete loaded[name];
    throw new Error(`Couldn't load ${model}: ${err.message}`);
  });
  return loaded[name];
}

const operations = {
  // Texts go through the model one at a time: a batch pads every text to the longest, which
  // makes a tab's vector depend on the tabs batched with it, and its memory grows with the
  // square of that length (a window of tabs at once, some with page descriptions, ran the
  // model out of memory).
  async embed({ texts }, progress) {
    const model = await load("embedding", progress);
    const vectors = [];
    for (const text of texts) {
      vectors.push(...(await model([text], { pooling: "mean", normalize: true })).tolist());
    }
    return vectors;
  },

  async topic({ prompt }, progress) {
    const model = await load("topic", progress);
    const [out] = await model(prompt, { max_new_tokens: 6 });
    return out?.generated_text?.trim() ?? "";
  },
};

self.onmessage = async ({ data: { id, op, ...args } }) => {
  try {
    const result = await operations[op](args, (text) => self.postMessage({ id, progress: text }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
