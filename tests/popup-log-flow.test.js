import { describe, it, expect, vi } from "vitest";
import { createLogFlow, fillAllFrames } from "../src/ui/popup/log-flow.js";

const cap = { company: "Acme", jobTitle: "BE", appliedAt: "2026-10-12", state: "Applied",
  domain: "a.com", jobUrl: "https://a.com/j/1", roleFamily: "swe" };

function setup({ add, update, capture } = {}) {
  document.body.innerHTML = `<form id="f" hidden><div id="hint" hidden></div><div id="fields"></div>
    <div id="status"></div><div id="dup" hidden></div><button id="save"></button></form>`;
  const els = { form: document.getElementById("f"), fields: document.getElementById("fields"),
    dup: document.getElementById("dup"), hint: document.getElementById("hint"),
    status: document.getElementById("status"), save: document.getElementById("save") };
  const store = {
    addApplication: add || vi.fn().mockResolvedValue({ ok: false, duplicateOf: "app_1" }),
    updateApplication: update || vi.fn().mockResolvedValue({ ok: true })
  };
  const capFn = capture || vi.fn().mockResolvedValue(cap);
  capFn.fallback = () => ({ ...cap, company: "" });
  const flow = createLogFlow({ els, store, capture: capFn, roleLabels: { swe: "SWE", genai: "G" } });
  return { els, store, flow, capFn };
}
const edit = (els) => {
  const c = els.form.querySelector('[name="company"]');
  c.value = "Acme India";
  c.dispatchEvent(new Event("input", { bubbles: true }));
};
const button = (els, text) => [...els.dup.querySelectorAll("button")].find((b) => b.textContent === text);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("duplicate flow", () => {
  it("Update existing sends the full edited record", async () => {
    const { els, store, flow } = setup();
    await flow.open(); edit(els);
    await flow.submit();
    button(els, "Update existing").click(); await flush();
    expect(store.updateApplication).toHaveBeenCalledWith("app_1",
      expect.objectContaining({ company: "Acme India", jobUrl: cap.jobUrl, roleFamily: "swe" }));
  });

  it("Save anyway sends force:true and edited values", async () => {
    const { els, store, flow } = setup();
    await flow.open(); edit(els);
    await flow.submit();
    button(els, "Save anyway").click(); await flush();
    expect(store.addApplication).toHaveBeenLastCalledWith(
      expect.objectContaining({ company: "Acme India", force: true }));
  });

  it("Keep editing hides only the warning and keeps typed values", async () => {
    const { els, flow, capFn } = setup();
    await flow.open(); edit(els);
    await flow.submit();
    button(els, "Keep editing").click();
    expect(els.dup.hidden).toBe(true);
    expect(els.form.hidden).toBe(false);
    expect(els.form.querySelector('[name="company"]').value).toBe("Acme India");
    flow.cancel(); await flow.open();
    expect(els.form.querySelector('[name="company"]').value).toBe("Acme India");
    expect(capFn).toHaveBeenCalledTimes(1);
  });

  it("a failed Update keeps all three buttons enabled with an error", async () => {
    const { els, flow } = setup({ update: vi.fn().mockResolvedValue({ ok: false, error: "boom" }) });
    await flow.open(); await flow.submit();
    button(els, "Update existing").click(); await flush();
    expect(els.dup.textContent).toContain("boom");
    for (const t of ["Update existing", "Save anyway", "Keep editing"]) expect(button(els, t).disabled).toBe(false);
  });

  it("double-clicking Save writes once", async () => {
    let release; const add = vi.fn(() => new Promise((r) => { release = r; }));
    const { flow, els } = setup({ add });
    await flow.open();
    const p1 = flow.submit(); const p2 = flow.submit();
    expect(els.save.disabled).toBe(true);
    release({ ok: true }); await Promise.all([p1, p2]);
    expect(add.mock.calls.length).toBe(1);
  });

  it("shows a hint when capture fails", async () => {
    const { els, flow } = setup({ capture: vi.fn().mockResolvedValue(undefined) });
    await flow.open();
    expect(els.hint.hidden).toBe(false);
    expect(els.hint.textContent).toContain("fill these in manually");
  });
});

describe("fillAllFrames", () => {
  it("aggregates mixed frame responses without NaN", async () => {
    const replies = {
      0: { ok: true, summary: { scanned: 10, filled: 6, skipped: 4, errors: ["a"] } },
      1: { scanned: 5, filled: 2, skipped: 3, errors: [] }
    };
    const total = await fillAllFrames({
      getAllFrames: async () => [{ frameId: 0 }, { frameId: 1 }, { frameId: 2 }],
      sendMessage: async (_t, _m, { frameId }) => { if (frameId === 2) throw new Error("no receiver"); return replies[frameId]; }
    }, 1, "genai");
    expect(total).toEqual({ scanned: 15, filled: 8, skipped: 7, errors: ["a"], responded: 2 });
  });

  it("reports zero responders when every frame rejects", async () => {
    const total = await fillAllFrames({
      getAllFrames: async () => [{ frameId: 0 }],
      sendMessage: async () => { throw new Error("x"); }
    }, 1, "genai");
    expect(total.responded).toBe(0);
  });
});
