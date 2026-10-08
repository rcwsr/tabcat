import { DEFAULT_SETTINGS, EXAMPLE_CATEGORIES, loadSettings } from "./settings.js";
import { SAMPLE_TABS, SEND_TAB_DATA, chat, checkAddress, checkService, isLocal, listModels, namingMessages, parseNames } from "./ai-service.js";

const $ = (id) => document.getElementById(id);
const form = $("settings");
const status = $("status");
const categoryList = $("categories");
const rowTemplate = $("categoryRow");
const checkboxes = ["keepOrganised", "newGroupForLoneTabs", "renameGrowingGroups", "showToast", "markGroups", "useAi"];
const fields = ["apiUrl", "apiKey", "apiModel", "apiPrompt"];

// Lets Tabcat show its message in the page you're on (and read pages' descriptions).
// Granted at install; you can turn it off in about:addons.
const ALL_SITES = { origins: ["<all_urls>"] };

function show(text, isError = false) {
  status.textContent = text;
  status.className = isError ? "error" : "";
}

function addCategoryRow(name = "", about = "") {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector(".key").value = name;
  row.querySelector(".criteria").value = about;
  row.querySelector(".remove").addEventListener("click", () => row.remove());
  categoryList.append(row);
  return row;
}

const categoryNames = () => [...categoryList.querySelectorAll(".key")].map((input) => input.value.trim().toLowerCase());

// The AI service's settings are only shown while it's turned on.
function showAiSettings() {
  $("aiSettings").hidden = !$("useAi").checked;
  showModels();
}

// The service's models, to choose from. If it can't list them, you type the name instead.
// A long list (OpenRouter has hundreds) gets a search box.
const LONG_LIST = 20;
let listing = 0;
let listed = [];

function fillModelList() {
  const words = $("modelSearch").value.trim().toLowerCase();
  const current = $("apiModel").value.trim();
  const names = listed.filter((name) => name.toLowerCase().includes(words));
  // The chosen model stays, even if the service doesn't list it (not downloaded any more,
  // say) or the search leaves it out.
  if (current && !names.includes(current)) names.unshift(current);
  $("modelList").replaceChildren(...(current ? [] : [new Option("Choose a model", "")]), ...names.map((name) => new Option(name, name)));
  $("modelList").value = current;
}

async function showModels() {
  const ask = ++listing;
  const [list, input, problem] = [$("modelList"), $("apiModel"), $("modelProblem")];
  let models = [];
  let error = "";
  if ($("useAi").checked && $("apiUrl").value.trim()) {
    try {
      models = await listModels({ apiUrl: checkAddress($("apiUrl").value), apiKey: $("apiKey").value.trim() });
    } catch (err) {
      error = `Couldn't list the models: ${err.message}`;
    }
  }
  // The address or key changed while this one was asking.
  if (ask !== listing) return;
  listed = models;
  $("modelSearch").value = "";
  $("modelSearch").hidden = models.length <= LONG_LIST;
  fillModelList();
  list.hidden = !models.length;
  input.hidden = models.length > 0;
  problem.hidden = !error;
  problem.textContent = error;
}

async function showToastPermission() {
  $("toastStatus").hidden = !$("showToast").checked || (await browser.permissions.contains(ALL_SITES));
}

function render(settings) {
  for (const id of checkboxes) $(id).checked = settings[id];
  for (const id of fields) $(id).value = settings[id];
  $("groupingThreshold").value = settings.groupingThreshold;
  $("tabOrder").value = settings.tabOrder;
  categoryList.replaceChildren();
  for (const [name, about] of Object.entries(settings.categories)) addCategoryRow(name, about);
  showAiSettings();
}

// Returns settings to save, or throws with a message for the user.
function collect() {
  const settings = Object.fromEntries(checkboxes.map((id) => [id, $(id).checked]));
  Object.assign(settings, {
    groupingThreshold: Number($("groupingThreshold").value),
    tabOrder: $("tabOrder").value,
    apiPrompt: $("apiPrompt").value.trim(),
  });
  if (settings.useAi) {
    const { url, key, model } = checkService({ url: $("apiUrl").value, key: $("apiKey").value, model: $("apiModel").value });
    Object.assign(settings, { apiUrl: url, apiKey: key, apiModel: model });
  } else {
    Object.assign(settings, { apiUrl: $("apiUrl").value.trim(), apiKey: $("apiKey").value.trim(), apiModel: $("apiModel").value.trim() });
  }
  const categories = {};
  for (const row of categoryList.querySelectorAll(".category")) {
    const name = row.querySelector(".key").value.trim();
    const about = row.querySelector(".criteria").value.trim();
    if (!name && !about) continue;
    if (!name || !about) throw new Error("Every category needs a name and a description.");
    if (Object.keys(categories).some((k) => k.toLowerCase() === name.toLowerCase())) {
      throw new Error(`There are two categories called “${name}”.`);
    }
    categories[name] = about;
  }
  return { ...settings, categories };
}

// What the AI service has cost so far.
async function showUsage() {
  const { aiUsage } = await browser.storage.local.get({ aiUsage: null });
  const n = (x) => x.toLocaleString();
  $("usage").textContent = aiUsage
    ? `Since ${new Date(aiUsage.since).toLocaleDateString(undefined, { day: "numeric", month: "long" })}: ` +
      `${n(aiUsage.requests)} request${aiUsage.requests === 1 ? "" : "s"}, ${n(aiUsage.input)} tokens sent and ${n(aiUsage.output)} received.`
    : "No requests yet.";
  $("resetUsage").hidden = !aiUsage;
  const { aiWarning } = await browser.storage.session.get({ aiWarning: null });
  $("aiWarning").hidden = !aiWarning;
  $("aiWarning").textContent = aiWarning ? `Last time, the service couldn't be used, so this computer did it all: ${aiWarning}` : "";
}

// The keyboard shortcut to the last moved tab, as set in Firefox.
async function showShortcut() {
  const [command] = (await browser.commands.getAll()).filter((c) => c.name === "show-last-move");
  $("shortcut").hidden = !command?.shortcut;
  $("shortcutKey").textContent = command?.shortcut ?? "";
  $("changeShortcut").hidden = !browser.commands.openShortcutSettings;
}

$("useAi").addEventListener("change", showAiSettings);
$("apiUrl").addEventListener("change", showModels);
$("apiKey").addEventListener("change", showModels);
$("modelList").addEventListener("change", () => ($("apiModel").value = $("modelList").value));
$("modelSearch").addEventListener("input", fillModelList);
$("showToast").addEventListener("change", showToastPermission);
$("addCategory").addEventListener("click", () => addCategoryRow().querySelector(".key").focus());

$("addExamples").addEventListener("click", () => {
  const have = new Set(categoryNames());
  // An empty row is replaced rather than left above the examples.
  for (const row of categoryList.querySelectorAll(".category")) {
    if (!row.querySelector(".key").value.trim() && !row.querySelector(".criteria").value.trim()) row.remove();
  }
  for (const [name, about] of Object.entries(EXAMPLE_CATEGORIES)) if (!have.has(name.toLowerCase())) addCategoryRow(name, about);
  show("Examples added. Change or remove any, then Save.");
});

$("testAi").addEventListener("click", async () => {
  const result = $("testResult");
  result.className = "";
  result.textContent = "Testing…";
  try {
    const { url, key, model } = checkService({ url: $("apiUrl").value, key: $("apiKey").value, model: $("apiModel").value });
    const start = performance.now();
    const { text } = await chat(
      { apiUrl: url, apiKey: key, apiModel: model },
      namingMessages(SAMPLE_TABS, [], $("apiPrompt").value),
      { sample: true },
    );
    const seconds = ((performance.now() - start) / 1000).toFixed(1);
    const [name] = parseNames(text, SAMPLE_TABS.length);
    result.textContent = name
      ? `It works: it named two tabs about a trip to Lisbon “${name}” (${seconds} s).`
      : `It answered, but not with a name: “${text.trim().slice(0, 80)}”`;
  } catch (err) {
    result.className = "error";
    result.textContent = err.message;
  }
});

$("resetUsage").addEventListener("click", async (event) => {
  event.preventDefault();
  await browser.storage.local.remove("aiUsage");
  await showUsage();
});

$("changeShortcut").addEventListener("click", (event) => {
  event.preventDefault();
  browser.commands.openShortcutSettings();
});

$("reset").addEventListener("click", () => {
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
    if (settings.useAi && !isLocal(settings.apiUrl) && !(await browser.permissions.request(SEND_TAB_DATA))) {
      throw new Error("Not saved: Tabcat needs your permission to send tab data to your AI service.");
    }
    await browser.storage.local.set(settings);
    show("Saved.");
  } catch (err) {
    show(err.message, true);
  }
});

render(await loadSettings());
await Promise.all([showToastPermission(), showUsage(), showShortcut()]);
