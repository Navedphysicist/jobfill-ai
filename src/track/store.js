const KEY = "applications";
const STRIP = ["utm_source", "utm_medium", "utm_campaign", "utm_term",
               "utm_content", "gh_src", "src", "ref"];

export const APPLICATION_STATES =
  ["Applied", "Call or Mail", "Process Started", "Rejected", "On Hold"];

// Never throws: anything that is not a parseable http(s) URL comes back unchanged.
// Local calendar date (YYYY-MM-DD). Not toISOString(), which is UTC and is a day off
// for users east of Greenwich shortly after midnight. Shared with capture.js.
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    u.hash = "";
    for (const p of STRIP) u.searchParams.delete(p);
    const qs = u.searchParams.toString();
    return `${u.origin}${u.pathname}${qs ? `?${qs}` : ""}`;
  } catch {
    return url;
  }
}

const BACKUP_KEY = "applications_corrupt_backup";
const EDITABLE = ["company", "jobTitle", "appliedAt", "state", "domain",
                  "jobUrl", "roleFamily", "outcomeReason", "notes"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Reads rows, tolerating junk. `corrupt` carries a non-array stored value so
// the next write can back it up instead of silently destroying it.
async function readState() {
  const got = await chrome.storage.local.get([KEY]);
  const raw = got[KEY];
  if (Array.isArray(raw)) {
    return { rows: raw.filter((r) => r && typeof r === "object"), corrupt: undefined, hasCorrupt: false };
  }
  return { rows: [], corrupt: raw, hasCorrupt: raw !== undefined && raw !== null };
}

async function readAll() {
  return (await readState()).rows;
}

async function writeAll(rows, state) {
  const toSet = { [KEY]: rows };
  if (state && state.hasCorrupt) {
    const got = await chrome.storage.local.get([BACKUP_KEY]);
    if (got[BACKUP_KEY] === undefined) toSet[BACKUP_KEY] = state.corrupt;
  }
  await chrome.storage.local.set(toSet);
}

// All mutators run one at a time: in-module promise chain, plus a Web Lock when
// available so extension pages and the service worker also exclude each other.
// NOTE: content scripts run in the page origin and share neither mechanism, so
// every writer must be an extension page or the service worker.
let q = Promise.resolve();
const serial = (fn) => (q = q.then(fn, fn));

function withLock(fn) {
  const locks = typeof navigator !== "undefined" && navigator.locks;
  return locks && typeof locks.request === "function"
    ? locks.request("jobfill-applications", fn)
    : fn();
}

function mutate(fn) {
  return serial(async () => {
    try {
      return await withLock(fn);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

function newId() {
  return `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function addApplication(record) {
  return mutate(() => addImpl(record || {}));
}

async function addImpl(record) {
  const state = await readState();
  const rows = state.rows;
  const url = normalizeUrl(record.jobUrl || "");

  if (record.force !== true && url) {
    const existing = rows.find((r) => normalizeUrl(r.jobUrl || "") === url);
    if (existing) return { ok: false, duplicateOf: existing.id };
  }

  const now = new Date();
  const row = {
    id: newId(),
    company: record.company || "",
    jobTitle: record.jobTitle || "",
    appliedAt: record.appliedAt || localDate(now),
    state: APPLICATION_STATES.includes(record.state) ? record.state : "Applied",
    domain: record.domain || "",
    jobUrl: record.jobUrl || "",
    roleFamily: record.roleFamily || "",
    outcomeReason: record.outcomeReason || "",
    notes: record.notes || "",
    updatedAt: now.toISOString()
  };

  rows.push(row);
  await writeAll(rows, state);
  return { ok: true, id: row.id };
}

// sno is a display index derived here, never stored (oldest = 1).
export async function listApplications(filter = {}) {
  const rows = await readAll();
  const ordered = [...rows].sort((a, b) =>
    a.appliedAt === b.appliedAt
      ? String(a.updatedAt).localeCompare(String(b.updatedAt))
      : String(a.appliedAt).localeCompare(String(b.appliedAt)));

  const numbered = ordered.map((r, i) => ({ ...r, sno: i + 1 })).reverse();

  return numbered.filter((r) => {
    if (filter.state && r.state !== filter.state) return false;
    if (filter.roleFamily && r.roleFamily !== filter.roleFamily) return false;
    if (filter.from && r.appliedAt < filter.from) return false;
    if (filter.to && r.appliedAt > filter.to) return false;
    if (filter.search &&
        !String(r.company).toLowerCase().includes(String(filter.search).toLowerCase())) return false;
    return true;
  });
}

export function updateApplication(id, patch) {
  return mutate(() => updateImpl(id, patch || {}));
}

async function updateImpl(id, patch) {
  if ("state" in patch && !APPLICATION_STATES.includes(patch.state)) {
    return { ok: false, error: `unknown state: ${patch.state}` };
  }
  if ("appliedAt" in patch && !DATE_RE.test(String(patch.appliedAt))) {
    return { ok: false, error: `appliedAt must be YYYY-MM-DD: ${patch.appliedAt}` };
  }
  const state = await readState();
  const rows = state.rows;
  const i = rows.findIndex((r) => r.id === id);
  if (i === -1) return { ok: false, error: "not found" };
  const clean = {};
  for (const k of EDITABLE) if (k in patch) clean[k] = String(patch[k] ?? "");
  rows[i] = { ...rows[i], ...clean, id, updatedAt: new Date().toISOString() };
  await writeAll(rows, state);
  return { ok: true };
}

export function deleteApplication(id) {
  if (!id) return Promise.resolve({ ok: false, error: "missing id" });
  return mutate(async () => {
    const state = await readState();
    await writeAll(state.rows.filter((r) => r.id !== id), state);
    return { ok: true };
  });
}
