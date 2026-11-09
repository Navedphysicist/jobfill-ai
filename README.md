# JobFill AI

A Chrome (Manifest V3) extension that autofills job application forms from your profile. Known data (name, email, links, work history) fills directly; essay and open-ended questions get AI-generated answers grounded in your profile.

**The extension never submits a form. You always review before submitting.**

**`truthRules` in `profile.json` constrain what the model may claim on your behalf** (work permits, tools you have not used, and so on). Keep them accurate.

## Install

```
npm install
npm run build
```

```
cp profile.example.json profile.json   # then fill in your own details
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `dist/`. Open **Settings** and paste your OpenAI API key.

`profile.json` and `dist/` are gitignored — your real details and your key never leave your machine.

See `MANUAL-CHECKLIST.md` for a first-run walkthrough with a real key and posting.

## Your profile

`profile.json` is the single source of truth — start from `profile.example.json`. Edit it directly (then rebuild), or edit it through the Settings page, which has a form view, a raw JSON view, and a **Preview** tab showing exactly what is sent to the model for the selected role.

## Role angles

The profile defines three role angles: **GenAI Engineer** (`genai`), **Software Engineer** (`swe`), and **Trainer / L&D** (`trainer`). The popup's "Fill as" switch picks one, and only that role's framing is used for the fill and for AI answers.

## Using it

1. On an application page, open the popup, pick a role, press **Fill this form**. It reports "Scanned N · filled M · skipped K".
2. For essay questions, click into the field and use the ✨ tooltip. You can **Regenerate**, make it **Shorter**, or add an extra instruction. Nothing is written to the page until you press **Insert**.
3. Fields it cannot handle (file uploads, CAPTCHAs, exotic widgets) are left for you.

## Application tracker and dashboard

**Log this application** in the popup records the job (company, role, URL, and the answers you gave). The **Dashboard** lists logged applications, supports export, and shows AI spend based on per-model rates. It flags calls made with models that have no configured price ("unpriced").

## Tests

```
npm test        # vitest unit tests
npm run e2e     # builds, then runs Playwright against the real extension in Chrome
```

## Engineering notes

**Reasoning-token budgeting.** Forms were reporting "Scanned 9 · filled 0" with no error. The model was returning empty content with `finish_reason: "length"`. The cause: on reasoning models `max_completion_tokens` budgets the *invisible* reasoning tokens too, and a flat 1,500-token cap with no `reasoning_effort` set meant medium-effort reasoning consumed the entire budget before a single visible token was emitted. `completion_tokens_details.reasoning_tokens` confirmed it.

The fix is in [`src/ai/router.js`](src/ai/router.js): the token budget is computed from each batch's actual field composition (a textarea costs ~700 tokens, a checkbox ~25) rather than a constant, with explicit reasoning headroom and `reasoning_effort: "low"`. [`src/ai/client.js`](src/ai/client.js) gates that parameter behind a model-family check, since non-reasoning models return 400 on it. Truncation is also no longer terminal — [`src/content.js`](src/content.js) halves a failed batch and retries rather than dropping it. Covered by `tests/reasoning-budget.test.js`.

**Cost control.** Static-first prompt construction, a result cache, in-flight request dedupe, per-task model routing, sized output caps, and per-model usage accounting surfaced in the dashboard.

**Safety.** The extension never submits a form — every `.click()` routes through [`src/fill/click.js`](src/fill/click.js), which refuses submit-like controls. `truthRules` in the profile constrain what the model may claim on your behalf.

## Architecture

Plain JavaScript, no runtime dependencies; esbuild bundles `src/` into `dist/` (`build.mjs`).

- `src/profile`: load, migrate, validate, and resolve the profile for a role
- `src/scan`: find form fields, labels, surrounding context, and custom widgets
- `src/fill`: write values into fields (native inputs, widgets, clicks)
- `src/ai`: prompts, model router, OpenAI client, answer cache, in-flight dedupe, usage and cost
- `src/track`: application capture, storage, export
- `src/ui`: popup, options (Settings), dashboard, and the in-page tooltip

Profile and API key live in Chrome local storage on your machine; the only network calls go to the API base URL you configure.
