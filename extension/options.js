import { DEFAULT_SETTINGS } from "./settings.js";
import { FIREFOX_ML_PERMISSION } from "./firefox-ml.js";

const form = document.getElementById("settings");
const provider = document.getElementById("provider");
const layaUrl = document.getElementById("layaUrl");
const minConfidence = document.getElementById("minConfidence");
const minConfidenceValue = document.getElementById("minConfidenceValue");
const categoryList = document.getElementById("categories");
const rowTemplate = document.getElementById("categoryRow");
const status = document.getElementById("status");
const modeInputs = document.querySelectorAll('input[name="mode"]');
const autoSettings = document.getElementById("autoSettings");
const categorySettings = document.getElementById("categorySettings");
const modelSettings = document.getElementById("modelSettings");
const tabcatHint = document.getElementById("tabcatHint");
const firefoxSettings = document.getElementById("firefoxSettings");
const firefoxStatus = document.getElementById("firefoxStatus");
const allowFirefox = document.getElementById("allowFirefox");
const layaSettings = document.getElementById("layaSettings");
const groupingThreshold = document.getElementById("groupingThreshold");
const groupingThresholdValue = document.getElementById("groupingThresholdValue");
const keepOrganised = document.getElementById("keepOrganised");
const newGroupForLoneTabs = document.getElementById("newGroupForLoneTabs");
const toastStatus = document.getElementById("toastStatus");
const allowToasts = document.getElementById("allowToasts");

// Lets Tabcat show "Moved … — Undo" in the page you're on. It's only used to add that message.
const TOAST_PERMISSION = { origins: ["<all_urls>"] };

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

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value ?? "auto";
}

// Only the chosen mode's section is shown. Disabling the other one also stops its
// required fields from blocking Save.
function showMode(mode) {
  autoSettings.hidden = autoSettings.disabled = mode !== "auto";
  categorySettings.hidden = categorySettings.disabled = mode !== "categories";
  // Only categories mode uses the decision model.
  modelSettings.hidden = modelSettings.disabled = mode !== "categories";
}

// Only the chosen model's settings are shown; disabling layad's also stops its URL blocking Save.
function showProvider(value) {
  tabcatHint.hidden = value !== "tabcat";
  firefoxSettings.hidden = value !== "firefox";
  layaUrl.disabled = layaSettings.hidden = value !== "laya";
}

async function showFirefoxPermission() {
  const granted = await browser.permissions.contains(FIREFOX_ML_PERMISSION);
  firefoxStatus.textContent = granted
    ? "Tabcat is allowed to use Firefox's built-in AI."
    : "Tabcat needs your permission to use Firefox's built-in AI.";
  allowFirefox.hidden = granted;
}

async function showToastPermission() {
  const granted = await browser.permissions.contains(TOAST_PERMISSION);
  toastStatus.hidden = !keepOrganised.checked;
  toastStatus.textContent = granted
    ? "Each move shows a message with Undo at the bottom of the page you're on."
    : "To show a message with Undo on the page you're on, Tabcat needs permission to add it to websites. Without it, moves are listed in Tabcat's popup instead.";
  allowToasts.hidden = granted || !keepOrganised.checked;
}

function render(settings) {
  for (const input of modeInputs) input.checked = input.value === settings.mode;
  showMode(settings.mode);
  keepOrganised.checked = settings.keepOrganised;
  newGroupForLoneTabs.checked = settings.newGroupForLoneTabs;
  groupingThreshold.value = settings.groupingThreshold;
  groupingThresholdValue.textContent = Number(settings.groupingThreshold).toFixed(2);
  // A disabled option can't stay selected, so fall back to the bundled model.
  provider.value = provider.querySelector(`option[value="${settings.provider}"]:not([disabled])`)
    ? settings.provider
    : "tabcat";
  showProvider(provider.value);
  layaUrl.value = settings.layaUrl;
  minConfidence.value = settings.minConfidence;
  minConfidenceValue.textContent = Number(settings.minConfidence).toFixed(2);
  categoryList.replaceChildren();
  for (const [key, criteria] of Object.entries(settings.categories)) addCategoryRow(key, criteria);
}

// Returns settings to save, or throws with a message for the user.
function collect() {
  const settings = { mode: selectedMode(), keepOrganised: keepOrganised.checked,
    newGroupForLoneTabs: newGroupForLoneTabs.checked,
    groupingThreshold: Number(groupingThreshold.value), provider: provider.value };
  if (provider.value === "laya") {
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
    settings.layaUrl = url.origin;
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

  return { ...settings, minConfidence: Number(minConfidence.value), categories };
}

for (const input of modeInputs) input.addEventListener("change", () => showMode(selectedMode()));

groupingThreshold.addEventListener("input", () => {
  groupingThresholdValue.textContent = Number(groupingThreshold.value).toFixed(2);
});

provider.addEventListener("change", () => showProvider(provider.value));

allowFirefox.addEventListener("click", async () => {
  // Must run straight from the click: Firefox only shows permission prompts for user actions.
  await browser.permissions.request(FIREFOX_ML_PERMISSION);
  await showFirefoxPermission();
await showToastPermission();
});

keepOrganised.addEventListener("change", async () => {
  // Ask before awaiting anything else, while this still counts as a user action. If it's
  // already granted, Firefox doesn't ask again.
  if (keepOrganised.checked) await browser.permissions.request(TOAST_PERMISSION);
  await showToastPermission();
});

allowToasts.addEventListener("click", async () => {
  await browser.permissions.request(TOAST_PERMISSION);
  await showToastPermission();
});

minConfidence.addEventListener("input", () => {
  minConfidenceValue.textContent = Number(minConfidence.value).toFixed(2);
});

document.getElementById("addCategory").addEventListener("click", () => {
  addCategoryRow().querySelector(".key").focus();
});

document.getElementById("reset").addEventListener("click", () => {
  render(DEFAULT_SETTINGS);
  showToastPermission();
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
await showFirefoxPermission();
await showToastPermission();
