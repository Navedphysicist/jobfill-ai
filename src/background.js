import { loadProfile, saveProfile, setDefaultProfile } from "./profile/load.js";
import { resolveProfile } from "./profile/resolve.js";
import { buildMapFieldsMessages, buildGenerateMessages, LENGTH_CAPS } from "./ai/prompts.js";
import { parseAnswers, callModel, BadResponseError } from "./ai/client.js";
import { estimateCost, recordUsage, readUsage, countUnpriced, DEFAULT_RATES_INR } from "./ai/usage.js";
import { cacheKey, getCached, setCached, clearCache, cacheStats } from "./ai/cache.js";
import { modelFor, capFor, effortFor } from "./ai/router.js";
import { DEFAULT_SETTINGS } from "./settings-defaults.js";
export { DEFAULT_SETTINGS };
import { dedupe } from "./ai/inflight.js";


let _fetch = (...a) => fetch(...a);
export function __setFetch(fn) { _fetch = fn; }

// Memoized per worker lifetime; a failed fetch clears the memo so the next call retries.
let _bootstrap = null;
// Test seam: lets tests clear the per-worker memo.
export function __resetBootstrap() { _bootstrap = null; }

export function bootstrapDefault() {
  if (!_bootstrap) {
    _bootstrap = (async () => {
      const res = await _fetch(chrome.runtime.getURL("profile.json"));
      setDefaultProfile(await res.json());
    })().catch((e) => { _bootstrap = null; throw e; });
  }
  return _bootstrap;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function getRates() {
  try {
    const { rates } = await chrome.storage.local.get(["rates"]);
    if (rates && typeof rates === "object" && !Array.isArray(rates)) return rates;
  } catch { /* fall through to defaults */ }
  return DEFAULT_RATES_INR;
}

// Cost estimation must never fail a call that has already been paid for.
// recordUsage itself swallows its own failures; this guards the estimate.
async function track(task, model, usage) {
  let estimatedCost = 0;
  try {
    estimatedCost = estimateCost({ model, ...usage }, await getRates());
  } catch { /* record the call with zero estimated cost */ }
  await recordUsage({ task, model, ...usage, estimatedCost });
}

export async function handleMapFields({ fields, pageContext, role }) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("NO_KEY");

  const profile = await loadProfile();
  const resolved = resolveProfile(profile, role);
  const messages = buildMapFieldsMessages({ resolved, fields, pageContext });

  const model = modelFor("mapFields", settings);
  const { content, usage } = await callModel({
    settings, model, messages, jsonMode: true,
    maxTokens: capFor("mapFields", fields),
    reasoningEffort: effortFor("mapFields"), fetchImpl: _fetch
  });

  await track("mapFields", model, usage);
  return parseAnswers(content);
}

// Content-derived cache version: changes exactly when what the model sees changes
// (a date stamp would miss a same-day edit). FNV-1a 32-bit over the resolved profile.
function contentVersion(resolved) {
  const s = JSON.stringify(resolved);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + ":" + s.length;
}

export async function handleGenerateAnswer({
  question, pageContext, currentValue, role, instruction, length, bypassCache
}) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("NO_KEY");

  const profile = await loadProfile();
  const resolved = resolveProfile(profile, role);
  const lengthKey = LENGTH_CAPS[length] ? length : "normal";

  // An instruction or an existing draft makes the request one-off, so it is not cached.
  const cacheable = !instruction && !currentValue;
  const key = cacheable
    ? await cacheKey({
        question, roleKey: role,
        profileVersion: contentVersion(resolved), length: lengthKey
      })
    : null;

  if (key && !bypassCache) {
    const hit = await getCached(key);
    if (hit) return { value: hit.answer, cached: true };
  }

  const dedupeKey = key ||
    JSON.stringify(["oneoff", question, instruction || "", currentValue || "", role, lengthKey]);

  const value = await dedupe(dedupeKey, async () => {
    // A cacheable answer is shared across sites, so the model must not see (and
    // therefore must not name) the current employer. One-off requests keep it.
    const messages = buildGenerateMessages({
      resolved, question, pageContext: cacheable ? "" : pageContext,
      currentValue, instruction, length: lengthKey
    });
    const model = modelFor("generateAnswer", settings);
    const { content, usage } = await callModel({
      settings, model, messages, jsonMode: false,
      maxTokens: capFor("generateAnswer", lengthKey),
      reasoningEffort: effortFor("generateAnswer"), fetchImpl: _fetch
    });

    await track("generateAnswer", model, usage);

    const trimmed = content.trim();
    // Already paid for and recorded; an empty reply is a failure, never cacheable.
    if (!trimmed) throw new BadResponseError("the model returned an empty answer");
    if (key) await setCached(key, { answer: trimmed, model });
    return trimmed;
  });

  return { value, cached: false };
}

// TruncatedResponseError is a sibling of BadResponseError, not a subclass, so
// it is branched on first and its actionable message reaches the user intact.
function errorResponse(e) {
  if (e && e.truncated === true) return { ok: false, error: e.message, truncated: true };
  if (e instanceof BadResponseError) return { ok: false, error: e.message };
  const message = String((e && e.message) || e);
  return { ok: false, error: message === "NO_KEY" ? "NO_KEY" : message };
}

chrome.runtime.onInstalled.addListener(async () => {
  await bootstrapDefault();
  const stored = await chrome.storage.local.get(["profile", "settings"]);
  if (!stored.profile) await saveProfile(await loadProfile());
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.action === "mapFields") {
        await bootstrapDefault();
        sendResponse({ ok: true, ...(await handleMapFields(msg)) });
      } else if (msg.action === "generateAnswer") {
        await bootstrapDefault();
        sendResponse({ ok: true, ...(await handleGenerateAnswer(msg)) });
      } else if (msg.action === "getProfile") {
        await bootstrapDefault();
        sendResponse({ ok: true, profile: await loadProfile() });
      } else if (msg.action === "saveProfile") {
        await bootstrapDefault();
        sendResponse({ ok: true, ...(await saveProfile(msg.profile)) });
      } else if (msg.action === "getSettingsStatus") {
        const s = await getSettings();
        sendResponse({ ok: true, hasKey: !!s.apiKey });
      } else if (msg.action === "clearCache") {
        // The cache's write queue is per JS context: UIs must go through the worker.
        await clearCache();
        sendResponse({ ok: true });
      } else if (msg.action === "cacheStats") {
        sendResponse({ ok: true, ...(await cacheStats()) });
      } else if (msg.action === "usageSummary") {
        const { entries, totals } = await readUsage();
        const unpricedCalls = countUnpriced(entries, await getRates());
        sendResponse({ ok: true, totals, unpricedCalls, cache: await cacheStats() });
      } else {
        sendResponse({ ok: false, error: "UNKNOWN_ACTION" });
      }
    } catch (e) {
      sendResponse(errorResponse(e));
    }
  })();
  return true;
});
