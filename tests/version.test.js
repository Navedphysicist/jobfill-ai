// tests/version.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { EXTENSION_VERSION, PROFILE_SCHEMA_VERSION } from "../src/version.js";

describe("version constants", () => {
  it("exposes the extension version", () => {
    expect(EXTENSION_VERSION).toBe("2.0.0");
  });

  it("exposes the profile schema version as a number", () => {
    expect(PROFILE_SCHEMA_VERSION).toBe(2);
  });
});

describe("chrome mock", () => {
  beforeEach(() => chrome.storage.local.__reset());

  it("round-trips a value through storage", async () => {
    await chrome.storage.local.set({ hello: "world" });
    const got = await chrome.storage.local.get(["hello"]);
    expect(got.hello).toBe("world");
  });

  it("returns an empty object for missing keys", async () => {
    const got = await chrome.storage.local.get(["nope"]);
    expect(got).toEqual({});
  });
});
