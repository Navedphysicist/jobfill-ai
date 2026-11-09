// tests/ai-inflight.test.js
import { describe, it, expect, vi } from "vitest";
import { dedupe, inflightCount } from "../src/ai/inflight.js";

describe("dedupe", () => {
  it("runs the factory once for concurrent identical keys", async () => {
    const factory = vi.fn(() => new Promise((r) => setTimeout(() => r("value"), 10)));
    const [a, b, c] = await Promise.all([
      dedupe("k", factory), dedupe("k", factory), dedupe("k", factory)
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual(["value", "value", "value"]);
  });

  it("runs the factory again once the first call has settled", async () => {
    const factory = vi.fn(async () => "v");
    await dedupe("k", factory);
    await dedupe("k", factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not share between different keys", async () => {
    const factory = vi.fn(async () => "v");
    await Promise.all([dedupe("a", factory), dedupe("b", factory)]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("propagates a rejection to every waiter and clears the entry", async () => {
    const factory = vi.fn(async () => { throw new Error("boom"); });
    const results = await Promise.allSettled([dedupe("k", factory), dedupe("k", factory)]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(inflightCount()).toBe(0);
  });
});
