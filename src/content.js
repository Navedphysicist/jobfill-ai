// Content script: joins the scanner, the fill engine and the tooltip.
import { scanFields } from "./scan/fields.js";
import { labelFor } from "./scan/labels.js";
import { pageContext } from "./scan/context.js";
import { applyAnswer } from "./fill/apply.js";
import { applyWidgetAnswer } from "./fill/widgets.js";
import { captureApplication } from "./track/capture.js";
import { createTooltip } from "./ui/tooltip/tooltip.js";

// Worker output is capped, so long forms are sent in chunks. Kept small because a
// reasoning model spends much of its budget before the first visible token; a batch
// that still truncates is halved and retried rather than lost (see runBatch).
const BATCH_SIZE = 12;

// Never throws. Re-scans on every call: data-jfa-id markers are only valid for the latest scan.
const DEFAULT_ROLE = "genai";

// The popup's saved role is the tooltip's default (spec 6.1); an unknown or
// missing value falls back to genai, then to the first known role.
export function pickRoleKey(selected, roleLabels) {
  if (selected && roleLabels[selected]) return selected;
  if (roleLabels[DEFAULT_ROLE]) return DEFAULT_ROLE;
  return Object.keys(roleLabels)[0] || DEFAULT_ROLE;
}

export async function fillPage({ sendMessage, doc, roleKey }) {
  const errors = [];
  let scanned = 0;
  let filled = 0;
  let skipped = 0;
  try {
    const { fields, radioGroups } = scanFields(doc);
    scanned = fields.length;
    if (!scanned) return { scanned, filled, skipped, errors };

    const ctx = pageContext(doc, doc.defaultView?.location?.href || "");
    const applied = new Set();

    async function applyOne(answer) {
      const field = fields.find((f) => f.id === answer.id);
      if (!field || applied.has(answer.id)) return;
      applied.add(answer.id);
      // Deliberate skips and empty values are not failures.
      if (answer.source === "skipped" || answer.value === "" || answer.value == null) return;
      try {
        let ok;
        if (field.kind === "radio") {
          // Radios carry no data-jfa-id: resolve through the group map, element is null.
          ok = applyAnswer(null, answer, radioGroups.get(field.groupKey));
        } else {
          const el = doc.querySelector(`[data-jfa-id="${answer.id}"]`);
          if (!el) return;
          ok = field.kind === "widget"
            ? await applyWidgetAnswer(el, answer.value)
            : applyAnswer(el, answer);
        }
        if (ok) filled++;
        else skipped++;
      } catch (e) {
        errors.push(`${field.label}: ${e.message}`);
      }
    }

    // A truncated reply means this batch could not fit in one response. Halving it
    // and retrying recovers the fields; failing the batch loses every one of them.
    async function runBatch(chunk, start) {
      const range = `fields ${start + 1}-${start + chunk.length}`;
      let res;
      try {
        res = await sendMessage({
          action: "mapFields",
          fields: chunk,
          pageContext: `${ctx.company} — ${ctx.jobTitle}`,
          role: roleKey
        });
      } catch (e) {
        errors.push(`${range}: ${String(e?.message || e)}`);
        return;
      }
      if (res?.ok) {
        for (const answer of res.answers || []) await applyOne(answer);
        return;
      }
      if (res?.truncated && chunk.length > 1) {
        const mid = Math.ceil(chunk.length / 2);
        await runBatch(chunk.slice(0, mid), start);
        await runBatch(chunk.slice(mid), start + mid);
        return;
      }
      errors.push(res?.error && fields.length <= BATCH_SIZE
        ? res.error
        : `${range}: ${res?.error || "unknown error"}`);
    }

    for (let start = 0; start < fields.length; start += BATCH_SIZE) {
      await runBatch(fields.slice(start, start + BATCH_SIZE), start);
    }
    return { scanned, filled, skipped, errors };
  } catch (e) {
    errors.push(String(e?.message || e));
    return { scanned, filled, skipped, errors };
  }
}

// ---------- in-page UI (skipped when imported in tests) ----------
(function mount() {
  if (typeof window === "undefined" || !window.chrome?.runtime?.id) return;
  if (window.__jobfillLoaded) return;
  window.__jobfillLoaded = true;

  const send = (m) => chrome.runtime.sendMessage(m);

  const icon = document.createElement("button");
  icon.textContent = "✨";
  icon.className = "jfa-icon";
  icon.type = "button";
  icon.title = "Generate answer with AI (JobFill)";
  icon.setAttribute("data-jobfill-ui", "1");
  document.documentElement.appendChild(icon);
  let iconTarget = null;
  let activeTarget = null;

  function resetIcon() {
    icon.textContent = "✨";
    icon.disabled = false;
    icon.style.display = "none";
  }

  function positionIcon(el) {
    const r = el.getBoundingClientRect();
    icon.style.top = `${window.scrollY + r.top + 4}px`;
    icon.style.left = `${window.scrollX + r.right - 30}px`;
    icon.style.display = "block";
  }

  const tooltip = createTooltip({
    async onGenerate({ length, instruction, bypassCache, roleKey }) {
      const target = activeTarget;
      if (!target) return;
      tooltip.setLoading(true);
      try {
        const res = await send({
          action: "generateAnswer",
          question: labelFor(target),
          pageContext: `${document.title} — ${location.hostname}`,
          currentValue: (target.value || "").slice(0, 500),
          role: roleKey, // tooltip says roleKey, worker reads role
          instruction,
          length,
          bypassCache
        });
        if (!res?.ok) throw new Error(res?.error || "no response from background");
        tooltip.setText(res.value, { cached: !!res.cached });
      } catch (err) {
        tooltip.setError(
          String(err.message).includes("NO_KEY")
            ? "Add your OpenAI API key in the extension options first."
            : String(err.message || err)
        );
      } finally {
        tooltip.setLoading(false);
      }
    },
    onInsert(text) {
      if (activeTarget && !applyAnswer(activeTarget, { value: text })) {
        console.warn("[JobFill] insert did not land", activeTarget);
      }
      resetIcon();
    },
    onCancel() {
      resetIcon();
    }
  });

  document.addEventListener("focusin", (e) => {
    const el = e.target;
    if (
      el.matches?.("textarea, input[type='text'], input[type='email'], input[type='url'], input:not([type])") &&
      !el.closest("[data-jobfill-ui]")
    ) {
      iconTarget = el;
      positionIcon(el);
    }
  });

  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (document.activeElement !== icon && !tooltip.isOpen()) icon.style.display = "none";
    }, 300);
  });

  icon.addEventListener("mousedown", (e) => e.preventDefault());
  icon.addEventListener("click", async () => {
    if (!iconTarget) return;
    activeTarget = iconTarget;
    icon.textContent = "…";
    icon.disabled = true;
    let roleKey = DEFAULT_ROLE;
    let selected;
    try {
      selected = (await chrome.storage.local.get("selectedRole")).selectedRole;
    } catch { /* default */ }
    let roleLabels = { genai: "GenAI", swe: "Software Engineer", trainer: "Trainer" };
    try {
      const res = await send({ action: "getProfile" });
      if (res?.ok && res.profile?.roles) {
        roleLabels = Object.fromEntries(
          Object.entries(res.profile.roles).map(([k, r]) => [k, r.label || k])
        );
      }
    } catch { /* fall back to defaults */ }
    roleKey = pickRoleKey(selected, roleLabels);
    tooltip.open(activeTarget, { roleKey, roleLabels });
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "fill") {
      fillPage({ sendMessage: send, doc: document, roleKey: msg.roleKey })
        .then((summary) => sendResponse({ ok: true, summary }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    // Read-only: the popup (an extension page) performs the store write.
    if (msg.action === "capture") {
      sendResponse(captureApplication(document, location.href, msg.roleKey));
      return;
    }
    if (msg.action === "ping") sendResponse({ ok: true });
  });
})();
