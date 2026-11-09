import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { setDefaultProfile } from "../src/profile/load.js";
import { handleMapFields, handleGenerateAnswer, __setFetch, __resetBootstrap }
  from "../src/background.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));

function okResponse(content) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] })
  };
}

beforeEach(async () => {
  chrome.storage.local.__reset();
  setDefaultProfile(profile);
  await chrome.storage.local.set({
    settings: { apiKey: "sk-test", fastModel: "m-fast",
                qualityModel: "m-quality", baseUrl: "https://api.test/v1" }
  });
});

describe("handleMapFields", () => {
  it("sends only the selected role angle to the model", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse(JSON.stringify({ answers: [{ id: "f1", value: "x", source: "profile" }] })));
    __setFetch(fetchMock);

    await handleMapFields({
      fields: [{ id: "f1", kind: "input", label: "Email" }],
      pageContext: "Acme — Backend Engineer",
      role: "swe"
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const sent = JSON.stringify(body.messages);
    expect(sent).toContain(profile.roles.swe.headline);
    expect(sent).not.toContain(profile.roles.trainer.headline);
    expect(sent).not.toContain(profile.roles.genai.headline);
  });

  it("includes every truth rule verbatim", async () => {
    const fetchMock = vi.fn(async () => okResponse(JSON.stringify({ answers: [] })));
    __setFetch(fetchMock);
    await handleMapFields({ fields: [], pageContext: "p", role: "genai" });
    const sent = JSON.stringify(JSON.parse(fetchMock.mock.calls[0][1].body).messages);
    for (const rule of profile.truthRules) expect(sent).toContain(rule);
  });

  it("throws NO_KEY when the API key is not set", async () => {
    await chrome.storage.local.set({ settings: { apiKey: "" } });
    await expect(handleMapFields({ fields: [], pageContext: "p", role: "genai" }))
      .rejects.toThrow("NO_KEY");
  });
});

describe("handleGenerateAnswer", () => {
  it("returns trimmed plain text", async () => {
    __setFetch(async () => okResponse("  Here is my answer.  "));
    const out = await handleGenerateAnswer({
      question: "Why this role?", pageContext: "p", role: "genai"
    });
    expect(out.value).toBe("Here is my answer.");
  });

  it("passes an extra instruction through to the prompt", async () => {
    const fetchMock = vi.fn(async () => okResponse("ok"));
    __setFetch(fetchMock);
    await handleGenerateAnswer({
      question: "Why this role?", pageContext: "p", role: "genai",
      instruction: "mention LangGraph"
    });
    expect(JSON.stringify(JSON.parse(fetchMock.mock.calls[0][1].body).messages))
      .toContain("mention LangGraph");
  });
});

// Drive the real message listener (where bootstrapDefault is wired in).
function send(msg) {
  const [listener] = chrome.runtime.onMessage.__listeners;
  return new Promise((resolve) => listener(msg, {}, resolve));
}
const isProfileUrl = (u) => String(u).endsWith("profile.json");
const mapMsg = { action: "mapFields", fields: [], pageContext: "p", role: "genai" };

describe("default-profile bootstrap memo", () => {
  beforeEach(() => __resetBootstrap());

  it("fetches profile.json exactly once for concurrent messages", async () => {
    const fetchMock = vi.fn(async (url) =>
      isProfileUrl(url)
        ? { json: async () => profile }
        : okResponse(JSON.stringify({ answers: [] })));
    __setFetch(fetchMock);
    const [a, b] = await Promise.all([send(mapMsg), send(mapMsg)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fetchMock.mock.calls.filter(([u]) => isProfileUrl(u))).toHaveLength(1);
  });

  it("retries after a failed fetch instead of caching the rejection", async () => {
    let n = 0;
    const fetchMock = vi.fn(async (url) => {
      if (isProfileUrl(url)) {
        if (++n === 1) throw new Error("boom");
        return { json: async () => profile };
      }
      return okResponse(JSON.stringify({ answers: [] }));
    });
    __setFetch(fetchMock);
    const first = await send(mapMsg);
    expect(first.ok).toBe(false);
    expect(first.error).toContain("boom");
    const second = await send(mapMsg);
    expect(second.ok).toBe(true);
    expect(n).toBe(2);
  });
});

describe("model routing", () => {
  it("mapFields uses fastModel, generateAnswer uses qualityModel", async () => {
    const f1 = vi.fn(async () => okResponse(JSON.stringify({ answers: [] })));
    __setFetch(f1);
    await handleMapFields({ fields: [], pageContext: "p", role: "genai" });
    expect(JSON.parse(f1.mock.calls[0][1].body).model).toBe("m-fast");

    const f2 = vi.fn(async () => okResponse("ok"));
    __setFetch(f2);
    await handleGenerateAnswer({ question: "q", pageContext: "p", role: "genai" });
    expect(JSON.parse(f2.mock.calls[0][1].body).model).toBe("m-quality");
  });
});

describe("message listener", () => {
  it("answers unknown actions instead of hanging", async () => {
    expect(await send({ action: "nope" })).toEqual({ ok: false, error: "UNKNOWN_ACTION" });
  });

  it("getSettingsStatus does not need the profile fetch", async () => {
    __resetBootstrap();
    const fetchMock = vi.fn(async () => { throw new Error("down"); });
    __setFetch(fetchMock);
    expect(await send({ action: "getSettingsStatus" })).toEqual({ ok: true, hasKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
