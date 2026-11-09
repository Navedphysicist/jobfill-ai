import { APPLICATION_STATES } from "../../track/store.js";

const TEXT_FIELDS = [
  ["company", "Company"], ["jobTitle", "Job title"],
  ["appliedAt", "Date"], ["domain", "Domain"], ["jobUrl", "Job URL"]
];

function labelled(label, control) {
  const wrap = document.createElement("label");
  wrap.className = "jfa-field";
  const span = document.createElement("span");
  span.className = "jfa-label";
  span.textContent = label;
  wrap.append(span, control);
  return wrap;
}

function row(name, label, value, type = "text") {
  const input = document.createElement("input");
  input.type = type;
  input.name = name;
  input.value = value ?? "";
  input.setAttribute("data-jobfill-ui", "1");
  return labelled(label, input);
}

function select(name, label, options, value) {
  const sel = document.createElement("select");
  sel.name = name;
  sel.setAttribute("data-jobfill-ui", "1");
  for (const [val, text] of options) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = text;
    sel.appendChild(o);
  }
  sel.value = value;
  return labelled(label, sel);
}

export function renderLogForm(capture, { roleLabels }) {
  const frag = document.createDocumentFragment();
  for (const [name, label] of TEXT_FIELDS) {
    frag.appendChild(row(name, label, capture[name], name === "appliedAt" ? "date" : "text"));
  }
  frag.appendChild(select("state", "State",
    APPLICATION_STATES.map((s) => [s, s]), capture.state || "Applied"));
  frag.appendChild(select("roleFamily", "Applied as",
    Object.entries(roleLabels), capture.roleFamily || "genai"));
  return frag;
}

export function readLogForm(root) {
  const out = {};
  for (const el of root.querySelectorAll("[name]")) out[el.name] = el.value;
  return out;
}
