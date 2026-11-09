import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fillPage, pickRoleKey } from "../src/content.js";

function load(name) {
  return new JSDOM(readFileSync(`tests/fixtures/${name}`, "utf8"),
    { url: "https://jobs.acme.com/apply/123" }).window.document;
}

describe("fillPage", () => {
  it("sends every scanned field to the worker and reports the count", async () => {
    const doc = load("plain.html");
    const sendMessage = vi.fn(async (msg) => ({
      ok: true,
      answers: msg.fields.map((f) => ({ id: f.id, value: "", source: "skipped" }))
    }));
    const out = await fillPage({ sendMessage, doc, roleKey: "swe" });
    expect(sendMessage.mock.calls[0][0].action).toBe("mapFields");
    expect(sendMessage.mock.calls[0][0].role).toBe("swe");
    expect(out.scanned).toBe(sendMessage.mock.calls[0][0].fields.length);
    expect(out.scanned).toBeGreaterThan(0);
  });

  it("applies returned answers to the page", async () => {
    const doc = load("plain.html");
    const sendMessage = async (msg) => ({
      ok: true,
      answers: msg.fields.map((f) => ({
        id: f.id,
        value: f.label === "Email address" ? "naved@example.com" : "",
        source: "profile"
      }))
    });
    const out = await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(doc.getElementById("email").value).toBe("naved@example.com");
    expect(out.filled).toBe(1);
  });

  it("returns the worker error instead of throwing", async () => {
    const doc = load("plain.html");
    const sendMessage = async () => ({ ok: false, error: "NO_KEY" });
    const out = await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(out.errors).toContain("NO_KEY");
    expect(out.filled).toBe(0);
  });

  it("skips answers whose field id no longer exists", async () => {
    const doc = load("plain.html");
    const sendMessage = async () => ({
      ok: true,
      answers: [{ id: "jfa-does-not-exist", value: "x", source: "profile" }]
    });
    const out = await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(out.filled).toBe(0);
    expect(out.errors).toEqual([]);
  });

  function manyFields(n) {
    const html = "<form>" + Array.from({ length: n }, (_, i) =>
      `<label for="f${i}">Field ${i}</label><input id="f${i}" type="text">`).join("") + "</form>";
    return new JSDOM(html, { url: "https://jobs.acme.com/apply/123" }).window.document;
  }
  const fillAll = (msg) => ({
    ok: true,
    answers: msg.fields.map((f) => ({ id: f.id, value: "v-" + f.label, source: "profile" }))
  });

  it("batches 80 fields as 12s with a remainder, each id exactly once", async () => {
    const doc = manyFields(80);
    const sendMessage = vi.fn(async (m) => fillAll(m));
    const out = await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(sendMessage.mock.calls.map((c) => c[0].fields.length))
      .toEqual([12, 12, 12, 12, 12, 12, 8]);
    const ids = sendMessage.mock.calls.flatMap((c) => c[0].fields.map((f) => f.id));
    expect(new Set(ids).size).toBe(80);
    expect(out.scanned).toBe(80);
    expect(out.filled).toBe(80);
  });

  it("a failed chunk does not abort the others", async () => {
    const doc = manyFields(80);
    let n = 0;
    const sendMessage = async (m) => {
      if (++n === 2) throw new Error("boom");
      return fillAll(m);
    };
    const out = await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(out.filled).toBe(68); // 80 minus the one 12-field chunk that threw
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("fields 13-24");
    expect(out.errors[0]).toContain("boom");
  });

  it("short forms use exactly one call", async () => {
    const doc = manyFields(5);
    const sendMessage = vi.fn(async (m) => fillAll(m));
    await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("counts failed applies as skipped, not deliberate skips", async () => {
    const doc = load("plain.html");
    const sendMessage = async (msg) => ({
      ok: true,
      answers: msg.fields.map((f, i) => ({
        id: f.id,
        value: i === 0 ? "" : "x",
        source: i === 0 ? "skipped" : "profile"
      }))
    });
    const out = await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(out.skipped).toBe(out.scanned - 1 - out.filled);
    expect(out.filled + out.skipped).toBe(out.scanned - 1);
  });

  it("applies a duplicated id only once", async () => {
    const doc = manyFields(2);
    const sendMessage = async (msg) => ({
      ok: true,
      answers: [0, 0].map(() => ({ id: msg.fields[0].id, value: "a", source: "profile" }))
    });
    const out = await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(out.filled).toBe(1);
  });
});

describe("tooltip default role", () => {
  it("uses the popup's saved role when it is a known role", () => {
    const labels = { genai: "GenAI", swe: "SWE", trainer: "Trainer" };
    expect(pickRoleKey("trainer", labels)).toBe("trainer");
    expect(pickRoleKey(undefined, labels)).toBe("genai");
    expect(pickRoleKey("bogus", labels)).toBe("genai");
    expect(pickRoleKey("genai", { swe: "SWE" })).toBe("swe");
  });
});
