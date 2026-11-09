// src/ui/tooltip/tooltip.js
import { TOOLTIP_CSS } from "./tooltip.css.js";

const WIDTH = 360;
const GAP = 6;
const MARGIN = 8;

export function position(rect, viewport, boxHeight) {
  const below = viewport.height - rect.bottom;
  const flipped = below < boxHeight + GAP && rect.top > below;
  const raw = flipped ? rect.top - boxHeight - GAP : rect.bottom + GAP;
  const top = Math.min(
    Math.max(MARGIN, raw),
    Math.max(MARGIN, viewport.height - boxHeight - MARGIN)
  );
  const left = Math.min(
    Math.max(MARGIN, rect.left),
    Math.max(MARGIN, viewport.width - WIDTH - MARGIN)
  );
  return { top, left, flipped };
}

export function createTooltip({ onGenerate, onInsert, onCancel }) {
  const host = document.createElement("div");
  host.setAttribute("data-jobfill-ui", "1");
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = TOOLTIP_CSS;

  const box = document.createElement("div");
  box.className = "box";
  box.innerHTML = `
    <div class="row head">
      <select data-part="role"></select>
      <span class="badge" data-part="cached" hidden>cached ⚡</span>
    </div>
    <textarea data-part="text" spellcheck="false"></textarea>
    <div class="error" data-part="error"></div>
    <div class="row">
      <button class="ghost" data-part="regenerate">↻ Regenerate</button>
      <button class="ghost" data-part="shorter">⤓ Shorter</button>
      <button class="ghost" data-part="longer">⤒ Longer</button>
    </div>
    <div class="row">
      <input data-part="instruction" placeholder="extra instruction…" />
    </div>
    <div class="row foot">
      <button class="ghost" data-part="cancel">Cancel</button>
      <button class="primary" data-part="insert">Insert</button>
    </div>`;

  shadow.append(style, box);
  const q = (part) => shadow.querySelector(`[data-part="${part}"]`);

  let open = false;
  let anchorEl = null;
  let loading = false;

  function setLoadingState(on) {
    loading = !!on;
    box.classList.toggle("loading", loading);
    for (const p of ["regenerate", "shorter", "longer"]) q(p).disabled = loading;
    syncInsert();
  }

  function syncInsert() {
    q("insert").disabled = loading || q("text").value.trim() === "";
  }

  function place() {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const vp = { width: window.innerWidth || 1200, height: window.innerHeight || 800 };
    const h = box.offsetHeight || 320;
    const p = position(r, vp, h);
    box.style.top = `${p.top}px`;
    box.style.left = `${p.left}px`;
  }

  function generate(extra) {
    onGenerate({
      length: "normal",
      instruction: q("instruction").value.trim(),
      bypassCache: false,
      roleKey: q("role").value,
      ...extra
    });
  }

  function teardown() {
    open = false;
    host.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("scroll", place, true);
    window.removeEventListener("resize", place);
    anchorEl = null;
  }

  function close() {
    if (!open) return;
    teardown();
    onCancel?.();
  }

  function onKey(e) { if (e.key === "Escape") close(); }
  function onOutside(e) { if (open && !host.contains(e.target) && e.target !== anchorEl) close(); }

  q("regenerate").addEventListener("click", () => generate({ bypassCache: true }));
  q("shorter").addEventListener("click", () => generate({ length: "shorter", bypassCache: true }));
  q("longer").addEventListener("click", () => generate({ length: "longer", bypassCache: true }));
  q("role").addEventListener("change", () => generate({ bypassCache: true }));
  q("text").addEventListener("input", syncInsert);
  q("cancel").addEventListener("click", close);
  q("insert").addEventListener("click", () => {
    const text = q("text").value;
    teardown();
    onInsert(text);
  });

  return {
    host,
    isOpen: () => open,
    close,
    open(el, { roleKey, roleLabels }) {
      if (open) close();
      anchorEl = el;
      const sel = q("role");
      sel.textContent = "";
      for (const [key, label] of Object.entries(roleLabels)) {
        const o = document.createElement("option");
        o.value = key;
        o.textContent = label;
        sel.appendChild(o);
      }
      sel.value = roleKey;
      q("text").value = "";
      q("error").textContent = "";
      q("cached").hidden = true;
      q("instruction").value = "";
      setLoadingState(false);
      document.documentElement.appendChild(host);
      open = true;
      place();
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("mousedown", onOutside, true);
      window.addEventListener("scroll", place, true);
      window.addEventListener("resize", place);
      generate({});
    },
    setLoading: setLoadingState,
    setText(text, { cached } = {}) {
      q("text").value = text;
      q("error").textContent = "";
      q("cached").hidden = !cached;
      syncInsert();
      place();
    },
    setError(message) {
      q("error").textContent = message;
      place();
    }
  };
}
