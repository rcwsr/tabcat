// The extension's embedding model, run in Node with the same quantised weights. The first
// run downloads it (23 MB) from Hugging Face into transformers.js's cache.
import { pipeline } from "@huggingface/transformers";

let model;

// One text at a time, as in the extension (see ml.js): no padding.
export async function embed(texts) {
  model ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
  const vectors = [];
  for (const text of texts) vectors.push(...(await (await model)([text], { pooling: "mean", normalize: true })).tolist());
  return vectors;
}
