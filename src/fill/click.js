// Make submission structurally impossible while we click. For EVERY form in the document:
// swallow submit events in the capture phase (requestSubmit, button activation) and shadow
// the instance's submit() with a no-op (form.submit() fires no event, so a listener cannot
// stop it). The document also gets a capture listener for form-less cases. Everything is
// restored in finally. Never touches HTMLFormElement.prototype.
export function clickWithoutSubmitting(el) {
  const doc = el.ownerDocument;
  const block = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const forms = Array.from(doc.forms);
  const owner = el.form ?? el.closest("form");
  if (owner && !forms.includes(owner)) forms.push(owner); // e.g. detached or shadow-DOM form

  const targets = [doc, ...forms];
  for (const t of targets) t.addEventListener("submit", block, true);

  const shadowed = [];
  for (const form of forms) {
    // A control named "submit" makes form.submit resolve to that element: leave it alone.
    if (typeof form.submit !== "function") continue;
    shadowed.push({
      form,
      had: Object.prototype.hasOwnProperty.call(form, "submit"),
      prev: form.submit,
    });
    form.submit = () => {};
  }

  try {
    el.click();
  } finally {
    for (const t of targets) t.removeEventListener("submit", block, true);
    for (const { form, had, prev } of shadowed) {
      if (had) form.submit = prev;
      else delete form.submit;
    }
  }
}
