// src/ai/cache.js
const KEY = "answerCache";
const STATS_KEY = "answerCacheStats";

export const TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 500;

function normalize(question) {
  return String(question || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// The key covers everything that can make a cached answer wrong: the question,
// the role angle, the profile version (an edit invalidates every answer) and
// the length target.
export async function cacheKey({ question, roleKey, profileVersion, length }) {
  // JSON.stringify of an array is injective, so no crafted input can collide.
  const material = JSON.stringify([
    normalize(question), roleKey || "", profileVersion || "", length || "normal"
  ]);
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readMap() {
  const got = await chrome.storage.local.get([KEY]);
  return got[KEY] && typeof got[KEY] === "object" ? got[KEY] : {};
}

async function readStats() {
  const got = await chrome.storage.local.get([STATS_KEY]);
  return { hits: 0, misses: 0, ...(got[STATS_KEY] || {}) };
}

// FIFO, not LRU: createdAt is set on write only (refreshing on read would
// rewrite up to 500 entries per hit). Oldest-written entries go first; an entry
// with a corrupt createdAt sorts oldest. Keeps the newest `keepCount`.
const ageOf = (e) => (Number.isFinite(e?.createdAt) ? e.createdAt : -Infinity);
function evictOldest(map, keepCount) {
  const sorted = Object.entries(map).sort((a, b) => {
    const x = ageOf(a[1]), y = ageOf(b[1]);
    return x === y ? 0 : x < y ? -1 : 1;
  });
  return Object.fromEntries(sorted.slice(Math.max(0, sorted.length - keepCount)));
}

// Every read-modify-write goes through one promise chain (both handlers, so a
// rejection cannot poison it). Concurrent fills therefore cannot lose entries
// or stat counts to interleaved read-then-write.
let queue = Promise.resolve();
function serialise(fn) {
  const run = fn;
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// Stats are telemetry: a failed counter write must never change what a lookup
// returns, or storage pressure would turn a paid-for hit into a second API call.
async function writeSafely(obj) {
  try {
    await chrome.storage.local.set(obj);
  } catch (e) {
    console.warn("JobFill: could not update answer cache", e);
  }
}

async function lookup(key) {
  const map = await readMap();
  const stats = await readStats();
  const hit = map[key];

  if (!hit) {
    stats.misses += 1;
    await writeSafely({ [STATS_KEY]: stats });
    return null;
  }
  if (!Number.isFinite(hit.createdAt) || Date.now() - hit.createdAt > TTL_MS) {
    delete map[key];
    stats.misses += 1;
    await writeSafely({ [KEY]: map, [STATS_KEY]: stats });
    return null;
  }
  stats.hits += 1;
  await writeSafely({ [STATS_KEY]: stats });
  return { answer: hit.answer, model: hit.model };
}

// A cache read failure is a miss, never an error for the caller.
export function getCached(key) {
  return serialise(() =>
    lookup(key).catch((e) => {
      console.warn("JobFill: could not read answer cache", e);
      return null;
    })
  );
}

async function store(key, { answer, model }) {
  const entry = { answer, model, createdAt: Date.now() };
  let map = await readMap();
  delete map[key]; // re-insert so it counts as newest
  map[key] = entry;
  if (Object.keys(map).length > MAX_ENTRIES) map = evictOldest(map, MAX_ENTRIES);

  try {
    await chrome.storage.local.set({ [KEY]: map });
  } catch (e) {
    // Quota: drop the older half, make sure the new entry is in, retry once.
    const { [key]: _new, ...older } = map;
    const keep = Math.floor(Object.keys(older).length / 2);
    const trimmed = evictOldest(older, keep);
    trimmed[key] = entry;
    await chrome.storage.local.set({ [KEY]: trimmed });
  }
}

// Never rejects: losing a cache entry is free, losing the paid answer is not.
export function setCached(key, value) {
  return serialise(() =>
    store(key, value).catch((e) => {
      console.warn("JobFill: could not cache answer", e);
    })
  );
}

export function clearCache() {
  return serialise(() =>
    chrome.storage.local.set({ [KEY]: {}, [STATS_KEY]: { hits: 0, misses: 0 } })
  );
}

export async function cacheStats() {
  const [map, stats] = await Promise.all([readMap(), readStats()]);
  return { entries: Object.keys(map).length, ...stats };
}
