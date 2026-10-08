const buttons = [...document.querySelectorAll("#organise, #reorganise, #undoReorganise")];
const undoReorganise = document.getElementById("undoReorganise");
const status = document.getElementById("status");
const warning = document.getElementById("warning");
const win = await browser.windows.getCurrent();
let busy = false;

function show(text, isError = false) {
  status.textContent = text;
  status.className = isError ? "error" : "";
}

function showWarning(text) {
  warning.hidden = !text;
  warning.textContent = text ? `The AI service couldn't be used, so this computer did it all: ${text}` : "";
}

// The first run downloads the models; the background page reports how it's going.
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "progress" && busy) show(message.text);
});

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describe(result) {
  if (result.restored !== undefined) return result.restored ? "Groups put back." : "Nothing to put back.";
  const lines = Object.entries(result.groups).map(([name, n]) => `${name}: ${plural(n, "tab")}`);
  if (result.skipped) lines.push(`Left ${plural(result.skipped, "tab")} on ${result.skipped === 1 ? "its" : "their"} own: nothing like ${result.skipped === 1 ? "it" : "them"} yet.`);
  return lines.join("\n") || "Nothing to tidy.";
}

// Sends `type` to the background page for this window and shows what it did.
async function run(type, working) {
  busy = true;
  buttons.forEach((b) => (b.disabled = true));
  show(working);
  try {
    const result = await browser.runtime.sendMessage({ type, windowId: win.id });
    show(describe(result));
    showWarning(result.warning);
  } catch (err) {
    show(err.message, true);
  } finally {
    busy = false;
    buttons.forEach((b) => (b.disabled = false));
    await offerUndoReorganise();
  }
}

document.getElementById("organise").addEventListener("click", () => run("organise", "Tidying tabs…"));
document.getElementById("reorganise").addEventListener("click", () => run("reorganise", "Sorting every tab again…"));
undoReorganise.addEventListener("click", () => run("undoReorganise", "Putting groups back…"));

async function offerUndoReorganise() {
  undoReorganise.hidden = !(await browser.runtime.sendMessage({ type: "canUndoReorganise", windowId: win.id }));
}

function moveButton(label, onClick) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

// Tabs Tabcat moved by itself as you browse, newest first, with Show and Undo.
async function showMoves() {
  const { moves } = await browser.storage.session.get({ moves: [] });
  const mine = moves.filter((m) => m.windowId === win.id).slice(0, 5);
  const list = document.getElementById("moves");
  list.hidden = !mine.length;
  list.querySelectorAll(".move").forEach((row) => row.remove());
  for (const move of mine) {
    const row = document.createElement("div");
    row.className = "move";
    const text = document.createElement("span");
    text.textContent = text.title = move.message;
    const showTab = moveButton("Show", async () => {
      await browser.runtime.sendMessage({ type: "show", moveId: move.id });
      window.close();
    });
    const undo = moveButton("Undo", async () => {
      await browser.runtime.sendMessage({ type: "undo", moveId: move.id });
      await showMoves();
    });
    row.append(text, showTab, undo);
    list.append(row);
  }
  // They've been seen now: clears the count on the toolbar button.
  await browser.runtime.sendMessage({ type: "seen", windowId: win.id });
}

document.getElementById("settings").addEventListener("click", (event) => {
  event.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});

const { aiWarning } = await browser.storage.session.get({ aiWarning: null });
showWarning(aiWarning);
await Promise.all([offerUndoReorganise(), showMoves()]);
