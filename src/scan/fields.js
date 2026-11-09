import { labelFor, textOf } from "./labels.js";
import { visible, scanWidgets } from "./widgets.js";

export function groupLabel(radioEl) {
  const fs = radioEl.closest("fieldset");
  if (fs) {
    const lg = fs.querySelector("legend");
    if (lg && textOf(lg)) return textOf(lg).slice(0, 300);
  }
  let node = radioEl.closest("div,section,li");
  for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
    const lab = node.querySelector("label:not([for]), legend, [class*='label' i], [class*='question' i]");
    if (lab && !lab.contains(radioEl) && textOf(lab)) return textOf(lab).slice(0, 300);
  }
  return labelFor(radioEl);
}

export function radioOptionLabel(el) {
  const doc = el.ownerDocument;
  if (el.id) {
    const css = doc.defaultView?.CSS;
    const id = css?.escape ? css.escape(el.id) : el.id;
    const lab = doc.querySelector(`label[for="${id}"]`);
    if (lab && textOf(lab)) return textOf(lab);
  }
  const wrap = el.closest("label");
  if (wrap && textOf(wrap)) return textOf(wrap);
  return el.value || "";
}

export function scanFields(doc) {
  let fieldSeq = 0;
  const radioGroups = new Map();
  const fields = [];

  // Ids restart each scan, so clear stale markers: a leftover data-jfa-id could otherwise
  // match the wrong element (or hide a widget from the rescan).
  for (const el of doc.querySelectorAll("[data-jfa-id]")) delete el.dataset.jfaId;

  const formIdx = (el) => (el.form ? Array.from(doc.forms).indexOf(el.form) : -1);

  for (const el of doc.querySelectorAll("input, select, textarea")) {
    const type = (el.type || "").toLowerCase();
    if (["hidden", "password", "file", "submit", "button", "image", "reset"].includes(type)) continue;
    if (el.disabled || el.readOnly || !visible(el)) continue;
    if (el.closest("[data-jobfill-ui]")) continue;

    if (type === "radio") {
      const key = `${formIdx(el)}::${el.name || labelFor(el)}::radio`;
      if (!radioGroups.has(key)) {
        radioGroups.set(key, []);
        fields.push({ id: `jfa-${++fieldSeq}`, kind: "radio", label: groupLabel(el) || el.name || "", options: [], groupKey: key });
      }
      radioGroups.get(key).push(el);
      const f = fields.find((x) => x.groupKey === key);
      if (f) f.options.push(radioOptionLabel(el));
      continue;
    }

    const id = `jfa-${++fieldSeq}`;
    el.dataset.jfaId = id;

    if (el.tagName === "SELECT") {
      const options = Array.from(el.options).map((o) => o.text.trim()).filter(Boolean).slice(0, 150);
      fields.push({ id, kind: "select", label: labelFor(el), options, currentValue: el.selectedOptions[0]?.text || "" });
    } else if (type === "checkbox") {
      fields.push({ id, kind: "checkbox", label: labelFor(el), currentValue: String(el.checked) });
    } else if (el.tagName === "TEXTAREA") {
      fields.push({ id, kind: "textarea", label: labelFor(el), placeholder: el.placeholder || "", currentValue: el.value.slice(0, 200) });
    } else {
      fields.push({ id, kind: "input", inputType: type || "text", label: labelFor(el), placeholder: el.placeholder || "", currentValue: el.value.slice(0, 200) });
    }
  }

  fields.push(...scanWidgets(doc, fieldSeq));
  return { fields, radioGroups };
}
