import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { loadProfile, saveProfile, resetProfile, setDefaultProfile }
  from "../src/profile/load.js";

const defaultProfile = JSON.parse(readFileSync("profile.json", "utf8"));

beforeEach(() => {
  chrome.storage.local.__reset();
  setDefaultProfile(defaultProfile);
});

describe("loadProfile", () => {
  it("returns the bundled default when storage is empty", async () => {
    const p = await loadProfile();
    expect(p.personal.email).toBe(defaultProfile.personal.email);
  });

  it("prefers the stored copy over the bundled default", async () => {
    const edited = structuredClone(defaultProfile);
    edited.personal.phone = "+91 9999999999";
    await chrome.storage.local.set({ profile: edited });
    const p = await loadProfile();
    expect(p.personal.phone).toBe("+91 9999999999");
  });

  it("migrates a stored v1 profile on read", async () => {
    const v1 = structuredClone(defaultProfile);
    delete v1._meta;
    delete v1.roles;
    v1.headline = "V1 HEADLINE";
    await chrome.storage.local.set({ profile: v1 });
    const p = await loadProfile();
    expect(p._meta.version).toBe(2);
    expect(p.roles.genai.headline).toBe("V1 HEADLINE");
  });

  it("backs up the v1 profile before replacing it", async () => {
    const v1 = structuredClone(defaultProfile);
    delete v1._meta;
    delete v1.roles;
    await chrome.storage.local.set({ profile: v1 });
    await loadProfile();
    const dump = chrome.storage.local.__dump();
    expect(dump.profile_v1_backup).toEqual(v1);
  });

  it("does not overwrite an existing backup on a second migration", async () => {
    const first = structuredClone(defaultProfile);
    delete first._meta;
    delete first.roles;
    first.personal.city = "FirstOriginal";
    await chrome.storage.local.set({ profile: first });
    await loadProfile();

    const second = structuredClone(first);
    second.personal.city = "SecondV1";
    await chrome.storage.local.set({ profile: second });
    await loadProfile();

    expect(chrome.storage.local.__dump().profile_v1_backup).toEqual(first);
  });

  it("leaves a profile with a newer schema version untouched", async () => {
    const future = structuredClone(defaultProfile);
    future._meta = { version: 3, updatedAt: "2027-01-01" };
    future.jobPreferences.expectedSalary = "INR 25 LPA";
    await chrome.storage.local.set({ profile: future });
    const p = await loadProfile();
    expect(p._meta.version).toBe(3);
    expect(p.jobPreferences.expectedSalary).toBe("INR 25 LPA");
    expect(chrome.storage.local.__dump().profile_v1_backup).toBeUndefined();
  });
});

describe("saveProfile", () => {
  it("writes a valid profile and bumps updatedAt", async () => {
    const edited = structuredClone(defaultProfile);
    edited.personal.city = "Hyderabad";
    const res = await saveProfile(edited);
    expect(res.ok).toBe(true);
    const back = await loadProfile();
    expect(back.personal.city).toBe("Hyderabad");
    expect(back._meta.updatedAt).toBeTruthy();
  });

  it("refuses an invalid profile and leaves storage untouched", async () => {
    const good = structuredClone(defaultProfile);
    good.personal.city = "Keep Me";
    await saveProfile(good);

    const bad = structuredClone(defaultProfile);
    bad.personal.email = "broken";
    const res = await saveProfile(bad);

    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.path === "personal.email")).toBe(true);
    const back = await loadProfile();
    expect(back.personal.city).toBe("Keep Me");
  });
});

describe("resetProfile", () => {
  it("restores the bundled default", async () => {
    const edited = structuredClone(defaultProfile);
    edited.personal.city = "Changed";
    await saveProfile(edited);
    const p = await resetProfile();
    expect(p.personal.city).toBe(defaultProfile.personal.city);
  });

  it("does not persist an invalid migration but still returns it", async () => {
    const v1 = structuredClone(defaultProfile);
    delete v1._meta;
    delete v1.roles;
    delete v1.personal.email;
    await chrome.storage.local.set({ profile: v1 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = await loadProfile();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(p._meta.version).toBe(2);
    const dump = chrome.storage.local.__dump();
    expect(dump.profile).toEqual(v1);
    expect(dump.profile_v1_backup).toEqual(v1);
  });
});
