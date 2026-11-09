// tests/profile-resolve.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveProfile } from "../src/profile/resolve.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));

describe("resolveProfile", () => {
  it("flattens the selected role onto the shared facts", () => {
    const r = resolveProfile(profile, "swe");
    expect(r.headline).toBe(profile.roles.swe.headline);
    expect(r.emphasis).toBe(profile.roles.swe.emphasis);
    expect(r.roleLabel).toBe(profile.roles.swe.label);
    expect(r.personal.email).toBe(profile.personal.email);
  });

  it("never leaks the other role angles", () => {
    const r = resolveProfile(profile, "swe");
    expect(r.roles).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(profile.roles.trainer.headline);
    expect(JSON.stringify(r)).not.toContain(profile.roles.genai.headline);
  });

  it("carries truthRules through unmodified", () => {
    const r = resolveProfile(profile, "trainer");
    expect(r.truthRules).toEqual(profile.truthRules);
  });

  it("falls back to genai for an unknown role key", () => {
    expect(resolveProfile(profile, "dataScience").headline)
      .toBe(profile.roles.genai.headline);
    expect(resolveProfile(profile, undefined).headline)
      .toBe(profile.roles.genai.headline);
  });

  it("drops _meta from the payload sent to the model", () => {
    expect(resolveProfile(profile, "genai")._meta).toBeUndefined();
  });

  // Review Focus #1
  it("resolves without throwing when a section is missing", () => {
    const partial = structuredClone(profile);
    delete partial.links;
    delete partial.diversity;
    const r = resolveProfile(partial, "genai");
    expect(r.links).toEqual({});
    expect(r.diversity).toEqual({});
    expect(r.personal.email).toBe(profile.personal.email);
  });

  it("resolves without throwing when a section is null", () => {
    const partial = structuredClone(profile);
    partial.education = null;
    partial.skills = null;
    const r = resolveProfile(partial, "genai");
    expect(r.education).toEqual([]);
    expect(r.skills).toEqual([]);
  });

  it("resolves without throwing when roles is missing entirely", () => {
    const partial = structuredClone(profile);
    delete partial.roles;
    const r = resolveProfile(partial, "swe");
    expect(r.headline).toBe("");
    expect(r.emphasis).toBe("");
    expect(r.personal.fullName).toBe(profile.personal.fullName);
  });
});
