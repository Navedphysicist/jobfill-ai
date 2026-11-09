// Regression tests for the "scanned 9 · filled 0" truncation failure.
//
// Root cause: the default models are gpt-5-mini, a REASONING model. On those,
// max_completion_tokens covers invisible reasoning tokens as well as the visible
// answer, so a budget sized only for the answer is spent entirely on reasoning
// and the reply comes back finish_reason="length" with ZERO content.
import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { capFor, effortFor, MAP_FIELDS_MIN, MAP_FIELDS_MAX } from "../src/ai/router.js";
import { callModel, supportsReasoning } from "../src/ai/client.js";
import { fillPage } from "../src/content.js";

const settings = { apiKey: "k", baseUrl: "https://api.test/v1" };
const okRes = (body) => ({ ok: true, status: 200, json: async () => body });
const reply = (content, extra = {}) => ({
  choices: [{ finish_reason: "stop", message: { content } }],
  usage: { prompt_tokens: 10, completion_tokens: 20, ...extra }
});

describe("capFor('mapFields') budgets for reasoning tokens", () => {
  const f = (kind) => ({ id: "x", kind });

  it("never budgets less than the reasoning floor", () => {
    expect(capFor("mapFields", [f("input")])).toBe(MAP_FIELDS_MIN);
    expect(MAP_FIELDS_MIN).toBeGreaterThanOrEqual(3000);
  });

  it("grows with the batch instead of staying fixed", () => {
    const small = capFor("mapFields", Array(5).fill(f("textarea")));
    const large = capFor("mapFields", Array(30).fill(f("textarea")));
    expect(large).toBeGreaterThan(small);
  });

  it("budgets more for free-text fields than for checkboxes", () => {
    const text = capFor("mapFields", Array(20).fill(f("textarea")));
    const boxes = capFor("mapFields", Array(20).fill(f("checkbox")));
    expect(text).toBeGreaterThan(boxes);
  });

  it("clamps at a ceiling", () => {
    expect(capFor("mapFields", Array(500).fill(f("textarea")))).toBe(MAP_FIELDS_MAX);
  });

  it("survives being called with no fields", () => {
    expect(capFor("mapFields")).toBe(MAP_FIELDS_MIN);
  });

  it("gives prose generation room to reason above its visible-answer target", () => {
    expect(capFor("generateAnswer", "normal")).toBeGreaterThan(400);
    expect(capFor("generateAnswer", "longer"))
      .toBeGreaterThan(capFor("generateAnswer", "shorter"));
  });
});

describe("effortFor", () => {
  it("keeps field mapping on low reasoning effort", () => {
    expect(effortFor("mapFields")).toBe("low");
  });
});

describe("supportsReasoning", () => {
  it("recognises the gpt-5 and o-series families", () => {
    expect(supportsReasoning("gpt-5-mini")).toBe(true);
    expect(supportsReasoning("o3-mini")).toBe(true);
  });
  it("rejects non-reasoning models, which error on the parameter", () => {
    expect(supportsReasoning("gpt-4o")).toBe(false);
    expect(supportsReasoning("")).toBe(false);
  });
});

describe("callModel reasoning wiring", () => {
  it("sends reasoning_effort to a reasoning model", async () => {
    const fetchImpl = vi.fn(async () => okRes(reply("{}")));
    await callModel({ settings, model: "gpt-5-mini", messages: [], reasoningEffort: "low", fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).reasoning_effort).toBe("low");
  });

  it("omits reasoning_effort for a model that would reject it", async () => {
    const fetchImpl = vi.fn(async () => okRes(reply("{}")));
    await callModel({ settings, model: "gpt-4o", messages: [], reasoningEffort: "low", fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).reasoning_effort).toBeUndefined();
  });

  it("records reasoning tokens so an invisible spend is diagnosable", async () => {
    const fetchImpl = async () =>
      okRes(reply("{}", { completion_tokens_details: { reasoning_tokens: 1472 } }));
    const { usage } = await callModel({ settings, model: "gpt-5-mini", messages: [], fetchImpl });
    expect(usage.reasoningTokens).toBe(1472);
  });
});

describe("fillPage recovers from a truncated batch", () => {
  const doc = () => new JSDOM(readFileSync("tests/fixtures/plain.html", "utf8"),
    { url: "https://jobs.acme.com/apply/123" }).window.document;

  it("halves the batch and retries instead of losing every field", async () => {
    let first = true;
    const sendMessage = vi.fn(async (msg) => {
      if (first && msg.fields.length > 1) {
        first = false;
        return { ok: false, truncated: true, error: "cut off" };
      }
      return {
        ok: true,
        answers: msg.fields.map((f) => ({
          id: f.id,
          value: f.label === "Email address" ? "naved@example.com" : "",
          source: "profile"
        }))
      };
    });
    const d = doc();
    const out = await fillPage({ sendMessage, doc: d, roleKey: "genai" });
    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);   // it split
    expect(d.getElementById("email").value).toBe("naved@example.com"); // and still filled
    expect(out.errors).toEqual([]);
  });

  it("reports the error when a single field still truncates", async () => {
    const sendMessage = async () => ({ ok: false, truncated: true, error: "cut off" });
    const out = await fillPage({ sendMessage, doc: doc(), roleKey: "genai" });
    expect(out.filled).toBe(0);
    expect(out.errors.join(" ")).toContain("cut off");
  });
});
