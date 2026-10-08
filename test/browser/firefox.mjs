// Headless Firefox for the browser tests, driven over WebDriver BiDi with puppeteer-core.
//
// - Firefox sends all http:// traffic to a local server acting as its proxy, so tabs can
//   have real hostnames ("http://www.bbc.co.uk/news") without touching the network. Each
//   page just has the title (and any <meta> tags) the test gave it.
// - BiDi can't open moz-extension:// pages, so organise() installs a copy of the extension
//   with a hook appended to background.js. The hook fetches a task from the server, runs it
//   with the extension's own functions and posts the results back.
// - The server is also a stand-in AI service at ${origin}/v1 (OpenAI chat completions):
//   ff.aiRequests records what it was asked, and ff.aiReply(request) says what it answers (or a promise of it).
//   It lists ff.aiModels as its models.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import http from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

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

const TYPES = { ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// An ff.aiReply for Tabcat's requests (see namingMessages): names each numbered tab with
// nameOf("Title (site)").
export const perTab = (nameOf) => (request) =>
  request.messages
    .at(-1)
    .content.split("\n")
    .flatMap((line) => {
      const match = /^(\d+)\. (.*)$/.exec(line);
      return match ? [`${match[1]}: ${nameOf(match[2]) ?? ""}`] : [];
    })
    .join("\n");

export async function launch() {
  const titles = new Map(); // url -> page title
  const metas = new Map(); // url -> { meta name: content }
  let task;
  let sendTask;
  let finished;
  const done = new Promise((resolve) => (finished = resolve));
  // Commands for the hook once its runs are done: one at a time, see command().
  let command;
  let sendCommand;
  let replied;

  const server = http.createServer((req, res) => {
    // Proxied page requests carry an absolute URL.
    if (req.url.startsWith("http://")) {
      const title = titles.get(new URL(req.url).href);
      if (title === undefined) return res.writeHead(404).end();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const meta = Object.entries(metas.get(new URL(req.url).href) ?? {})
        // Open Graph tags use property=, the rest name=.
        .map(([name, content]) => `<meta ${name.startsWith("og:") ? "property" : "name"}="${escape(name)}" content="${escape(content)}">`)
        .join("");
      return res.end(`<!doctype html><title>${escape(title)}</title>${meta}<p>${escape(title)}`);
    }
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/task") return task ? res.end(JSON.stringify(task)) : (sendTask = () => res.end(JSON.stringify(task)));
    if (path === "/command") {
      if (command) return res.end(JSON.stringify(command));
      return (sendCommand = () => res.end(JSON.stringify(command)));
    }
    if (path === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ object: "list", data: ff.aiModels.map((id) => ({ id, object: "model" })) }));
    }
    if (path === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const request = { ...JSON.parse(body), authorization: req.headers.authorization };
        ff.aiRequests.push(request);
        const content = await ff.aiReply(request);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }));
      });
      return;
    }
    if (path === "/done" || path === "/reply") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (path === "/done") finished(JSON.parse(body));
        else {
          command = undefined;
          replied(JSON.parse(body));
        }
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

  const profile = mkdtempSync(join(tmpdir(), "tabcat-test-"));
  const prefs = { ...PREFS, "network.proxy.http_port": port };
  writeFileSync(join(profile, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n"));

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

  const pages = new Map(); // url -> puppeteer page
  let front; // url of the tab in front
  const ff = {
    browser,
    origin: `http://127.0.0.1:${port}`,
    aiRequests: [],
    aiModels: ["llama-3.1-8b", "gemma-3-4b", "text-embedding-nomic-embed-text-v1.5"],
    aiReply: () => "none",

    // Opens one tab per [title, url, meta]; url is host + path, served over the proxy, and
    // meta is optional { name: content } for <meta> tags. With background, the tab you were
    // on stays in front while the new one loads.
    async openTabs(tabs, { background = false } = {}) {
      const urls = [];
      for (const [title, hostPath, meta] of tabs) {
        const url = new URL(`http://${hostPath}`).href;
        titles.set(url, title);
        metas.set(url, meta);
        const [blank] = (await browser.pages()).filter((p) => p.url() === "about:blank");
        const page = blank ?? (await browser.newPage());
        if (background && front) await pages.get(front).bringToFront();
        await page.goto(url, { waitUntil: "load" });
        pages.set(url, page);
        if (!background) front = url;
        urls.push(url);
      }
      return urls;
    },

    // Switches to the tab showing url and returns its page.
    async show(url) {
      await pages.get(url).bringToFront();
      front = url;
      return pages.get(url);
    },

    // The page of the tab showing url.
    page: (url) => pages.get(url),

    // Takes the tab showing url to another page, with its own title.
    async navigate(url, [title, hostPath]) {
      const to = new URL(`http://${hostPath}`).href;
      titles.set(to, title);
      const page = pages.get(url);
      pages.delete(url);
      await page.goto(to, { waitUntil: "load" });
      pages.set(to, page);
      if (front === url) front = to;
      return to;
    },

    // Polls the tab layout until check(layout) passes. The first move loads the models.
    async waitForLayout(check, what, timeout = 120_000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const layout = await ff.command("layout");
        if (check(layout)) return layout;
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(layout)}`);
        await sleep(500);
      }
    },

    // Installs the extension with the test hook, then runs `task`:
    //   { settings, groups: [{ title, urls }] (made before organising), runs }
    // Resolves to [{ result, error, layout: { url: group title or null } }], one per run.
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

    // After organise(), asks the extension something. name is one of:
    //   "layout"            { url: group title or null } for every tab (titles as shown,
    //                       with the mark on groups with a moved tab you haven't been to)
    //   "ungroup", url      takes that tab out of its group, as a user would
    //   "colours"           { group title: colour }
    //   "set", settings     saves settings, as the settings page would
    //   "badge"             the toolbar button's badge text
    //   "allSites", granted whether Tabcat may use websites; with true or false, sets it first
    //   "send", message     what the popup would send, for this window; replies with the answer
    //   "order"             the tabs' URLs, left to right
    //   "moved"             tabs moved since last asked: [[url, fromIndex, toIndex]]
    //   "collapse", title   collapses that group; replies { title: collapsed } for every group
    //   "session"           everything in storage.session
    //   "local"             everything in storage.local
    //   "active"            the URL of the tab in front
    //   "breakGrouping"     the next tabs.group() fails, as if Firefox had a problem
    async command(name, arg) {
      const reply = new Promise((resolve) => (replied = resolve));
      command = { name, arg };
      sendCommand?.();
      sendCommand = undefined;
      const result = await reply;
      if (result?.error) throw new Error(result.error);
      return result;
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
    const layout = async () => {
      const groups = await browser.tabGroups.query({ windowId: win.id });
      const result = {};
      for (const t of await browser.tabs.query({ windowId: win.id })) {
        result[t.url] = groups.find((g) => g.id === t.groupId)?.title ?? null;
      }
      return result;
    };
    const tabs = await browser.tabs.query({ windowId: win.id });
    for (const { title, urls } of task.groups ?? []) {
      const groupId = await browser.tabs.group({ tabIds: tabs.filter((t) => urls.includes(t.url)).map((t) => t.id) });
      await browser.tabGroups.update(groupId, { title });
    }
    // Tabs moved since the "moved" command last asked: [url, from, to].
    const moves = [];
    browser.tabs.onMoved.addListener((tabId, { fromIndex, toIndex }) => moves.push([tabId, fromIndex, toIndex]));
    const runs = [];
    for (let i = 0; i < (task.runs ?? 1); i++) {
      let result, error;
      try {
        result = await keepAlive(() => organiseWindow(win.id));
      } catch (e) {
        error = e.message;
      }
      runs.push({ result, error, layout: await layout() });
    }
    await post({ runs });

    // Then answer commands until the test closes Firefox.
    await keepAlive(async () => {
      for (;;) {
        const { name, arg } = await (await fetch("${origin}/command")).json();
        let reply = null;
        try {
          if (name === "layout") reply = await layout();
          else if (name === "colours") {
            const groups = await browser.tabGroups.query({ windowId: win.id });
            reply = Object.fromEntries(groups.map((g) => [g.title, g.color]));
          } else if (name === "set") await browser.storage.local.set(arg);
          else if (name === "badge") reply = await browser.action.getBadgeText({ windowId: win.id });
          else if (name === "allSites") {
            const all = { origins: ["<all_urls>"] };
            if (arg === false) await browser.permissions.remove(all);
            if (arg === true) await browser.permissions.request(all);
            reply = await browser.permissions.contains(all);
          }
          else if (name === "send") reply = (await handleMessage({ ...arg, windowId: win.id })) ?? null;
          else if (name === "order") reply = (await browser.tabs.query({ windowId: win.id })).map((t) => t.url);
          else if (name === "moved") {
            const urls = new Map((await browser.tabs.query({})).map((t) => [t.id, t.url]));
            reply = moves.splice(0).map(([id, from, to]) => [urls.get(id), from, to]);
          }
          else if (name === "collapse") {
            // arg: a group's title to collapse. Replies { title: collapsed }.
            const group = (await browser.tabGroups.query({ windowId: win.id })).find((g) => g.title === arg);
            if (group) await browser.tabGroups.update(group.id, { collapsed: true });
            reply = Object.fromEntries((await browser.tabGroups.query({ windowId: win.id })).map((g) => [g.title, g.collapsed]));
          }
          else if (name === "session") reply = await browser.storage.session.get();
          else if (name === "local") reply = await browser.storage.local.get();
          else if (name === "active") reply = (await browser.tabs.query({ windowId: win.id, active: true }))[0].url;
          else if (name === "breakGrouping") {
            const group = browser.tabs.group;
            const put = (value) => Object.defineProperty(browser.tabs, "group", { value, configurable: true, writable: true });
            put(async () => {
              put(group);
              throw new Error("Firefox couldn't make the group");
            });
          }
          else if (name === "ungroup") {
            const [tab] = (await browser.tabs.query({ windowId: win.id })).filter((t) => t.url === arg);
            await browser.tabs.ungroup(tab.id);
          } else throw new Error("unknown command " + name);
        } catch (e) {
          reply = { error: e.message };
        }
        await fetch("${origin}/reply", { method: "POST", body: JSON.stringify(reply) });
      }
    });
  } catch (e) {
    await post({ fatal: String(e) });
  }
})();
`;
}
