import { PROFILE_SCHEMA_VERSION } from "../version.js";
import { ROLE_KEYS } from "./schema.js";

// Filled from the shipped profile rather than hardcoded: profile.json is the
// single source of truth for every profile fact.
const CORRECTED_PREFERENCE_KEYS = ["noticePeriod", "currentSalary", "expectedSalary"];

const ML_TRUTH_RULE =
  "NEVER claim machine learning, data science, or data engineering experience — " +
  "no model training, no MLOps, no data pipelines. LLM application work only.";

export function needsMigration(profile) {
  return !profile?._meta || Number(profile._meta.version) < PROFILE_SCHEMA_VERSION;
}

export function migrateV1(v1, defaultProfile) {
  const out = structuredClone(v1);

  out.roles = out.roles ? structuredClone(out.roles) : {};
  for (const key of ROLE_KEYS) {
    if (!out.roles[key]) out.roles[key] = structuredClone(defaultProfile.roles[key]);
  }
  if (v1.headline) out.roles.genai.headline = v1.headline;

  delete out.headline;
  delete out.summary;

  // Genuine v1 (no _meta) gets the corrected values; otherwise only fill gaps,
  // so a user-edited value is never reverted.
  const isPreV2 = !v1._meta;
  const prefs = { ...(out.jobPreferences || {}) };
  for (const k of CORRECTED_PREFERENCE_KEYS) {
    const val = defaultProfile?.jobPreferences?.[k];
    if (typeof val !== "string") continue;
    const cur = prefs[k];
    if (isPreV2 || typeof cur !== "string" || cur.trim() === "") prefs[k] = val;
  }
  out.jobPreferences = prefs;

  const rules = Array.isArray(out.truthRules) ? [...out.truthRules] : [];
  if (!rules.some((r) => r.toLowerCase().includes("machine learning"))) {
    rules.push(ML_TRUTH_RULE);
  }
  out.truthRules = rules;

  for (const section of ["links", "diversity", "languages", "education", "skills"]) {
    if (out[section] === undefined) out[section] = structuredClone(defaultProfile[section]);
  }

  out._meta = {
    version: PROFILE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString().slice(0, 10)
  };

  return out;
}
