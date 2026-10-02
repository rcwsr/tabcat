const button = document.getElementById("organise");
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

document.getElementById("settings").addEventListener("click", (event) => {
  event.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});
