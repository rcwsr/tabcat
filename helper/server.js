// Local HTTP wrapper around Laya so the extension can make typed decisions
// without sending tab data off the machine. Request/response shapes mirror
// Laya's systemOne() call, which is Jev-compatible.
import http from "node:http";
import { Laya } from "@receptron/laya";

const HOST = "127.0.0.1";
const PORT = Number(process.env.TABY_PORT ?? 7357);
const MAX_BODY_BYTES = 64 * 1024;

let layaPromise;
let loaded = false;

function getLaya() {
  layaPromise ??= Laya.load().then((laya) => {
    loaded = true;
    console.log("Laya model loaded");
    return laya;
  });
  return layaPromise;
}

// Laya runs one forward pass at a time; queue requests rather than overlap them.
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

function send(res, status, body, origin) {
  const headers = { "Content-Type": "application/json" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
  }
  res.writeHead(status, headers);
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Only the extension (or local tools like curl, which send no Origin) may call us.
  const origin = req.headers.origin;
  if (origin && !origin.startsWith("moz-extension://")) {
    return send(res, 403, { error: "Forbidden origin" });
  }

  if (req.method === "OPTIONS") return send(res, 204, undefined, origin);

  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, loaded }, origin);
  }

  if (req.method === "POST" && req.url === "/system-one") {
    try {
      const { state, questions } = await readJson(req);
      if (!state || typeof questions !== "object") {
        return send(res, 400, { error: "Expected { state, questions }" }, origin);
      }
      const laya = await getLaya();
      const result = await enqueue(() => laya.systemOne(state, questions));
      return send(res, 200, result, origin);
    } catch (err) {
      console.error(err);
      return send(res, 500, { error: err.message }, origin);
    }
  }

  send(res, 404, { error: "Not found" }, origin);
});

server.listen(PORT, HOST, () => {
  console.log(`Taby helper listening on http://${HOST}:${PORT}`);
  // Start loading now so the first organise isn't stuck behind the model load.
  // First run downloads ~1.7 GB of weights to ~/.cache/receptron-laya.
  getLaya().catch((err) => console.error("Failed to load Laya:", err));
});

async function shutdown() {
  server.close();
  if (loaded) await (await layaPromise).close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
