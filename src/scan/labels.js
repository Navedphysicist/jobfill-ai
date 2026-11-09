// Label resolution, ported from v1 content.js. Heuristics intentionally unchanged.
export function textOf(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function esc(doc, s) {
  const css = doc.defaultView?.CSS;
  return css?.escape ? css.escape(s) : String(s).replace(/["\\]/g, "\\$&");
}

const NON_CONTENT = "head, script, style, title, noscript, template";

// Visible text of a sibling, ignoring non-content elements; "" for non-content siblings themselves.
function contentText(node) {
  if (node.matches(NON_CONTENT)) return "";
  const clone = node.cloneNode(true);
  clone.querySelectorAll(NON_CONTENT).forEach((n) => n.remove());
  return textOf(clone);
}

export function labelFor(el) {
  try {
    const doc = el.ownerDocument;
    if (el.id) {
      const lab = doc.querySelector(`label[for="${esc(doc, el.id)}"]`);
      if (lab && textOf(lab)) return textOf(lab);
    }
    const wrap = el.closest("label");
    if (wrap && textOf(wrap)) return textOf(wrap).slice(0, 300);
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => textOf(doc.getElementById(id))).join(" ").trim();
      if (t) return t;
    }
    // A label belongs to another field if it targets a different element or wraps another control.
    const foreign = (lab) => {
      // A legend only names the fieldset it belongs to.
      if (lab.tagName === "LEGEND" && !lab.closest("fieldset")?.contains(el)) return true;
      if (lab.tagName === "LABEL") {
        const f = lab.getAttribute("for");
        if (f) { const t = doc.getElementById(f); if (t && t !== el) return true; }
      }
      return Array.from(lab.querySelectorAll("input,select,textarea")).some((c) => c !== el);
    };
    let node = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      // body, html and anything above are never a label source (page title, headers, etc.)
      if (node.tagName === "BODY" || node.tagName === "HTML") break;
      const lab = Array.from(node.querySelectorAll("label, legend, [class*='label' i]"))
        .find((l) => !l.contains(el) && textOf(l) && !foreign(l));
      if (lab) return textOf(lab).slice(0, 300);
      const own = Array.from(node.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(" ")
        .trim();
      if (own) return own.slice(0, 300);
      // question text often sits in a sibling immediately above the control's container
      const prev = node.previousElementSibling;
      if (prev && !prev.querySelector("input,select,textarea,button") && contentText(prev) && !foreign(prev)) {
        return contentText(prev).slice(0, 300);
      }
    }
    return el.getAttribute("placeholder") || el.name || el.id || "";
  } catch {
    return "";
  }
}
