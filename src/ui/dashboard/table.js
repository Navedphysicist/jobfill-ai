// Pure rendering helpers for the dashboard: no chrome API, no storage.
import { APPLICATION_STATES } from "../../track/store.js";

const HEADERS = ["S.No", "Company", "Job Title", "Date", "State",
                 "Domain", "Link", "Applied as", "Reason", ""];

function td(child) {
  const cell = document.createElement("td");
  if (child !== undefined && child !== null) {
    cell.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return cell;
}

function stateSelect(row) {
  const sel = document.createElement("select");
  sel.dataset.field = "state";
  sel.setAttribute("data-jobfill-ui", "1");
  for (const s of APPLICATION_STATES) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  }
  sel.value = row.state;
  return sel;
}

function reasonInput(row) {
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.field = "outcomeReason";
  input.setAttribute("data-jobfill-ui", "1");
  input.value = row.outcomeReason || "";
  input.placeholder = "reason";
  return input;
}

function link(url) {
  if (!url) return "";
  // Only http(s) becomes a link; anything else (javascript:, data:, junk) is
  // shown as plain text so it can never execute in the extension origin.
  let ok = false;
  try {
    const proto = new URL(String(url)).protocol;
    ok = proto === "http:" || proto === "https:";
  } catch { /* unparseable: plain text */ }
  if (!ok) return String(url);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "open";
  return a;
}

function deleteButton() {
  const b = document.createElement("button");
  b.dataset.action = "delete";
  b.setAttribute("data-jobfill-ui", "1");
  b.className = "ghost";
  b.textContent = "✕";
  b.title = "Delete this record";
  return b;
}

export function renderTable(rows, { roleLabels = {} } = {}) {
  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const h of HEADERS) {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);

  const tbody = document.createElement("tbody");
  if (!rows.length) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = HEADERS.length;
    cell.className = "empty";
    cell.textContent = "No applications logged yet.";
    tr.appendChild(cell);
    tbody.appendChild(tr);
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.append(
      td(String(row.sno)), td(row.company), td(row.jobTitle), td(row.appliedAt),
      td(stateSelect(row)), td(row.domain), td(link(row.jobUrl)),
      td(roleLabels[row.roleFamily] || row.roleFamily || ""),
      td(reasonInput(row)), td(deleteButton())
    );
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  const frag = document.createDocumentFragment();
  frag.appendChild(table);
  return frag;
}

export function summarize(rows) {
  const byState = Object.fromEntries(APPLICATION_STATES.map((s) => [s, 0]));
  for (const r of rows) if (byState[r.state] !== undefined) byState[r.state]++;
  return { total: rows.length, byState };
}
