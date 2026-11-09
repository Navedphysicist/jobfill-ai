// src/ai/usage.js
const KEY = "usageLog";
const MAX_ENTRIES = 1000;

export const DEFAULT_RATES_INR = {
  "gpt-5-mini": { input: 21, cachedInput: 2.1, output: 168 }
};

export function estimateCost(
  { model, promptTokens, cachedTokens, completionTokens },
  rates = DEFAULT_RATES_INR
) {
  const r = rates?.[model];
  if (!r) return 0;
  const prompt = Math.max(0, promptTokens || 0);
  const cached = Math.min(Math.max(0, cachedTokens || 0), prompt);
  const cachedRate = Number.isFinite(r.cachedInput) ? r.cachedInput : r.input;
  const cost =
    ((prompt - cached) / 1e6) * (r.input || 0) +
    (cached / 1e6) * (cachedRate || 0) +
    (Math.max(0, completionTokens || 0) / 1e6) * (r.output || 0);
  return Number.isFinite(cost) ? cost : 0;
}

// A model is priced only if its rates entry has numeric input and output.
export function hasRate(rates, model) {
  const r = rates?.[model];
  return !!r && Number.isFinite(r.input) && Number.isFinite(r.output);
}

export function countUnpriced(entries, rates = DEFAULT_RATES_INR) {
  return entries.reduce((n, e) => n + (hasRate(rates, e.model) ? 0 : 1), 0);
}

let queue = Promise.resolve();

async function appendEntry(entry) {
  const got = await chrome.storage.local.get([KEY]);
  const entries = Array.isArray(got[KEY]) ? got[KEY] : [];
  entries.push({ ...entry, at: new Date().toISOString() });
  while (entries.length > MAX_ENTRIES) entries.shift();
  await chrome.storage.local.set({ [KEY]: entries });
}

// Serialised, and never rejects: usage accounting is telemetry and must not
// be able to fail the model call it measures.
export function recordUsage(entry) {
  const run = () =>
    appendEntry(entry).catch((e) => {
      console.warn("JobFill: could not record usage", e);
    });
  queue = queue.then(run, run);
  return queue;
}

export async function readUsage() {
  const got = await chrome.storage.local.get([KEY]);
  const entries = Array.isArray(got[KEY]) ? got[KEY] : [];
  const totals = entries.reduce(
    (acc, e) => ({
      calls: acc.calls + 1,
      promptTokens: acc.promptTokens + (e.promptTokens || 0),
      cachedTokens: acc.cachedTokens + (e.cachedTokens || 0),
      completionTokens: acc.completionTokens + (e.completionTokens || 0),
      estimatedCost: acc.estimatedCost + (e.estimatedCost || 0)
    }),
    { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, estimatedCost: 0 }
  );
  return { entries, totals };
}
