// tests/scan.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { labelFor } from "../src/scan/labels.js";
import { scanFields } from "../src/scan/fields.js";
import { pageContext } from "../src/scan/context.js";

function load(name) {
  return new JSDOM(readFileSync(`tests/fixtures/${name}`, "utf8"),
    { url: "https://jobs.acme.com/apply/123" }).window.document;
}

describe("labelFor", () => {
  const doc = load("plain.html");

  it("uses an explicit label[for]", () => {
    expect(labelFor(doc.getElementById("email"))).toBe("Email address");
  });

  it("falls back to aria-label", () => {
    expect(labelFor(doc.getElementById("phone"))).toBe("Phone number");
  });

  it("falls back to the placeholder", () => {
    expect(labelFor(doc.getElementById("linkedin"))).toBe("LinkedIn URL");
  });

  // Review Focus #2
  it("returns an empty string for a field with nothing to go on", () => {
    expect(labelFor(doc.querySelector('[data-testid="bare"]'))).toBe("");
  });
});

describe("labelFor neighbour isolation", () => {
  const frag = (inner) => new JSDOM(`<body><div class="shared">${inner}</div></body>`).window.document;

  it("does not hand a bare input the label of a sibling field", () => {
    const doc = frag('<div><label for="a">First name</label><input id="a"></div><div><input data-testid="b"></div>');
    expect(labelFor(doc.querySelector('[data-testid="b"]'))).toBe("");
  });

  it("does not use a label that wraps a different control", () => {
    const doc = frag('<div><label>Nickname <input id="n"></label></div><div><span><input data-testid="b"></span></div>');
    expect(labelFor(doc.querySelector('[data-testid="b"]'))).toBe("");
  });

  it("does not use the legend of a fieldset the input is not inside", () => {
    const doc = frag('<fieldset><legend>Work authorisation</legend><input type="radio" name="w" id="w1"><label for="w1">Yes</label></fieldset><div><input data-testid="b"></div>');
    expect(labelFor(doc.querySelector('[data-testid="b"]'))).toBe("");
  });

  it("never labels an input with the page <title> (\"Apply\")", () => {
    const doc = new JSDOM('<html><head><title>Apply</title></head><body><div><input data-testid="b"></div></body></html>').window.document;
    expect(labelFor(doc.querySelector('[data-testid="b"]'))).not.toBe("Apply");
    expect(labelFor(doc.querySelector('[data-testid="b"]'))).toBe("");
  });

  it("falls back to the id when there is no label, placeholder or name", () => {
    const doc = frag('<input id="linkedinUrl">');
    expect(labelFor(doc.getElementById("linkedinUrl"))).toBe("linkedinUrl");
  });
});

describe("scanFields", () => {
  it("finds inputs, textareas, selects and checkboxes", () => {
    const { fields } = scanFields(load("plain.html"));
    const kinds = fields.map((f) => f.kind);
    expect(kinds).toContain("input");
    expect(kinds).toContain("textarea");
    expect(kinds).toContain("select");
    expect(kinds).toContain("checkbox");
  });

  it("collapses a radio group into one field carrying its options", () => {
    const { fields } = scanFields(load("plain.html"));
    const radio = fields.find((f) => f.kind === "radio");
    expect(radio).toBeTruthy();
    expect(radio.options).toEqual(["Yes", "No"]);
  });

  it("captures select options verbatim", () => {
    const { fields } = scanFields(load("plain.html"));
    const sel = fields.find((f) => f.kind === "select");
    expect(sel.options).toContain("India");
  });

  it("skips hidden, disabled, password and file inputs", () => {
    const { fields } = scanFields(load("plain.html"));
    const labels = fields.map((f) => f.label).join(" ");
    expect(labels).not.toContain("Secret");
    expect(labels).not.toContain("Resume file");
    expect(labels).not.toContain("Disabled field");
  });

  it("ignores the extension's own UI", () => {
    const doc = load("plain.html");
    const ui = doc.createElement("input");
    ui.setAttribute("data-jobfill-ui", "1");
    ui.id = "jfa-own";
    doc.body.appendChild(ui);
    const { fields } = scanFields(doc);
    expect(fields.some((f) => f.id === "jfa-own")).toBe(false);
  });

  it("emits an unlabelled field rather than dropping it", () => {
    const { fields } = scanFields(load("plain.html"));
    const bare = fields.find((f) => f.label === "");
    expect(bare).toBeTruthy();
  });

  it("gives every field a unique id", () => {
    const { fields } = scanFields(load("greenhouse.html"));
    expect(new Set(fields.map((f) => f.id)).size).toBe(fields.length);
  });

  it("detects Workday-style listbox widgets", () => {
    const { fields } = scanFields(load("workday.html"));
    const widget = fields.find((f) => f.kind === "widget");
    expect(widget).toBeTruthy();
    expect(widget.label).toContain("Country");
  });
});

describe("rescanning", () => {
  it("leaves no stale data-jfa-id after the page changes between scans", () => {
    const doc = load("plain.html");
    scanFields(doc);
    // The form changes: one field disappears, another becomes disabled (skipped).
    doc.getElementById("email").closest("div").remove();
    doc.getElementById("phone").disabled = true;
    const { fields } = scanFields(doc);
    const ids = new Set(fields.map((f) => f.id));
    for (const el of doc.querySelectorAll("[data-jfa-id]")) expect(ids.has(el.dataset.jfaId)).toBe(true);
    for (const f of fields.filter((x) => x.kind !== "radio")) {
      const matches = doc.querySelectorAll(`[data-jfa-id="${f.id}"]`);
      expect(matches).toHaveLength(1);
      expect(labelFor(matches[0])).toBe(f.label);
    }
  });

  it("finds the Workday widget on both scans", () => {
    const doc = load("workday.html");
    expect(scanFields(doc).fields.some((f) => f.kind === "widget")).toBe(true);
    expect(scanFields(doc).fields.some((f) => f.kind === "widget")).toBe(true);
  });
});

describe("radio groups across forms", () => {
  it("keeps same-named groups in different forms separate", () => {
    const doc = new JSDOM(`<body>
      <form><fieldset><legend>Gender</legend><input type="radio" name="gender" value="m" id="a1"><label for="a1">Male</label><input type="radio" name="gender" value="f" id="a2"><label for="a2">Female</label></fieldset></form>
      <form><fieldset><legend>Gender (EEO)</legend><input type="radio" name="gender" value="d" id="b1"><label for="b1">Decline</label><input type="radio" name="gender" value="o" id="b2"><label for="b2">Other</label></fieldset></form>
    </body>`).window.document;
    const radios = scanFields(doc).fields.filter((f) => f.kind === "radio");
    expect(radios).toHaveLength(2);
    expect(radios[0].options).toEqual(["Male", "Female"]);
    expect(radios[1].options).toEqual(["Decline", "Other"]);
  });
});

describe("pageContext", () => {
  it("does not name the ATS vendor as the company", () => {
    const d = new JSDOM("<body></body>").window.document;
    expect(pageContext(d, "https://boards.greenhouse.io/acme/jobs/1").company).toBe("acme");
  });

  it("uses the subdomain for Workday and iCIMS hosts", () => {
    const d = new JSDOM("<body></body>").window.document;
    expect(pageContext(d, "https://barclays.wd3.myworkdayjobs.com/Barclays_Careers/job/London/x").company).toBe("barclays");
    expect(pageContext(d, "https://careers-acme.icims.com/jobs/123").company).toBe("acme");
  });

  it("handles two-part public suffixes", () => {
    const d = new JSDOM("<body></body>").window.document;
    expect(pageContext(d, "https://careers.acme.co.uk/job/2").company).toBe("acme");
  });

  it("reads company and title from JSON-LD when present", () => {
    const doc = load("greenhouse.html");
    const ctx = pageContext(doc, "https://jobs.acme.com/apply/123");
    expect(ctx.company).toBe("Acme Corp");
    expect(ctx.jobTitle).toBe("Senior Backend Engineer");
  });

  it("falls back to the hostname when there is no metadata", () => {
    const doc = load("plain.html");
    expect(pageContext(doc, "https://jobs.acme.com/apply/123").company).toBe("acme");
  });
});
