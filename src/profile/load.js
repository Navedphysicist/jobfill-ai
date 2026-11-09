import { validateProfile } from "./schema.js";
import { migrateV1, needsMigration } from "./migrate.js";
import { PROFILE_SCHEMA_VERSION } from "../version.js";

let bundledDefault = null;

export function setDefaultProfile(obj) {
  bundledDefault = structuredClone(obj);
}

export function getDefaultProfile() {
  if (!bundledDefault) throw new Error("default profile not loaded");
  return bundledDefault;
}

export async function loadProfile() {
  const { profile, profile_v1_backup: existingBackup } =
    await chrome.storage.local.get(["profile", "profile_v1_backup"]);
  if (!profile) return structuredClone(getDefaultProfile());

  if (needsMigration(profile)) {
    const migrated = migrateV1(profile, getDefaultProfile());
    const write = {};
    const { valid, errors } = validateProfile(migrated);
    // An invalid migration still serves this session but is never persisted.
    if (valid) write.profile = migrated;
    else console.warn("JobFill: migrated profile is invalid, not saved:", errors.map((e) => e.path ?? e));
    if (existingBackup === undefined) write.profile_v1_backup = profile;
    await chrome.storage.local.set(write);
    return migrated;
  }

  return profile;
}

export async function saveProfile(profile) {
  const { valid, errors } = validateProfile(profile);
  if (!valid) return { ok: false, errors };

  const toStore = structuredClone(profile);
  toStore._meta = {
    version: PROFILE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString().slice(0, 10)
  };
  await chrome.storage.local.set({ profile: toStore });
  return { ok: true, errors: [] };
}

export async function resetProfile() {
  const fresh = structuredClone(getDefaultProfile());
  await chrome.storage.local.set({ profile: fresh });
  return fresh;
}
