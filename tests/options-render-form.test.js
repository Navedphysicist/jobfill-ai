// tests/options-render-form.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderFormView, readFormView } from "../src/ui/options/render-form.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));

function mount(p) {
  const root = document.createElement("div");
  root.appendChild(renderFormView(p));
  return root;
}

describe("renderFormView", () => {
  it("renders an input for every personal field", () => {
    const root = mount(profile);
    for (const key of Object.keys(profile.personal)) {
      const el = root.querySelector(`[data-path="personal.${key}"]`);
      expect(el, `missing input for personal.${key}`).toBeTruthy();
      expect(el.value).toBe(String(profile.personal[key]));
    }
  });

  it("renders every truth rule as an editable row", () => {
    const root = mount(profile);
    const rows = root.querySelectorAll('[data-path^="truthRules\\["]');
    expect(rows.length).toBe(profile.truthRules.length);
  });

  it("renders the three role angles", () => {
    const root = mount(profile);
    for (const key of ["genai", "swe", "trainer"]) {
      expect(root.querySelector(`[data-path="roles.${key}.headline"]`)).toBeTruthy();
      expect(root.querySelector(`[data-path="roles.${key}.emphasis"]`)).toBeTruthy();
    }
  });

  it("marks every control as extension UI", () => {
    const root = mount(profile);
    for (const el of root.querySelectorAll("input, textarea")) {
      expect(el.getAttribute("data-jobfill-ui")).toBe("1");
    }
  });
});

describe("readFormView", () => {
  it("round-trips an unedited profile", () => {
    const root = mount(profile);
    const back = readFormView(root);
    expect(back.personal).toEqual(profile.personal);
    expect(back.truthRules).toEqual(profile.truthRules);
    expect(back.roles.swe.headline).toBe(profile.roles.swe.headline);
  });

  it("picks up an edit made in the form", () => {
    const root = mount(profile);
    root.querySelector('[data-path="personal.city"]').value = "Hyderabad";
    expect(readFormView(root).personal.city).toBe("Hyderabad");
  });

  it("preserves sections that have no form controls", () => {
    const root = mount(profile);
    expect(readFormView(root, profile).experience).toEqual(profile.experience);
  });

  it("merges edits onto the base profile", () => {
    const root = mount(profile);
    root.querySelector('[data-path="personal.city"]').value = "Hyderabad";
    const back = readFormView(root, profile);
    expect(back.personal.city).toBe("Hyderabad");
    expect(back.workAuthorization).toEqual(profile.workAuthorization);
  });
});
