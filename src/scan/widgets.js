import { labelFor, textOf } from "./labels.js";

export const WIDGET_SELECTOR = [
  "button[aria-haspopup='listbox']",
  "div[aria-haspopup='listbox']",
  "button[data-automation-id*='select' i]",
  "[role='combobox']"
].join(", ");

const layoutCache = new WeakMap();
function hasLayout(doc) {
  if (!layoutCache.has(doc)) {
    const b = doc.body;
    layoutCache.set(doc, !!b && (b.offsetWidth > 0 || b.offsetHeight > 0));
  }
  return layoutCache.get(doc);
}

export function visible(el) {
  const doc = el.ownerDocument;
  const style = doc.defaultView.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  // jsdom reports zero dimensions for everything, so the geometry test is meaningless
  // there; skip it only when the document has no layout engine at all.
  if (hasLayout(doc) && !el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
  return true;
}

// Custom dropdown widgets (Workday, Greenhouse, etc.) — options hidden until opened.
export function scanWidgets(doc, startSeq = 0) {
  let seq = startSeq;
  const fields = [];
  for (const el of doc.querySelectorAll(WIDGET_SELECTOR)) {
    if (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) continue; // already handled
    if (el.dataset.jfaId || !visible(el) || el.closest("[data-jobfill-ui]")) continue;
    const label = labelFor(el); // may be "" — emitted anyway, never dropped
    const id = `jfa-${++seq}`;
    el.dataset.jfaId = id;
    fields.push({ id, kind: "widget", label, currentValue: textOf(el).slice(0, 100) });
  }
  return fields;
}
