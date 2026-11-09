
// tests/ai-cache.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cacheKey, getCached, setCached, clearCache, cacheStats, TTL_MS, MAX_ENTRIES }
  from "../src/ai/cache.js";

const q = { question: "Why do you want to work here?", roleKey: "genai",
            profileVersion: "2026-10-12", length: "normal" };

beforeEach(() => chrome.storage.local.__reset());
const realSet = chrome.storage.local.set;
afterEach(() => {
  vi.useRealTimers();
  chrome.storage.local.set = realSet;
  vi.restoreAllMocks();
});

describe("cacheKey", () => {
  it("is stable for the same inputs", async () => {
    expect(await cacheKey(q)).toBe(await cacheKey({ ...q }));
  });

  it("ignores case and surrounding whitespace in the question", async () => {
    expect(await cacheKey(q))
      .toBe(await cacheKey({ ...q, question: "  WHY DO YOU WANT TO WORK HERE?  " }));
  });

  it("collapses internal whitespace", async () => {
    expect(await cacheKey(q))
      .toBe(await cacheKey({ ...q, question: "Why do you    want to work\nhere?" }));
  });

  it("differs by role", async () => {
    expect(await cacheKey(q)).not.toBe(await cacheKey({ ...q, roleKey: "swe" }));
  });

  it("differs by profile version, so an edit invalidates the cache", async () => {
    expect(await cacheKey(q)).not.toBe(await cacheKey({ ...q, profileVersion: "2026-11-01" }));
  });

  it("differs by length target", async () => {
    expect(await cacheKey(q)).not.toBe(await cacheKey({ ...q, length: "shorter" }));
  });
});

describe("get and set", () => {
  it("returns null on a miss", async () => {
    expect(await getCached(await cacheKey(q))).toBeNull();
  });

  it("round-trips an answer", async () => {
    const k = await cacheKey(q);
    await setCached(k, { answer: "Because…", model: "m" });
    expect((await getCached(k)).answer).toBe("Because…");
  });

  it("expires an entry past the TTL and removes it", async () => {
    vi.useFakeTimers();
    const k = await cacheKey(q);
    await setCached(k, { answer: "old", model: "m" });
    vi.setSystemTime(new Date(Date.now() + TTL_MS + 1000));
    expect(await getCached(k)).toBeNull();
    expect((await cacheStats()).entries).toBe(0);
  });

  it("counts hits and misses", async () => {
    const k = await cacheKey(q);
    await getCached(k);
    await setCached(k, { answer: "a", model: "m" });
    await getCached(k);
    const s = await cacheStats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
  });
});

describe("eviction", () => {
  it("never grows past MAX_ENTRIES", async () => {
    for (let i = 0; i < MAX_ENTRIES + 25; i++) {
      await setCached(`k${i}`, { answer: `a${i}`, model: "m" });
    }
    expect((await cacheStats()).entries).toBeLessThanOrEqual(MAX_ENTRIES);
  });

  it("evicts the oldest entries first", async () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      await setCached(`k${i}`, { answer: `a${i}`, model: "m" });
    }
    expect(await getCached("k0")).toBeNull();
    expect((await getCached(`k${MAX_ENTRIES + 4}`)).answer).toBe(`a${MAX_ENTRIES + 4}`);
  });

  // Review Focus #4
  it("recovers from a quota error by evicting and retrying", async () => {
    for (let i = 0; i < 20; i++) await setCached(`k${i}`, { answer: `a${i}`, model: "m" });

    const realSet = chrome.storage.local.set.bind(chrome.storage.local);
    let thrown = false;
    chrome.storage.local.set = async (obj) => {
      if (!thrown) {
        thrown = true;
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      return realSet(obj);
    };

    await expect(setCached("new", { answer: "fits now", model: "m" })).resolves.toBeUndefined();
    chrome.storage.local.set = realSet;

    expect((await getCached("new")).answer).toBe("fits now");
    expect((await cacheStats()).entries).toBeLessThan(21);
  });
});

describe("clearCache", () => {
  it("empties the cache and resets the counters", async () => {
    await setCached("k", { answer: "a", model: "m" });
    await clearCache();
    const s = await cacheStats();
    expect(s.entries).toBe(0);
    expect(s.hits).toBe(0);
    expect(s.misses).toBe(0);
  });
});

describe("failure isolation and serialisation", () => {
  it("setCached resolves and warns when the write fails even after retry", async () => {
    const realSet = chrome.storage.local.set;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    chrome.storage.local.set = async () => { throw new Error("QUOTA_BYTES quota exceeded"); };
    await expect(setCached("k", { answer: "a", model: "m" })).resolves.toBeUndefined();
    chrome.storage.local.set = realSet;
    expect(warn).toHaveBeenCalled();
    expect(await cacheStats()).toMatchObject({ entries: 0 });
  });

  it("retries only once on quota failure", async () => {
    const realSet = chrome.storage.local.set;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    chrome.storage.local.set = async () => { calls++; throw new Error("quota"); };
    await setCached("k", { answer: "a", model: "m" });
    chrome.storage.local.set = realSet;
    warn.mockRestore();
    expect(calls).toBe(2);
  });

  it("keeps every entry when setCached is called concurrently", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) =>
      setCached(`c${i}`, { answer: `a${i}`, model: "m" })));
    expect((await cacheStats()).entries).toBe(30);
  });

  it("counts hits correctly under concurrent reads", async () => {
    await setCached("k", { answer: "a", model: "m" });
    await Promise.all(Array.from({ length: 10 }, () => getCached("k")));
    expect((await cacheStats()).hits).toBe(10);
  });

  it("quota recovery keeps the new entry and drops about half the old ones", async () => {
    for (let i = 0; i < 20; i++) await setCached(`k${i}`, { answer: `a${i}`, model: "m" });
    const realSet = chrome.storage.local.set.bind(chrome.storage.local);
    let thrown = false;
    chrome.storage.local.set = async (o) => {
      if (!thrown) { thrown = true; throw new Error("quota"); }
      return realSet(o);
    };
    await setCached("new", { answer: "x", model: "m" });
    chrome.storage.local.set = realSet;
    const s = await cacheStats();
    expect(s.entries).toBeLessThanOrEqual(11);
    expect((await getCached("new")).answer).toBe("x");
    expect(await getCached("k0")).toBeNull();
    expect((await getCached("k19")).answer).toBe("a19");
  });
});

describe("stat and corruption resilience", () => {
  it("still returns a cached answer when the stat write fails", async () => {
    await setCached("k", { answer: "paid for", model: "m" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    chrome.storage.local.set = async () => { throw new Error("quota"); };
    expect((await getCached("k")).answer).toBe("paid for");
  });

  it("still reports a miss (not an error) when the stat write fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    chrome.storage.local.set = async () => { throw new Error("quota"); };
    expect(await getCached("nope")).toBeNull();
  });

  it("does not serve an entry with a corrupt createdAt", async () => {
    await chrome.storage.local.set({
      answerCache: { bad: { answer: "x", model: "m", createdAt: undefined } }
    });
    expect(await getCached("bad")).toBeNull();
    expect((await cacheStats()).entries).toBe(0);
  });

  it("evicts a corrupt-createdAt entry first", async () => {
    const map = { bad: { answer: "x", model: "m" } };
    for (let i = 0; i < MAX_ENTRIES; i++) map[`k${i}`] = { answer: "a", model: "m", createdAt: 1000 + i };
    await chrome.storage.local.set({ answerCache: map });
    await setCached("new", { answer: "n", model: "m" });
    const s = await cacheStats();
    expect(s.entries).toBe(MAX_ENTRIES);
    expect((await getCached("new")).answer).toBe("n");
    expect(await getCached("bad")).toBeNull();
  });
});
