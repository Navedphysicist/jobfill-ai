// tests/ai-client.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseAnswers, callModel, BadResponseError, TruncatedResponseError } from "../src/ai/client.js";
import { estimateCost, recordUsage, readUsage, DEFAULT_RATES_INR } from "../src/ai/usage.js";

const settings = { apiKey: "sk-test", baseUrl: "https://api.test/v1" };
const nap = async () => {};

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function okBody(content, usage) {
  return {
    choices: [{ message: { content } }],
    usage: usage || { prompt_tokens: 100, completion_tokens: 20,
                      prompt_tokens_details: { cached_tokens: 80 } }
  };
}

describe("parseAnswers", () => {
  it("parses clean JSON", () => {
    expect(parseAnswers('{"answers":[{"id":"a","value":"x","source":"profile"}]}').answers)
      .toHaveLength(1);
  });

  it("strips a markdown code fence", () => {
    expect(parseAnswers('```json\n{"answers":[]}\n```').answers).toEqual([]);
  });

  // Review Focus #3
  it("throws BadResponseError on malformed JSON rather than a raw SyntaxError", () => {
    expect(() => parseAnswers('{"answers": [')).toThrow(BadResponseError);
  });

  it("throws BadResponseError on truncated output", () => {
    expect(() => parseAnswers('{"answers":[{"id":"a","value":"half of a sent'))
      .toThrow(BadResponseError);
  });

  it("throws BadResponseError when answers is not an array", () => {
    expect(() => parseAnswers('{"answers":"nope"}')).toThrow(BadResponseError);
  });

  it("throws BadResponseError on an empty response", () => {
    expect(() => parseAnswers("")).toThrow(BadResponseError);
  });
});

describe("callModel", () => {
  it("returns content and normalised usage", async () => {
    const fetchImpl = async () => res(200, okBody("hello"));
    const out = await callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap });
    expect(out.content).toBe("hello");
    expect(out.usage).toEqual({ promptTokens: 100, cachedTokens: 80, completionTokens: 20, reasoningTokens: 0 });
  });

  it("sends max_completion_tokens when a cap is given", async () => {
    const fetchImpl = vi.fn(async () => res(200, okBody("x")));
    await callModel({ settings, model: "m", messages: [], maxTokens: 400, fetchImpl, sleepImpl: nap });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).max_completion_tokens).toBe(400);
  });

  it("retries a 429 and succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(429, { error: "rate" }))
      .mockResolvedValueOnce(res(200, okBody("ok")));
    const out = await callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap });
    expect(out.content).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts on repeated 500s", async () => {
    const fetchImpl = vi.fn(async () => res(500, { error: "boom" }));
    await expect(callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap }))
      .rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 401", async () => {
    const fetchImpl = vi.fn(async () => res(401, { error: "bad key" }));
    await expect(callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap }))
      .rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400", async () => {
    const fetchImpl = vi.fn(async () => res(400, { error: "bad request" }));
    await expect(callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap }))
      .rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("backs off for longer on each retry", async () => {
    const waits = [];
    const fetchImpl = vi.fn(async () => res(429, {}));
    await callModel({ settings, model: "m", messages: [], fetchImpl,
                      sleepImpl: async (ms) => { waits.push(ms); } }).catch(() => {});
    expect(waits.length).toBe(2);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });
});

describe("callModel: truncation and redaction", () => {
  const withFinish = (content, finish) => ({
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1500 }
  });
  const run = (fetchImpl) =>
    callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap }).catch((e) => e);

  it("throws TruncatedResponseError on finish_reason length with valid JSON", async () => {
    const err = await run(async () => res(200, withFinish('{"answers":[]}', "length")));
    expect(err).toBeInstanceOf(TruncatedResponseError);
    expect(err).not.toBeInstanceOf(BadResponseError);
    expect(err.truncated).toBe(true);
    expect(err.message).toMatch(/cut off/);
    expect(err.message).toMatch(/fewer fields/);
  });

  it("throws TruncatedResponseError on finish_reason length with truncated JSON", async () => {
    const err = await run(async () => res(200, withFinish('{"answers":[{"id":"a","value":"half', "length")));
    expect(err).toBeInstanceOf(TruncatedResponseError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err.message).not.toMatch(/JSON/);
  });

  it("does not flag finish_reason stop", async () => {
    const out = await run(async () => res(200, withFinish("ok", "stop")));
    expect(out.content).toBe("ok");
  });

  it("redacts API keys from a 401 body", async () => {
    const err = await run(async () =>
      res(401, { error: { message: "Incorrect API key provided: sk-proj-ABCDEF1234567890" } }));
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain("sk-proj-ABCDEF1234567890");
    expect(err.message).not.toContain("ABCDEF1234567890");
  });

  it("redacts long opaque tokens and caps the echoed body", async () => {
    const err = await run(async () => res(400, { error: "A".repeat(40) + "x ".repeat(600) }));
    expect(err.message).not.toContain("A".repeat(40));
    expect(err.message.length).toBeLessThan(300);
  });
});

describe("parseAnswers: more shapes", () => {
  it("rejects non-object JSON, fenced garbage and undefined as BadResponseError", () => {
    expect(() => parseAnswers("null")).toThrow(BadResponseError);
    expect(() => parseAnswers("```json\nnot json\n```")).toThrow(BadResponseError);
    expect(() => parseAnswers(undefined)).toThrow(BadResponseError);
  });
});

describe("callModel: hardening", () => {
  const run = (fetchImpl, s = settings) =>
    callModel({ settings: s, model: "m", messages: [], fetchImpl, sleepImpl: nap }).catch((e) => e);

  it("turns a non-JSON 200 body into BadResponseError", async () => {
    const err = await run(async () => ({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError("Unexpected token <"); },
      text: async () => "<html>"
    }));
    expect(err).toBeInstanceOf(BadResponseError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err.message).toMatch(/not JSON/);
  });

  it("keeps request ids and UUIDs readable", async () => {
    const req = "req_" + "a1b2c3d4".repeat(4);
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const err = await run(async () => res(400, { error: `bad ${req} and ${uuid}` }));
    expect(err.message).toContain(req);
    expect(err.message).toContain(uuid);
  });

  it("scrubs the configured apiKey even when it is not key-shaped", async () => {
    const err = await run(async () => res(401, { error: "bad key hunter2-secret" }),
      { ...settings, apiKey: "hunter2-secret" });
    expect(err.message).not.toContain("hunter2-secret");
  });

  it("redacts a Bearer token on its own", async () => {
    const err = await run(async () => res(401, { error: "Authorization: Bearer abc.def-123" }));
    expect(err.message).not.toContain("abc.def-123");
    expect(err.message).toContain("Bearer [redacted]");
  });

  it("makes exactly one fetch call on truncation", async () => {
    const fetchImpl = vi.fn(async () => res(200, {
      choices: [{ message: { content: "{" }, finish_reason: "length" }]
    }));
    await run(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps backoff within the jittered, capped range", async () => {
    const waits = [];
    await callModel({ settings, model: "m", messages: [], fetchImpl: async () => res(503, {}),
      sleepImpl: async (ms) => { waits.push(ms); } }).catch(() => {});
    expect(waits[0]).toBeGreaterThanOrEqual(250);
    expect(waits[0]).toBeLessThanOrEqual(500);
    expect(waits[1]).toBeGreaterThanOrEqual(500);
    expect(waits[1]).toBeLessThanOrEqual(1000);
    waits.forEach((w) => expect(w).toBeLessThanOrEqual(8000));
  });
});

describe("estimateCost: robustness", () => {
  it("falls back to the input rate when cachedInput is missing", () => {
    const c = estimateCost({ model: "m", promptTokens: 1e6, cachedTokens: 5e5, completionTokens: 0 },
      { m: { input: 100, output: 400 } });
    expect(Number.isFinite(c)).toBe(true);
    expect(c).toBeCloseTo(100, 5);
  });

  it("does not over-report when cachedTokens exceeds promptTokens", () => {
    const c = estimateCost({ model: "m", promptTokens: 1e6, cachedTokens: 5e6, completionTokens: 0 },
      { m: { input: 100, cachedInput: 10, output: 400 } });
    expect(c).toBeCloseTo(10, 5);
  });

  it("defaults to DEFAULT_RATES_INR when no rates are passed", () => {
    expect(estimateCost({ model: "gpt-5-mini", promptTokens: 1e6, cachedTokens: 0, completionTokens: 0 }))
      .toBeCloseTo(DEFAULT_RATES_INR["gpt-5-mini"].input, 5);
  });
});

describe("recordUsage: concurrency and failure", () => {
  beforeEach(() => chrome.storage.local.__reset());

  it("keeps all 20 concurrent entries", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      recordUsage({ task: "t", model: "m", promptTokens: i, cachedTokens: 0, completionTokens: 0, estimatedCost: 0 })));
    expect((await readUsage()).entries).toHaveLength(20);
  });

  it("does not reject when storage.set throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orig = chrome.storage.local.set;
    chrome.storage.local.set = async () => { throw new Error("QUOTA_BYTES exceeded"); };
    try {
      await expect(recordUsage({ task: "t", model: "m" })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      chrome.storage.local.set = orig;
      warn.mockRestore();
    }
  });
});

describe("estimateCost", () => {
  const rates = { "m": { input: 100, cachedInput: 10, output: 400 } }; // INR per 1M tokens

  it("charges cached input at the cached rate", () => {
    const full = estimateCost({ model: "m", promptTokens: 1e6, cachedTokens: 0, completionTokens: 0 }, rates);
    const cached = estimateCost({ model: "m", promptTokens: 1e6, cachedTokens: 1e6, completionTokens: 0 }, rates);
    expect(full).toBeCloseTo(100, 5);
    expect(cached).toBeCloseTo(10, 5);
  });

  it("charges output at the output rate", () => {
    expect(estimateCost({ model: "m", promptTokens: 0, cachedTokens: 0, completionTokens: 1e6 }, rates))
      .toBeCloseTo(400, 5);
  });

  it("returns 0 for an unknown model rather than NaN", () => {
    expect(estimateCost({ model: "unknown", promptTokens: 1e6, cachedTokens: 0, completionTokens: 0 }, rates))
      .toBe(0);
  });
});

describe("usage log", () => {
  beforeEach(() => chrome.storage.local.__reset());

  it("accumulates totals across calls", async () => {
    await recordUsage({ task: "mapFields", model: "m", promptTokens: 100,
                        cachedTokens: 80, completionTokens: 20, estimatedCost: 1.5 });
    await recordUsage({ task: "generateAnswer", model: "m", promptTokens: 200,
                        cachedTokens: 150, completionTokens: 50, estimatedCost: 2.5 });
    const { totals, entries } = await readUsage();
    expect(entries).toHaveLength(2);
    expect(totals.promptTokens).toBe(300);
    expect(totals.cachedTokens).toBe(230);
    expect(totals.estimatedCost).toBeCloseTo(4, 5);
  });

  it("keeps at most 1000 entries", async () => {
    for (let i = 0; i < 1005; i++) {
      await recordUsage({ task: "t", model: "m", promptTokens: 1,
                          cachedTokens: 0, completionTokens: 1, estimatedCost: 0 });
    }
    expect((await readUsage()).entries.length).toBe(1000);
  });
});
