import { describe, it, expect } from "vitest";
import { renderLogForm, readLogForm } from "../src/ui/popup/log-form.js";
import { APPLICATION_STATES } from "../src/track/store.js";

const capture = {
  company: "Acme", jobTitle: "Backend Engineer", appliedAt: "2026-10-12",
  state: "Applied", domain: "acme.com", jobUrl: "https://a.com/j/1", roleFamily: "swe"
};
const roleLabels = { genai: "GenAI Engineer", swe: "Software Engineer", trainer: "Trainer / L&D" };

function mount(c) {
  const root = document.createElement("div");
  root.appendChild(renderLogForm(c, { roleLabels }));
  return root;
}

describe("renderLogForm", () => {
  it("pre-fills every captured field", () => {
    const root = mount(capture);
    expect(root.querySelector('[name="company"]').value).toBe("Acme");
    expect(root.querySelector('[name="jobTitle"]').value).toBe("Backend Engineer");
    expect(root.querySelector('[name="jobUrl"]').value).toBe("https://a.com/j/1");
    expect(root.querySelector('[name="domain"]').value).toBe("acme.com");
    expect(root.querySelector('[name="appliedAt"]').value).toBe("2026-10-12");
  });

  it("offers every state, defaulting to Applied", () => {
    const sel = mount(capture).querySelector('[name="state"]');
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(APPLICATION_STATES);
    expect(sel.value).toBe("Applied");
  });

  it("preselects the captured role", () => {
    expect(mount(capture).querySelector('[name="roleFamily"]').value).toBe("swe");
  });

  it("leaves every field editable", () => {
    for (const el of mount(capture).querySelectorAll("input, select")) {
      expect(el.disabled).toBe(false);
      expect(el.readOnly).toBeFalsy();
    }
  });
});

describe("readLogForm", () => {
  it("round-trips the capture unedited", () => {
    expect(readLogForm(mount(capture))).toMatchObject(capture);
  });

  it("picks up an edited company name", () => {
    const root = mount(capture);
    root.querySelector('[name="company"]').value = "Acme India";
    expect(readLogForm(root).company).toBe("Acme India");
  });
});
