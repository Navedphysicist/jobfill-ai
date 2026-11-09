// src/ai/router.js
import { LENGTH_CAPS } from "./prompts.js";

// Reasoning models (gpt-5*, o-series) spend max_completion_tokens on INVISIBLE
// reasoning before emitting the first visible token. A budget sized only for the
// visible answer is consumed entirely by reasoning and the reply comes back
// finish_reason="length" with no content at all — which is how a nine-field form
// managed to scan 9 and fill 0. Every cap below carries headroom for that spend.
export const REASONING_HEADROOM = 2000;

// Rough visible-output budget per field, by kind.
const KIND_COST = { textarea: 700, input: 90, select: 45, radio: 45, checkbox: 25 };
const DEFAULT_KIND_COST = 90;
const ENVELOPE_TOKENS = 250; // JSON scaffolding around the answers

export const MAP_FIELDS_MIN = 3000;
export const MAP_FIELDS_MAX = 16000;

export function modelFor(task, settings) {
  return task === "mapFields" ? settings.fastModel : settings.qualityModel;
}

// Field mapping is structured extraction from a profile that is already in the
// prompt — it does not need deep reasoning, and low effort cuts both the latency
// and the token spend that caused the truncation.
export function effortFor() {
  return "low";
}

// capFor("mapFields", fields) — budget scales with the batch.
// capFor("generateAnswer", lengthKey) — visible target plus reasoning headroom.
export function capFor(task, arg) {
  if (task === "mapFields") {
    const fields = Array.isArray(arg) ? arg : [];
    const body = fields.reduce(
      (n, f) => n + (KIND_COST[f?.kind] ?? DEFAULT_KIND_COST), 0);
    const want = body + ENVELOPE_TOKENS + REASONING_HEADROOM;
    return Math.min(MAP_FIELDS_MAX, Math.max(MAP_FIELDS_MIN, want));
  }
  return (LENGTH_CAPS[arg] || LENGTH_CAPS.normal) + REASONING_HEADROOM;
}
