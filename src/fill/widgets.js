import { matchOption } from "./apply.js";
import { textOf } from "../scan/labels.js";
import { clickWithoutSubmitting } from "./click.js";
import { visible } from "../scan/widgets.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function defaultWaitFor(fn, timeout = 2500, interval = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

const OPTION_SELECTOR =
  "[role='option'], [data-automation-id='menuItem'], [data-automation-id*='promptOption'], [role='listbox'] li";

// A control that would submit a form if clicked. The extension must never do that.
function isSubmitControl(el) {
  const tag = el.tagName;
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (tag === "INPUT") return type === "submit" || type === "image";
  if (tag === "BUTTON") return !!el.form && (type === "submit" || type === "");
  return false;
}

// The option itself gets the scanner's full visible() test (as v1). Ancestors only get
// the cheap hidden checks: geometry tests are wrong for position:fixed poppers and
// display:contents wrappers used by portal-rendered menus.
function shown(el) {
  if (!visible(el)) return false;
  const win = el.ownerDocument.defaultView;
  for (let n = el; n; n = n.parentElement) {
    if (n.hidden || n.getAttribute("aria-hidden") === "true") return false;
    const st = win.getComputedStyle(n);
    if (st.display === "none" || st.visibility === "hidden") return false;
  }
  return true;
}

// Dropdown triggers are often untyped <button>s inside a <form>; a real submit button
// never carries these.
function isDropdownTrigger(el) {
  return el.getAttribute("aria-haspopup") === "listbox" || el.getAttribute("role") === "combobox";
}

function closePopups(doc) {
  doc.body.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

export async function applyWidgetAnswer(el, value, { waitFor, sleep: pause = sleep, timeout, interval } = {}) {
  if (!el) return false;
  const declared = (el.getAttribute("type") || "").toLowerCase();
  if (declared === "submit" || (isSubmitControl(el) && !isDropdownTrigger(el))) {
    console.warn("[JobFill] skipped a dropdown whose trigger looks like a submit button", el);
    return false; // clicking it would submit the form
  }
  waitFor ??= (fn) => defaultWaitFor(fn, timeout, interval);
  const doc = el.ownerDocument;

  el.scrollIntoView?.({ block: "center" });
  await pause(80);
  clickWithoutSubmitting(el);

  const options = await waitFor(() => {
    const list = Array.from(doc.querySelectorAll(OPTION_SELECTOR))
      .filter((o) => shown(o) && !isSubmitControl(o));
    return list.length ? list : null;
  });
  if (!options) {
    closePopups(doc);
    return false;
  }

  const i = matchOption(options.map(textOf), value);
  if (i === -1) {
    closePopups(doc);
    return false;
  }

  clickWithoutSubmitting(options[i]);
  await pause(150);
  closePopups(doc);
  return true;
}
