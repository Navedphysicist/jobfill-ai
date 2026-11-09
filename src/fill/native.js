// Write a value so React-style controlled inputs notice it: use the native prototype
// setter (bypasses React's value tracker), then fire input and change, both bubbling.
export function setNativeValue(el, value) {
  const win = el.ownerDocument.defaultView;
  const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
}
