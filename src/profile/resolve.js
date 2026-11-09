import { ROLE_KEYS } from "./schema.js";

const OBJECT_SECTIONS = ["personal", "links", "workAuthorization",
                         "jobPreferences", "diversity"];
const ARRAY_SECTIONS = ["education", "experience", "skills",
                        "languages", "truthRules"];

export function resolveProfile(profile, roleKey) {
  const src = profile && typeof profile === "object" ? profile : {};
  const key = ROLE_KEYS.includes(roleKey) ? roleKey : "genai";
  const role = (src.roles && src.roles[key]) || {};

  const out = {};
  for (const s of OBJECT_SECTIONS) {
    out[s] = src[s] && typeof src[s] === "object" ? structuredClone(src[s]) : {};
  }
  for (const s of ARRAY_SECTIONS) {
    out[s] = Array.isArray(src[s]) ? structuredClone(src[s]) : [];
  }

  out.roleLabel = role.label || "";
  out.headline = role.headline || "";
  out.emphasis = role.emphasis || "";

  return out;
}
