import { DEFAULT_SETTINGS } from "./settings.js";
import { FIREFOX_ML_PERMISSION } from "./firefox-ml.js";
import { SEND_TAB_DATA, checkService, isLocal } from "./ai-service.js";

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
const nameWithAi = document.getElementById("nameWithAi");
const renameGrowingGroups = document.getElementById("renameGrowingGroups");
const aiSettings = document.getElementById("aiSettings");
const apiUrl = document.getElementById("apiUrl");
const apiKey = document.getElementById("apiKey");
const apiModel = document.getElementById("apiModel");

// Lets Tabcat show "Moved … — Undo" in the page you're on. Granted at install; you can turn
// it off in about:addons.
const ALL_SITES = { origins: ["<all_urls>"] };

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
  showAiSettings();
}

function usesAi() {
  const mode = selectedMode();
  return (mode === "auto" && nameWithAi.checked) || (mode === "categories" && provider.value === "ai");
}

// The AI service's settings are only shown while something uses it.
function showAiSettings() {
  aiSettings.hidden = !usesAi();
}

// Only the chosen model's settings are shown; disabling layad's also stops its URL blocking Save.
function showProvider(value) {
  tabcatHint.hidden = value !== "tabcat";
  firefoxSettings.hidden = value !== "firefox";
  layaUrl.disabled = layaSettings.hidden = value !== "laya";
  showAiSettings();
}

async function showFirefoxPermission() {
  const granted = await browser.permissions.contains(FIREFOX_ML_PERMISSION);
  firefoxStatus.textContent = granted
    ? "Tabcat is allowed to use Firefox's built-in AI."
    : "Tabcat needs your permission to use Firefox's built-in AI.";
  allowFirefox.hidden = granted;
}

async function showToastPermission() {
  toastStatus.hidden = !keepOrganised.checked || (await browser.permissions.contains(ALL_SITES));
}

function render(settings) {
  for (const input of modeInputs) input.checked = input.value === settings.mode;
  showMode(settings.mode);
  keepOrganised.checked = settings.keepOrganised;
  newGroupForLoneTabs.checked = settings.newGroupForLoneTabs;
  nameWithAi.checked = settings.nameWithAi;
  renameGrowingGroups.checked = settings.renameGrowingGroups;
  apiUrl.value = settings.apiUrl;
  apiKey.value = settings.apiKey;
  apiModel.value = settings.apiModel;
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
    newGroupForLoneTabs: newGroupForLoneTabs.checked, nameWithAi: nameWithAi.checked,
    renameGrowingGroups: renameGrowingGroups.checked,
    groupingThreshold: Number(groupingThreshold.value), provider: provider.value };
  if (provider.value === "laya") {
    let url;
    try {
      url = new URL(layaUrl.value.trim());
    } catch {
      throw new Error("layad URL isn't a valid URL.");
    }
    // Tab data must stay on this machine.
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error("layad URL must be http://127.0.0.1:<port>.");
    }
    settings.layaUrl = url.origin;
  }

  if (usesAi()) {
    const { url, key, model } = checkService({ url: apiUrl.value, key: apiKey.value, model: apiModel.value });
    Object.assign(settings, { apiUrl: url, apiKey: key, apiModel: model });
  } else {
    Object.assign(settings, { apiUrl: apiUrl.value.trim(), apiKey: apiKey.value.trim(), apiModel: apiModel.value.trim() });
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
nameWithAi.addEventListener("change", showAiSettings);

allowFirefox.addEventListener("click", async () => {
  // Must run straight from the click: Firefox only shows permission prompts for user actions.
  await browser.permissions.request(FIREFOX_ML_PERMISSION);
  await showFirefoxPermission();
});

keepOrganised.addEventListener("change", showToastPermission);

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
    const settings = collect();
    // Sending tab data off this computer needs Firefox's data collection permission. The
    // request must come straight from the click, before any other await.
    if (usesAi() && !isLocal(settings.apiUrl) && !(await browser.permissions.request(SEND_TAB_DATA))) {
      throw new Error("Not saved: Tabcat needs your permission to send tab data to your AI service.");
    }
    await browser.storage.local.set(settings);
    show("Saved.");
  } catch (err) {
    show(err.message, true);
  }
});

render(await browser.storage.local.get(DEFAULT_SETTINGS));
await showFirefoxPermission();
await showToastPermission();
