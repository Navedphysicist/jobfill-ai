# JobFill AI v2 — Design

**Date:** 2026-10-12
**Status:** Approved for planning
**Supersedes:** v1.1 (flat files, no tests)

## 1. Context

JobFill AI v1.1 is a Manifest V3 Chrome extension that autofills job application
forms from a hardcoded profile using the OpenAI API. It works, but it has four
structural problems:

1. The profile lives in `profile-data.js` as a JavaScript object literal. The
   user cannot read or verify it without reading code, and it is seeded into
   `chrome.storage.local` only on install, so edits to the file never reach a
   running extension.
2. The `✨` icon generates an answer and writes it straight into the field. There
   is no preview, no way to regenerate, and no way to steer the result.
3. Applications are not recorded anywhere. The user tracks them by memory.
4. Every call sends the entire profile and interleaves static and variable
   content, which defeats prompt caching. There is no result cache, no request
   deduplication and no output cap.

There are also no tests and no build step, which makes all of the above hard to
change safely.

## 2. Goals

- `profile.json` is the single source of truth, readable and verifiable by the
  user without reading code.
- Per-field regeneration through a tooltip, with preview before anything is
  written to the page.
- An application tracker with a dashboard, for later analysis of outcomes.
- Three role angles (GenAI / Software Engineer / Trainer), switched manually.
- Measurably lower LLM cost per application.
- A test suite that proves autofill and the tooltip work.

## 3. Non-goals

These were considered and explicitly excluded:

- **Email monitoring.** Deferred to its own spec. Requires Google Cloud OAuth
  setup that only the user can perform. The user will check email manually.
- **Automatic role detection from the page.** Rejected in favour of a manual
  switch: no extra LLM call, no wrong guesses.
- **Automatic submit detection.** Rejected as unreliable across ATS platforms.
  Logging is triggered by an explicit button with pre-filled data.
- **Automatic form submission.** The extension never submits. Unchanged from v1.

## 4. Architecture

### 4.1 Build

The extension moves from flat files to `src/` modules bundled by **esbuild**
into `dist/`, which Chrome loads unpacked.

Rationale: content scripts cannot use ES module `import`, so testable pure
logic cannot be shared with the content script without bundling. esbuild is a
single dev dependency with no configuration file beyond a short build script.

Accepted cost: the user must run `npm run build` after editing source. A
`npm run dev` watch mode mitigates this.

### 4.2 Layout

```
profile.json              single source of truth, hand-editable
manifest.json             points at dist/
src/
  profile/
    schema.js             JSON Schema + validate()
    load.js               read from storage, fall back to bundled default
    resolve.js            merge shared facts + selected role angle
  scan/
    fields.js             input/select/textarea detection
    widgets.js            Workday-style aria-haspopup widgets
    context.js            page context extraction (company, title, URL)
  fill/
    native.js             React-safe setNativeValue
    apply.js              apply one answer to one element
    widgets.js            open -> wait -> match -> click
  ai/
    client.js             fetch wrapper, error mapping
    prompts.js            static-first prompt assembly
    router.js             task -> model mapping
    cache.js              result cache (hash -> answer, TTL)
    inflight.js           in-flight dedupe
    usage.js              token + cost accounting
  track/
    store.js              CRUD over chrome.storage.local
    capture.js            derive company/domain/url/date from a page
    export.js             CSV + JSON
  ui/
    tooltip/              field popover
    popup/                action popup
    dashboard/            application table
    options/              settings + profile editor
dist/                     build output, git-ignored
tests/                    vitest
  fixtures/               plain.html, greenhouse.html, workday.html
e2e/                      playwright
```

### 4.3 Message contract

The content script and service worker communicate over
`chrome.runtime.sendMessage` with these actions:

| Action | Payload | Response |
|---|---|---|
| `mapFields` | `{ fields, pageContext, role }` | `{ ok, answers[] }` |
| `generateAnswer` | `{ question, pageContext, currentValue, role, instruction, length }` | `{ ok, value, cached }` |
| `getProfile` | `{}` | `{ ok, profile }` |
| `saveProfile` | `{ profile }` | `{ ok, errors[] }` |
| `logApplication` | `{ record }` | `{ ok, id }` |
| `listApplications` | `{ filter }` | `{ ok, records[] }` |
| `updateApplication` | `{ id, patch }` | `{ ok }` |
| `getUsage` | `{}` | `{ ok, usage }` |

## 5. profile.json

### 5.1 Shape

Everything factual is shared. Only `roles` varies, and it carries exactly two
fields plus a label.

```json
{
  "_meta": { "version": 2, "updatedAt": "2026-10-12" },
  "personal": { "fullName", "firstName", "lastName", "email", "phone",
                "dateOfBirth", "gender", "pronouns", "addressLine",
                "city", "state", "country", "pincode" },
  "links": { "linkedin", "github", "portfolio" },
  "education": [ { "degree", "school", "location", "from", "to", "gpa" } ],
  "experience": [ { "title", "company", "location", "from", "to",
                    "current", "bullets": [ ... ] } ],
  "skills": [ ... ],
  "languages": [ { "language", "proficiency" } ],
  "workAuthorization": { "citizenOf", "authorizedToWorkIn",
                         "requiresSponsorshipOutsideIndia", "note" },
  "jobPreferences": { "noticePeriod", "currentSalary", "expectedSalary",
                      "employmentType", "workMode", "willingToRelocate",
                      "totalExperienceYears" },
  "diversity": { "disability", "veteran", "ethnicity", "casteCategory" },
  "truthRules": [ ... ],
  "roles": {
    "genai":   { "label", "headline", "emphasis" },
    "swe":     { "label", "headline", "emphasis" },
    "trainer": { "label", "headline", "emphasis" }
  }
}
```

### 5.2 Values changed from v1

| Field | v1 | v2 |
|---|---|---|
| `jobPreferences.noticePeriod` | `"1 month"` | `"1 month"` — reviewed and kept at the user's direction, despite the employment agreement stating two months with a buyout option |
| `jobPreferences.currentSalary` | `"INR 15 LPA (share only when mandatory)"` | `"INR 00,00,000"` |
| `jobPreferences.expectedSalary` | `"INR 30+ LPA / market rate..."` | `"INR 00 LPA"` |

### 5.3 New truth rule

Added to `truthRules`, implementing the "avoid ML/data roles" requirement as an
honesty constraint rather than page detection:

> `"NEVER claim machine learning, data science, or data engineering experience — no model training, no MLOps, no data pipelines. LLM application work only."`

### 5.4 Resolution

`resolve(profile, roleKey)` returns a flat object containing every shared
section plus `headline` and `emphasis` from the selected role. Only the
resolved object is sent to the model. The other two role entries are never
transmitted.

### 5.5 Storage and precedence

- `profile.json` is bundled with the extension as the default.
- On install, it is written to `chrome.storage.local.profile`.
- The options page edits the stored copy, which always wins at runtime.
- "Reset to file" restores the bundled default.
- Export writes the stored copy back out as `profile.json` for the user to keep
  under version control.

### 5.6 Validation

A JSON Schema validates on save. Errors are reported with a JSON path
(`personal.email: must be a valid email`). An invalid profile is never saved
and never sent to the model.

### 5.7 Verification UI

The options page gains three tabs:

1. **Form view** — every field rendered as a labelled input, grouped by section.
2. **JSON view** — a raw editor with validation errors inline.
3. **Preview** — the exact resolved payload for a selected role, so the user can
   see what the model will receive.

## 6. Tooltip

### 6.1 Behaviour

The `✨` icon continues to appear on focus of a text input or textarea. Clicking
it now opens a popover anchored to the field instead of writing immediately.

```
┌─────────────────────────────────────┐
│ GenAI Engineer ▾            cached ⚡│
│ ─────────────────────────────────── │
│ <generated answer, scrollable>      │
│ ─────────────────────────────────── │
│ ↻ Regenerate   ⤓ Shorter  ⤒ Longer  │
│ ✎ [ extra instruction…            ] │
│ ─────────────────────────────────── │
│          [ Cancel ]  [ Insert ]     │
└─────────────────────────────────────┘
```

- **Nothing is written to the field until `Insert`.**
- `Regenerate` bypasses the result cache.
- `Shorter` / `Longer` re-request with a different length target.
- The instruction box appends a one-line steer (e.g. "mention LangGraph").
- The role selector changes the active role for this field only; the popup
  controls the default.
- `cached ⚡` indicates the answer came from the result cache (zero cost).

### 6.2 Constraints

- The popover is rendered in a closed shadow root to avoid host-page CSS.
- It is positioned within the viewport, flipping above the field when there is
  no room below.
- `Escape` cancels. Clicking outside cancels. Neither writes to the field.
- All popover elements carry `data-jobfill-ui="1"` so the scanner ignores them.

## 7. Application tracking

### 7.1 Record

```json
{
  "id": "uuid",
  "sno": 1,
  "company": "Barclays",
  "jobTitle": "Senior Software Engineer",
  "appliedAt": "2026-10-12",
  "state": "Applied",
  "domain": "barclays.com",
  "jobUrl": "https://barclays.wd3.myworkdayjobs.com/...",
  "roleFamily": "swe",
  "outcomeReason": "",
  "notes": "",
  "updatedAt": "2026-10-12T09:14:00Z"
}
```

`sno` is a display index derived at render time from `appliedAt` ordering, not
stored as a mutable counter.

### 7.2 States

`Applied` · `Call or Mail` · `Process Started` · `Rejected` · `On Hold`

### 7.3 Capture

The popup's **Log this application** button pre-fills the record from the page:

| Field | Derivation |
|---|---|
| `company` | `og:site_name`, then JSON-LD `hiringOrganization.name`, then `<title>` segment, then hostname minus public suffix |
| `jobTitle` | JSON-LD `title`, then `<h1>`, then `<title>` |
| `domain` | hostname minus `www.` |
| `jobUrl` | `location.href` with tracking params stripped |
| `appliedAt` | today, local date |
| `roleFamily` | currently selected role |

Every pre-filled field is editable before saving.

### 7.4 Dashboard

A full-tab extension page:

- Table of all records, newest first, with inline state editing.
- Filter by state, role family and date range; free-text search on company.
- Click a row to expand notes and outcome reason.
- Export CSV and JSON.
- A usage panel showing tokens and estimated spend (see §8.7).
- Summary counts per state, which is the basis for the later analysis.

## 8. Cost optimization

### 8.1 Static-first prompt assembly

Prompts are assembled as `[STATIC][VARIABLE]`, never interleaved:

- **Static block** — instructions, hard rules, resolved profile. Identical for
  every call with the same profile version and role.
- **Variable block** — page context, field list, current value, instruction.

v1 interleaves these, so the cacheable prefix ends at the first page-specific
byte. This change is the single biggest cache win.

### 8.2 Smaller payload

v1 sends `JSON.stringify(profile)` — the whole object. v2 sends the resolved
single-role object, dropping two unused role entries and any section not
relevant to the task.

### 8.3 Model routing

`router.js` maps task type to model, configurable in options:

Two named slots in settings, each holding a model ID:

| Slot | Used by | Default | Why |
|---|---|---|---|
| `fastModel` | `mapFields` | `gpt-5-mini` | Structured extraction against a fixed schema; swap for a cheaper model if the account has one |
| `qualityModel` | `generateAnswer` | `gpt-5-mini` | Prose quality matters; swap upward when a field deserves it |

Both default to the current model so routing changes nothing until the user
sets them. The mechanism ships; the choice of models stays the user's. The
options page shows per-slot spend so the trade-off is visible before changing
either.

### 8.4 Result cache

Key: `sha256(normalizedQuestion + roleKey + profileVersion + lengthTarget)`.
Value: `{ answer, createdAt, model, tokens }`. Stored in
`chrome.storage.local.answerCache` with a 30-day TTL and an LRU cap of 500
entries. `Regenerate` sets `bypassCache: true`.

Generic questions ("Why do you want to work here?") recur across employers, so
the hit rate should be meaningful after a few weeks of use.

### 8.5 In-flight deduplication

A `Map<hash, Promise>` in the service worker. A second identical request while
the first is in flight awaits the same promise rather than issuing a second
call. Entries are deleted on settle.

### 8.6 Output caps

`max_tokens` per task: `mapFields` 1500, `generateAnswer` 400 (250 for
`Shorter`, 700 for `Longer`). Structured output via `response_format` with a
schema for `mapFields`.

### 8.7 Usage accounting

Every call records `{ task, model, promptTokens, cachedTokens,
completionTokens, estimatedCost, at }`. Rates live in a config map in
`usage.js` and are user-editable in options, since published prices change.
Totals and a 30-day chart appear in the dashboard.

### 8.8 Failure handling

- Exponential backoff with jitter on 429 and 5xx, three attempts maximum.
- No retry on 400 and 401; these surface to the user immediately.
- A backoff ceiling prevents a retry storm.

## 9. Testing

### 9.1 Unit and integration — vitest + jsdom

| Suite | Covers |
|---|---|
| `profile` | schema validation, resolution per role, storage precedence, migration from v1 |
| `scan` | field detection, label association, widget detection, skipping `data-jobfill-ui` |
| `fill` | native setter, React input event dispatch, checkbox/radio/select, widget sequence |
| `ai` | static-first prompt ordering, cache hit/miss/TTL/LRU, dedupe, routing, backoff, usage maths |
| `track` | CRUD, capture derivation from fixture HTML, CSV/JSON export, state transitions |

`chrome.*` is mocked with an in-memory storage implementation shared across
tests.

### 9.2 Fixtures

Three HTML files under `tests/fixtures/`, each a realistic form:

- `plain.html` — standard labelled inputs, selects, textareas, radios.
- `greenhouse.html` — Greenhouse-shaped markup with `aria-describedby` labels.
- `workday.html` — `aria-haspopup="listbox"` custom dropdowns matching the
  structure v1.1 was fixed for.

### 9.3 End to end — Playwright

One test, run against a locally served fixture page with the built extension
loaded via `--load-extension`:

1. Open `workday.html`.
2. Trigger fill from the popup.
3. Assert that `personal.email`, `personal.phone` and `personal.fullName` are
   populated with the exact values from the profile, and that the Workday
   country widget resolves to `India`.
4. Focus a textarea, click `✨`, assert the popover opens with text.
5. Click `Insert`, assert the textarea now contains that text.
6. Click `Log this application`, assert a record exists in storage.

The OpenAI client is stubbed at the network layer so the E2E test is
deterministic and free.

### 9.4 Definition of done

- `npm test` green.
- `npm run e2e` green.
- A manual smoke check on one real job posting.

## 10. Migration

On upgrade, if `chrome.storage.local.profile` exists without `_meta.version`,
it is a v1 profile. A migration maps it to the v2 shape, moves `headline` and
`summary` into `roles.genai`, seeds `roles.swe` and `roles.trainer` from the
bundled default, applies the three changed `jobPreferences` values, and adds the
new truth rule. The original is kept at `profile_v1_backup` for one version.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Build step friction for the user | `npm run dev` watch mode; `dist/` committed so the extension is loadable without a build |
| Playwright + MV3 extension loading is finicky | Keep the E2E suite to one test; unit tests carry the real coverage |
| Company-name extraction is heuristic | Every captured field is editable before saving |
| Cache returns a stale answer after a profile edit | `profileVersion` is part of the cache key, so an edit invalidates naturally |
| Published model prices drift | Rates are user-editable in options, not hardcoded constants |

## 12. Implementation sequencing

This spec covers four sub-projects. The implementation plan should phase them,
each phase independently testable and shippable:

1. **Build + test harness + `profile.json`** — nothing else can be verified first.
2. **Tooltip** — depends on phase 1's profile resolution.
3. **Tracking dashboard** — independent of phases 2 and 3 except for the popup.
4. **Cost optimization** — last, so it optimizes stable call sites rather than
   code about to be rewritten.

## 13. Open questions

None. All design decisions are resolved above.
