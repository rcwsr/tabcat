const buttons = [...document.querySelectorAll("#organise, #reorganise, #undoReorganise")];
const undoReorganise = document.getElementById("undoReorganise");
const status = document.getElementById("status");
let busy = false;

function show(text, isError = false) {
  status.textContent = text;
  status.className = isError ? "error" : "";
}

// The first automatic run downloads the models; the background page reports how it's going.
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "progress" && busy) show(message.text);
});

function describe(result) {
  if (result.restored !== undefined) return result.restored ? "Groups put back." : "Nothing to put back.";
  const lines = Object.entries(result.groups).map(([name, n]) => `${name}: ${n}`);
  if (result.skipped) lines.push(`Left alone: ${result.skipped}`);
  return lines.join("\n") || "Nothing to organise.";
}

// Sends `type` to the background page for this window and shows what it did.
async function run(type, working) {
  busy = true;
  buttons.forEach((b) => (b.disabled = true));
  show(working);
  try {
    const win = await browser.windows.getCurrent();
    show(describe(await browser.runtime.sendMessage({ type, windowId: win.id })));
  } catch (err) {
    show(err.message, true);
  } finally {
    busy = false;
    buttons.forEach((b) => (b.disabled = false));
    await offerUndoReorganise();
  }
}

document.getElementById("organise").addEventListener("click", () => run("organise", "Sorting tabs…"));
document.getElementById("reorganise").addEventListener("click", () => run("reorganise", "Sorting every tab again…"));
undoReorganise.addEventListener("click", () => run("undoReorganise", "Putting groups back…"));

async function offerUndoReorganise() {
  const win = await browser.windows.getCurrent();
  undoReorganise.hidden = !(await browser.runtime.sendMessage({ type: "canUndoReorganise", windowId: win.id }));
}

offerUndoReorganise();

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

document.getElementById("settings").addEventListener("click", (event) => {
  event.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});
