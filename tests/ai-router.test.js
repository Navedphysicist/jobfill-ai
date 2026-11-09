// tests/ai-router.test.js
import { describe, it, expect } from "vitest";
import { modelFor, capFor, REASONING_HEADROOM, MAP_FIELDS_MIN } from "../src/ai/router.js";

const settings = { fastModel: "fast-m", qualityModel: "quality-m" };

describe("modelFor", () => {
  it("routes field mapping to the fast model", () => {
    expect(modelFor("mapFields", settings)).toBe("fast-m");
  });
  it("routes prose generation to the quality model", () => {
    expect(modelFor("generateAnswer", settings)).toBe("quality-m");
  });
  it("falls back to the quality model for an unknown task", () => {
    expect(modelFor("whatever", settings)).toBe("quality-m");
  });
});

describe("capFor", () => {
  it("caps field mapping at the reasoning floor for a tiny batch", () => {
    expect(capFor("mapFields", [{ kind: "input" }])).toBe(MAP_FIELDS_MIN);
  });
  it("caps generation by length target plus reasoning headroom", () => {
    expect(capFor("generateAnswer", "shorter")).toBe(250 + REASONING_HEADROOM);
    expect(capFor("generateAnswer", "normal")).toBe(400 + REASONING_HEADROOM);
    expect(capFor("generateAnswer", "longer")).toBe(700 + REASONING_HEADROOM);
  });
  it("treats an unknown length as normal", () => {
    expect(capFor("generateAnswer", "enormous")).toBe(400 + REASONING_HEADROOM);
  });
});
