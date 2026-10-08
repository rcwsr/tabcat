// On-device models, run inside the extension with transformers.js (vendored by
// `npm install`, see scripts/vendor.mjs). Firefox's own browser.trial.ml would need
// about:config switches and only allows one model per extension; Tabcat needs two.
// Models download from Hugging Face on first use and are cached by the browser.
// No tab data is sent anywhere.
//
// They run in a worker (ml-worker.js) that's stopped when it's idle, and when Firefox
// suspends the background page, so the ONNX runtime's memory is freed each time.

// Firefox suspends an idle background page after ~30 s; stop the models before it does.
const IDLE_MS = 20_000;

let worker = null;
let idleTimer = null;
let nextId = 0;
// Calls waiting for the worker's answer, by id.
const pending = new Map();

function stop(reason = "The models were stopped.") {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
  for (const call of pending.values()) call.reject(new Error(reason));
  pending.clear();
}

function start() {
  if (worker) return worker;
  worker = new Worker(browser.runtime.getURL("ml-worker.js"), { type: "module" });
  const mine = worker;
  mine.onmessage = ({ data: { id, progress, result, error } }) => {
    const call = pending.get(id);
    if (!call) return;
    if (progress !== undefined) return call.onProgress?.(progress);
    pending.delete(id);
    if (error !== undefined) call.reject(new Error(error));
    else call.resolve(result);
    stopWhenIdle();
  };
  mine.onerror = (event) => {
    if (worker === mine) stop(`Couldn't start the models: ${event.message || "the worker failed"}`);
  };
  return mine;
}

// Stops the models once nothing has used them for a while.
function stopWhenIdle() {
  clearTimeout(idleTimer);
  if (!pending.size) idleTimer = setTimeout(stop, IDLE_MS);
}

function call(op, args, onProgress) {
  clearTimeout(idleTimer);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    try {
      start().postMessage({ id, op, ...args });
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

browser.runtime.onSuspend?.addListener(() => stop("Firefox suspended Tabcat."));

// One unit vector per text. onProgress(text) is called while a model downloads, which only
// happens on first use.
export function embed(texts, onProgress) {
  return call("embed", { texts }, onProgress);
}

// A short topic name for a prompt built by topicPrompt(), or "" if the model has none.
export function topic(prompt, onProgress) {
  return call("topic", { prompt }, onProgress);
}
