import { setNativeValue } from "./native.js";
import { clickWithoutSubmitting } from "./click.js";
import { textOf } from "../scan/labels.js";

// Index of the best match, or -1. Tiers (ported from v1): exact, startsWith,
// includes, then wanted-includes-option (option text longer than 1 char).
export function matchOption(optionTexts, wanted) {
  const v = String(wanted ?? "").toLowerCase().trim();
  if (!v) return -1;
  const norm = optionTexts.map((t) => String(t ?? "").toLowerCase().trim());
  let i = norm.findIndex((t) => t === v);
  if (i !== -1) return i;
  i = norm.findIndex((t) => t.startsWith(v));
  if (i !== -1) return i;
  i = norm.findIndex((t) => t.includes(v));
  if (i !== -1) return i;
  return norm.findIndex((t) => t.length > 1 && v.includes(t));
}

function radioOptionLabel(el) {
  if (el.id) {
    const css = el.ownerDocument.defaultView?.CSS;
    const id = css?.escape ? css.escape(el.id) : el.id.replace(/["\\]/g, "\\$&");
    const lab = el.ownerDocument.querySelector(`label[for="${id}"]`);
    if (lab && textOf(lab)) return textOf(lab);
  }
  const wrap = el.closest("label");
  if (wrap && textOf(wrap)) return textOf(wrap);
  return el.value || "";
}

// radioElements: the group's elements from scanFields' radioGroups (radios never carry
// a data-jfa-id, so the caller passes el=null for them). Returns true if anything was set.
export function applyAnswer(el, answer, radioElements) {
  const value = String(answer?.value ?? "").trim();
  if (!value) return false;

  if (radioElements?.length) {
    const i = matchOption(radioElements.map(radioOptionLabel), value);
    if (i === -1) return false;
    clickWithoutSubmitting(radioElements[i]); // click (not .checked=) so React radio handlers fire
    return radioElements[i].checked === true; // verified, not assumed
  }

  if (!el) return false;
  const win = el.ownerDocument.defaultView;

  if (el.tagName === "SELECT") {
    const i = matchOption(Array.from(el.options).map((o) => o.text), value);
    if (i === -1) return false;
    el.selectedIndex = i;
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    return el.selectedIndex === i;
  }

  if (el.type === "checkbox") {
    const want = ["true", "yes"].includes(value.toLowerCase());
    if (el.checked !== want) clickWithoutSubmitting(el);
    return el.checked === want; // already-in-state counts as success, verified
  }

  setNativeValue(el, value);
  return true;
}
