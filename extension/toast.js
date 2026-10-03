// "Moved … to Dev  Undo", shown at the bottom of the page you're looking at when Tav
// moves another tab. background.js injects showToast() into that page, so it has to be
// self-contained: no imports, nothing from outside the function.
export function showToast(message, moveId) {
  const SHOW_MS = 6000;
  document.getElementById("tav-toast")?.remove();

  // A shadow root keeps the page's styles off the toast and the toast's off the page.
  const host = document.createElement("div");
  host.id = "tav-toast";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .toast {
      position: fixed; z-index: 2147483647; left: 50%; bottom: 24px;
      display: flex; gap: 12px; align-items: center; max-width: min(520px, calc(100vw - 32px));
      padding: 8px 8px 8px 16px; border-radius: 8px; background: #2b2a33; color: #fbfbfe;
      font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      opacity: 0; transform: translate(-50%, 16px); transition: opacity 0.2s, transform 0.2s;
    }
    .toast.shown { opacity: 1; transform: translate(-50%, 0); }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button {
      all: unset; cursor: pointer; padding: 4px 10px; border-radius: 4px;
      color: #80ebff; font-weight: 600;
    }
    button:hover { background: rgba(255, 255, 255, 0.1); }
  `;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  const text = document.createElement("span");
  text.className = "text";
  // Long titles are cut off with an ellipsis; the tooltip has all of it.
  text.textContent = text.title = message;
  const undo = document.createElement("button");
  undo.textContent = "Undo";
  toast.append(text, undo);
  root.append(style, toast);
  document.documentElement.append(host);

  let timer;
  const hide = () => {
    toast.classList.remove("shown");
    setTimeout(() => host.remove(), 200);
  };
  const hideLater = () => (timer = setTimeout(hide, SHOW_MS));
  // Stays up while the pointer is on it, so there's time to reach Undo.
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", hideLater);
  undo.addEventListener("click", () => {
    clearTimeout(timer);
    browser.runtime.sendMessage({ type: "undo", moveId });
    hide();
  });
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("shown")));
  hideLater();
}
