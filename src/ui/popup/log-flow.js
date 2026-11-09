// Testable popup logic: chrome and store calls are injected.
import { renderLogForm, readLogForm } from "./log-form.js";

// Fill every frame; sum the summaries. A frame that rejects (no content script) is skipped.
// `responded` counts frames that answered successfully.
export async function fillAllFrames({ getAllFrames, sendMessage }, tabId, roleKey) {
  let frames = [];
  try { frames = (await getAllFrames({ tabId })) || []; } catch { /* top frame only */ }
  const frameIds = frames.length ? frames.map((f) => f.frameId) : [0];
  const total = { scanned: 0, filled: 0, skipped: 0, errors: [], responded: 0 };
  await Promise.all(frameIds.map(async (frameId) => {
    try {
      const res = await sendMessage(tabId, { action: "fill", roleKey }, { frameId });
      if (!res) return;
      if (res.ok === false) {
        total.responded++;
        if (res.error) total.errors.push(res.error);
        return;
      }
      const s = res.summary || res;
      total.responded++;
      total.scanned += Number(s.scanned) || 0;
      total.filled += Number(s.filled) || 0;
      total.skipped += Number(s.skipped) || 0;
      if (Array.isArray(s.errors)) total.errors.push(...s.errors);
    } catch { /* frame without a content script */ }
  }));
  return total;
}

function btn(text, cls) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (cls) b.className = cls;
  b.setAttribute("data-jobfill-ui", "1");
  return b;
}

// els: { form, fields, dup, hint, status, save }
export function createLogFlow({ els, store, capture, roleLabels, onDone = () => {} }) {
  let dirty = false;
  let populated = false;

  els.form.addEventListener("input", () => { dirty = true; });

  function setBusy(busy) {
    if (els.save) els.save.disabled = busy;
    for (const b of els.dup.querySelectorAll("button")) b.disabled = busy;
  }

  let busy = false;
  async function guarded(fn) {
    if (busy) return; // re-entrant submits (double click, Enter) are ignored
    busy = true;
    setBusy(true);
    try { return await fn(); } finally { busy = false; setBusy(false); }
  }

  function complete(text) {
    els.form.hidden = true;
    els.dup.hidden = true;
    els.dup.replaceChildren();
    els.fields.replaceChildren();
    els.hint.hidden = true;
    dirty = false;
    populated = false;
    onDone(text);
  }

  function showDuplicate(duplicateOf, record) {
    const msg = document.createElement("div");
    msg.textContent = "This job URL is already logged.";
    const status = document.createElement("div");
    status.className = "dup-status";
    const fail = (t) => { status.textContent = t; };

    const upd = btn("Update existing");
    upd.addEventListener("click", () => guarded(async () => {
      const res = await store.updateApplication(duplicateOf, record);
      if (res?.ok) complete("Updated existing application.");
      else fail(`Could not update: ${res?.error || "unknown error"}`);
    }));
    const force = btn("Save anyway", "secondary");
    force.addEventListener("click", () => guarded(async () => {
      const res = await store.addApplication({ ...record, force: true });
      if (res?.ok) complete("Saved.");
      else fail(`Could not save: ${res?.error || "unknown error"}`);
    }));
    const keep = btn("Keep editing", "secondary");
    keep.addEventListener("click", () => { els.dup.hidden = true; });

    els.dup.replaceChildren(msg, upd, force, keep, status);
    els.dup.hidden = false;
  }

  async function open() {
    if (populated && dirty) { els.form.hidden = false; return; } // reuse typed input
    els.dup.hidden = true;
    let cap;
    try { cap = await capture(); } catch { cap = undefined; }
    const failed = !cap;
    if (failed) cap = await Promise.resolve(capture.fallback?.() ?? {});
    els.hint.textContent = failed ? "Couldn't read the page — please fill these in manually." : "";
    els.hint.hidden = !failed;
    els.fields.replaceChildren(renderLogForm(cap, { roleLabels }));
    populated = true;
    dirty = false;
    els.form.hidden = false;
  }

  function cancel() { els.form.hidden = true; } // keeps fields and dirty state

  async function submit(e) {
    e?.preventDefault?.();
    await guarded(async () => {
      els.status.textContent = "";
      const record = readLogForm(els.form);
      const res = await store.addApplication(record);
      if (res?.ok) return complete("Application logged.");
      if (res?.duplicateOf) return showDuplicate(res.duplicateOf, record);
      els.status.textContent = `Could not save: ${res?.error || "unknown error"}`;
    });
  }

  return { open, cancel, submit };
}
