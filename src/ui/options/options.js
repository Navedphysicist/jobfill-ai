// src/ui/options/options.js
import { loadProfile, saveProfile, resetProfile, setDefaultProfile }
  from "../../profile/load.js";
import { resolveProfile } from "../../profile/resolve.js";
import { validateProfile, ROLE_KEYS } from "../../profile/schema.js";
import { DEFAULT_RATES_INR, hasRate } from "../../ai/usage.js";
import { DEFAULT_SETTINGS } from "../../settings-defaults.js";
import { renderFormView, readFormView } from "./render-form.js";


let current = null;

const $ = (id) => document.getElementById(id);

function status(msg, isError) {
  const el = $("status");
  el.textContent = msg;
  el.style.color = isError ? "var(--err)" : "var(--accent)";
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 4000);
}

function showTab(name) {
  for (const btn of document.querySelectorAll(".jfa-tabs button")) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  for (const sec of document.querySelectorAll(".jfa-tab")) {
    sec.hidden = sec.id !== `tab-${name}`;
  }
  if (name === "preview") renderPreview();
}

function renderForm() {
  const root = $("formRoot");
  root.textContent = "";
  root.appendChild(renderFormView(current));
}

function renderPreview() {
  const sel = $("previewRole");
  if (!sel.options.length) {
    for (const key of ROLE_KEYS) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = current.roles?.[key]?.label || key;
      sel.appendChild(opt);
    }
  }
  $("previewOut").textContent = JSON.stringify(resolveProfile(current, sel.value), null, 2);
}

function showErrors(errors) {
  for (const id of ["jsonErrors", "formErrors"]) {
    const ul = $(id);
    ul.textContent = "";
    for (const e of errors) {
      const li = document.createElement("li");
      li.textContent = e.path ? `${e.path}: ${e.message}` : e.message;
      ul.appendChild(li);
    }
  }
}

async function commit(next) {
  const res = await saveProfile(next);
  if (!res.ok) {
    showErrors(res.errors);
    status(`${res.errors.length} validation error(s) — nothing was saved`, true);
    return false;
  }
  showErrors([]);
  current = await loadProfile();
  $("jsonEditor").value = JSON.stringify(current, null, 2);
  renderForm();
  status("Saved");
  return true;
}

async function init() {
  const res = await fetch(chrome.runtime.getURL("profile.json"));
  setDefaultProfile(await res.json());

  current = await loadProfile();
  $("jsonEditor").value = JSON.stringify(current, null, 2);
  renderForm();

  const { settings, rates } = await chrome.storage.local.get(["settings", "rates"]);
  $("rates").value = JSON.stringify(rates || DEFAULT_RATES_INR, null, 2);
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  $("apiKey").value = s.apiKey;
  $("fastModel").value = s.fastModel;
  $("qualityModel").value = s.qualityModel;
  $("baseUrl").value = s.baseUrl;

  for (const btn of document.querySelectorAll(".jfa-tabs button")) {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  }
  $("previewRole").addEventListener("change", renderPreview);

  $("saveSettings").addEventListener("click", async () => {
    let newRates;
    try {
      newRates = JSON.parse($("rates").value);
      if (!newRates || typeof newRates !== "object" || Array.isArray(newRates)) throw new Error("must be an object");
    } catch (e) {
      status(`Model prices are not valid JSON (${e.message}) \u2014 nothing was saved`, true);
      return;
    }
    const fastModel = $("fastModel").value.trim() || DEFAULT_SETTINGS.fastModel;
    const qualityModel = $("qualityModel").value.trim() || DEFAULT_SETTINGS.qualityModel;
    await chrome.storage.local.set({
      settings: {
        apiKey: $("apiKey").value.trim(),
        fastModel,
        qualityModel,
        baseUrl: $("baseUrl").value.trim() || DEFAULT_SETTINGS.baseUrl
      }
    });
    // Persist rates only when edited, so future default changes still reach the user.
    if (JSON.stringify(newRates) === JSON.stringify(DEFAULT_RATES_INR)) {
      await chrome.storage.local.remove("rates");
    } else {
      await chrome.storage.local.set({ rates: newRates });
    }
    const unpriced = [...new Set([fastModel, qualityModel])].filter((m) => !hasRate(newRates, m));
    if (unpriced.length) {
      status(
        unpriced.map((m) => `No rate configured for '${m}'`).join("; ") +
        " \u2014 spend for it will report as \u20B90 until you add one.", true);
      return;
    }
    status("Settings saved");
  });

  $("clearCache").addEventListener("click", async () => {
    // Via the worker: the cache's write queue lives in the worker's JS context.
    let res;
    try {
      res = await chrome.runtime.sendMessage({ action: "clearCache" });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (res && res.ok) status("Answer cache cleared");
    else status(`Could not clear the cache: ${(res && res.error) || "no response"}`, true);
  });

  $("saveForm").addEventListener("click", () => commit(readFormView($("formRoot"), current)));

  $("saveJson").addEventListener("click", async () => {
    let parsed;
    try {
      parsed = JSON.parse($("jsonEditor").value);
    } catch (e) {
      showErrors([{ path: "", message: `Invalid JSON — ${e.message}` }]);
      status("Invalid JSON — nothing was saved", true);
      return;
    }
    const { valid, errors } = validateProfile(parsed);
    if (!valid) {
      showErrors(errors);
      status(`${errors.length} validation error(s) — nothing was saved`, true);
      return;
    }
    await commit(parsed);
  });

  $("resetProfile").addEventListener("click", async () => {
    if (!confirm("Reset your profile to the bundled profile.json? Any edits you have made will be lost.")) return;
    showErrors([]);
    current = await resetProfile();
    $("jsonEditor").value = JSON.stringify(current, null, 2);
    renderForm();
    status("Reset to the bundled profile.json");
  });

  $("exportJson").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "profile.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("importJson").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await commit(JSON.parse(await file.text()));
    } catch (err) {
      status(`Import failed — ${err.message}`, true);
    }
    e.target.value = "";
  });
}

init().catch((e) => status(`Failed to load: ${e.message}`, true));
