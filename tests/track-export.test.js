import { describe, it, expect } from "vitest";
import { toCsv, toJson } from "../src/track/export.js";

const rows = [
  { sno: 1, company: "Acme", jobTitle: "Backend Engineer", appliedAt: "2026-10-10",
    state: "Applied", domain: "acme.com", jobUrl: "https://a.com/1",
    roleFamily: "swe", outcomeReason: "", notes: "" },
  { sno: 2, company: 'Big "Quoted" Co', jobTitle: "Eng, Senior", appliedAt: "2026-10-11",
    state: "Rejected", domain: "big.com", jobUrl: "https://b.com/2",
    roleFamily: "genai", outcomeReason: "Line one\nLine two", notes: "" }
];

describe("toCsv", () => {
  const csv = toCsv(rows);
  const lines = csv.split("\n");

  it("starts with a header row", () => {
    expect(lines[0]).toContain("Company");
    expect(lines[0]).toContain("Job URL");
  });

  it("escapes embedded quotes by doubling them", () => {
    expect(csv).toContain('"Big ""Quoted"" Co"');
  });

  it("quotes values containing a comma", () => {
    expect(csv).toContain('"Eng, Senior"');
  });

  it("quotes values containing a newline", () => {
    expect(csv).toContain('"Line one\nLine two"');
  });

  it("writes one data row per record", () => {
    expect(csv.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });
});

describe("toCsv safety", () => {
  const row = (over) => ({ sno: 1, company: "A", jobTitle: "T", appliedAt: "", state: "Applied",
    domain: "", jobUrl: "", roleFamily: "", outcomeReason: "", notes: "", ...over });

  it("quotes a value containing a carriage return", () => {
    expect(toCsv([row({ notes: "a\rb" })])).toContain('"a\rb"');
  });
  it("neutralises a formula in jobTitle and keeps it one field", () => {
    const csv = toCsv([row({ jobTitle: '=HYPERLINK("http://x","clickme")' })]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"",""clickme"")"`);
  });
  it("prefixes a leading minus in company", () => {
    expect(toCsv([row({ company: "-Acme" })]).split("\n")[1]).toMatch(/^1,'-Acme,/);
  });
  it("prefixes + @ tab and CR leaders", () => {
    for (const lead of ["+1", "@x", "\tx"]) {
      expect(toCsv([row({ notes: lead })])).toContain("'" + lead);
    }
    expect(toCsv([row({ notes: "\rx" })])).toContain(`"'\rx"`);
  });
  it("leaves sno untouched", () => {
    expect(toCsv([row({ sno: -3 })]).split("\n")[1].startsWith("-3,")).toBe(true);
    expect(toCsv([row()]).split("\n")[1].startsWith("1,")).toBe(true);
  });
});

describe("toJson", () => {
  it("omits the derived sno", () => {
    expect(JSON.parse(toJson(rows))[0].sno).toBeUndefined();
  });
  it("keeps every stored field", () => {
    expect(JSON.parse(toJson(rows))[0].company).toBe("Acme");
  });
});
