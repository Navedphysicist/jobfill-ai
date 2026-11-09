// tests/profile-schema.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateProfile, ROLE_KEYS } from "../src/profile/schema.js";

const profile = JSON.parse(readFileSync("profile.example.json", "utf8"));

describe("profile.example.json", () => {
  it("validates clean", () => {
    const { valid, errors } = validateProfile(profile);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("carries the three role angles", () => {
    expect(Object.keys(profile.roles).sort()).toEqual([...ROLE_KEYS].sort());
    for (const key of ROLE_KEYS) {
      expect(profile.roles[key].label).toBeTruthy();
      expect(profile.roles[key].headline).toBeTruthy();
      expect(profile.roles[key].emphasis).toBeTruthy();
    }
  });

  it("holds the corrected job preference values", () => {
    expect(profile.jobPreferences.noticePeriod).toBe("1 month");
    expect(profile.jobPreferences.currentSalary).toBe("INR 00,00,000");
    expect(profile.jobPreferences.expectedSalary).toBe("INR 00 LPA");
  });

  it("forbids machine learning and data engineering claims", () => {
    const joined = profile.truthRules.join(" ").toLowerCase();
    expect(joined).toContain("machine learning");
    expect(joined).toContain("data engineering");
  });

  it("keeps facts out of the role angles", () => {
    for (const key of ROLE_KEYS) {
      expect(Object.keys(profile.roles[key]).sort())
        .toEqual(["emphasis", "headline", "label"]);
    }
  });
});

describe("validateProfile", () => {
  it("reports a missing required section with its path", () => {
    const bad = structuredClone(profile);
    delete bad.personal;
    const { valid, errors } = validateProfile(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.path === "personal")).toBe(true);
  });

  it("reports a malformed email with its path", () => {
    const bad = structuredClone(profile);
    bad.personal.email = "not-an-email";
    const { errors } = validateProfile(bad);
    expect(errors.some((e) => e.path === "personal.email")).toBe(true);
  });

  it("reports an unknown role key", () => {
    const bad = structuredClone(profile);
    bad.roles.dataScience = { label: "x", headline: "y", emphasis: "z" };
    const { errors } = validateProfile(bad);
    expect(errors.some((e) => e.path === "roles.dataScience")).toBe(true);
  });

  it("rejects a non-object input without throwing", () => {
    expect(validateProfile(null).valid).toBe(false);
    expect(validateProfile("nope").valid).toBe(false);
  });

  const hasPath = (bad, path) =>
    validateProfile(bad).errors.some((e) => e.path === path);

  it("rejects wrong-type sections", () => {
    const a = structuredClone(profile);
    a.personal = "x";
    expect(validateProfile(a).valid).toBe(false);
    expect(hasPath(a, "personal")).toBe(true);
    const b = structuredClone(profile);
    b.roles = "x";
    expect(validateProfile(b).valid).toBe(false);
    expect(hasPath(b, "roles")).toBe(true);
    const c = structuredClone(profile);
    c.roles = [];
    expect(hasPath(c, "roles")).toBe(true);
  });

  it("requires every role and every role field", () => {
    const a = structuredClone(profile);
    delete a.roles.trainer;
    expect(validateProfile(a).valid).toBe(false);
    expect(hasPath(a, "roles.trainer")).toBe(true);
    const b = structuredClone(profile);
    delete b.roles.genai.emphasis;
    expect(validateProfile(b).valid).toBe(false);
    expect(hasPath(b, "roles.genai.emphasis")).toBe(true);
  });

  it("requires the form-facing job preference and authorization fields", () => {
    const a = structuredClone(profile);
    delete a.jobPreferences.expectedSalary;
    expect(validateProfile(a).valid).toBe(false);
    expect(hasPath(a, "jobPreferences.expectedSalary")).toBe(true);
    const b = structuredClone(profile);
    b.workAuthorization.authorizedToWorkIn = "India";
    expect(hasPath(b, "workAuthorization.authorizedToWorkIn")).toBe(true);
    const c = structuredClone(profile);
    c.workAuthorization.citizenOf = "";
    expect(hasPath(c, "workAuthorization.citizenOf")).toBe(true);
  });

  it("type-checks array elements", () => {
    const a = structuredClone(profile);
    a.truthRules = [123];
    expect(validateProfile(a).valid).toBe(false);
    expect(hasPath(a, "truthRules[0]")).toBe(true);
    const b = structuredClone(profile);
    b.skills = [1, null];
    expect(hasPath(b, "skills[0]")).toBe(true);
    expect(hasPath(b, "skills[1]")).toBe(true);
    const c = structuredClone(profile);
    c.experience[0].bullets = [5];
    expect(hasPath(c, "experience[0].bullets[0]")).toBe(true);
  });

  it("never throws on odd inputs", () => {
    for (const input of [undefined, [], 42]) {
      expect(validateProfile(input).valid).toBe(false);
    }
  });

  it("still validates the unmodified profile clean", () => {
    expect(validateProfile(structuredClone(profile))).toEqual({ valid: true, errors: [] });
  });
});

describe("whitespace-only required personal strings", () => {
  it("rejects a blank fullName", async () => {
    const { readFileSync } = await import("node:fs");
    const bad = JSON.parse(readFileSync("profile.example.json", "utf8"));
    bad.personal.fullName = "   ";
    const { valid, errors } = validateProfile(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.path === "personal.fullName")).toBe(true);
  });
});
