// tests/fill.test.js
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { setNativeValue } from "../src/fill/native.js";
import { applyAnswer, matchOption } from "../src/fill/apply.js";
import { applyWidgetAnswer } from "../src/fill/widgets.js";
import { scanFields } from "../src/scan/fields.js";

function load(name) {
  const dom = new JSDOM(readFileSync(`tests/fixtures/${name}`, "utf8"),
    { url: "https://jobs.acme.com/apply/123" });
  return dom.window.document;
}

describe("setNativeValue", () => {
  it("sets the value and fires input and change", () => {
    const doc = load("plain.html");
    const el = doc.getElementById("email");
    const seen = [];
    el.addEventListener("input", () => seen.push("input"));
    el.addEventListener("change", () => seen.push("change"));
    setNativeValue(el, "naved@example.com");
    expect(el.value).toBe("naved@example.com");
    expect(seen).toEqual(["input", "change"]);
  });

  it("bubbles the events so delegated React handlers see them", () => {
    const doc = load("plain.html");
    const el = doc.getElementById("email");
    const onForm = vi.fn();
    el.closest("form").addEventListener("input", onForm);
    setNativeValue(el, "x@y.co");
    expect(onForm).toHaveBeenCalled();
  });
});

describe("matchOption", () => {
  const opts = ["India", "United States", "Germany"];
  it("prefers an exact case-insensitive match", () => {
    expect(matchOption(opts, "india")).toBe(0);
  });
  it("falls back to startsWith", () => {
    expect(matchOption(opts, "United")).toBe(1);
  });
  it("falls back to includes", () => {
    expect(matchOption(opts, "States")).toBe(1);
  });
  it("returns -1 when nothing matches", () => {
    expect(matchOption(opts, "Mars")).toBe(-1);
  });
});

describe("applyAnswer", () => {
  it("fills a text input", () => {
    const doc = load("plain.html");
    const { fields } = scanFields(doc);
    const f = fields.find((x) => x.label === "Email address");
    const el = doc.querySelector(`[data-jfa-id="${f.id}"]`);
    expect(applyAnswer(el, { value: "a@b.co" })).toBe(true);
    expect(el.value).toBe("a@b.co");
  });

  it("selects a select option by visible text", () => {
    const doc = load("plain.html");
    const el = doc.getElementById("country");
    applyAnswer(el, { value: "India" });
    expect(el.selectedOptions[0].text).toBe("India");
  });

  it("checks a checkbox for the string 'true'", () => {
    const doc = load("plain.html");
    const el = doc.querySelector('input[type="checkbox"]');
    applyAnswer(el, { value: "true" });
    expect(el.checked).toBe(true);
  });

  it("picks the matching radio in a group", () => {
    const doc = load("plain.html");
    const { fields, radioGroups } = scanFields(doc);
    const f = fields.find((x) => x.kind === "radio");
    applyAnswer(null, { value: "No" }, radioGroups.get(f.groupKey));
    expect(doc.querySelector('input[name="sponsorship"][value="no"]').checked).toBe(true);
  });

  it("does nothing for an empty value", () => {
    const doc = load("plain.html");
    const el = doc.getElementById("email");
    el.value = "keep";
    expect(applyAnswer(el, { value: "" })).toBe(false);
    expect(el.value).toBe("keep");
  });
});

describe("applyWidgetAnswer", () => {
  it("opens the listbox, matches an option and clicks it", async () => {
    const doc = load("workday.html");
    const btn = doc.querySelector('button[aria-haspopup="listbox"]');
    const list = doc.querySelector('ul[role="listbox"]');
    btn.addEventListener("click", () => { list.hidden = false; });

    const clicked = [];
    for (const li of list.querySelectorAll('[role="option"]')) {
      li.addEventListener("click", () => clicked.push(li.textContent.trim()));
    }

    const ok = await applyWidgetAnswer(btn, "India", { waitFor: async (fn) => fn() });
    expect(ok).toBe(true);
    expect(clicked).toEqual(["India"]);
  });

  it("returns false and leaves the widget closed when nothing matches", async () => {
    const doc = load("workday.html");
    const btn = doc.querySelector('button[aria-haspopup="listbox"]');
    const list = doc.querySelector('ul[role="listbox"]');
    btn.addEventListener("click", () => { list.hidden = false; });
    const escapes = [];
    doc.body.addEventListener("keydown", (e) => escapes.push(e.key));
    const clicked = [];
    for (const li of list.querySelectorAll('[role="option"]')) {
      li.addEventListener("click", () => clicked.push(li.textContent.trim()));
    }
    const ok = await applyWidgetAnswer(btn, "Atlantis", { waitFor: async (fn) => fn() });
    expect(ok).toBe(false);
    expect(clicked).toEqual([]);
    expect(escapes).toContain("Escape");
  });
});

describe("submit protection and verification", () => {
  function page(html) {
    const dom = new JSDOM(`<body><form id="f">${html}</form></body>`, { url: "https://jobs.acme.com/" });
    const doc = dom.window.document;
    const form = doc.getElementById("f");
    const submits = [];
    form.addEventListener("submit", (e) => { e.preventDefault(); submits.push(1); });
    return { doc, form, submits };
  }
  const now = async (fn) => fn();
  const noSleep = async () => {};

  it("never clicks a submit-button trigger", async () => {
    const { doc, submits } = page(`<button type="submit" id="t">Go</button>
      <ul role="listbox"><li role="option">India</li></ul>`);
    const btn = doc.getElementById("t");
    const clicks = vi.fn();
    btn.addEventListener("click", clicks);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await applyWidgetAnswer(btn, "India", { waitFor: now, sleep: noSleep })).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(submits).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never clicks a submit button posing as an option", async () => {
    const { doc, submits } = page(`<button type="button" aria-haspopup="listbox" id="t">Pick</button>
      <ul role="listbox"><button type="submit" role="option" id="bad">India</button></ul>`);
    const bad = doc.getElementById("bad");
    const clicks = vi.fn();
    bad.addEventListener("click", clicks);
    const ok = await applyWidgetAnswer(doc.getElementById("t"), "India", { waitFor: now, sleep: noSleep });
    expect(ok).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(submits).toEqual([]);
  });

  it("treats an untyped aria-haspopup button in a form as a dropdown", async () => {
    const { doc, submits } = page(`<button aria-haspopup="listbox" id="t">Pick</button>
      <ul role="listbox"><li role="option">India</li></ul>`);
    const btn = doc.getElementById("t");
    const picked = [];
    doc.querySelector("li").addEventListener("click", () => picked.push("India"));
    expect(await applyWidgetAnswer(btn, "India", { waitFor: now, sleep: noSleep })).toBe(true);
    expect(picked).toEqual(["India"]);
    expect(submits).toEqual([]);
  });

  it("matchOption ignores empty / 1-char option texts for reverse includes", () => {
    expect(matchOption(["", "A"], "anything")).toBe(-1);
  });

  it("default waitFor returns false when the listbox never appears", async () => {
    const { doc } = page(`<button type="button" aria-haspopup="listbox" id="t">Pick</button>`);
    const ok = await applyWidgetAnswer(doc.getElementById("t"), "India",
      { sleep: noSleep, timeout: 30, interval: 5 });
    expect(ok).toBe(false);
  });

  it("reports false when a radio click is cancelled", () => {
    const { doc } = page(`<input type="radio" name="r" value="yes" id="a">`);
    const r = doc.getElementById("a");
    r.addEventListener("click", (e) => e.preventDefault());
    expect(applyAnswer(null, { value: "yes" }, [r])).toBe(false);
  });

  it("reports false when a checkbox click is cancelled, true when already set", () => {
    const { doc } = page(`<input type="checkbox" id="c"><input type="checkbox" id="d" checked>`);
    const c = doc.getElementById("c");
    c.addEventListener("click", (e) => e.preventDefault());
    expect(applyAnswer(c, { value: "true" })).toBe(false);
    expect(applyAnswer(doc.getElementById("d"), { value: "true" })).toBe(true);
  });

  it("submit-typed trigger that also has aria-haspopup is refused, never clicked", async () => {
    const { doc, submits } = page(`<button type="submit" aria-haspopup="listbox" id="t">Pick</button>
      <ul role="listbox"><li role="option">India</li></ul>`);
    const btn = doc.getElementById("t");
    const clicks = vi.fn();
    btn.addEventListener("click", clicks);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await applyWidgetAnswer(btn, "India", { waitFor: now, sleep: noSleep })).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(submits).toEqual([]);
    warn.mockRestore();
  });

  it("restores submit behaviour after a successful fill", async () => {
    const { doc, form, submits } = page(`<button aria-haspopup="listbox" id="t">Pick</button>
      <ul role="listbox"><li role="option">India</li></ul>`);
    expect(await applyWidgetAnswer(doc.getElementById("t"), "India", { waitFor: now, sleep: noSleep })).toBe(true);
    expect(submits).toEqual([]);
    form.dispatchEvent(new doc.defaultView.Event("submit", { bubbles: true, cancelable: true }));
    expect(submits).toEqual([1]);
  });

  it("removes the guard even when the option click throws", async () => {
    const { doc, form, submits } = page(`<button aria-haspopup="listbox" id="t">Pick</button>
      <ul role="listbox"><li role="option">India</li></ul>`);
    doc.querySelector("li").click = () => { throw new Error("boom"); };
    await expect(applyWidgetAnswer(doc.getElementById("t"), "India", { waitFor: now, sleep: noSleep }))
      .rejects.toThrow("boom");
    form.dispatchEvent(new doc.defaultView.Event("submit", { bubbles: true, cancelable: true }));
    expect(submits).toEqual([1]);
  });

  it("verifies the select branch", () => {
    const { doc } = page(`<select id="s"><option>A</option><option>India</option></select>`);
    const s = doc.getElementById("s");
    expect(applyAnswer(s, { value: "India" })).toBe(true);
    expect(s.selectedIndex).toBe(1);
  });

  it("radio and checkbox clicks cannot submit the form", () => {
    const { doc, form, submits } = page(`<input type="radio" name="r" value="yes" id="a">
      <input type="checkbox" id="c">`);
    // a hostile click handler that tries to submit the form (jsdom's form.submit() is
    // unimplemented and fires no event, so dispatch the submit event it would cause)
    const trySubmit = () => form.dispatchEvent(
      new doc.defaultView.Event("submit", { bubbles: true, cancelable: true }));
    const r = doc.getElementById("a"), c = doc.getElementById("c");
    r.addEventListener("click", trySubmit);
    c.addEventListener("click", trySubmit);
    expect(applyAnswer(null, { value: "yes" }, [r])).toBe(true);
    expect(applyAnswer(c, { value: "true" })).toBe(true);
    expect(submits).toEqual([]);
  });

  it("select: changes on a match, untouched on no match", () => {
    const { doc } = page(`<select id="s"><option>India</option><option>Germany</option></select>`);
    const sel = doc.getElementById("s");
    expect(applyAnswer(sel, { value: "Germany" })).toBe(true);
    expect(sel.selectedOptions[0].text).toBe("Germany");
    expect(applyAnswer(sel, { value: "Atlantis" })).toBe(false);
    expect(sel.selectedOptions[0].text).toBe("Germany");
  });

  describe("programmatic form.submit()", () => {
    const own = (f) => Object.prototype.hasOwnProperty.call(f, "submit");

    it("is neutralised during the click and restored without leaving an own property", async () => {
      const { doc, form } = page(`<button aria-haspopup="listbox" id="t">Pick</button>
        <ul role="listbox"><li role="option">India</li></ul>`);
      const proto = doc.defaultView.HTMLFormElement.prototype;
      const realSubmit = proto.submit;
      const protoSpy = vi.fn();
      proto.submit = protoSpy; // replaces jsdom's unimplemented method; restored below
      try {
        doc.getElementById("t").addEventListener("click", () => form.submit());
        const picked = [];
        doc.querySelector("li").addEventListener("click", () => picked.push("India"));
        expect(await applyWidgetAnswer(doc.getElementById("t"), "India", { waitFor: now, sleep: noSleep })).toBe(true);
        expect(picked).toEqual(["India"]);
        expect(protoSpy).not.toHaveBeenCalled();
        expect(own(form)).toBe(false);
        form.submit(); // reaches the real (prototype) method again
        expect(protoSpy).toHaveBeenCalledTimes(1);
      } finally {
        proto.submit = realSubmit;
      }
    });

    it("an existing own submit (spy) is called zero times and then restored", async () => {
      const { doc, form } = page(`<button aria-haspopup="listbox" id="t">Pick</button>
        <ul role="listbox"><li role="option">India</li></ul>`);
      const spy = vi.fn();
      form.submit = spy;
      doc.getElementById("t").addEventListener("click", () => form.submit());
      expect(await applyWidgetAnswer(doc.getElementById("t"), "India", { waitFor: now, sleep: noSleep })).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(form.submit).toBe(spy);
    });

    it("is restored when the click throws", async () => {
      const { doc, form } = page(`<button aria-haspopup="listbox" id="t">Pick</button>
        <ul role="listbox"><li role="option">India</li></ul>`);
      doc.querySelector("li").click = () => { throw new Error("boom"); };
      await expect(applyWidgetAnswer(doc.getElementById("t"), "India", { waitFor: now, sleep: noSleep }))
        .rejects.toThrow("boom");
      expect(own(form)).toBe(false);
    });
  });

  describe("all forms are guarded", () => {
    it("a handler submitting a DIFFERENT form is neutralised and restored", async () => {
      const { doc, form } = page(`<button aria-haspopup="listbox" id="t">Pick</button>
        <ul role="listbox"><li role="option">India</li></ul>`);
      const other = doc.createElement("form");
      doc.body.appendChild(other);
      const otherSubmits = [];
      other.addEventListener("submit", () => otherSubmits.push(1));
      const proto = doc.defaultView.HTMLFormElement.prototype;
      const realSubmit = proto.submit;
      const protoSpy = vi.fn();
      proto.submit = protoSpy;
      try {
        doc.getElementById("t").addEventListener("click", () => {
          other.submit();
          other.dispatchEvent(new doc.defaultView.Event("submit", { bubbles: true, cancelable: true }));
        });
        expect(await applyWidgetAnswer(doc.getElementById("t"), "India", { waitFor: now, sleep: noSleep })).toBe(true);
        expect(protoSpy).not.toHaveBeenCalled();
        expect(otherSubmits).toEqual([]);
        for (const f of [form, other]) expect(Object.prototype.hasOwnProperty.call(f, "submit")).toBe(false);
        other.submit();
        expect(protoSpy).toHaveBeenCalledTimes(1);
      } finally {
        proto.submit = realSubmit;
      }
    });

    it("a form with <input name=submit> is left intact", async () => {
      const { doc, form, submits } = page(`<input name="submit" id="named">
        <button aria-haspopup="listbox" id="t">Pick</button>
        <ul role="listbox"><li role="option">India</li></ul>
        <input id="txt" type="text">`);
      const named = doc.getElementById("named");
      // jsdom does not implement named-property shadowing, so emulate what browsers do:
      // form.submit resolves to the element, not the method.
      Object.defineProperty(form, "submit", { value: named, configurable: true, writable: true });
      doc.getElementById("t").addEventListener("click", () =>
        form.dispatchEvent(new doc.defaultView.Event("submit", { bubbles: true, cancelable: true })));
      expect(await applyWidgetAnswer(doc.getElementById("t"), "India", { waitFor: now, sleep: noSleep })).toBe(true);
      expect(applyAnswer(doc.getElementById("txt"), { value: "x" })).toBe(true);
      expect(submits).toEqual([]);
      expect(form.submit).toBe(named);
    });
  });
});
