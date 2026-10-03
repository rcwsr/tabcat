// Headless Firefox for the browser tests, driven over WebDriver BiDi with puppeteer-core.
//
// - Firefox sends all http:// traffic to a local server acting as its proxy, so tabs can
//   have real hostnames ("http://www.bbc.co.uk/news") without touching the network. Each
//   page just has the title the test gave it.
// - BiDi can't open moz-extension:// pages, so organise() installs a copy of the extension
//   with a hook appended to background.js. The hook fetches a task from the server, runs it
//   with the extension's own functions and posts the results back.
import puppeteer from "puppeteer-core";
import http from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIREFOX =
  process.env.FIREFOX ?? (process.platform === "darwin" ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "firefox");
export const EXTENSION_DIR = fileURLToPath(new URL("../../extension/", import.meta.url));

const PREFS = {
  "browser.tabs.groups.enabled": true,
  "network.proxy.type": 1,
  "network.proxy.http": "127.0.0.1",
  // Real hostnames over plain http: don't upgrade them to https.
  "network.stricttransportsecurity.preloadlist": false,
  "dom.security.https_first": false,
  "dom.security.https_only_mode": false,
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// Pass to launch() as `firefoxML` to turn on Firefox's built-in AI and grant Tav trialML.
const FIREFOX_ML_PREFS = { "browser.ml.enable": true, "extensions.ml.enabled": true };

export async function launch({ firefoxML = false } = {}) {
  const titles = new Map(); // url -> page title
  let task;
  let sendTask;
  let finished;
  const done = new Promise((resolve) => (finished = resolve));

  const server = http.createServer((req, res) => {
    // Proxied page requests carry an absolute URL.
    if (req.url.startsWith("http://")) {
      const title = titles.get(new URL(req.url).href);
      if (title === undefined) return res.writeHead(404).end();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><title>${escape(title)}</title><p>${escape(title)}`);
    }
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/task") return task ? res.end(JSON.stringify(task)) : (sendTask = () => res.end(JSON.stringify(task)));
    if (path === "/done") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        finished(JSON.parse(body));
        res.end();
      });
      return;
    }
    // The extension's own files, for pages tested with stubbed browser APIs.
    if (path.startsWith("/ext/")) {
      const file = join(EXTENSION_DIR, path.slice(5));
      if (!file.startsWith(EXTENSION_DIR) || !existsSync(file)) return res.writeHead(404).end();
      res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
      return res.end(readFileSync(file));
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const profile = mkdtempSync(join(tmpdir(), "tav-test-"));
  const prefs = { ...PREFS, "network.proxy.http_port": port, ...(firefoxML ? FIREFOX_ML_PREFS : {}) };
  writeFileSync(join(profile, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n"));
  if (firefoxML) {
    writeFileSync(
      join(profile, "extension-preferences.json"),
      JSON.stringify({ "tav@cwsr.dev": { permissions: ["trialML"], origins: [], data_collection: [] } }),
    );
  }

  const firefox = spawn(FIREFOX, ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0", "about:blank"], {
    env: { ...process.env, MOZ_NO_REMOTE: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Firefox didn't start within 30 s")), 30_000);
    firefox.on("error", reject);
    firefox.on("exit", (code) => reject(new Error(`Firefox exited (${code}) before it was ready`)));
    firefox.stderr.on("data", (d) => {
      const match = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(d);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const browser = await puppeteer.connect({ browserWSEndpoint: `${endpoint}/session`, protocol: "webDriverBiDi" });

  const ff = {
    browser,
    origin: `http://127.0.0.1:${port}`,

    // Opens one tab per [title, url]; url is host + path, served over the proxy.
    async openTabs(tabs) {
      const urls = [];
      const [first] = await browser.pages();
      for (const [i, [title, hostPath]] of tabs.entries()) {
        const url = new URL(`http://${hostPath}`).href;
        titles.set(url, title);
        const page = i === 0 ? first : await browser.newPage();
        await page.goto(url, { waitUntil: "load" });
        urls.push(url);
      }
      return urls;
    },

    // Installs the extension with the test hook, then runs `task`:
    //   { settings, groups: [{ title, urls }] (made before organising), runs, toolbar }
    // Resolves to [{ result, error, layout: { url: group title or null }, badge, tooltip }],
    // one per run.
    async organise(newTask, { timeout = 240_000 } = {}) {
      if (!existsSync(join(EXTENSION_DIR, "vendor", "transformers.min.js"))) {
        throw new Error("extension/vendor/ is missing; run npm install");
      }
      const ext = join(profile, "ext");
      cpSync(EXTENSION_DIR, ext, { recursive: true });
      appendFileSync(join(ext, "background.js"), hook(ff.origin));
      task = newTask;
      await browser.installExtension(ext);
      sendTask?.();
      let timer;
      const report = await Promise.race([
        done,
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no result within ${timeout / 1000} s`)), timeout))),
      ]).finally(() => clearTimeout(timer));
      if (report.fatal) throw new Error(`test hook failed: ${report.fatal}`);
      return report.runs;
    },

    async close() {
      await browser.close().catch(() => {});
      firefox.kill();
      server.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
  return ff;
}

function hook(origin) {
  return `
// --- test hook, added by test/browser/firefox.mjs (not part of the extension) ---
(async () => {
  const post = (body) => fetch("${origin}/done", { method: "POST", body: JSON.stringify(body) });
  try {
    // keepAlive: waiting on fetch alone doesn't stop Firefox suspending this page.
    const task = await keepAlive(async () => (await fetch("${origin}/task")).json());
    await browser.storage.local.set(task.settings ?? {});
    const [win] = await browser.windows.getAll({ windowTypes: ["normal"] });
    const tabs = await browser.tabs.query({ windowId: win.id });
    for (const { title, urls } of task.groups ?? []) {
      const groupId = await browser.tabs.group({ tabIds: tabs.filter((t) => urls.includes(t.url)).map((t) => t.id) });
      await browser.tabGroups.update(groupId, { title });
    }
    const runs = [];
    for (let i = 0; i < (task.runs ?? 1); i++) {
      let result, error;
      try {
        // toolbar: run what a click on Tav's button runs, badge and tooltip included.
        result = await (task.toolbar ? tidyWindow(win.id) : keepAlive(() => organiseWindow(win.id)));
      } catch (e) {
        error = e.message;
      }
      const badge = await browser.action.getBadgeText({ windowId: win.id });
      const tooltip = await browser.action.getTitle({ windowId: win.id });
      const groups = await browser.tabGroups.query({ windowId: win.id });
      const layout = {};
      for (const t of await browser.tabs.query({ windowId: win.id })) {
        layout[t.url] = groups.find((g) => g.id === t.groupId)?.title ?? null;
      }
      runs.push({ result, error, layout, badge, tooltip });
    }
    await post({ runs });
  } catch (e) {
    await post({ fatal: String(e) });
  }
})();
`;
}
