import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { captureApplication } from "../src/track/capture.js";

function load(name, url) {
  return new JSDOM(readFileSync(`tests/fixtures/${name}`, "utf8"), { url }).window.document;
}
afterEach(() => vi.useRealTimers());

describe("captureApplication", () => {
  it("prefers JSON-LD for company and title", () => {
    const doc = load("greenhouse.html", "https://boards.greenhouse.io/acme/jobs/1");
    const c = captureApplication(doc, "https://boards.greenhouse.io/acme/jobs/1", "swe");
    expect(c.company).toBe("Acme Corp");
    expect(c.jobTitle).toBe("Senior Backend Engineer");
  });

  it("falls back to the hostname for company", () => {
    const doc = load("plain.html", "https://careers.swiggy.com/apply/9");
    expect(captureApplication(doc, "https://careers.swiggy.com/apply/9", "swe").company)
      .toBe("swiggy");
  });

  // Delegation to pageContext: the ATS vendor must never be recorded as the employer.
  it.each([
    ["https://barclays.wd3.myworkdayjobs.com/Barclays_Careers/job/x/1", "barclays"],
    ["https://boards.greenhouse.io/acme/jobs/1", "acme"],
    ["https://careers.acme.co.uk/jobs/1", "acme"]
  ])("names the employer, not the ATS vendor, for %s", (url, expected) => {
    expect(captureApplication(load("plain.html", url), url, "swe").company).toBe(expected);
  });

  it("records the domain without www", () => {
    const doc = load("plain.html", "https://www.phonepe.com/jobs/1");
    expect(captureApplication(doc, "https://www.phonepe.com/jobs/1", "swe").domain)
      .toBe("phonepe.com");
  });

  it("strips tracking params from the stored url", () => {
    const doc = load("plain.html", "https://a.com/j/1?utm_source=li");
    expect(captureApplication(doc, "https://a.com/j/1?utm_source=li", "swe").jobUrl)
      .toBe("https://a.com/j/1");
  });

  it("stamps today (local date) and the selected role", () => {
    const doc = load("plain.html", "https://a.com/j/1");
    const c = captureApplication(doc, "https://a.com/j/1", "trainer");
    expect(c.roleFamily).toBe("trainer");
    expect(c.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.state).toBe("Applied");
  });

  it("uses the LOCAL date just after midnight, not UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 5, 0, 30));
    const doc = load("plain.html", "https://a.com/j/1");
    expect(captureApplication(doc, "https://a.com/j/1", "swe").appliedAt).toBe("2026-10-05");
  });
});
