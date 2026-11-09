import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderFormView, readFormView } from "../src/ui/options/render-form.js";
import { validateProfile } from "../src/profile/schema.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));

describe("form round trip against the schema", () => {
  it("an unedited profile read back with a base still validates and is identical", () => {
    const root = document.createElement("div");
    root.appendChild(renderFormView(profile));
    const back = readFormView(root, profile);
    expect(validateProfile(back)).toEqual({ valid: true, errors: [] });
    expect(back).toEqual(profile);
  });
});

describe("willingToRelocate control", () => {
  it("is a Yes/No select that round-trips to a real boolean", () => {
    const root = document.createElement("div");
    root.appendChild(renderFormView({ ...profile, jobPreferences: { ...profile.jobPreferences, willingToRelocate: true } }));
    const el = root.querySelector('[data-path="jobPreferences.willingToRelocate"]');
    expect(el.tagName).toBe("SELECT");
    expect(el.value).toBe("true");
    expect(el.getAttribute("data-jobfill-ui")).toBe("1");
    el.value = "false";
    expect(readFormView(root, profile).jobPreferences.willingToRelocate).toBe(false);
  });
});

describe("workAuthorization section", () => {
  const root = () => {
    const r = document.createElement("div");
    r.appendChild(renderFormView(profile));
    return r;
  };
  it("renders every control with data-jobfill-ui and a boolean select", () => {
    const r = root();
    for (const k of ["citizenOf", "authorizedToWorkIn", "requiresSponsorshipOutsideIndia", "note"]) {
      const el = r.querySelector(`[data-path="workAuthorization.${k}"]`);
      expect(el, k).toBeTruthy();
      expect(el.getAttribute("data-jobfill-ui")).toBe("1");
    }
    expect(r.querySelector('[data-path="workAuthorization.requiresSponsorshipOutsideIndia"]').tagName).toBe("SELECT");
  });
  it("round-trips edits as a real boolean and a trimmed array", () => {
    const r = root();
    r.querySelector('[data-path="workAuthorization.requiresSponsorshipOutsideIndia"]').value = "false";
    r.querySelector('[data-path="workAuthorization.authorizedToWorkIn"]').value = " India ,UAE, ";
    const back = readFormView(r, profile);
    expect(back.workAuthorization.requiresSponsorshipOutsideIndia).toBe(false);
    expect(back.workAuthorization.authorizedToWorkIn).toEqual(["India", "UAE"]);
    expect(validateProfile(back).valid).toBe(true);
  });
});
