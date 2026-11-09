import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { addApplication, listApplications, updateApplication,
         deleteApplication, normalizeUrl, APPLICATION_STATES }
  from "../src/track/store.js";

const base = {
  company: "Acme", jobTitle: "Backend Engineer", appliedAt: "2026-10-10",
  state: "Applied", domain: "acme.com",
  jobUrl: "https://jobs.acme.com/apply/1", roleFamily: "swe"
};

beforeEach(() => chrome.storage.local.__reset());
afterEach(() => vi.useRealTimers());

describe("normalizeUrl", () => {
  it("strips tracking params and the hash", () => {
    expect(normalizeUrl("https://a.com/j/1?utm_source=li&gh_src=x&keep=1#top"))
      .toBe("https://a.com/j/1?keep=1");
  });
  it("leaves a clean url alone", () => {
    expect(normalizeUrl("https://a.com/j/1")).toBe("https://a.com/j/1");
  });
  it("returns the input unchanged when it is not a url", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("addApplication", () => {
  it("defaults appliedAt to the LOCAL date, not UTC", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 5, 0, 30));
    const { appliedAt, ...rest } = base;
    await addApplication(rest);
    expect((await listApplications())[0].appliedAt).toBe("2026-10-05");
  });

  it("stores a record and returns its id", async () => {
    const res = await addApplication(base);
    expect(res.ok).toBe(true);
    expect(res.id).toBeTruthy();
    expect((await listApplications()).length).toBe(1);
  });

  it("defaults the state to Applied", async () => {
    const { company, jobUrl } = base;
    await addApplication({ company, jobUrl });
    expect((await listApplications())[0].state).toBe("Applied");
  });

  // Review Focus #5
  it("refuses a duplicate jobUrl and names the existing record", async () => {
    const first = await addApplication(base);
    const second = await addApplication({ ...base, company: "Acme again" });
    expect(second.ok).toBe(false);
    expect(second.duplicateOf).toBe(first.id);
    expect((await listApplications()).length).toBe(1);
  });

  it("treats urls differing only by tracking params as the same application", async () => {
    await addApplication(base);
    const dup = await addApplication({ ...base, jobUrl: `${base.jobUrl}?utm_source=linkedin` });
    expect(dup.ok).toBe(false);
  });

  it("allows a duplicate when force is set", async () => {
    await addApplication(base);
    const forced = await addApplication({ ...base, force: true });
    expect(forced.ok).toBe(true);
    expect((await listApplications()).length).toBe(2);
  });
});

describe("listApplications", () => {
  it("returns newest first and numbers oldest as 1", async () => {
    await addApplication({ ...base, appliedAt: "2026-10-01", jobUrl: "https://a.com/1" });
    await addApplication({ ...base, appliedAt: "2026-10-09", jobUrl: "https://a.com/2" });
    const rows = await listApplications();
    expect(rows[0].appliedAt).toBe("2026-10-09");
    expect(rows[0].sno).toBe(2);
    expect(rows[1].sno).toBe(1);
  });

  it("filters by state", async () => {
    await addApplication({ ...base, jobUrl: "https://a.com/1" });
    await addApplication({ ...base, jobUrl: "https://a.com/2", state: "Rejected" });
    expect((await listApplications({ state: "Rejected" })).length).toBe(1);
  });

  it("filters by company substring, case-insensitively", async () => {
    await addApplication({ ...base, company: "Swiggy", jobUrl: "https://a.com/1" });
    await addApplication({ ...base, company: "PhonePe", jobUrl: "https://a.com/2" });
    expect((await listApplications({ search: "swig" }))[0].company).toBe("Swiggy");
  });
});

describe("updateApplication", () => {
  it("changes the state and refreshes updatedAt", async () => {
    const { id } = await addApplication(base);
    const before = (await listApplications())[0].updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await updateApplication(id, { state: "Rejected", outcomeReason: "No GenAI depth" });
    const row = (await listApplications())[0];
    expect(row.state).toBe("Rejected");
    expect(row.outcomeReason).toBe("No GenAI depth");
    expect(row.updatedAt).not.toBe(before);
  });

  it("rejects a state that is not in the list", async () => {
    const { id } = await addApplication(base);
    const res = await updateApplication(id, { state: "Ghosted" });
    expect(res.ok).toBe(false);
    expect((await listApplications())[0].state).toBe("Applied");
  });

  it("reports a missing id instead of throwing", async () => {
    expect((await updateApplication("nope", { state: "Applied" })).ok).toBe(false);
  });
});

describe("deleteApplication", () => {
  it("removes the record", async () => {
    const { id } = await addApplication(base);
    await deleteApplication(id);
    expect((await listApplications()).length).toBe(0);
  });
});

describe("APPLICATION_STATES", () => {
  it("is the five states from the spec", () => {
    expect(APPLICATION_STATES).toEqual(
      ["Applied", "Call or Mail", "Process Started", "Rejected", "On Hold"]);
  });
});

describe("concurrency", () => {
  it("keeps all 20 records when adds are not awaited one by one", async () => {
    await Promise.all([...Array(20)].map((_, i) =>
      addApplication({ company: "C", jobUrl: `https://x.com/${i}` })));
    expect((await listApplications()).length).toBe(20);
  });

  it("lets only one of several simultaneous same-url adds through", async () => {
    const res = await Promise.all([...Array(5)].map(() =>
      addApplication({ company: "C", jobUrl: "https://x.com/same" })));
    expect(res.filter((r) => r.ok).length).toBe(1);
    expect((await listApplications()).length).toBe(1);
  });

  it("keeps every edit when updates are not awaited", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await addApplication({ company: "C", jobUrl: `https://x.com/${i}` })).id);
    await Promise.all(ids.map((id) => updateApplication(id, { state: "Rejected" })));
    expect((await listApplications({ state: "Rejected" })).length).toBe(5);
  });
});

describe("deleteApplication safety", () => {
  it("refuses a missing id and deletes nothing", async () => {
    await chrome.storage.local.set({ applications: [{ company: "NoId", appliedAt: "2026-10-01" }] });
    for (const bad of [undefined, null, ""]) {
      expect((await deleteApplication(bad)).ok).toBe(false);
    }
    expect((await listApplications()).length).toBe(1);
  });
});

describe("corrupt storage", () => {
  it("lists the valid rows when one row is null", async () => {
    await addApplication(base);
    const { applications } = await chrome.storage.local.get(["applications"]);
    await chrome.storage.local.set({ applications: [null, ...applications, "junk"] });
    const rows = await listApplications();
    expect(rows.length).toBe(1);
    expect(rows[0].company).toBe("Acme");
  });

  it("backs up a non-array value before the next write overwrites it", async () => {
    await chrome.storage.local.set({ applications: { weird: "data" } });
    expect(await listApplications()).toEqual([]);
    await addApplication(base);
    const got = await chrome.storage.local.get(["applications_corrupt_backup"]);
    expect(got.applications_corrupt_backup).toEqual({ weird: "data" });
  });

  it("does not clobber an existing backup", async () => {
    await chrome.storage.local.set({ applications: "second", applications_corrupt_backup: "first" });
    await addApplication(base);
    const got = await chrome.storage.local.get(["applications_corrupt_backup"]);
    expect(got.applications_corrupt_backup).toBe("first");
  });
});

describe("updateApplication field rules", () => {
  it("rejects a bad appliedAt and leaves the record untouched", async () => {
    const { id } = await addApplication(base);
    const res = await updateApplication(id, { notes: "ok", evil: 1, appliedAt: "garbage" });
    expect(res.ok).toBe(false);
    const row = (await listApplications())[0];
    expect(row.notes).toBe("");
    expect(row.appliedAt).toBe("2026-10-10");
    expect(row.evil).toBeUndefined();
  });

  it("applies whitelisted fields and drops unknown keys, sno and force", async () => {
    const { id } = await addApplication(base);
    const res = await updateApplication(id, { notes: "ok", evil: 1, sno: 99, force: true, id: "hijack" });
    expect(res.ok).toBe(true);
    const row = (await listApplications())[0];
    expect(row.notes).toBe("ok");
    expect(row.evil).toBeUndefined();
    expect(row.force).toBeUndefined();
    expect(row.sno).toBe(1);
    expect(row.id).toBe(id);
    const { applications } = await chrome.storage.local.get(["applications"]);
    expect("sno" in applications[0]).toBe(false);
  });

  it("coerces values to strings", async () => {
    const { id } = await addApplication(base);
    await updateApplication(id, { notes: 42 });
    expect((await listApplications())[0].notes).toBe("42");
  });
});

describe("write failures", () => {
  it("returns ok:false instead of throwing", async () => {
    const orig = chrome.storage.local.set;
    chrome.storage.local.set = () => Promise.reject(new Error("QUOTA"));
    try {
      const res = await addApplication(base);
      expect(res.ok).toBe(false);
      expect(res.error).toContain("QUOTA");
    } finally { chrome.storage.local.set = orig; }
  });
});

describe("normalizeUrl hardening", () => {
  it("passes non-http(s) input through unchanged and never throws", () => {
    for (const s of ["about:blank", "javascript:void(0)", "", "mailto:a@b.c"]) {
      expect(normalizeUrl(s)).toBe(s);
    }
    expect(() => normalizeUrl(undefined)).not.toThrow();
  });
});
