// The extension's embedding model, run in Node with the same quantised weights. The first
// run downloads it (23 MB) from Hugging Face into transformers.js's cache.
import { pipeline } from "@huggingface/transformers";

let model;

export async function embed(texts) {
  model ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
  return (await (await model)(texts, { pooling: "mean", normalize: true })).tolist();
}
