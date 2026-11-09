# JobFill AI — Design Spec (2026-08-19)

Chrome MV3 extension that autofills job application forms from Naved's canonical profile, using the OpenAI API for field mapping and answer generation.

## Approved scope (v1)

- Popup "Fill this form" button: content script scans visible form fields (inputs, textareas, selects, radios, checkboxes), sends field descriptors + profile to OpenAI, fills the returned mapping.
- ✨ generate icon appears on focused text inputs/textareas: generates an answer to that specific question grounded in the profile.
- Options page: OpenAI API key, model (default `gpt-5-mini`), base URL (OpenAI-compatible), editable profile JSON.
- Out of scope (user handles manually): file uploads, CAPTCHAs, exotic custom widgets. Unfillable fields are listed in the popup result.

## Safety rails

- Never clicks Submit.
- Filled-from-profile fields outlined yellow; AI-generated answers outlined orange (review before submitting).
- Truth rules hard-coded in prompt + profile: India-only work authorization, sponsorship required abroad, no Azure, no fine-tuning claims, no invoice-parser project, CGPA 8.6, 4 years experience.

## Architecture

| File | Responsibility |
|---|---|
| `manifest.json` | MV3, content script on `<all_urls>`, service worker, options + popup |
| `profile-data.js` | `DEFAULT_PROFILE` seed (canonical data as of Aug 19 2026) |
| `background.js` | Seeds storage on install; proxies OpenAI calls (fill-mapping + single-field generation) |
| `content.js` | Field scanning (label resolution, radio grouping, select options), React-safe filling, outline classes, ✨ icon lifecycle |
| `content.css` | Outlines + icon styles |
| `popup.html/js/css` | Fill button, progress, result summary |
| `options.html/js/css` | Settings + profile editor (JSON textarea, validate, reset-to-default) |

## Data flow

popup → content `{action: "fill"}` → content scans fields → background `{action: "mapFields", fields}` → OpenAI chat completions (JSON response) → `{answers: [{id, value, source, skipped}]}` → content fills + outlines → popup summary.

✨ icon → content captures field label + page context → background `{action: "generateAnswer"}` → OpenAI → insert with orange outline.

## Decisions

- API key stored in `chrome.storage.local`; requests go only to the configured base URL.
- Fields chunked (35/request) sequentially.
- React compatibility: native value setter + `input`/`change` events.
- Date inputs answered as YYYY-MM-DD; selects matched by option text (exact, then contains).
- Testing: load unpacked, verify on a live Greenhouse/Lever/Workday form (user does manual pass; no automated harness in v1).
