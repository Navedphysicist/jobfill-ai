// tests/tooltip.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTooltip, position } from "../src/ui/tooltip/tooltip.js";

beforeEach(() => { document.body.innerHTML = ""; });

function anchor() {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  ta.getBoundingClientRect = () => ({ top: 100, bottom: 140, left: 50, right: 450, width: 400, height: 40 });
  return ta;
}

const ROLE_LABELS = { genai: "GenAI Engineer", swe: "Software Engineer", trainer: "Trainer / L&D" };

describe("position", () => {
  const vp = { width: 1200, height: 800, scrollX: 0, scrollY: 0 };
  it("places the popover below the anchor when there is room", () => {
    const p = position({ top: 100, bottom: 140, left: 50, right: 450 }, vp, 320);
    expect(p.flipped).toBe(false);
    expect(p.top).toBeGreaterThan(140);
  });
  it("flips above the anchor when there is not", () => {
    const p = position({ top: 600, bottom: 700, left: 50, right: 450 }, vp, 320);
    expect(p.flipped).toBe(true);
    expect(p.top).toBeLessThan(600);
  });
  it("keeps the popover inside the left edge", () => {
    const p = position({ top: 100, bottom: 140, left: -200, right: 100 }, vp, 320);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });
  it("keeps the popover inside the right edge", () => {
    const p = position({ top: 100, bottom: 140, left: 1150, right: 1190 }, vp, 320);
    expect(p.left + 360).toBeLessThanOrEqual(vp.width);
  });
});

describe("position clamping", () => {
  const vp = { width: 1200, height: 800, scrollX: 0, scrollY: 0 };
  it("clamps top into the viewport when the anchor is scrolled above it", () => {
    const p = position({ top: -100, bottom: -50, left: 50, right: 450 }, vp, 320);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
  it("keeps a tall box inside the bottom edge", () => {
    const p = position({ top: 300, bottom: 340, left: 50, right: 450 }, vp, 700);
    expect(p.top + 700 <= vp.height || p.top === 8).toBe(true);
  });
});

describe("createTooltip lifecycle", () => {
  const mk = (o = {}) => {
    const cb = { onGenerate: vi.fn(), onInsert: vi.fn(), onCancel: vi.fn(), ...o };
    return { cb, t: createTooltip(cb) };
  };
  const sr = (t) => t.host.shadowRoot;
  const part = (t, n) => sr(t).querySelector(`[data-part=${n}]`);

  it("re-opening cancels the previous session and targets the new anchor", () => {
    const { cb, t } = mk();
    const a = anchor(), b = anchor();
    t.open(a, { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.open(b, { roleKey: "genai", roleLabels: ROLE_LABELS });
    expect(cb.onCancel).toHaveBeenCalledTimes(1);
    expect(t.isOpen()).toBe(true);
    t.setText("For B.", { cached: false });
    expect(part(t, "text").value).toBe("For B.");
    expect(a.value).toBe("");
    expect(b.value).toBe("");
  });

  it("Cancel leaves the field untouched and closes", () => {
    const { cb, t } = mk();
    const el = anchor();
    t.open(el, { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.setText("x", { cached: false });
    part(t, "cancel").click();
    expect(el.value).toBe("");
    expect(cb.onInsert).not.toHaveBeenCalled();
    expect(t.isOpen()).toBe(false);
  });

  it("click outside leaves the field untouched and closes", () => {
    const { cb, t } = mk();
    const el = anchor();
    t.open(el, { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.setText("x", { cached: false });
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(el.value).toBe("");
    expect(cb.onInsert).not.toHaveBeenCalled();
    expect(t.isOpen()).toBe(false);
  });

  it("Insert closes the popover and removes the host", () => {
    const { cb, t } = mk();
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.setText("Hi.", { cached: false });
    part(t, "insert").click();
    expect(cb.onInsert).toHaveBeenCalledWith("Hi.");
    expect(t.isOpen()).toBe(false);
    expect(document.documentElement.contains(t.host)).toBe(false);
  });

  it("listeners are gone after close", () => {
    const { cb, t } = mk();
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.close();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(cb.onCancel).toHaveBeenCalledTimes(1);
  });

  it("role change regenerates with the new role and bypassCache", () => {
    const { cb, t } = mk();
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    const sel = part(t, "role");
    sel.value = "trainer";
    sel.dispatchEvent(new Event("change"));
    expect(cb.onGenerate.mock.calls[1][0]).toMatchObject({ roleKey: "trainer", bypassCache: true });
  });

  it("setLoading toggles the action buttons", () => {
    const { t } = mk();
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.setText("ok", { cached: false });
    const names = ["regenerate", "shorter", "longer", "insert"];
    t.setLoading(true);
    for (const n of names) expect(part(t, n).disabled).toBe(true);
    t.setLoading(false);
    for (const n of names) expect(part(t, n).disabled).toBe(false);
  });

  it("Insert is disabled without text and enabled once text arrives", () => {
    const { t } = mk();
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.setError("API 401");
    expect(part(t, "insert").disabled).toBe(true);
    t.setText("hello", { cached: false });
    expect(part(t, "insert").disabled).toBe(false);
  });
});

describe("createTooltip", () => {
  it("calls onGenerate once when opened", () => {
    const onGenerate = vi.fn();
    const t = createTooltip({ onGenerate, onInsert: vi.fn(), onCancel: vi.fn() });
    t.open(anchor(), { roleKey: "swe", roleLabels: ROLE_LABELS });
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0][0]).toMatchObject({
      length: "normal", instruction: "", bypassCache: false, roleKey: "swe"
    });
    expect(t.host.shadowRoot.querySelector("[data-part=role]").value).toBe("swe");
  });

  it("marks its host as extension UI", () => {
    const t = createTooltip({ onGenerate: vi.fn(), onInsert: vi.fn(), onCancel: vi.fn() });
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    expect(t.host.getAttribute("data-jobfill-ui")).toBe("1");
  });

  it("shows generated text and the cached badge", () => {
    const t = createTooltip({ onGenerate: vi.fn(), onInsert: vi.fn(), onCancel: vi.fn() });
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.setText("Generated answer.", { cached: true });
    const root = t.host.shadowRoot;
    expect(root.querySelector("[data-part=text]").value).toBe("Generated answer.");
    expect(root.querySelector("[data-part=cached]").hidden).toBe(false);
  });

  it("does NOT write to the field until Insert is pressed", () => {
    const onInsert = vi.fn();
    const el = anchor();
    const t = createTooltip({ onGenerate: vi.fn(), onInsert, onCancel: vi.fn() });
    t.open(el, { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.setText("Hello.", { cached: false });
    expect(el.value).toBe("");
    t.host.shadowRoot.querySelector("[data-part=insert]").click();
    expect(onInsert).toHaveBeenCalledWith("Hello.");
  });

  it("regenerates with bypassCache set", () => {
    const onGenerate = vi.fn();
    const t = createTooltip({ onGenerate, onInsert: vi.fn(), onCancel: vi.fn() });
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.host.shadowRoot.querySelector("[data-part=regenerate]").click();
    expect(onGenerate.mock.calls[1][0]).toMatchObject({ bypassCache: true });
  });

  it("requests a shorter and a longer answer", () => {
    const onGenerate = vi.fn();
    const t = createTooltip({ onGenerate, onInsert: vi.fn(), onCancel: vi.fn() });
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.host.shadowRoot.querySelector("[data-part=shorter]").click();
    t.host.shadowRoot.querySelector("[data-part=longer]").click();
    expect(onGenerate.mock.calls[1][0].length).toBe("shorter");
    expect(onGenerate.mock.calls[2][0].length).toBe("longer");
  });

  it("passes the extra instruction through", () => {
    const onGenerate = vi.fn();
    const t = createTooltip({ onGenerate, onInsert: vi.fn(), onCancel: vi.fn() });
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.host.shadowRoot.querySelector("[data-part=instruction]").value = "mention LangGraph";
    t.host.shadowRoot.querySelector("[data-part=regenerate]").click();
    expect(onGenerate.mock.calls[1][0].instruction).toBe("mention LangGraph");
  });

  it("closes on Escape without inserting", () => {
    const onInsert = vi.fn();
    const onCancel = vi.fn();
    const t = createTooltip({ onGenerate: vi.fn(), onInsert, onCancel });
    const el = anchor();
    t.open(el, { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.setText("Draft.", { cached: false });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(t.isOpen()).toBe(false);
    expect(el.value).toBe("");
    expect(onInsert).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows an error without destroying the popover", () => {
    const t = createTooltip({ onGenerate: vi.fn(), onInsert: vi.fn(), onCancel: vi.fn() });
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    t.setError("API 401: bad key");
    expect(t.host.shadowRoot.querySelector("[data-part=error]").textContent)
      .toContain("API 401");
    expect(t.isOpen()).toBe(true);
  });
});
