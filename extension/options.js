import { DEFAULT_SETTINGS } from "./categories.js";

const form = document.getElementById("settings");
const provider = document.getElementById("provider");
const layaUrl = document.getElementById("layaUrl");
const minConfidence = document.getElementById("minConfidence");
const minConfidenceValue = document.getElementById("minConfidenceValue");
const categoryList = document.getElementById("categories");
const rowTemplate = document.getElementById("categoryRow");
const status = document.getElementById("status");

function show(text, isError = false) {
  status.textContent = text;
  status.className = isError ? "error" : "";
}

function addCategoryRow(key = "", criteria = "") {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector(".key").value = key;
  row.querySelector(".criteria").value = criteria;
  row.querySelector(".remove").addEventListener("click", () => row.remove());
  categoryList.append(row);
  return row;
}

function render(settings) {
  // A disabled option can't stay selected, so fall back to Laya.
  provider.value = provider.querySelector(`option[value="${settings.provider}"]:not([disabled])`)
    ? settings.provider
    : "laya";
  layaUrl.value = settings.layaUrl;
  minConfidence.value = settings.minConfidence;
  minConfidenceValue.textContent = Number(settings.minConfidence).toFixed(2);
  categoryList.replaceChildren();
  for (const [key, criteria] of Object.entries(settings.categories)) addCategoryRow(key, criteria);
}

// Returns settings to save, or throws with a message for the user.
function collect() {
  let url;
  try {
    url = new URL(layaUrl.value.trim());
  } catch {
    throw new Error("layad URL isn't a valid URL.");
  }
  // host_permissions only cover 127.0.0.1, and tab data must stay on this machine.
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("layad URL must be http://127.0.0.1:<port>.");
  }

  const categories = {};
  for (const row of categoryList.querySelectorAll(".category")) {
    const key = row.querySelector(".key").value.trim();
    const criteria = row.querySelector(".criteria").value.trim();
    if (!key && !criteria) continue;
    if (!key || !criteria) throw new Error("Every category needs a name and a description.");
    const normalised = key.toLowerCase();
    if (Object.keys(categories).some((k) => k.toLowerCase() === normalised)) {
      throw new Error(`Duplicate category "${key}".`);
    }
    categories[key] = criteria;
  }
  if (Object.keys(categories).length < 2) throw new Error("Add at least two categories.");

  return {
    provider: provider.value,
    layaUrl: url.origin,
    minConfidence: Number(minConfidence.value),
    categories,
  };
}

minConfidence.addEventListener("input", () => {
  minConfidenceValue.textContent = Number(minConfidence.value).toFixed(2);
});

document.getElementById("addCategory").addEventListener("click", () => {
  addCategoryRow().querySelector(".key").focus();
});

document.getElementById("reset").addEventListener("click", () => {
  render(DEFAULT_SETTINGS);
  show("Defaults restored. Save to keep them.");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await browser.storage.local.set(collect());
    show("Saved.");
  } catch (err) {
    show(err.message, true);
  }
});

render(await browser.storage.local.get(DEFAULT_SETTINGS));
