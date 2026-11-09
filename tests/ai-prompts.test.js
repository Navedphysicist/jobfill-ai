import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveProfile } from "../src/profile/resolve.js";
import { buildMapFieldsMessages, buildGenerateMessages, staticPrefix, LENGTH_CAPS }
  from "../src/ai/prompts.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));
const resolved = resolveProfile(profile, "genai");

describe("staticPrefix", () => {
  it("is byte-identical for the same resolved profile", () => {
    expect(staticPrefix(resolved)).toBe(staticPrefix(resolveProfile(profile, "genai")));
  });

  it("differs between role angles", () => {
    expect(staticPrefix(resolved)).not.toBe(staticPrefix(resolveProfile(profile, "swe")));
  });

  it("contains every truth rule verbatim", () => {
    const prefix = staticPrefix(resolved);
    expect(prefix).toContain("TRUTH RULES (These are ABSOLUTE.");
    for (const rule of profile.truthRules) expect(prefix).toContain(`\n- ${rule}\n`);
  });

  it("states all three work-authorization branches without hardcoding a country", () => {
    const prefix = staticPrefix(resolved);
    const start = prefix.indexOf("- Work authorization:");
    const rule = prefix.slice(start, prefix.indexOf("- Dates for a date input"));
    expect(rule).toContain("Job located in an authorized country: eligible = Yes, requires sponsorship = No");
    expect(rule).toContain("Job located anywhere else: eligible = No, requires sponsorship = Yes");
    expect(rule).toContain("unclear, remote, or not stated: do NOT guess; skip the field");
    expect(rule).not.toMatch(/India/);
  });

  it("contains no timestamp, random value or page detail", () => {
    const prefix = staticPrefix(resolved);
    expect(prefix).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(prefix).not.toContain("Page:");
  });
});

describe("buildMapFieldsMessages", () => {
  const msgs = buildMapFieldsMessages({
    resolved, fields: [{ id: "f1", kind: "input", label: "Email" }],
    pageContext: "Acme — Backend Engineer"
  });

  it("puts the static prefix first and nothing else in it", () => {
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe(staticPrefix(resolved));
  });

  it("puts all variable content last", () => {
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("Acme — Backend Engineer");
    expect(msgs[1].content).toContain("f1");
    expect(msgs[1].content.trimEnd().endsWith("Return the JSON object only.")).toBe(true);
  });

  it("keeps the system message identical across different pages", () => {
    const other = buildMapFieldsMessages({
      resolved, fields: [{ id: "zz", kind: "input", label: "Name" }],
      pageContext: "Different Co — Trainer"
    });
    expect(other[0].content).toBe(msgs[0].content);
  });
});

describe("buildGenerateMessages", () => {
  it("shares the same static prefix as mapFields", () => {
    const g = buildGenerateMessages({ resolved, question: "Why us?", pageContext: "p" });
    const m = buildMapFieldsMessages({ resolved, fields: [], pageContext: "p" });
    expect(g[0].content).toBe(m[0].content);
  });

  it("carries the instruction and the length target in the user message", () => {
    const g = buildGenerateMessages({
      resolved, question: "Why us?", pageContext: "p",
      instruction: "mention LangGraph", length: "shorter"
    });
    expect(g[1].content).toContain("mention LangGraph");
    expect(g[1].content).toContain("25-60 words");
  });

  it("caps output per length target", () => {
    expect(LENGTH_CAPS.shorter).toBe(250);
    expect(LENGTH_CAPS.normal).toBe(400);
    expect(LENGTH_CAPS.longer).toBe(700);
  });
});
