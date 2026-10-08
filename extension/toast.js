// "Moved … to Dev  Show  Undo", shown at the bottom of the page when Tabcat moves the tab
// you're on (and "Back" after Show). moves.js injects showToast() into the page, so it has
// to be self-contained: no imports, nothing from outside the function.
// buttons: [{ label, message }]; clicking one sends `message` to the background page and
// hides the toast.
export function showToast(text, buttons) {
  const SHOW_MS = 6000;
  document.getElementById("tabcat-toast")?.remove();

  // A shadow root keeps the page's styles off the toast and the toast's off the page.
  const host = document.createElement("div");
  host.id = "tabcat-toast";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .toast {
      position: fixed; z-index: 2147483647; left: 50%; bottom: 24px;
      display: flex; gap: 4px; align-items: center; max-width: min(560px, calc(100vw - 32px));
      padding: 8px 8px 8px 16px; border-radius: 8px; background: #2b2a33; color: #fbfbfe;
      font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      opacity: 0; transform: translate(-50%, 16px); transition: opacity 0.2s, transform 0.2s;
    }
    .toast.shown { opacity: 1; transform: translate(-50%, 0); }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px; }
    button {
      all: unset; cursor: pointer; padding: 4px 10px; border-radius: 4px; white-space: nowrap;
      color: #80ebff; font-weight: 600;
    }
    button:hover, button:focus-visible { background: rgba(255, 255, 255, 0.1); }
  `;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  const label = document.createElement("span");
  label.className = "text";
  // Long titles are cut off with an ellipsis; the tooltip has all of it.
  label.textContent = label.title = text;
  toast.append(label);
  root.append(style, toast);
  document.documentElement.append(host);

  let timer;
  const hide = () => {
    toast.classList.remove("shown");
    setTimeout(() => host.remove(), 200);
  };
  const hideLater = () => (timer = setTimeout(hide, SHOW_MS));
  for (const { label: name, message } of buttons) {
    const button = document.createElement("button");
    button.textContent = name;
    button.addEventListener("click", () => {
      clearTimeout(timer);
      browser.runtime.sendMessage(message);
      hide();
    });
    toast.append(button);
  }
  // Stays up while the pointer is on it, so there's time to reach the buttons.
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", hideLater);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("shown")));
  hideLater();
}
