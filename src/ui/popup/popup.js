// Popup: role switch, Fill (all frames), one-click application logging.
// Only this extension page writes to the application store; the content script just reads the page.
import { addApplication, updateApplication, localDate } from "../../track/store.js";
import { createLogFlow, fillAllFrames } from "./log-flow.js";

const $ = (id) => document.getElementById(id);
const DEFAULT_ROLE = "genai";
let roleLabels = { genai: "GenAI Engineer" };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function currentRole() {
  return $("role").value || DEFAULT_ROLE;
}

async function initRoles() {
  let saved = DEFAULT_ROLE;
  try {
    const s = await chrome.storage.local.get("selectedRole");
    saved = s.selectedRole || DEFAULT_ROLE;
  } catch { /* default */ }
  try {
    const res = await chrome.runtime.sendMessage({ action: "getProfile" });
    if (res?.ok && res.profile?.roles) {
      roleLabels = Object.fromEntries(
        Object.entries(res.profile.roles).map(([k, r]) => [k, r.label || k])
      );
    }
  } catch { /* keep fallback labels */ }
  const sel = $("role");
  for (const [key, label] of Object.entries(roleLabels)) {
    const o = document.createElement("option");
    o.value = key;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = roleLabels[saved] ? saved : Object.keys(roleLabels)[0];
  sel.addEventListener("change", () => {
    chrome.storage.local.set({ selectedRole: sel.value });
  });
}

// ---------- fill ----------
function renderResult(t) {
  const box = $("result");
  if (!t.responded) {
    box.textContent = "No frame responded — try reloading the page";
    return;
  }
  box.textContent = `Scanned ${t.scanned} · filled ${t.filled} · skipped ${t.skipped}`;
  if (t.errors.length) {
    const ul = document.createElement("ul");
    ul.className = "jfa-errors";
    for (const e of t.errors) {
      const li = document.createElement("li");
      li.textContent = e;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}

async function onFill() {
  const btn = $("fill");
  btn.disabled = true;
  $("result").textContent = "Filling…";
  try {
    const tab = await activeTab();
    renderResult(await fillAllFrames({
      getAllFrames: (o) => chrome.webNavigation.getAllFrames(o),
      sendMessage: (id, m, o) => chrome.tabs.sendMessage(id, m, o)
    }, tab.id, currentRole()));
  } catch (e) {
    $("result").textContent = String(e?.message || e);
  } finally {
    btn.disabled = false;
  }
}

// ---------- log this application ----------
function makeFlow() {
  const captureFn = async () => {
    const tab = await activeTab();
    return chrome.tabs.sendMessage(tab.id, { action: "capture", roleKey: currentRole() }, { frameId: 0 });
  };
  captureFn.fallback = async () => {
    const cap = { company: "", jobTitle: "", state: "Applied", domain: "", jobUrl: "",
                  roleFamily: currentRole(), appliedAt: localDate() };
    try {
      const tab = await activeTab();
      if (tab?.url) {
        cap.jobUrl = tab.url;
        cap.domain = new URL(tab.url).hostname.replace(/^www\./, "");
      }
    } catch { /* leave blank */ }
    return cap;
  };
  return createLogFlow({
    els: { form: $("logForm"), fields: $("logFields"), dup: $("dupWarning"),
           hint: $("logHint"), status: $("logStatus"), save: $("logSave") },
    store: { addApplication, updateApplication },
    capture: captureFn,
    roleLabels,
    onDone: (t) => { $("result").textContent = t; }
  });
}

async function main() {
  await initRoles();
  $("fill").addEventListener("click", onFill);
  const flow = makeFlow();
  $("logToggle").addEventListener("click", () => ($("logForm").hidden ? flow.open() : flow.cancel()));
  $("logCancel").addEventListener("click", () => flow.cancel());
  $("logForm").addEventListener("submit", flow.submit);
  $("openDashboard").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });
  $("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

main();
