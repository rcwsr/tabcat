import { DEFAULT_SETTINGS } from "./settings.js";

const button = document.getElementById("organise");
const allowToasts = document.getElementById("allowToasts");
// Lets Tabcat show "Moved … Undo" in the page you're on (see toast.js). Same as in options.js.
const TOAST_PERMISSION = { origins: ["<all_urls>"] };
const status = document.getElementById("status");

function show(text, isError = false) {
  status.textContent = text;
  status.className = isError ? "error" : "";
}

// The first automatic run downloads the models; the background page reports how it's going.
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "progress" && button.disabled) show(message.text);
});

button.addEventListener("click", async () => {
  button.disabled = true;
  show("Sorting tabs…");
  try {
    const win = await browser.windows.getCurrent();
    const result = await browser.runtime.sendMessage({ type: "organise", windowId: win.id });
    const lines = Object.entries(result.groups).map(([name, n]) => `${name}: ${n}`);
    if (result.skipped) lines.push(`Left alone: ${result.skipped}`);
    show(lines.join("\n") || "Nothing to organise.");
  } catch (err) {
    show(err.message, true);
  } finally {
    button.disabled = false;
  }
});

// Tabs Tabcat moved by itself (keepOrganised), newest first, each with Undo.
async function showMoves() {
  const win = await browser.windows.getCurrent();
  const { moves } = await browser.storage.session.get({ moves: [] });
  const mine = moves.filter((m) => m.windowId === win.id).slice(0, 5);
  const list = document.getElementById("moves");
  list.hidden = !mine.length;
  list.querySelectorAll(".move").forEach((row) => row.remove());
  for (const move of mine) {
    const row = document.createElement("div");
    row.className = "move";
    const text = document.createElement("span");
    text.textContent = move.message;
    text.title = text.textContent;
    const undo = document.createElement("button");
    undo.textContent = "Undo";
    undo.addEventListener("click", async () => {
      await browser.runtime.sendMessage({ type: "undo", moveId: move.id });
      await showMoves();
    });
    row.append(text, undo);
    list.append(row);
  }
  // They've been seen now: clear the count on the toolbar button.
  if (moves.some((m) => m.windowId === win.id && !m.seen)) {
    await browser.storage.session.set({ moves: moves.map((m) => (m.windowId === win.id ? { ...m, seen: true } : m)) });
  }
  await browser.action.setBadgeText({ windowId: win.id, text: "" });
}

showMoves();

// keepOrganised is on by default, but Firefox only asks for a permission after a click, so
// offer it here until it's granted.
async function offerToasts() {
  const { keepOrganised } = await browser.storage.local.get({ keepOrganised: DEFAULT_SETTINGS.keepOrganised });
  allowToasts.hidden = !keepOrganised || (await browser.permissions.contains(TOAST_PERMISSION));
}

allowToasts.querySelector("button").addEventListener("click", async () => {
  await browser.permissions.request(TOAST_PERMISSION);
  await offerToasts();
});

offerToasts();

document.getElementById("settings").addEventListener("click", (event) => {
  event.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});
