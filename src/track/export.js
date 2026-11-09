const COLUMNS = [
  ["sno", "S.No"], ["company", "Company"], ["jobTitle", "Job Title"],
  ["appliedAt", "Date of Application"], ["state", "State"],
  ["domain", "Company Domain"], ["jobUrl", "Job URL"],
  ["roleFamily", "Role Family"], ["outcomeReason", "Reason"], ["notes", "Notes"]
];

// RFC 4180: quote when the value has a quote, comma or line break (CR or LF);
// double internal quotes.
// Spreadsheet formula injection: text from job pages may start with = + - @ TAB CR,
// which Excel/Sheets would evaluate. Prefix an apostrophe (text columns only; sno is numeric).
function cell(value, guard = false) {
  let s = value === undefined || value === null ? "" : String(value);
  if (guard && typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const head = COLUMNS.map(([, label]) => cell(label)).join(",");
  const body = rows.map((r) => COLUMNS.map(([key]) => cell(r[key], key !== "sno")).join(","));
  return [head, ...body].join("\n");
}

export function toJson(rows) {
  return JSON.stringify(rows.map(({ sno, ...rest }) => rest), null, 2);
}
