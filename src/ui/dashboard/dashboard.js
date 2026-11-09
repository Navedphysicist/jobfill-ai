// Dashboard wiring: storage access, filters, inline edits, delete, export.
import { addApplication, listApplications, updateApplication, deleteApplication, APPLICATION_STATES }
  from "../../track/store.js";
import { toCsv, toJson } from "../../track/export.js";
import { ROLE_KEYS } from "../../profile/schema.js";
import { renderTable, summarize } from "./table.js";

const $ = (id) => document.getElementById(id);

let roleLabels = Object.fromEntries(ROLE_KEYS.map((k) => [k, k]));
let rows = [];

function showStatus(msg) {
  $("status").textContent = msg || "";
}

function currentFilter() {
  const f = {};
  if ($("filterState").value) f.state = $("filterState").value;
  if ($("filterRole").value) f.roleFamily = $("filterRole").value;
  if ($("search").value.trim()) f.search = $("search").value.trim();
  if ($("from").value) f.from = $("from").value;
  if ($("to").value) f.to = $("to").value;
  return f;
}

function renderSummary() {
  const { total, byState } = summarize(rows);
  const root = $("summary");
  root.replaceChildren();
  const make = (text) => {
    const c = document.createElement("span");
    c.className = "chip";
    c.textContent = text;
    root.appendChild(c);
  };
  make(`Total ${total}`);
  for (const s of APPLICATION_STATES) if (byState[s]) make(`${s} ${byState[s]}`);
}

function render() {
  renderSummary();
  $("tableRoot").replaceChildren(renderTable(rows, { roleLabels }));
}

let reloadSeq = 0;

function updateExportLabels() {
  $("exportCsv").textContent = `Export ${rows.length} shown (CSV)`;
  $("exportJson").textContent = `Export ${rows.length} shown (JSON)`;
}

async function reload() {
  const seq = ++reloadSeq;
  let next;
  let err = "";
  try {
    next = await listApplications(currentFilter());
  } catch (e) {
    next = [];
    err = `Could not load applications: ${(e && e.message) || e}`;
  }
  if (seq !== reloadSeq) return; // a newer reload superseded this one
  rows = next;
  showStatus(err);
  render();
  updateExportLabels();
}

function fillSelect(sel, firstLabel, entries) {
  sel.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = firstLabel;
  sel.appendChild(all);
  for (const [value, label] of entries) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }
}

async function loadRoleLabels() {
  try {
    const res = await chrome.runtime.sendMessage({ action: "getProfile" });
    if (res?.ok && res.profile?.roles) {
      roleLabels = Object.fromEntries(
        Object.entries(res.profile.roles).map(([k, r]) => [k, r.label || k])
      );
    }
  } catch { /* keep key fallbacks */ }
}

// Inline edit: persist, and if the store refuses, tell the user and put the
// control back to the last saved value so the UI never shows an unsaved one.
async function onFieldChange(e) {
  const el = e.target.closest("[data-field]");
  const tr = e.target.closest("tr[data-id]");
  if (!el || !tr) return;
  const field = el.dataset.field;
  const row = rows.find((r) => r.id === tr.dataset.id);
  if (!row) return;
  const previous = row[field] ?? "";
  let res;
  try {
    res = await updateApplication(row.id, { [field]: el.value });
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!res || !res.ok) {
    el.value = previous;
    showStatus(`Not saved (${row.company}): ${(res && res.error) || "unknown error"}`);
    return;
  }
  row[field] = el.value;
  showStatus("");
  renderSummary();
}

async function onDelete(e) {
  const btn = e.target.closest('[data-action="delete"]');
  const tr = e.target.closest("tr[data-id]");
  if (!btn || !tr) return;
  const row = rows.find((r) => r.id === tr.dataset.id);
  if (!row) return;
  if (!confirm(`Delete the ${row.company} application? This cannot be undone.`)) return;
  let res;
  try {
    res = await deleteApplication(row.id);
  } catch (err) {
    res = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!res || !res.ok) {
    showStatus(`Not deleted (${row.company}): ${(res && res.error) || "unknown error"}`);
    return;
  }
  await reload();
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const inr = (n) => `\u20B9${(Number(n) || 0).toFixed(2)}`;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// Goes through the worker so the cache's queue (per JS context) is the worker's.
async function renderUsage() {
  const root = $("usage");
  root.replaceChildren();
  let res;
  try {
    res = await chrome.runtime.sendMessage({ action: "usageSummary" });
  } catch (e) {
    res = { ok: false, error: (e && e.message) || String(e) };
  }
  const h = document.createElement("h2");
  h.textContent = "AI usage";
  root.appendChild(h);
  if (!res || !res.ok) {
    const p = document.createElement("p");
    p.textContent = `Usage unavailable: ${(res && res.error) || "no response"}`;
    root.appendChild(p);
    return;
  }
  const { totals: t, cache: c, unpricedCalls = 0 } = res;
  const lookups = (c.hits || 0) + (c.misses || 0);
  const chips = document.createElement("div");
  chips.className = "chips";
  for (const text of [
    `Calls ${t.calls}`,
    `Prompt tokens ${t.promptTokens}`,
    `Cached tokens ${t.cachedTokens} (${pct(t.cachedTokens, t.promptTokens)}%)`,
    `Completion tokens ${t.completionTokens}`,
    `Estimated spend ${inr(t.estimatedCost)}${unpricedCalls ? ` (${unpricedCalls} calls unpriced)` : ""}`,
    `Answer cache hit rate ${pct(c.hits || 0, lookups)}% (${c.hits || 0}/${lookups})`
  ]) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = text;
    chips.appendChild(chip);
  }
  root.appendChild(chips);
}

async function init() {
  await loadRoleLabels();
  fillSelect($("filterState"), "All states", APPLICATION_STATES.map((s) => [s, s]));
  fillSelect($("filterRole"), "All roles", Object.entries(roleLabels));

  for (const id of ["filterState", "filterRole", "from", "to"]) $(id).addEventListener("change", reload);
  $("search").addEventListener("input", reload);

  const root = $("tableRoot");
  root.addEventListener("change", onFieldChange);
  root.addEventListener("click", onDelete);

  // "shown" buttons write the filtered rows; "Export all" ignores filters.
  const exportRows = (list, name, build, type) => {
    if (!list.length) { showStatus("Nothing to export."); return; }
    showStatus("");
    download(name, build(list), type);
  };
  $("exportCsv").addEventListener("click", () => exportRows(rows, "applications.csv", toCsv, "text/csv"));
  $("exportJson").addEventListener("click", () => exportRows(rows, "applications.json", toJson, "application/json"));
  $("exportAllCsv").addEventListener("click", async () => {
    try {
      exportRows(await listApplications({}), "applications.csv", toCsv, "text/csv");
    } catch (e) {
      showStatus(`Export failed: ${(e && e.message) || e}`);
    }
  });

  await reload();
  await renderUsage();
}

init();

// Intentional e2e seam (Playwright): extension-origin only, unreachable from web pages,
// exposes only add/list of the user's own log. Do not remove as a "leak".
window.__jobfillTrackForTest = { addApplication, listApplications };
