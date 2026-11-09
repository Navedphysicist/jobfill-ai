// tests/background-cost.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { setDefaultProfile, saveProfile } from "../src/profile/load.js";
import { handleGenerateAnswer, handleMapFields, __setFetch, __resetBootstrap } from "../src/background.js";
import { clearCache, cacheStats } from "../src/ai/cache.js";
import { readUsage } from "../src/ai/usage.js";
import { inflightCount } from "../src/ai/inflight.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));

function okResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 20,
               prompt_tokens_details: { cached_tokens: 80 } }
    }),
    text: async () => ""
  };
}

beforeEach(async () => {
  chrome.storage.local.__reset();
  setDefaultProfile(profile);
  await clearCache();
  await chrome.storage.local.set({
    settings: { apiKey: "sk-test", fastModel: "fast-m",
                qualityModel: "quality-m", baseUrl: "https://api.test/v1" }
  });
});

describe("cost layer", () => {
  it("serves a repeated question from cache without calling the API", async () => {
    const fetchMock = vi.fn(async () => okResponse("My answer."));
    __setFetch(fetchMock);

    const first = await handleGenerateAnswer({ question: "Why us?", pageContext: "Barclays Careers — barclays.com", role: "genai" });
    const second = await handleGenerateAnswer({ question: "why us?  ", pageContext: "Google Careers — google.com", role: "genai" });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toBe("My answer.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never shows the page identity to the model for a cacheable request", async () => {
    const fetchMock = vi.fn(async () => okResponse("Neutral answer."));
    __setFetch(fetchMock);
    await handleGenerateAnswer({ question: "Why us?", pageContext: "Barclays Careers — barclays.com", role: "genai" });
    const user = (i) => JSON.parse(fetchMock.mock.calls[i][1].body).messages.find((m) => m.role === "user").content;
    expect(user(0)).not.toMatch(/Page:/);
    expect(user(0)).not.toMatch(/Barclays/);

    await handleGenerateAnswer({ question: "Why us?", pageContext: "Barclays Careers — barclays.com", role: "genai", instruction: "be brief" });
    expect(user(1)).toMatch(/Page: Barclays Careers/);
  });

  it("misses the cache after the profile content changes on the same day", async () => {
    const fetchMock = vi.fn(async () => okResponse("Answer."));
    __setFetch(fetchMock);
    const q = { question: "What are your salary expectations?", pageContext: "p", role: "genai" };
    await handleGenerateAnswer(q);
    expect((await handleGenerateAnswer(q)).cached).toBe(true);

    const edited = structuredClone(profile);
    edited.jobPreferences.expectedSalary = "INR 26 LPA";
    expect((await saveProfile(edited)).ok).toBe(true);
    expect((await handleGenerateAnswer(q)).cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache when the user regenerates", async () => {
    const fetchMock = vi.fn(async () => okResponse("Answer."));
    __setFetch(fetchMock);
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai", bypassCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an answer across role angles", async () => {
    const fetchMock = vi.fn(async () => okResponse("Answer."));
    __setFetch(fetchMock);
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "swe" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("routes mapFields to the fast model and generation to the quality model", async () => {
    const fetchMock = vi.fn(async (_url, init) =>
      okResponse(JSON.parse(init.body).model === "fast-m" ? '{"answers":[]}' : "prose"));
    __setFetch(fetchMock);

    await handleMapFields({ fields: [], pageContext: "p", role: "genai" });
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });

    const models = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).model);
    expect(models).toEqual(["fast-m", "quality-m"]);
  });

  it("collapses two concurrent identical generate calls into one API call", async () => {
    const fetchMock = vi.fn(() => new Promise((r) => setTimeout(() => r(okResponse("A")), 15)));
    __setFetch(fetchMock);
    const args = { question: "Why us?", pageContext: "p", role: "genai" };
    await Promise.all([handleGenerateAnswer(args), handleGenerateAnswer(args)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records usage for a real call and not for a cache hit", async () => {
    __setFetch(async () => okResponse("Answer."));
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    const { entries } = await readUsage();
    expect(entries).toHaveLength(1);
    expect(entries[0].cachedTokens).toBe(80);
    expect((await cacheStats()).hits).toBe(1);
  });

  it("surfaces a malformed mapFields response as a clean error", async () => {
    __setFetch(async () => okResponse("not json at all"));
    await expect(handleMapFields({ fields: [], pageContext: "p", role: "genai" }))
      .rejects.toThrow(/unusable/);
  });
});

function send(msg) {
  const [listener] = chrome.runtime.onMessage.__listeners;
  return new Promise((resolve) => listener(msg, {}, resolve));
}
const isProfileUrl = (u) => String(u).endsWith("profile.json");
const genMsg = { action: "generateAnswer", question: "Why us?", pageContext: "p", role: "genai" };

describe("one-off requests are never cached", () => {
  it("does not cache or reuse when an instruction or currentValue is given", async () => {
    const fetchMock = vi.fn(async () => okResponse("A"));
    __setFetch(fetchMock);
    const base = { question: "Why us?", pageContext: "p", role: "genai" };
    await handleGenerateAnswer({ ...base, instruction: "be brief" });
    await handleGenerateAnswer({ ...base, instruction: "be brief" });
    await handleGenerateAnswer({ ...base, currentValue: "draft" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await cacheStats()).entries).toBe(0);
  });
});

describe("usage logging can never fail a paid call", () => {
  it("returns the answer when the rates in storage are garbage", async () => {
    await chrome.storage.local.set({ rates: "not an object" });
    __setFetch(async () => okResponse("Fine."));
    const r = await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    expect(r).toEqual({ value: "Fine.", cached: false });
  });

  it("returns the answer when the storage write for usage throws", async () => {
    __setFetch(async () => okResponse("Fine."));
    const spy = vi.spyOn(chrome.storage.local, "set").mockImplementation(async (o) => {
      if (o.usageLog) throw new Error("quota");
      return undefined;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    spy.mockRestore(); warn.mockRestore();
    expect(r.value).toBe("Fine.");
  });

  it("uses user-edited rates from storage", async () => {
    await chrome.storage.local.set({ rates: { "quality-m": { input: 1000000, cachedInput: 0, output: 0 } } });
    __setFetch(async () => okResponse("A"));
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    const { entries } = await readUsage();
    expect(entries[0].estimatedCost).toBeCloseTo(20, 5); // 20 uncached prompt tokens x 1/token
  });
});

describe("message listener error mapping", () => {
  beforeEach(() => __resetBootstrap());
  const profileOr = (fn) => async (url, init) =>
    isProfileUrl(url) ? { json: async () => profile } : fn(url, init);

  it("passes a truncation message through intact and flags it", async () => {
    __setFetch(profileOr(async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "{" }, finish_reason: "length" }] }),
      text: async () => ""
    })));
    const res = await send({ action: "mapFields", fields: [], pageContext: "p", role: "genai" });
    expect(res.ok).toBe(false);
    expect(res.truncated).toBe(true);
    expect(res.error).toMatch(/fewer fields/);
  });

  it("maps a malformed response to a clean, non-truncated error", async () => {
    __setFetch(profileOr(async () => okResponse("not json")));
    const res = await send({ action: "mapFields", fields: [], pageContext: "p", role: "genai" });
    expect(res.ok).toBe(false);
    expect(res.truncated).toBeFalsy();
    expect(res.error).toMatch(/unusable/);
  });

  it("keeps a catch-all for HTTP and network failures", async () => {
    __setFetch(profileOr(async () => ({ ok: false, status: 401, text: async () => "bad key" })));
    const http = await send(genMsg);
    expect(http.ok).toBe(false);
    expect(http.error).toMatch(/API 401/);

    __setFetch(profileOr(async () => { throw new TypeError("Failed to fetch"); }));
    const net = await send({ ...genMsg, bypassCache: true });
    expect(net).toMatchObject({ ok: false, error: "Failed to fetch" });
  });

  it("returns NO_KEY unchanged", async () => {
    await chrome.storage.local.set({ settings: { apiKey: "" } });
    __setFetch(profileOr(async () => okResponse("x")));
    expect(await send(genMsg)).toMatchObject({ ok: false, error: "NO_KEY" });
  });
});

describe("cache message actions (worker owns the cache queue)", () => {
  beforeEach(() => __resetBootstrap());

  it("cacheStats and clearCache work through the worker", async () => {
    __setFetch(async (url) => isProfileUrl(url) ? { json: async () => profile } : okResponse("A"));
    await send(genMsg);
    const stats = await send({ action: "cacheStats" });
    expect(stats).toMatchObject({ ok: true, entries: 1, hits: 0, misses: 1 });
    expect(await send({ action: "clearCache" })).toEqual({ ok: true });
    expect(await send({ action: "cacheStats" })).toMatchObject({ ok: true, entries: 0, hits: 0 });
  });

  it("usageSummary returns totals", async () => {
    __setFetch(async (url) => isProfileUrl(url) ? { json: async () => profile } : okResponse("A"));
    await send(genMsg);
    const res = await send({ action: "usageSummary" });
    expect(res.ok).toBe(true);
    expect(res.totals.calls).toBe(1);
    expect(res.cache.misses).toBe(1);
  });
});

describe("fix round 1", () => {
  beforeEach(() => __resetBootstrap());
  const fetchFor = (reply) => async (url) =>
    isProfileUrl(url) ? { json: async () => profile } : reply();

  it("counts calls whose model has no rates entry as unpriced", async () => {
    __setFetch(fetchFor(() => okResponse("A"))); // quality-m has no default rate
    await send(genMsg);
    const res = await send({ action: "usageSummary" });
    expect(res.unpricedCalls).toBe(1);
    await chrome.storage.local.set({ rates: { "quality-m": { input: 1, cachedInput: 0, output: 1 } } });
    expect((await send({ action: "usageSummary" })).unpricedCalls).toBe(0);
  });

  it.each(["", "   \n "])("does not cache an empty completion (%j) and surfaces an error", async (empty) => {
    const fetchMock = vi.fn(async () => okResponse(empty));
    __setFetch(fetchMock);
    const args = { question: "Why us?", pageContext: "p", role: "genai" };
    await expect(handleGenerateAnswer(args)).rejects.toThrow(/empty answer/);
    expect((await cacheStats()).entries).toBe(0);
    await expect(handleGenerateAnswer(args)).rejects.toThrow(/empty answer/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bypassCache still writes the fresh answer", async () => {
    let n = 0;
    __setFetch(async () => okResponse(`Answer ${++n}`));
    const args = { question: "Why us?", pageContext: "p", role: "genai" };
    await handleGenerateAnswer(args);
    await handleGenerateAnswer({ ...args, bypassCache: true });
    const third = await handleGenerateAnswer(args);
    expect(third).toEqual({ value: "Answer 2", cached: true });
  });

  it("a failed call frees its dedupe key so a retry can proceed", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () =>
      ++n === 1 ? { ok: false, status: 400, text: async () => "nope" } : okResponse("Recovered"));
    __setFetch(fetchMock);
    const args = { question: "Why us?", pageContext: "p", role: "genai" };
    await expect(handleGenerateAnswer(args)).rejects.toThrow(/API 400/);
    expect(await handleGenerateAnswer(args)).toEqual({ value: "Recovered", cached: false });
    expect(inflightCount()).toBe(0);
  });
});
