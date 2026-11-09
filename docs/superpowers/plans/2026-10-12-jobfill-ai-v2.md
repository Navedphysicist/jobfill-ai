# JobFill AI v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn JobFill AI from an untested flat-file extension into a tested, cheap-to-run job-application assistant with a verifiable `profile.json`, a per-field regeneration tooltip, and an application tracker.

**Architecture:** Source moves to `src/` ES modules bundled by esbuild into `dist/`, which Chrome loads unpacked. Pure logic (profile resolution, scanning, filling, caching, tracking) is importable and tested in Node with jsdom; a single Playwright test loads the real extension in Chrome to prove autofill and the tooltip work end to end. All OpenAI calls stay in the service worker.

**Tech Stack:** Chrome Manifest V3, vanilla JS (ES modules), esbuild, vitest, jsdom, @playwright/test, OpenAI Chat Completions API.

**Spec:** `docs/superpowers/specs/2026-10-12-jobfill-ai-v2-design.md`

## Global Constraints

- Manifest V3. Service worker, not a background page.
- No runtime dependencies. esbuild, vitest, jsdom and @playwright/test are `devDependencies` only.
- The extension **never submits a form**. No task may add a `.submit()` or a click on a submit control.
- `profile.json` is the single source of truth. No profile facts may be hardcoded in any other file except the bundled default copy.
- Every generated answer must obey `profile.truthRules` verbatim; the rules array is injected into every prompt unmodified.
- Node >= 20 (vitest 3 and the `node:test` ESM loader require it).
- All extension UI elements carry `data-jobfill-ui="1"` so the scanner never treats its own UI as a form field.
- `dist/` is committed so the extension stays loadable without running a build.
- Values that must appear exactly in `profile.json`: `noticePeriod: "1 month"`, `currentSalary: "INR 00,00,000"`, `expectedSalary: "INR 00 LPA"`.

## Deliberate deviation from the spec

Spec §4.3 lists `logApplication`, `listApplications` and `updateApplication` as
service-worker messages. The popup, options and dashboard are extension pages with
direct `chrome.storage.local` access, so they import `src/track/store.js` instead of
round-tripping through the worker. The store stays the single writer; only the
transport differs. Content scripts never touch the store, so nothing is lost.

## Review Focus

These are the failure modes the spec implies but does not call out. Each has a test assigned to the task that owns the code.

1. **A profile section is missing or null** (user deleted `links` in the JSON editor) — `resolve()` must return a usable object rather than throwing, so the extension keeps working. *Test in Task 4.*
2. **A form field has no label, no placeholder and no `aria-label`** (common in ATS tables) — the scanner must emit the field with an empty label rather than crashing the whole scan. *Test in Task 7.*
3. **The model returns malformed or truncated JSON** — `mapFields` must surface a clean error and fill nothing, never throw an unhandled rejection into the service worker. *Test in Task 16.*
4. **`chrome.storage.local` is full or the cache exceeds its cap** — writes must evict oldest entries and continue, never reject and lose the answer the user just paid for. *Test in Task 17.*
5. **The same job URL is logged twice** — the tracker must warn and offer to update the existing record rather than silently creating a duplicate that corrupts the later analysis. *Test in Task 11.*

---

# Phase 1 — Build, test harness, and profile.json

## Task 1: Build system and test harness

**Files:**
- Create: `package.json`, `build.mjs`, `vitest.config.js`, `tests/setup.js`, `tests/chrome-mock.js`, `.gitignore`
- Create: `src/version.js`
- Test: `tests/version.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` (vitest), `npm run build` (esbuild → `dist/`), `npm run dev` (watch). Global `chrome` mock available in every test via `tests/setup.js`, exposing `chrome.storage.local` backed by an in-memory `Map`, plus `chrome.storage.local.__reset()` and `chrome.storage.local.__dump()`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/version.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { EXTENSION_VERSION, PROFILE_SCHEMA_VERSION } from "../src/version.js";

describe("version constants", () => {
  it("exposes the extension version", () => {
    expect(EXTENSION_VERSION).toBe("2.0.0");
  });

  it("exposes the profile schema version as a number", () => {
    expect(PROFILE_SCHEMA_VERSION).toBe(2);
  });
});

describe("chrome mock", () => {
  beforeEach(() => chrome.storage.local.__reset());

  it("round-trips a value through storage", async () => {
    await chrome.storage.local.set({ hello: "world" });
    const got = await chrome.storage.local.get(["hello"]);
    expect(got.hello).toBe("world");
  });

  it("returns an empty object for missing keys", async () => {
    const got = await chrome.storage.local.get(["nope"]);
    expect(got).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/version.test.js`
Expected: FAIL — vitest is not installed, no `package.json`.

- [ ] **Step 3: Write minimal implementation**

```json
// package.json
{
  "name": "jobfill-ai",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "node build.mjs",
    "dev": "node build.mjs --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "e2e": "npm run build && playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "esbuild": "^0.24.0",
    "jsdom": "^25.0.1",
    "vitest": "^3.0.0"
  }
}
```

```javascript
// build.mjs
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

const ENTRIES = {
  "dist/background.js": "src/background.js",
  "dist/content.js": "src/content.js",
  "dist/popup.js": "src/ui/popup/popup.js",
  "dist/options.js": "src/ui/options/options.js",
  "dist/dashboard.js": "src/ui/dashboard/dashboard.js"
};

const STATIC = [
  ["manifest.json", "dist/manifest.json"],
  ["profile.json", "dist/profile.json"],
  ["src/content.css", "dist/content.css"],
  ["src/ui/popup/popup.html", "dist/popup.html"],
  ["src/ui/popup/popup.css", "dist/popup.css"],
  ["src/ui/options/options.html", "dist/options.html"],
  ["src/ui/options/options.css", "dist/options.css"],
  ["src/ui/dashboard/dashboard.html", "dist/dashboard.html"],
  ["src/ui/dashboard/dashboard.css", "dist/dashboard.css"]
];

async function copyStatic() {
  for (const [from, to] of STATIC) {
    try {
      await cp(from, to);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}

async function run() {
  await rm("dist", { recursive: true, force: true });
  await mkdir("dist", { recursive: true });

  const common = {
    bundle: true,
    format: "iife",
    target: "chrome120",
    logLevel: "info"
  };

  for (const [out, entry] of Object.entries(ENTRIES)) {
    const opts = { ...common, entryPoints: [entry], outfile: out };
    if (watch) {
      const ctx = await esbuild.context(opts);
      await ctx.watch();
    } else {
      await esbuild.build(opts);
    }
  }

  await copyStatic();
  console.log(watch ? "watching…" : "build complete");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

```javascript
// vitest.config.js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.js"],
    include: ["tests/**/*.test.js"]
  }
});
```

```javascript
// tests/chrome-mock.js
export function createChromeMock() {
  const store = new Map();
  const listeners = [];

  const local = {
    async get(keys) {
      if (keys == null) return Object.fromEntries(store);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (store.has(k)) out[k] = store.get(k);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
    async clear() {
      store.clear();
    },
    __reset() {
      store.clear();
      listeners.length = 0;
    },
    __dump() {
      return Object.fromEntries(store);
    },
    __failNextSet: null
  };

  return {
    storage: { local },
    runtime: {
      id: "test-extension-id",
      lastError: null,
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        __listeners: listeners
      },
      async sendMessage(msg) {
        for (const fn of listeners) {
          let response;
          const done = new Promise((resolve) => {
            response = resolve;
          });
          const returned = fn(msg, { id: "test" }, response);
          if (returned === true) return await done;
        }
        return undefined;
      }
    },
    tabs: {
      async query() {
        return [{ id: 1, url: "https://example.com/job/1" }];
      },
      async sendMessage() {
        return { ok: true };
      }
    }
  };
}
```

```javascript
// tests/setup.js
import { beforeEach } from "vitest";
import { createChromeMock } from "./chrome-mock.js";

globalThis.chrome = createChromeMock();

beforeEach(() => {
  chrome.storage.local.__reset();
  chrome.runtime.lastError = null;
});
```

```javascript
// src/version.js
export const EXTENSION_VERSION = "2.0.0";
export const PROFILE_SCHEMA_VERSION = 2;
```

```
# .gitignore
node_modules/
test-results/
playwright-report/
.DS_Store
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm install && npm test`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json build.mjs vitest.config.js tests/ src/version.js .gitignore
git commit -m "build: add esbuild bundling and vitest harness with chrome mock"
```

---

## Task 2: profile.json and its schema

**Files:**
- Create: `profile.json`, `src/profile/schema.js`
- Test: `tests/profile-schema.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `validateProfile(profile) -> { valid: boolean, errors: Array<{ path: string, message: string }> }`. `errors` is `[]` when valid. Also exports `ROLE_KEYS = ["genai", "swe", "trainer"]`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/profile-schema.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateProfile, ROLE_KEYS } from "../src/profile/schema.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));

describe("profile.json", () => {
  it("validates clean", () => {
    const { valid, errors } = validateProfile(profile);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("carries the three role angles", () => {
    expect(Object.keys(profile.roles).sort()).toEqual([...ROLE_KEYS].sort());
    for (const key of ROLE_KEYS) {
      expect(profile.roles[key].label).toBeTruthy();
      expect(profile.roles[key].headline).toBeTruthy();
      expect(profile.roles[key].emphasis).toBeTruthy();
    }
  });

  it("holds the corrected job preference values", () => {
    expect(profile.jobPreferences.noticePeriod).toBe("1 month");
    expect(profile.jobPreferences.currentSalary).toBe("INR 00,00,000");
    expect(profile.jobPreferences.expectedSalary).toBe("INR 00 LPA");
  });

  it("forbids machine learning and data engineering claims", () => {
    const joined = profile.truthRules.join(" ").toLowerCase();
    expect(joined).toContain("machine learning");
    expect(joined).toContain("data engineering");
  });

  it("keeps facts out of the role angles", () => {
    for (const key of ROLE_KEYS) {
      expect(Object.keys(profile.roles[key]).sort())
        .toEqual(["emphasis", "headline", "label"]);
    }
  });
});

describe("validateProfile", () => {
  it("reports a missing required section with its path", () => {
    const bad = structuredClone(profile);
    delete bad.personal;
    const { valid, errors } = validateProfile(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.path === "personal")).toBe(true);
  });

  it("reports a malformed email with its path", () => {
    const bad = structuredClone(profile);
    bad.personal.email = "not-an-email";
    const { errors } = validateProfile(bad);
    expect(errors.some((e) => e.path === "personal.email")).toBe(true);
  });

  it("reports an unknown role key", () => {
    const bad = structuredClone(profile);
    bad.roles.dataScience = { label: "x", headline: "y", emphasis: "z" };
    const { errors } = validateProfile(bad);
    expect(errors.some((e) => e.path === "roles.dataScience")).toBe(true);
  });

  it("rejects a non-object input without throwing", () => {
    expect(validateProfile(null).valid).toBe(false);
    expect(validateProfile("nope").valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/profile-schema.test.js`
Expected: FAIL — `profile.json` and `src/profile/schema.js` do not exist.

- [ ] **Step 3: Write minimal implementation**

```json
// profile.json
{
  "_meta": { "version": 2, "updatedAt": "2026-10-12" },

  "personal": {
    "fullName": "Naved Khan",
    "firstName": "Naved",
    "lastName": "Khan",
    "email": "you@example.com",
    "phone": "+91 90000 00000",
    "dateOfBirth": "1990-01-01",
    "gender": "Male",
    "pronouns": "He/Him",
    "addressLine": "123 Example Street, Example Area",
    "city": "Bareilly",
    "state": "Uttar Pradesh",
    "country": "India",
    "pincode": "560001"
  },

  "links": {
    "linkedin": "https://www.linkedin.com/in/naved-khan-093167137/",
    "github": "https://github.com/Navedphysicist",
    "portfolio": ""
  },

  "education": [
    {
      "degree": "B.Tech / B.E. in Mechanical Engineering",
      "school": "Shri Siddhi Vinayak Institute of Technology (AKTU)",
      "location": "Bareilly, India",
      "from": "2016",
      "to": "2020",
      "gpa": "8.6 / 10"
    },
    {
      "degree": "Full Stack Web Development (bootcamp)",
      "school": "Masai School",
      "location": "Bengaluru, India",
      "from": "2021-12",
      "to": "2022-08",
      "gpa": ""
    }
  ],

  "experience": [
    {
      "title": "Senior Generative AI Engineer",
      "company": "Axelerant (Progression School, an Axelerant venture)",
      "location": "Gurgaon, India (Remote)",
      "from": "2024-05",
      "to": "Present",
      "current": true,
      "bullets": [
        "Lead engineer on Talent Studios (determinedpeople.ai), an AI-powered executive talent-sourcing platform — owning features end-to-end across 85+ REST APIs with Next.js, React 19, Node.js, TypeScript and PostgreSQL.",
        "Engineered the candidate-matching engine: LLM attribute extraction, embeddings and vector similarity search, and a two-level scoring model producing explainable ranked recommendations.",
        "Built an app-wide AI assistant that runs full candidate searches from chat via LLM tool calling, with a capability tool library and admin-approved ranking rules.",
        "Designed a multi-provider AI model layer (OpenAI, Anthropic, Groq) with a per-task model catalog, registry and resolver, plus per-route usage and cost observability.",
        "Shipped an AI interview workflow: meeting bots capture live transcripts for LLM-driven interview analysis, integrated with Calendly, Clockwork ATS and Resend.",
        "Deployed LangChain and LangGraph agents with custom tools, including a real-time web search assistant.",
        "Designs and delivers Generative AI training for internal teams, clients and university cohorts — RAG, agents, LangChain/LangGraph, Python and FastAPI."
      ]
    },
    {
      "title": "SDE-I",
      "company": "Masai School",
      "location": "Bengaluru, India",
      "from": "2022-08",
      "to": "2024-04",
      "current": false,
      "bullets": [
        "Core engineer on Masai's Learning Management System, used daily for live classes and student tracking.",
        "Implemented attendance tracking using Zoom APIs (TypeScript, Node.js), improving accuracy by 45%.",
        "Built Aadhaar-based identity verification and role-based authentication (OAuth 2.0, email and mobile OTP).",
        "Automated data synchronisation with off-peak cron jobs; Winston and CloudWatch logging on AWS.",
        "Built REST APIs with Node.js and Express; modelled cross-entity data relations with MySQL and GraphQL.",
        "Taught data structures and algorithms and JavaScript to 5,000+ students across 800+ live sessions, and authored curriculum, session plans and interview question banks."
      ]
    }
  ],

  "skills": [
    "Generative AI", "Large Language Models (LLMs)", "RAG", "Agentic AI",
    "LangChain", "LangGraph", "MCP", "Prompt Engineering", "Vector Databases",
    "Embeddings", "Semantic Search", "LLM Evaluation", "Python", "FastAPI",
    "TypeScript", "JavaScript", "Node.js", "Express", "Next.js", "React.js",
    "PostgreSQL", "MySQL", "MongoDB", "GraphQL", "AWS", "Docker", "REST APIs",
    "Curriculum Design", "Technical Training"
  ],

  "languages": [
    { "language": "English", "proficiency": "Full professional proficiency" },
    { "language": "Hindi", "proficiency": "Native" }
  ],

  "workAuthorization": {
    "citizenOf": "India",
    "authorizedToWorkIn": ["India"],
    "requiresSponsorshipOutsideIndia": true,
    "note": "Indian citizen. Work-authorized in India ONLY — no permits or visas for any other country. For a job located in India: legally eligible = Yes, requires sponsorship = No. For a job outside India: will require sponsorship = Yes."
  },

  "jobPreferences": {
    "noticePeriod": "1 month",
    "currentSalary": "INR 00,00,000",
    "expectedSalary": "INR 00 LPA",
    "employmentType": "Full-time",
    "workMode": "Remote preferred; open to hybrid or onsite anywhere in India",
    "willingToRelocate": true,
    "totalExperienceYears": 4
  },

  "diversity": {
    "disability": "No",
    "veteran": "No",
    "ethnicity": "South Asian",
    "casteCategory": "General"
  },

  "truthRules": [
    "NEVER claim work permits, visas, or work authorization outside India.",
    "NEVER claim Azure experience — cloud experience is AWS only.",
    "NEVER claim LLM fine-tuning experience.",
    "NEVER mention an AI Invoice Parser project.",
    "NEVER claim machine learning, data science, or data engineering experience — no model training, no MLOps, no data pipelines. LLM application work only.",
    "B.Tech CGPA is 8.6, never 9.2.",
    "Total professional experience is 4 years (career started August 2022).",
    "Agentic frameworks used in production: LangChain, LangGraph, MCP, Vercel AI SDK. CrewAI: taught hands-on in college workshops (claimable as teaching/workshop experience, not production). Never claim AutoGen."
  ],

  "roles": {
    "genai": {
      "label": "GenAI Engineer",
      "headline": "Senior Generative AI Engineer | RAG · Agents · LLM Evals · LangGraph",
      "emphasis": "Lead engineer on production LLM systems: RAG pipelines, agent architectures, tool calling, embeddings and vector search, LLM evaluation, and per-route cost observability."
    },
    "swe": {
      "label": "Software Engineer",
      "headline": "Senior Software Engineer | Node.js · TypeScript · Python · PostgreSQL",
      "emphasis": "Full-stack delivery: 85+ REST APIs end to end, LMS core systems, OAuth and OTP authentication, third-party integrations, cron automation, and AWS logging and monitoring."
    },
    "trainer": {
      "label": "Trainer / L&D",
      "headline": "Technical Trainer | Generative AI · Python · DSA | 5,000+ engineers trained",
      "emphasis": "Curriculum design and live delivery across GenAI, Python, FastAPI, JavaScript and DSA — 800+ sessions, 5,000+ learners — while building the same production systems being taught."
    }
  }
}
```

```javascript
// src/profile/schema.js
export const ROLE_KEYS = ["genai", "swe", "trainer"];

const REQUIRED_SECTIONS = [
  "personal", "links", "education", "experience", "skills",
  "languages", "workAuthorization", "jobPreferences", "diversity",
  "truthRules", "roles"
];

const REQUIRED_PERSONAL = ["fullName", "firstName", "lastName", "email", "phone"];
const ROLE_FIELDS = ["label", "headline", "emphasis"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validateProfile(profile) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });

  if (!isObject(profile)) {
    add("", "profile must be an object");
    return { valid: false, errors };
  }

  for (const section of REQUIRED_SECTIONS) {
    if (profile[section] === undefined || profile[section] === null) {
      add(section, "required section is missing");
    }
  }

  if (isObject(profile.personal)) {
    for (const field of REQUIRED_PERSONAL) {
      if (!profile.personal[field]) add(`personal.${field}`, "is required");
    }
    if (profile.personal.email && !EMAIL_RE.test(profile.personal.email)) {
      add("personal.email", "must be a valid email address");
    }
  }

  for (const key of ["education", "experience", "skills", "languages", "truthRules"]) {
    if (profile[key] !== undefined && !Array.isArray(profile[key])) {
      add(key, "must be an array");
    }
  }

  if (Array.isArray(profile.experience)) {
    profile.experience.forEach((entry, i) => {
      if (!entry?.company) add(`experience[${i}].company`, "is required");
      if (!Array.isArray(entry?.bullets)) add(`experience[${i}].bullets`, "must be an array");
    });
  }

  if (isObject(profile.roles)) {
    for (const key of Object.keys(profile.roles)) {
      if (!ROLE_KEYS.includes(key)) {
        add(`roles.${key}`, `unknown role key; expected one of ${ROLE_KEYS.join(", ")}`);
      }
    }
    for (const key of ROLE_KEYS) {
      const role = profile.roles[key];
      if (!isObject(role)) {
        add(`roles.${key}`, "is required");
        continue;
      }
      for (const field of ROLE_FIELDS) {
        if (!role[field]) add(`roles.${key}.${field}`, "is required");
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/profile-schema.test.js`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add profile.json src/profile/schema.js tests/profile-schema.test.js
git commit -m "feat(profile): add profile.json as single source of truth with schema validation"
```

---

## Task 3: Profile loading, storage precedence and v1 migration

**Files:**
- Create: `src/profile/load.js`, `src/profile/migrate.js`
- Test: `tests/profile-load.test.js`, `tests/profile-migrate.test.js`

**Interfaces:**
- Consumes: `validateProfile`, `ROLE_KEYS` from `src/profile/schema.js`; `PROFILE_SCHEMA_VERSION` from `src/version.js`.
- Produces:
  - `loadProfile() -> Promise<profile>` — stored copy wins; falls back to the bundled default.
  - `saveProfile(profile) -> Promise<{ ok: boolean, errors: Array }>` — validates first; never writes an invalid profile.
  - `resetProfile() -> Promise<profile>` — restores the bundled default.
  - `setDefaultProfile(obj)` — injects the bundled default (called by the service worker after fetching `profile.json`; lets tests supply their own).
  - `migrateV1(v1Profile, defaultProfile) -> profile` — pure function, no storage access.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/profile-migrate.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { migrateV1 } from "../src/profile/migrate.js";

const defaultProfile = JSON.parse(readFileSync("profile.json", "utf8"));

const v1 = {
  personal: { fullName: "Naved Khan", firstName: "Naved", lastName: "Khan",
              email: "you@example.com", phone: "+91 90000 00000" },
  links: { linkedin: "https://linkedin.com/in/x", github: "", portfolio: "" },
  headline: "Senior Generative AI Engineer | OLD HEADLINE",
  summary: "Old summary text.",
  experience: [{ title: "T", company: "C", from: "2024-05", to: "Present", bullets: ["b1"] }],
  education: [{ degree: "D", school: "S", from: "2016", to: "2020", gpa: "8.6 / 10" }],
  skills: ["Python"],
  languages: [{ language: "English", proficiency: "Full professional proficiency" }],
  workAuthorization: { citizenOf: "India", authorizedToWorkIn: ["India"],
                       requiresSponsorshipOutsideIndia: true, note: "n" },
  jobPreferences: { noticePeriod: "1 month", currentSalary: "INR 15 LPA",
                    expectedSalary: "INR 30+ LPA", employmentType: "Full-time" },
  diversity: { disability: "No", veteran: "No" },
  truthRules: ["NEVER claim Azure experience — cloud experience is AWS only."]
};

describe("migrateV1", () => {
  const out = migrateV1(v1, defaultProfile);

  it("stamps the v2 schema version", () => {
    expect(out._meta.version).toBe(2);
  });

  it("keeps the user's own facts", () => {
    expect(out.personal.email).toBe("you@example.com");
    expect(out.experience[0].company).toBe("C");
    expect(out.skills).toEqual(["Python"]);
  });

  it("moves the v1 headline into the genai role", () => {
    expect(out.roles.genai.headline).toBe("Senior Generative AI Engineer | OLD HEADLINE");
  });

  it("seeds the two missing role angles from the default", () => {
    expect(out.roles.swe).toEqual(defaultProfile.roles.swe);
    expect(out.roles.trainer).toEqual(defaultProfile.roles.trainer);
  });

  it("applies the three corrected job preference values", () => {
    expect(out.jobPreferences.noticePeriod).toBe("1 month");
    expect(out.jobPreferences.currentSalary).toBe("INR 00,00,000");
    expect(out.jobPreferences.expectedSalary).toBe("INR 00 LPA");
  });

  it("adds the ML/data truth rule without dropping existing rules", () => {
    expect(out.truthRules).toContain(
      "NEVER claim Azure experience — cloud experience is AWS only."
    );
    expect(out.truthRules.join(" ")).toContain("machine learning");
  });

  it("drops the v1 top-level headline and summary", () => {
    expect(out.headline).toBeUndefined();
    expect(out.summary).toBeUndefined();
  });

  it("is idempotent when run on an already-migrated profile", () => {
    const twice = migrateV1(out, defaultProfile);
    expect(twice).toEqual(out);
  });
});
```

```javascript
// tests/profile-load.test.js
import { describe, it, expect, beforeEach } from "vitest";
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
    expect(dump.profile_v1_backup).toBeDefined();
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/profile-load.test.js tests/profile-migrate.test.js`
Expected: FAIL — `src/profile/load.js` and `src/profile/migrate.js` do not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/profile/migrate.js
import { PROFILE_SCHEMA_VERSION } from "../version.js";
import { ROLE_KEYS } from "./schema.js";

const CORRECTED_PREFERENCES = {
  noticePeriod: "1 month",
  currentSalary: "INR 00,00,000",
  expectedSalary: "INR 00 LPA"
};

const ML_TRUTH_RULE =
  "NEVER claim machine learning, data science, or data engineering experience — " +
  "no model training, no MLOps, no data pipelines. LLM application work only.";

export function needsMigration(profile) {
  return !profile?._meta || profile._meta.version !== PROFILE_SCHEMA_VERSION;
}

export function migrateV1(v1, defaultProfile) {
  const out = structuredClone(v1);

  out.roles = out.roles ? structuredClone(out.roles) : {};
  for (const key of ROLE_KEYS) {
    if (!out.roles[key]) out.roles[key] = structuredClone(defaultProfile.roles[key]);
  }
  if (v1.headline) out.roles.genai.headline = v1.headline;

  delete out.headline;
  delete out.summary;

  out.jobPreferences = { ...(out.jobPreferences || {}), ...CORRECTED_PREFERENCES };

  const rules = Array.isArray(out.truthRules) ? [...out.truthRules] : [];
  if (!rules.some((r) => r.toLowerCase().includes("machine learning"))) {
    rules.push(ML_TRUTH_RULE);
  }
  out.truthRules = rules;

  for (const section of ["links", "diversity", "languages", "education", "skills"]) {
    if (out[section] === undefined) out[section] = structuredClone(defaultProfile[section]);
  }

  out._meta = {
    version: PROFILE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString().slice(0, 10)
  };

  return out;
}
```

```javascript
// src/profile/load.js
import { validateProfile } from "./schema.js";
import { migrateV1, needsMigration } from "./migrate.js";
import { PROFILE_SCHEMA_VERSION } from "../version.js";

let bundledDefault = null;

export function setDefaultProfile(obj) {
  bundledDefault = obj;
}

export function getDefaultProfile() {
  if (!bundledDefault) throw new Error("default profile not loaded");
  return bundledDefault;
}

export async function loadProfile() {
  const { profile } = await chrome.storage.local.get(["profile"]);
  if (!profile) return structuredClone(getDefaultProfile());

  if (needsMigration(profile)) {
    const migrated = migrateV1(profile, getDefaultProfile());
    await chrome.storage.local.set({
      profile_v1_backup: profile,
      profile: migrated
    });
    return migrated;
  }

  return profile;
}

export async function saveProfile(profile) {
  const { valid, errors } = validateProfile(profile);
  if (!valid) return { ok: false, errors };

  const toStore = structuredClone(profile);
  toStore._meta = {
    version: PROFILE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString().slice(0, 10)
  };
  await chrome.storage.local.set({ profile: toStore });
  return { ok: true, errors: [] };
}

export async function resetProfile() {
  const fresh = structuredClone(getDefaultProfile());
  await chrome.storage.local.set({ profile: fresh });
  return fresh;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/profile-load.test.js tests/profile-migrate.test.js`
Expected: PASS — 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/profile/load.js src/profile/migrate.js tests/profile-load.test.js tests/profile-migrate.test.js
git commit -m "feat(profile): add storage precedence, validation on save, and v1 migration"
```

---

## Task 4: Role resolution

**Files:**
- Create: `src/profile/resolve.js`
- Test: `tests/profile-resolve.test.js`

**Interfaces:**
- Consumes: `ROLE_KEYS` from `src/profile/schema.js`.
- Produces: `resolveProfile(profile, roleKey) -> resolved` where `resolved` contains every shared section plus `headline` and `emphasis` (strings) and `roleLabel` (string), and **no `roles` key**. Unknown or missing `roleKey` falls back to `"genai"`.

> **Review Focus #1 is covered here:** a profile with a missing or null section must resolve rather than throw.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/profile-resolve.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveProfile } from "../src/profile/resolve.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));

describe("resolveProfile", () => {
  it("flattens the selected role onto the shared facts", () => {
    const r = resolveProfile(profile, "swe");
    expect(r.headline).toBe(profile.roles.swe.headline);
    expect(r.emphasis).toBe(profile.roles.swe.emphasis);
    expect(r.roleLabel).toBe(profile.roles.swe.label);
    expect(r.personal.email).toBe(profile.personal.email);
  });

  it("never leaks the other role angles", () => {
    const r = resolveProfile(profile, "swe");
    expect(r.roles).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(profile.roles.trainer.headline);
    expect(JSON.stringify(r)).not.toContain(profile.roles.genai.headline);
  });

  it("carries truthRules through unmodified", () => {
    const r = resolveProfile(profile, "trainer");
    expect(r.truthRules).toEqual(profile.truthRules);
  });

  it("falls back to genai for an unknown role key", () => {
    expect(resolveProfile(profile, "dataScience").headline)
      .toBe(profile.roles.genai.headline);
    expect(resolveProfile(profile, undefined).headline)
      .toBe(profile.roles.genai.headline);
  });

  it("drops _meta from the payload sent to the model", () => {
    expect(resolveProfile(profile, "genai")._meta).toBeUndefined();
  });

  // Review Focus #1
  it("resolves without throwing when a section is missing", () => {
    const partial = structuredClone(profile);
    delete partial.links;
    delete partial.diversity;
    const r = resolveProfile(partial, "genai");
    expect(r.links).toEqual({});
    expect(r.diversity).toEqual({});
    expect(r.personal.email).toBe(profile.personal.email);
  });

  it("resolves without throwing when a section is null", () => {
    const partial = structuredClone(profile);
    partial.education = null;
    partial.skills = null;
    const r = resolveProfile(partial, "genai");
    expect(r.education).toEqual([]);
    expect(r.skills).toEqual([]);
  });

  it("resolves without throwing when roles is missing entirely", () => {
    const partial = structuredClone(profile);
    delete partial.roles;
    const r = resolveProfile(partial, "swe");
    expect(r.headline).toBe("");
    expect(r.emphasis).toBe("");
    expect(r.personal.fullName).toBe(profile.personal.fullName);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/profile-resolve.test.js`
Expected: FAIL — `src/profile/resolve.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/profile/resolve.js
import { ROLE_KEYS } from "./schema.js";

const OBJECT_SECTIONS = ["personal", "links", "workAuthorization",
                         "jobPreferences", "diversity"];
const ARRAY_SECTIONS = ["education", "experience", "skills",
                        "languages", "truthRules"];

export function resolveProfile(profile, roleKey) {
  const src = profile && typeof profile === "object" ? profile : {};
  const key = ROLE_KEYS.includes(roleKey) ? roleKey : "genai";
  const role = (src.roles && src.roles[key]) || {};

  const out = {};
  for (const s of OBJECT_SECTIONS) {
    out[s] = src[s] && typeof src[s] === "object" ? structuredClone(src[s]) : {};
  }
  for (const s of ARRAY_SECTIONS) {
    out[s] = Array.isArray(src[s]) ? structuredClone(src[s]) : [];
  }

  out.roleLabel = role.label || "";
  out.headline = role.headline || "";
  out.emphasis = role.emphasis || "";

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/profile-resolve.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/profile/resolve.js tests/profile-resolve.test.js
git commit -m "feat(profile): resolve a single role angle onto shared facts"
```

---

## Task 5: Options page — profile verification UI

**Files:**
- Create: `src/ui/options/options.html`, `src/ui/options/options.css`, `src/ui/options/options.js`, `src/ui/options/render-form.js`
- Delete: `options.html`, `options.css`, `options.js` (the v1 files at repo root)
- Test: `tests/options-render-form.test.js`

**Interfaces:**
- Consumes: `loadProfile`, `saveProfile`, `resetProfile` from `src/profile/load.js`; `resolveProfile` from `src/profile/resolve.js`; `validateProfile` from `src/profile/schema.js`.
- Produces: `renderFormView(profile) -> DocumentFragment` and `readFormView(root) -> profile`. These are pure DOM functions so they can be tested without a browser.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/options-render-form.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderFormView, readFormView } from "../src/ui/options/render-form.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));

function mount(p) {
  const root = document.createElement("div");
  root.appendChild(renderFormView(p));
  return root;
}

describe("renderFormView", () => {
  it("renders an input for every personal field", () => {
    const root = mount(profile);
    for (const key of Object.keys(profile.personal)) {
      const el = root.querySelector(`[data-path="personal.${key}"]`);
      expect(el, `missing input for personal.${key}`).toBeTruthy();
      expect(el.value).toBe(String(profile.personal[key]));
    }
  });

  it("renders every truth rule as an editable row", () => {
    const root = mount(profile);
    const rows = root.querySelectorAll('[data-path^="truthRules["]');
    expect(rows.length).toBe(profile.truthRules.length);
  });

  it("renders the three role angles", () => {
    const root = mount(profile);
    for (const key of ["genai", "swe", "trainer"]) {
      expect(root.querySelector(`[data-path="roles.${key}.headline"]`)).toBeTruthy();
      expect(root.querySelector(`[data-path="roles.${key}.emphasis"]`)).toBeTruthy();
    }
  });

  it("marks every control as extension UI", () => {
    const root = mount(profile);
    for (const el of root.querySelectorAll("input, textarea")) {
      expect(el.getAttribute("data-jobfill-ui")).toBe("1");
    }
  });
});

describe("readFormView", () => {
  it("round-trips an unedited profile", () => {
    const root = mount(profile);
    const back = readFormView(root);
    expect(back.personal).toEqual(profile.personal);
    expect(back.truthRules).toEqual(profile.truthRules);
    expect(back.roles.swe.headline).toBe(profile.roles.swe.headline);
  });

  it("picks up an edit made in the form", () => {
    const root = mount(profile);
    root.querySelector('[data-path="personal.city"]').value = "Hyderabad";
    expect(readFormView(root).personal.city).toBe("Hyderabad");
  });

  it("preserves sections that have no form controls", () => {
    const root = mount(profile);
    expect(readFormView(root, profile).experience).toEqual(profile.experience);
  });

  it("merges edits onto the base profile", () => {
    const root = mount(profile);
    root.querySelector('[data-path="personal.city"]').value = "Hyderabad";
    const back = readFormView(root, profile);
    expect(back.personal.city).toBe("Hyderabad");
    expect(back.workAuthorization).toEqual(profile.workAuthorization);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/options-render-form.test.js`
Expected: FAIL — `src/ui/options/render-form.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/ui/options/render-form.js
const PERSONAL_ORDER = ["fullName", "firstName", "lastName", "email", "phone",
  "dateOfBirth", "gender", "pronouns", "addressLine", "city", "state",
  "country", "pincode"];

const PREF_ORDER = ["noticePeriod", "currentSalary", "expectedSalary",
  "employmentType", "workMode", "willingToRelocate", "totalExperienceYears"];

const LONG_FIELDS = new Set(["addressLine", "emphasis", "note"]);

function field(path, value) {
  const wrap = document.createElement("label");
  wrap.className = "jfa-field";

  const span = document.createElement("span");
  span.className = "jfa-label";
  span.textContent = path.split(".").pop().replace(/\[(\d+)\]$/, " $1");
  wrap.appendChild(span);

  const leaf = path.split(".").pop();
  const long = LONG_FIELDS.has(leaf) || String(value ?? "").length > 90;
  const input = document.createElement(long ? "textarea" : "input");
  if (!long) input.type = "text";
  input.value = value === undefined || value === null ? "" : String(value);
  input.dataset.path = path;
  input.setAttribute("data-jobfill-ui", "1");
  wrap.appendChild(input);

  return wrap;
}

function section(title) {
  const el = document.createElement("section");
  el.className = "jfa-section";
  const h = document.createElement("h2");
  h.textContent = title;
  el.appendChild(h);
  return el;
}

export function renderFormView(profile) {
  const frag = document.createDocumentFragment();

  const personal = section("Personal");
  for (const key of PERSONAL_ORDER) {
    personal.appendChild(field(`personal.${key}`, profile.personal?.[key]));
  }
  frag.appendChild(personal);

  const links = section("Links");
  for (const key of Object.keys(profile.links || {})) {
    links.appendChild(field(`links.${key}`, profile.links[key]));
  }
  frag.appendChild(links);

  const prefs = section("Job preferences");
  for (const key of PREF_ORDER) {
    prefs.appendChild(field(`jobPreferences.${key}`, profile.jobPreferences?.[key]));
  }
  frag.appendChild(prefs);

  const div = section("Diversity");
  for (const key of Object.keys(profile.diversity || {})) {
    div.appendChild(field(`diversity.${key}`, profile.diversity[key]));
  }
  frag.appendChild(div);

  const rules = section("Truth rules");
  (profile.truthRules || []).forEach((rule, i) => {
    rules.appendChild(field(`truthRules[${i}]`, rule));
  });
  frag.appendChild(rules);

  const roles = section("Role angles");
  for (const key of Object.keys(profile.roles || {})) {
    const h = document.createElement("h3");
    h.textContent = profile.roles[key].label || key;
    roles.appendChild(h);
    roles.appendChild(field(`roles.${key}.label`, profile.roles[key].label));
    roles.appendChild(field(`roles.${key}.headline`, profile.roles[key].headline));
    roles.appendChild(field(`roles.${key}.emphasis`, profile.roles[key].emphasis));
  }
  frag.appendChild(roles);

  return frag;
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i].match(/^(.+)\[(\d+)\]$/);
    if (m) {
      node[m[1]] = node[m[1]] || [];
      node[m[1]][Number(m[2])] = node[m[1]][Number(m[2])] || {};
      node = node[m[1]][Number(m[2])];
    } else {
      node[parts[i]] = node[parts[i]] || {};
      node = node[parts[i]];
    }
  }
  const last = parts[parts.length - 1];
  const m = last.match(/^(.+)\[(\d+)\]$/);
  if (m) {
    node[m[1]] = node[m[1]] || [];
    node[m[1]][Number(m[2])] = value;
  } else {
    node[last] = value;
  }
}

const BOOLEAN_PATHS = new Set(["jobPreferences.willingToRelocate"]);
const NUMBER_PATHS = new Set(["jobPreferences.totalExperienceYears"]);

export function readFormView(root, base) {
  const out = base ? structuredClone(base) : {};
  for (const el of root.querySelectorAll("[data-path]")) {
    const path = el.dataset.path;
    let value = el.value;
    if (BOOLEAN_PATHS.has(path)) value = value === "true";
    else if (NUMBER_PATHS.has(path)) value = Number(value);
    setPath(out, path, value);
  }
  return out;
}
```

`readFormView(root, base)` takes the loaded profile as `base` so sections with no
form controls (`experience`, `education`, `skills`, `languages`,
`workAuthorization`) survive the round trip. Called without a base it still
works, returning only the sections the form renders.

```html
<!-- src/ui/options/options.html -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>JobFill AI — Settings</title>
  <link rel="stylesheet" href="options.css" />
</head>
<body>
  <header>
    <h1>JobFill AI</h1>
    <nav class="jfa-tabs">
      <button data-tab="settings" class="active">Settings</button>
      <button data-tab="form">Profile</button>
      <button data-tab="json">JSON</button>
      <button data-tab="preview">Preview</button>
    </nav>
  </header>

  <main>
    <div id="status" role="status"></div>

    <section id="tab-settings" class="jfa-tab">
      <label class="jfa-field"><span class="jfa-label">OpenAI API key</span>
        <input id="apiKey" type="password" autocomplete="off" /></label>
      <label class="jfa-field"><span class="jfa-label">Fast model (field mapping)</span>
        <input id="fastModel" type="text" /></label>
      <label class="jfa-field"><span class="jfa-label">Quality model (generated answers)</span>
        <input id="qualityModel" type="text" /></label>
      <label class="jfa-field"><span class="jfa-label">Base URL</span>
        <input id="baseUrl" type="text" /></label>
      <button id="saveSettings">Save settings</button>
    </section>

    <section id="tab-form" class="jfa-tab" hidden>
      <div id="formRoot"></div>
      <div class="jfa-actions">
        <button id="saveForm">Save profile</button>
        <button id="resetProfile" class="secondary">Reset to bundled file</button>
      </div>
    </section>

    <section id="tab-json" class="jfa-tab" hidden>
      <textarea id="jsonEditor" spellcheck="false"></textarea>
      <ul id="jsonErrors" class="jfa-errors"></ul>
      <div class="jfa-actions">
        <button id="saveJson">Save JSON</button>
        <button id="exportJson" class="secondary">Export profile.json</button>
        <label class="secondary jfa-import">Import…
          <input id="importJson" type="file" accept="application/json" hidden />
        </label>
      </div>
    </section>

    <section id="tab-preview" class="jfa-tab" hidden>
      <label class="jfa-field"><span class="jfa-label">Role</span>
        <select id="previewRole"></select></label>
      <p class="jfa-hint">This is exactly what the model receives. Nothing else is sent.</p>
      <pre id="previewOut"></pre>
    </section>
  </main>

  <script src="options.js"></script>
</body>
</html>
```

```css
/* src/ui/options/options.css */
:root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#e2e2e2; --accent:#2b6cb0; --err:#c53030; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#16181d; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2c2f36; --accent:#63a4ff; --err:#ff8a8a; }
}
* { box-sizing: border-box; }
body { margin:0; padding:24px; max-width:860px; font:14px/1.5 system-ui,sans-serif;
       background:var(--bg); color:var(--fg); }
h1 { font-size:18px; margin:0 0 12px; }
h2 { font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted);
     margin:24px 0 8px; }
h3 { font-size:13px; margin:16px 0 6px; }
.jfa-tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin-bottom:16px; }
.jfa-tabs button { background:none; border:0; padding:8px 12px; cursor:pointer;
                   color:var(--muted); border-bottom:2px solid transparent; font:inherit; }
.jfa-tabs button.active { color:var(--fg); border-bottom-color:var(--accent); }
.jfa-field { display:block; margin-bottom:10px; }
.jfa-label { display:block; font-size:12px; color:var(--muted); margin-bottom:3px; }
input, textarea, select, pre {
  width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:6px;
  background:var(--bg); color:var(--fg); font:inherit;
}
textarea { min-height:64px; resize:vertical; }
#jsonEditor { min-height:460px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
pre { overflow:auto; max-height:520px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
button { padding:8px 14px; border:0; border-radius:6px; background:var(--accent); color:#fff;
         cursor:pointer; font:inherit; }
button.secondary { background:transparent; color:var(--accent); border:1px solid var(--line); }
.jfa-actions { display:flex; gap:8px; align-items:center; margin-top:16px;
               position:sticky; bottom:0; padding:12px 0; background:var(--bg); }
.jfa-import { padding:8px 14px; border:1px solid var(--line); border-radius:6px; cursor:pointer; }
.jfa-errors { color:var(--err); font-size:12px; padding-left:18px; }
.jfa-hint { color:var(--muted); font-size:12px; }
#status { min-height:20px; font-size:12px; color:var(--accent); }
```

```javascript
// src/ui/options/options.js
import { loadProfile, saveProfile, resetProfile, setDefaultProfile }
  from "../../profile/load.js";
import { resolveProfile } from "../../profile/resolve.js";
import { validateProfile, ROLE_KEYS } from "../../profile/schema.js";
import { renderFormView, readFormView } from "./render-form.js";

const DEFAULT_SETTINGS = {
  apiKey: "",
  fastModel: "gpt-5-mini",
  qualityModel: "gpt-5-mini",
  baseUrl: "https://api.openai.com/v1"
};

let current = null;

const $ = (id) => document.getElementById(id);

function status(msg, isError) {
  const el = $("status");
  el.textContent = msg;
  el.style.color = isError ? "var(--err)" : "var(--accent)";
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 4000);
}

function showTab(name) {
  for (const btn of document.querySelectorAll(".jfa-tabs button")) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  for (const sec of document.querySelectorAll(".jfa-tab")) {
    sec.hidden = sec.id !== `tab-${name}`;
  }
  if (name === "preview") renderPreview();
}

function renderForm() {
  const root = $("formRoot");
  root.textContent = "";
  root.appendChild(renderFormView(current));
}

function renderPreview() {
  const sel = $("previewRole");
  if (!sel.options.length) {
    for (const key of ROLE_KEYS) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = current.roles?.[key]?.label || key;
      sel.appendChild(opt);
    }
  }
  $("previewOut").textContent = JSON.stringify(resolveProfile(current, sel.value), null, 2);
}

function showErrors(errors) {
  const ul = $("jsonErrors");
  ul.textContent = "";
  for (const e of errors) {
    const li = document.createElement("li");
    li.textContent = e.path ? `${e.path}: ${e.message}` : e.message;
    ul.appendChild(li);
  }
}

async function commit(next) {
  const res = await saveProfile(next);
  if (!res.ok) {
    showErrors(res.errors);
    status(`${res.errors.length} validation error(s) — nothing was saved`, true);
    return false;
  }
  showErrors([]);
  current = await loadProfile();
  $("jsonEditor").value = JSON.stringify(current, null, 2);
  renderForm();
  status("Saved");
  return true;
}

async function init() {
  const res = await fetch(chrome.runtime.getURL("profile.json"));
  setDefaultProfile(await res.json());

  current = await loadProfile();
  $("jsonEditor").value = JSON.stringify(current, null, 2);
  renderForm();

  const { settings } = await chrome.storage.local.get(["settings"]);
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  $("apiKey").value = s.apiKey;
  $("fastModel").value = s.fastModel;
  $("qualityModel").value = s.qualityModel;
  $("baseUrl").value = s.baseUrl;

  for (const btn of document.querySelectorAll(".jfa-tabs button")) {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  }
  $("previewRole").addEventListener("change", renderPreview);

  $("saveSettings").addEventListener("click", async () => {
    await chrome.storage.local.set({
      settings: {
        apiKey: $("apiKey").value.trim(),
        fastModel: $("fastModel").value.trim() || DEFAULT_SETTINGS.fastModel,
        qualityModel: $("qualityModel").value.trim() || DEFAULT_SETTINGS.qualityModel,
        baseUrl: $("baseUrl").value.trim() || DEFAULT_SETTINGS.baseUrl
      }
    });
    status("Settings saved");
  });

  $("saveForm").addEventListener("click", () => commit(readFormView($("formRoot"), current)));

  $("saveJson").addEventListener("click", async () => {
    let parsed;
    try {
      parsed = JSON.parse($("jsonEditor").value);
    } catch (e) {
      showErrors([{ path: "", message: `Invalid JSON — ${e.message}` }]);
      status("Invalid JSON — nothing was saved", true);
      return;
    }
    const { valid, errors } = validateProfile(parsed);
    if (!valid) {
      showErrors(errors);
      status(`${errors.length} validation error(s) — nothing was saved`, true);
      return;
    }
    await commit(parsed);
  });

  $("resetProfile").addEventListener("click", async () => {
    current = await resetProfile();
    $("jsonEditor").value = JSON.stringify(current, null, 2);
    renderForm();
    status("Reset to the bundled profile.json");
  });

  $("exportJson").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "profile.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("importJson").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await commit(JSON.parse(await file.text()));
    } catch (err) {
      status(`Import failed — ${err.message}`, true);
    }
    e.target.value = "";
  });
}

init();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/options-render-form.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Delete the v1 options files and commit**

```bash
git rm options.html options.css options.js
git add src/ui/options/ tests/options-render-form.test.js
git commit -m "feat(options): add profile verification UI with form, JSON and preview tabs"
```

---

## Task 6: Port the service worker onto the profile modules

**Files:**
- Create: `src/background.js`
- Delete: `background.js`, `profile-data.js` (repo root, v1)
- Modify: `manifest.json` (point every path at `dist/`, bump version to 2.0.0)
- Test: `tests/background-messages.test.js`

**Interfaces:**
- Consumes: `loadProfile`, `saveProfile`, `setDefaultProfile`; `resolveProfile`.
- Produces: the message handlers `mapFields`, `generateAnswer`, `getProfile`, `saveProfile`, `getSettingsStatus`, each exported as a plain async function from `src/background.js` so they can be tested without the service-worker shell:
  - `handleMapFields({ fields, pageContext, role }) -> { answers }`
  - `handleGenerateAnswer({ question, pageContext, currentValue, role, instruction, length }) -> { value }`
  - `getSettings() -> settings`
- The prompt shape is carried over unchanged from v1 at this stage. Phase 4 restructures it.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/background-messages.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { setDefaultProfile } from "../src/profile/load.js";
import { handleMapFields, handleGenerateAnswer, __setFetch }
  from "../src/background.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));

function okResponse(content) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] })
  };
}

beforeEach(async () => {
  chrome.storage.local.__reset();
  setDefaultProfile(profile);
  await chrome.storage.local.set({
    settings: { apiKey: "sk-test", fastModel: "m-fast",
                qualityModel: "m-quality", baseUrl: "https://api.test/v1" }
  });
});

describe("handleMapFields", () => {
  it("sends only the selected role angle to the model", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse(JSON.stringify({ answers: [{ id: "f1", value: "x", source: "profile" }] })));
    __setFetch(fetchMock);

    await handleMapFields({
      fields: [{ id: "f1", kind: "input", label: "Email" }],
      pageContext: "Acme — Backend Engineer",
      role: "swe"
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const sent = JSON.stringify(body.messages);
    expect(sent).toContain(profile.roles.swe.headline);
    expect(sent).not.toContain(profile.roles.trainer.headline);
    expect(sent).not.toContain(profile.roles.genai.headline);
  });

  it("includes every truth rule verbatim", async () => {
    const fetchMock = vi.fn(async () => okResponse(JSON.stringify({ answers: [] })));
    __setFetch(fetchMock);
    await handleMapFields({ fields: [], pageContext: "p", role: "genai" });
    const sent = JSON.stringify(JSON.parse(fetchMock.mock.calls[0][1].body).messages);
    for (const rule of profile.truthRules) expect(sent).toContain(rule);
  });

  it("throws NO_KEY when the API key is not set", async () => {
    await chrome.storage.local.set({ settings: { apiKey: "" } });
    await expect(handleMapFields({ fields: [], pageContext: "p", role: "genai" }))
      .rejects.toThrow("NO_KEY");
  });
});

describe("handleGenerateAnswer", () => {
  it("returns trimmed plain text", async () => {
    __setFetch(async () => okResponse("  Here is my answer.  "));
    const out = await handleGenerateAnswer({
      question: "Why this role?", pageContext: "p", role: "genai"
    });
    expect(out.value).toBe("Here is my answer.");
  });

  it("passes an extra instruction through to the prompt", async () => {
    const fetchMock = vi.fn(async () => okResponse("ok"));
    __setFetch(fetchMock);
    await handleGenerateAnswer({
      question: "Why this role?", pageContext: "p", role: "genai",
      instruction: "mention LangGraph"
    });
    expect(JSON.stringify(JSON.parse(fetchMock.mock.calls[0][1].body).messages))
      .toContain("mention LangGraph");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/background-messages.test.js`
Expected: FAIL — `src/background.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/background.js` by porting v1 `background.js` with these changes:
- Replace `importScripts("profile-data.js")` with ES imports of the profile modules.
- Replace `JSON.stringify(profile)` in both prompts with `JSON.stringify(resolveProfile(profile, role))`.
- Replace the single `model` setting with `fastModel` (used by `mapFields`) and `qualityModel` (used by `generateAnswer`).
- Add `instruction` and `length` to the `generateAnswer` user message.
- Export `handleMapFields`, `handleGenerateAnswer`, `getSettings`, and `__setFetch` for tests.
- Fetch `profile.json` on install and pass it to `setDefaultProfile`.

```javascript
// src/background.js
import { loadProfile, saveProfile, setDefaultProfile } from "./profile/load.js";
import { resolveProfile } from "./profile/resolve.js";

export const DEFAULT_SETTINGS = {
  apiKey: "",
  fastModel: "gpt-5-mini",
  qualityModel: "gpt-5-mini",
  baseUrl: "https://api.openai.com/v1"
};

let _fetch = (...a) => fetch(...a);
export function __setFetch(fn) { _fetch = fn; }

async function bootstrapDefault() {
  const res = await _fetch(chrome.runtime.getURL("profile.json"));
  setDefaultProfile(await res.json());
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export const SHARED_RULES = `
HARD RULES (violating any of these is a failure):
- Answer ONLY from the profile. Never invent employers, degrees, certifications, permits, or experience.
- Follow every entry in truthRules exactly.
- Work authorization: job in India => eligible "Yes", needs sponsorship "No". Job outside India => needs sponsorship "Yes".
- Dates for <input type="date">: use YYYY-MM-DD. Other date fields: match the format the field's placeholder/label suggests, else MM/YYYY.
- Salary questions: use jobPreferences.
- For select/radio/checkbox fields, the value MUST be copied verbatim from the provided options list.
- If a field cannot be answered truthfully from the profile and is not a generic motivational/essay question, skip it.`;

function parseJson(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned);
}

async function callModel(settings, model, messages, jsonMode, maxTokens) {
  const body = { model, messages };
  if (jsonMode) body.response_format = { type: "json_object" };
  if (maxTokens) body.max_completion_tokens = maxTokens;

  const res = await _fetch(`${settings.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function handleMapFields({ fields, pageContext, role }) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("NO_KEY");
  const resolved = resolveProfile(await loadProfile(), role);

  const system = `You fill job application forms for the candidate whose profile is below. Return STRICT JSON only.

PROFILE:
${JSON.stringify(resolved)}
${SHARED_RULES}

Target role angle: ${resolved.roleLabel}. Emphasis: ${resolved.emphasis}

For each field decide:
- "value": the string to fill ("" if skipping). For checkboxes: "true" or "false".
- Fields with kind "widget" are custom dropdowns whose options are hidden until clicked: answer with the exact short option text a typical form would offer (e.g. "No", "Yes", "India", "Male", "1 month"). Prefer the shortest standard phrasing.
- "source": "profile", "generated", or "skipped".
Essay/textarea answers: first person, specific to the profile, 40-120 words unless the label asks otherwise.

Return JSON: {"answers":[{"id":"<field id>","value":"...","source":"profile|generated|skipped"}]}`;

  const user = `Page: ${pageContext}\n\nFields (JSON):\n${JSON.stringify(fields)}`;

  const content = await callModel(settings, settings.fastModel,
    [{ role: "system", content: system }, { role: "user", content: user }], true, 1500);

  const parsed = parseJson(content);
  if (!Array.isArray(parsed.answers)) throw new Error("Bad response shape");
  return { answers: parsed.answers };
}

const LENGTH_TARGETS = { shorter: "25-60 words", normal: "40-150 words", longer: "150-250 words" };
const LENGTH_CAPS = { shorter: 250, normal: 400, longer: 700 };

export async function handleGenerateAnswer({ question, pageContext, currentValue, role, instruction, length }) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("NO_KEY");
  const resolved = resolveProfile(await loadProfile(), role);
  const lengthKey = LENGTH_TARGETS[length] ? length : "normal";

  const system = `You write one answer for one job-application question, as the candidate whose profile is below. Plain text only — no markdown, no surrounding quotes.

PROFILE:
${JSON.stringify(resolved)}
${SHARED_RULES}

Target role angle: ${resolved.roleLabel}. Emphasis: ${resolved.emphasis}
Style: first person, specific, grounded in real profile facts, professional but human. ${LENGTH_TARGETS[lengthKey]} unless the question implies shorter (a number, a URL, a yes/no).`;

  const user = `Page: ${pageContext}
Question / field label: ${question}
${currentValue ? `Current draft in the field (improve or replace): ${currentValue}` : ""}
${instruction ? `Extra instruction from the candidate: ${instruction}` : ""}
Write the answer text only.`;

  const value = await callModel(settings, settings.qualityModel,
    [{ role: "system", content: system }, { role: "user", content: user }],
    false, LENGTH_CAPS[lengthKey]);

  return { value: value.trim() };
}

chrome.runtime.onInstalled.addListener(async () => {
  await bootstrapDefault();
  const stored = await chrome.storage.local.get(["profile", "settings"]);
  if (!stored.profile) await saveProfile(await loadProfile());
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      await bootstrapDefault();
      if (msg.action === "mapFields") {
        sendResponse({ ok: true, ...(await handleMapFields(msg)) });
      } else if (msg.action === "generateAnswer") {
        sendResponse({ ok: true, ...(await handleGenerateAnswer(msg)) });
      } else if (msg.action === "getProfile") {
        sendResponse({ ok: true, profile: await loadProfile() });
      } else if (msg.action === "saveProfile") {
        sendResponse({ ok: true, ...(await saveProfile(msg.profile)) });
      } else if (msg.action === "getSettingsStatus") {
        const s = await getSettings();
        sendResponse({ ok: true, hasKey: !!s.apiKey });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message === "NO_KEY" ? "NO_KEY" : String(e.message || e) });
    }
  })();
  return true;
});
```

```json
// manifest.json
{
  "manifest_version": 3,
  "name": "JobFill AI",
  "version": "2.0.0",
  "description": "Autofills job application forms from your profile.json using AI, with per-field regeneration and an application tracker. Never submits — you review.",
  "permissions": ["storage", "activeTab", "webNavigation"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html", "default_title": "JobFill AI" },
  "options_page": "options.html",
  "web_accessible_resources": [
    { "resources": ["profile.json"], "matches": ["<all_urls>"] }
  ],
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle",
      "all_frames": true
    }
  ]
}
```

`manifest.json` lives at the repo root and is copied into `dist/` by `build.mjs`, so its paths are relative to `dist/`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/background-messages.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git rm background.js profile-data.js
git add src/background.js manifest.json tests/background-messages.test.js
git commit -m "refactor(worker): port service worker onto profile.json modules and model slots"
```

---

# Phase 2 — Scanning, filling, and the tooltip

## Task 7: Extract and test field scanning

**Files:**
- Create: `src/scan/labels.js`, `src/scan/fields.js`, `src/scan/widgets.js`, `src/scan/context.js`
- Create: `tests/fixtures/plain.html`, `tests/fixtures/greenhouse.html`, `tests/fixtures/workday.html`
- Test: `tests/scan.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `labelFor(el) -> string` — never throws; returns `""` when nothing is found.
  - `scanFields(doc) -> { fields: Field[], radioGroups: Map<string, HTMLElement[]> }` where `Field = { id, kind, label, options?, placeholder?, currentValue?, inputType?, groupKey? }` and `kind ∈ { input, textarea, select, checkbox, radio, widget }`.
  - `scanWidgets(doc, startSeq) -> Field[]`.
  - `pageContext(doc, url) -> { company, jobTitle, text }`.

> **Review Focus #2 is covered here:** an unlabelled field must be emitted with `label: ""`, not skipped and not thrown on.

Port the logic from the v1 `content.js` lines 22–140 (`textOf`, `labelFor`, `visible`, `WIDGET_SELECTOR`, `scanFields`, `groupLabel`, `radioOptionLabel`) into these modules, changing only:
- take `doc` as a parameter instead of using the global `document`;
- `export` each function;
- in `scanWidgets`, emit the field with `label: ""` instead of `continue` when no label is found.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/scan.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { labelFor } from "../src/scan/labels.js";
import { scanFields } from "../src/scan/fields.js";
import { pageContext } from "../src/scan/context.js";

function load(name) {
  return new JSDOM(readFileSync(`tests/fixtures/${name}`, "utf8"),
    { url: "https://jobs.acme.com/apply/123" }).window.document;
}

describe("labelFor", () => {
  const doc = load("plain.html");

  it("uses an explicit label[for]", () => {
    expect(labelFor(doc.getElementById("email"))).toBe("Email address");
  });

  it("falls back to aria-label", () => {
    expect(labelFor(doc.getElementById("phone"))).toBe("Phone number");
  });

  it("falls back to the placeholder", () => {
    expect(labelFor(doc.getElementById("linkedin"))).toBe("LinkedIn URL");
  });

  // Review Focus #2
  it("returns an empty string for a field with nothing to go on", () => {
    expect(labelFor(doc.getElementById("bare"))).toBe("");
  });
});

describe("scanFields", () => {
  it("finds inputs, textareas, selects and checkboxes", () => {
    const { fields } = scanFields(load("plain.html"));
    const kinds = fields.map((f) => f.kind);
    expect(kinds).toContain("input");
    expect(kinds).toContain("textarea");
    expect(kinds).toContain("select");
    expect(kinds).toContain("checkbox");
  });

  it("collapses a radio group into one field carrying its options", () => {
    const { fields } = scanFields(load("plain.html"));
    const radio = fields.find((f) => f.kind === "radio");
    expect(radio).toBeTruthy();
    expect(radio.options).toEqual(["Yes", "No"]);
  });

  it("captures select options verbatim", () => {
    const { fields } = scanFields(load("plain.html"));
    const sel = fields.find((f) => f.kind === "select");
    expect(sel.options).toContain("India");
  });

  it("skips hidden, disabled, password and file inputs", () => {
    const { fields } = scanFields(load("plain.html"));
    const labels = fields.map((f) => f.label).join(" ");
    expect(labels).not.toContain("Secret");
    expect(labels).not.toContain("Resume file");
    expect(labels).not.toContain("Disabled field");
  });

  it("ignores the extension's own UI", () => {
    const doc = load("plain.html");
    const ui = doc.createElement("input");
    ui.setAttribute("data-jobfill-ui", "1");
    ui.id = "jfa-own";
    doc.body.appendChild(ui);
    const { fields } = scanFields(doc);
    expect(fields.some((f) => f.id === "jfa-own")).toBe(false);
  });

  it("emits an unlabelled field rather than dropping it", () => {
    const { fields } = scanFields(load("plain.html"));
    const bare = fields.find((f) => f.label === "");
    expect(bare).toBeTruthy();
  });

  it("gives every field a unique id", () => {
    const { fields } = scanFields(load("greenhouse.html"));
    expect(new Set(fields.map((f) => f.id)).size).toBe(fields.length);
  });

  it("detects Workday-style listbox widgets", () => {
    const { fields } = scanFields(load("workday.html"));
    const widget = fields.find((f) => f.kind === "widget");
    expect(widget).toBeTruthy();
    expect(widget.label).toContain("Country");
  });
});

describe("pageContext", () => {
  it("reads company and title from JSON-LD when present", () => {
    const doc = load("greenhouse.html");
    const ctx = pageContext(doc, "https://jobs.acme.com/apply/123");
    expect(ctx.company).toBe("Acme Corp");
    expect(ctx.jobTitle).toBe("Senior Backend Engineer");
  });

  it("falls back to the hostname when there is no metadata", () => {
    const doc = load("plain.html");
    expect(pageContext(doc, "https://jobs.acme.com/apply/123").company).toBe("acme");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scan.test.js`
Expected: FAIL — fixtures and `src/scan/*` do not exist.

- [ ] **Step 3: Write the fixtures and the modules**

`tests/fixtures/plain.html` must contain, inside a `<form>`: `label[for=email]` reading "Email address"; `input#phone[aria-label="Phone number"]`; `input#linkedin[placeholder="LinkedIn URL"]`; `input#bare` with no label, placeholder, name or id-derived text (give it `id="bare"` only and ensure `labelFor` cannot find text — wrap it in a `div` containing no text nodes); a `textarea` labelled "Why do you want this role?"; a `select#country` whose options include `India`; a checkbox labelled "I agree"; a radio group named `sponsorship` with options `Yes` and `No` under a `<legend>Do you require sponsorship?</legend>`; plus `input[type=hidden]`, `input[type=password]` labelled "Secret", `input[type=file]` labelled "Resume file", and a disabled input labelled "Disabled field".

`tests/fixtures/greenhouse.html` must contain a `<script type="application/ld+json">` block with `{"@type":"JobPosting","title":"Senior Backend Engineer","hiringOrganization":{"name":"Acme Corp"}}`, plus at least six labelled inputs using `aria-describedby` for their labels.

`tests/fixtures/workday.html` must contain a `button[aria-haspopup="listbox"][data-automation-id="countrySelect"]` preceded by a sibling `<label>Country</label>`, and a `ul[role="listbox"]` (initially `hidden`) containing `li[role="option"]` entries `India`, `United States`, `Germany`.

Then create the four modules by porting from v1 `content.js` as described in the Interfaces block above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scan.test.js`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/scan/ tests/fixtures/ tests/scan.test.js
git commit -m "feat(scan): extract field, widget and context scanning into tested modules"
```

---

## Task 8: Extract and test the fill engine

**Files:**
- Create: `src/fill/native.js`, `src/fill/apply.js`, `src/fill/widgets.js`
- Test: `tests/fill.test.js`

**Interfaces:**
- Consumes: `scanFields` from `src/scan/fields.js`.
- Produces:
  - `setNativeValue(el, value)` — uses the native property setter so React's `onChange` fires, then dispatches `input` and `change` with `bubbles: true`.
  - `applyAnswer(el, answer, radioGroups) -> boolean` — returns whether anything changed.
  - `applyWidgetAnswer(el, value, { waitFor }) -> Promise<boolean>` — opens the widget, waits for a `[role="listbox"]`, matches an option, clicks it.
  - `matchOption(optionTexts, wanted) -> number` — index of the best match, or `-1`. Exact case-insensitive match wins, then `startsWith`, then `includes`.

Port `setNativeValue` and the widget open/match/click sequence from v1 `content.js` lines 140–277, changing only: take the document from the element (`el.ownerDocument`), accept an injectable `waitFor` so tests need no real timers, and `export` each function.

- [ ] **Step 1: Write the failing test**

```javascript
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
    expect(doc.querySelector('input[name="sponsorship"][value="No"]').checked).toBe(true);
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
    const ok = await applyWidgetAnswer(btn, "Atlantis", { waitFor: async (fn) => fn() });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fill.test.js`
Expected: FAIL — `src/fill/*` does not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/fill/native.js
export function setNativeValue(el, value) {
  const proto = el instanceof el.ownerDocument.defaultView.HTMLTextAreaElement
    ? el.ownerDocument.defaultView.HTMLTextAreaElement.prototype
    : el.ownerDocument.defaultView.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new el.ownerDocument.defaultView.Event("input", { bubbles: true }));
  el.dispatchEvent(new el.ownerDocument.defaultView.Event("change", { bubbles: true }));
}
```

```javascript
// src/fill/apply.js
import { setNativeValue } from "./native.js";

export function matchOption(optionTexts, wanted) {
  const w = String(wanted || "").trim().toLowerCase();
  if (!w) return -1;
  const norm = optionTexts.map((t) => String(t).trim().toLowerCase());
  let i = norm.indexOf(w);
  if (i !== -1) return i;
  i = norm.findIndex((t) => t.startsWith(w) || w.startsWith(t));
  if (i !== -1) return i;
  return norm.findIndex((t) => t.includes(w) || w.includes(t));
}

export function applyAnswer(el, answer, radioElements) {
  const value = String(answer?.value ?? "").trim();
  if (!value) return false;

  if (radioElements?.length) {
    const texts = radioElements.map((r) =>
      r.value || r.closest("label")?.textContent?.trim() || "");
    const i = matchOption(texts, value);
    if (i === -1) return false;
    radioElements[i].checked = true;
    radioElements[i].dispatchEvent(
      new radioElements[i].ownerDocument.defaultView.Event("change", { bubbles: true }));
    return true;
  }

  if (!el) return false;
  const win = el.ownerDocument.defaultView;

  if (el.tagName === "SELECT") {
    const texts = Array.from(el.options).map((o) => o.text);
    const i = matchOption(texts, value);
    if (i === -1) return false;
    el.selectedIndex = i;
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    return true;
  }

  if (el.type === "checkbox") {
    const next = value.toLowerCase() === "true" || value.toLowerCase() === "yes";
    if (el.checked === next) return false;
    el.checked = next;
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    return true;
  }

  setNativeValue(el, value);
  return true;
}
```

```javascript
// src/fill/widgets.js
import { matchOption } from "./apply.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function defaultWaitFor(fn, timeout = 2500, interval = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(interval);
  }
  return null;
}

function visibleListbox(doc) {
  for (const list of doc.querySelectorAll('[role="listbox"]')) {
    if (!list.hidden && list.querySelector('[role="option"]')) return list;
  }
  return null;
}

export async function applyWidgetAnswer(el, value, { waitFor = defaultWaitFor } = {}) {
  const doc = el.ownerDocument;
  const win = doc.defaultView;

  el.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
  el.click();

  const list = await waitFor(() => visibleListbox(doc));
  if (!list) return false;

  const options = Array.from(list.querySelectorAll('[role="option"]'));
  const i = matchOption(options.map((o) => o.textContent.trim()), value);
  if (i === -1) {
    el.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }

  options[i].dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
  options[i].click();
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fill.test.js`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fill/ tests/fill.test.js
git commit -m "feat(fill): extract React-safe fill engine and widget selection into tested modules"
```

---

## Task 9: The tooltip component

**Files:**
- Create: `src/ui/tooltip/tooltip.js`, `src/ui/tooltip/tooltip.css.js`
- Test: `tests/tooltip.test.js`

**Interfaces:**
- Consumes: nothing (pure DOM; the caller supplies callbacks).
- Produces: `createTooltip({ onGenerate, onInsert, onCancel }) -> controller` where `controller` exposes:
  - `open(anchorEl, { roleKey, roleLabels })` — mounts beside the anchor and calls `onGenerate({ length: "normal", instruction: "", bypassCache: false, roleKey })`.
  - `setText(text, { cached })`, `setError(message)`, `setLoading(bool)`, `close()`, `isOpen()`, `host` (the shadow host element).
  - The host element carries `data-jobfill-ui="1"`.
  - `position(anchorRect, viewport) -> { top, left, flipped }` is exported separately so placement is testable.

- [ ] **Step 1: Write the failing test**

```javascript
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

describe("createTooltip", () => {
  it("calls onGenerate once when opened", () => {
    const onGenerate = vi.fn();
    const t = createTooltip({ onGenerate, onInsert: vi.fn(), onCancel: vi.fn() });
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0][0]).toMatchObject({
      length: "normal", instruction: "", bypassCache: false, roleKey: "genai"
    });
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
    t.open(anchor(), { roleKey: "genai", roleLabels: ROLE_LABELS });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(t.isOpen()).toBe(false);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tooltip.test.js`
Expected: FAIL — `src/ui/tooltip/tooltip.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/ui/tooltip/tooltip.css.js
export const TOOLTIP_CSS = `
:host { all: initial; }
.box {
  position: fixed; width: 360px; max-width: calc(100vw - 16px);
  font: 13px/1.45 system-ui, sans-serif; color: #1a1a1a; background: #fff;
  border: 1px solid #d8d8d8; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18); z-index: 2147483647;
  display: flex; flex-direction: column; overflow: hidden;
}
@media (prefers-color-scheme: dark) {
  .box { color: #e8e8e8; background: #1d1f24; border-color: #343841; }
  select, textarea, input, button.ghost { color: #e8e8e8; background: #14161a; border-color: #343841; }
}
.row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
.row.head { border-bottom: 1px solid #ececec; }
.row.foot { border-top: 1px solid #ececec; justify-content: flex-end; }
.badge { margin-left: auto; font-size: 11px; color: #2f855a; }
textarea[data-part="text"] { border: 0; outline: none; resize: vertical; min-height: 120px;
  padding: 10px; font: inherit; background: transparent; color: inherit; }
input[data-part="instruction"] { flex: 1; padding: 5px 7px; border: 1px solid #ddd;
  border-radius: 5px; font: inherit; background: transparent; color: inherit; }
button { font: inherit; border-radius: 6px; cursor: pointer; padding: 5px 9px; }
button.ghost { background: transparent; border: 1px solid #ddd; }
button.primary { background: #2b6cb0; color: #fff; border: 0; padding: 6px 14px; }
button:disabled { opacity: .5; cursor: default; }
select { font: inherit; border: 1px solid #ddd; border-radius: 5px; padding: 3px 5px;
  background: transparent; color: inherit; }
.error { color: #c53030; font-size: 12px; padding: 0 10px 8px; }
.error:empty { display: none; }
.loading textarea { opacity: .45; }
`;
```

```javascript
// src/ui/tooltip/tooltip.js
import { TOOLTIP_CSS } from "./tooltip.css.js";

const WIDTH = 360;
const GAP = 6;
const MARGIN = 8;

export function position(rect, viewport, boxHeight) {
  const below = viewport.height - rect.bottom;
  const flipped = below < boxHeight + GAP && rect.top > below;
  const top = flipped
    ? Math.max(MARGIN, rect.top - boxHeight - GAP)
    : rect.bottom + GAP;
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

  function close() {
    if (!open) return;
    open = false;
    host.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("scroll", place, true);
    window.removeEventListener("resize", place);
    anchorEl = null;
    onCancel?.();
  }

  function onKey(e) { if (e.key === "Escape") close(); }
  function onOutside(e) { if (open && !host.contains(e.target) && e.target !== anchorEl) close(); }

  q("regenerate").addEventListener("click", () => generate({ bypassCache: true }));
  q("shorter").addEventListener("click", () => generate({ length: "shorter", bypassCache: true }));
  q("longer").addEventListener("click", () => generate({ length: "longer", bypassCache: true }));
  q("role").addEventListener("change", () => generate({ bypassCache: true }));
  q("cancel").addEventListener("click", close);
  q("insert").addEventListener("click", () => {
    onInsert(q("text").value);
    open = false;
    host.remove();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
    anchorEl = null;
  });

  return {
    host,
    isOpen: () => open,
    close,
    open(el, { roleKey, roleLabels }) {
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
      document.documentElement.appendChild(host);
      open = true;
      place();
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("mousedown", onOutside, true);
      window.addEventListener("scroll", place, true);
      window.addEventListener("resize", place);
      generate({});
    },
    setLoading(on) {
      box.classList.toggle("loading", !!on);
      for (const p of ["regenerate", "shorter", "longer", "insert"]) q(p).disabled = !!on;
    },
    setText(text, { cached } = {}) {
      q("text").value = text;
      q("error").textContent = "";
      q("cached").hidden = !cached;
      place();
    },
    setError(message) {
      q("error").textContent = message;
      place();
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tooltip.test.js`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/tooltip/ tests/tooltip.test.js
git commit -m "feat(tooltip): add shadow-DOM field popover with preview before insert"
```

---

## Task 10: Wire the content script to scan, fill and the tooltip

**Files:**
- Create: `src/content.js`, `src/content.css`
- Delete: `content.js`, `content.css` (repo root, v1)
- Test: `tests/content-wiring.test.js`

**Interfaces:**
- Consumes: `scanFields`, `pageContext`, `applyAnswer`, `applyWidgetAnswer`, `createTooltip`.
- Produces: exported `fillPage({ sendMessage, doc, roleKey }) -> { scanned, filled, errors }` so the fill loop is testable without a browser. The `✨` icon lifecycle stays in the IIFE body.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/content-wiring.test.js
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fillPage } from "../src/content.js";

function load(name) {
  return new JSDOM(readFileSync(`tests/fixtures/${name}`, "utf8"),
    { url: "https://jobs.acme.com/apply/123" }).window.document;
}

describe("fillPage", () => {
  it("sends every scanned field to the worker and reports the count", async () => {
    const doc = load("plain.html");
    const sendMessage = vi.fn(async (msg) => ({
      ok: true,
      answers: msg.fields.map((f) => ({ id: f.id, value: "", source: "skipped" }))
    }));
    const out = await fillPage({ sendMessage, doc, roleKey: "swe" });
    expect(sendMessage.mock.calls[0][0].action).toBe("mapFields");
    expect(sendMessage.mock.calls[0][0].role).toBe("swe");
    expect(out.scanned).toBe(sendMessage.mock.calls[0][0].fields.length);
    expect(out.scanned).toBeGreaterThan(0);
  });

  it("applies returned answers to the page", async () => {
    const doc = load("plain.html");
    const sendMessage = async (msg) => ({
      ok: true,
      answers: msg.fields.map((f) => ({
        id: f.id,
        value: f.label === "Email address" ? "naved@example.com" : "",
        source: "profile"
      }))
    });
    const out = await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(doc.getElementById("email").value).toBe("naved@example.com");
    expect(out.filled).toBe(1);
  });

  it("returns the worker error instead of throwing", async () => {
    const doc = load("plain.html");
    const sendMessage = async () => ({ ok: false, error: "NO_KEY" });
    const out = await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(out.errors).toContain("NO_KEY");
    expect(out.filled).toBe(0);
  });

  it("skips answers whose field id no longer exists", async () => {
    const doc = load("plain.html");
    const sendMessage = async () => ({
      ok: true,
      answers: [{ id: "jfa-does-not-exist", value: "x", source: "profile" }]
    });
    const out = await fillPage({ sendMessage, doc, roleKey: "genai" });
    expect(out.filled).toBe(0);
    expect(out.errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/content-wiring.test.js`
Expected: FAIL — `src/content.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

`src/content.js` exports `fillPage` and, when running inside a real page, mounts the `✨` icon. Port the icon lifecycle from v1 `content.js` lines 278–356 unchanged except that the click handler now opens the tooltip rather than filling the field directly:

```javascript
// src/content.js  (structure; the icon block is ported from v1 lines 278-356)
import { scanFields } from "./scan/fields.js";
import { pageContext } from "./scan/context.js";
import { applyAnswer } from "./fill/apply.js";
import { applyWidgetAnswer } from "./fill/widgets.js";
import { createTooltip } from "./ui/tooltip/tooltip.js";

export async function fillPage({ sendMessage, doc, roleKey }) {
  const { fields, radioGroups } = scanFields(doc);
  const ctx = pageContext(doc, doc.defaultView?.location?.href || "");
  const errors = [];
  let filled = 0;

  if (!fields.length) return { scanned: 0, filled: 0, errors };

  const res = await sendMessage({
    action: "mapFields",
    fields,
    pageContext: `${ctx.company} — ${ctx.jobTitle}`,
    role: roleKey
  });

  if (!res?.ok) {
    errors.push(res?.error || "unknown error");
    return { scanned: fields.length, filled: 0, errors };
  }

  for (const answer of res.answers) {
    const field = fields.find((f) => f.id === answer.id);
    if (!field) continue;
    try {
      if (field.kind === "radio") {
        if (applyAnswer(null, answer, radioGroups.get(field.groupKey))) filled++;
      } else {
        const el = doc.querySelector(`[data-jfa-id="${answer.id}"]`);
        if (!el) continue;
        const ok = field.kind === "widget"
          ? await applyWidgetAnswer(el, answer.value)
          : applyAnswer(el, answer);
        if (ok) filled++;
      }
    } catch (e) {
      errors.push(`${field.label}: ${e.message}`);
    }
  }

  return { scanned: fields.length, filled, errors };
}
```

The IIFE at the bottom of the file guards on `typeof window !== "undefined" && window.chrome?.runtime?.id`, sets `window.__jobfillLoaded`, mounts the `✨` icon, and wires:
- `chrome.runtime.onMessage` for `{ action: "fill", roleKey }` → `fillPage({ sendMessage: chrome.runtime.sendMessage, doc: document, roleKey })`;
- icon click → `tooltip.open(target, { roleKey, roleLabels })`;
- `onGenerate` → `chrome.runtime.sendMessage({ action: "generateAnswer", question, pageContext, currentValue, role: roleKey, instruction, length, bypassCache })` → `tooltip.setText(value, { cached })` or `tooltip.setError(error)`.
  ⚠️ **The tooltip emits `roleKey`; the worker expects `role`.** Map it at this boundary — it is the one name mismatch in the codebase and it fails silently (the worker falls back to `genai`) if missed;
- `onInsert` → `applyAnswer(target, { value })`.

Move the v1 `content.css` to `src/content.css` unchanged; it styles only the `✨` icon, since the tooltip carries its own shadow styles.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — the whole suite, including 4 new tests.

- [ ] **Step 5: Commit**

```bash
git rm content.js content.css
git add src/content.js src/content.css tests/content-wiring.test.js
git commit -m "feat(content): wire scanning, filling and the tooltip into the content script"
```

---

# Phase 3 — Application tracking

## Task 11: The application store

**Files:**
- Create: `src/track/store.js`
- Test: `tests/track-store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `APPLICATION_STATES = ["Applied","Call or Mail","Process Started","Rejected","On Hold"]`
  - `addApplication(record) -> Promise<{ ok, id, duplicateOf? }>` — rejects a duplicate `jobUrl` with `{ ok:false, duplicateOf:<id> }` unless `record.force === true`.
  - `listApplications(filter?) -> Promise<Record[]>` — newest first, `sno` assigned at read time starting at 1 for the oldest.
  - `updateApplication(id, patch) -> Promise<{ ok }>` — refreshes `updatedAt`; rejects an invalid `state`.
  - `deleteApplication(id) -> Promise<{ ok }>`
  - `normalizeUrl(url) -> string` — strips the hash and `utm_*`, `gh_src`, `src`, `ref` params.

> **Review Focus #5 is covered here.**

- [ ] **Step 1: Write the failing test**

```javascript
// tests/track-store.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { addApplication, listApplications, updateApplication,
         deleteApplication, normalizeUrl, APPLICATION_STATES }
  from "../src/track/store.js";

const base = {
  company: "Acme", jobTitle: "Backend Engineer", appliedAt: "2026-10-10",
  state: "Applied", domain: "acme.com",
  jobUrl: "https://jobs.acme.com/apply/1", roleFamily: "swe"
};

beforeEach(() => chrome.storage.local.__reset());

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/track-store.test.js`
Expected: FAIL — `src/track/store.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/track/store.js
const KEY = "applications";
const STRIP = ["utm_source", "utm_medium", "utm_campaign", "utm_term",
               "utm_content", "gh_src", "src", "ref"];

export const APPLICATION_STATES =
  ["Applied", "Call or Mail", "Process Started", "Rejected", "On Hold"];

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const p of STRIP) u.searchParams.delete(p);
    const qs = u.searchParams.toString();
    return `${u.origin}${u.pathname}${qs ? `?${qs}` : ""}`;
  } catch {
    return url;
  }
}

async function readAll() {
  const got = await chrome.storage.local.get([KEY]);
  return Array.isArray(got[KEY]) ? got[KEY] : [];
}

async function writeAll(rows) {
  await chrome.storage.local.set({ [KEY]: rows });
}

function newId() {
  return `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function addApplication(record) {
  const rows = await readAll();
  const url = normalizeUrl(record.jobUrl || "");

  if (!record.force && url) {
    const existing = rows.find((r) => normalizeUrl(r.jobUrl || "") === url);
    if (existing) return { ok: false, duplicateOf: existing.id };
  }

  const now = new Date();
  const row = {
    id: newId(),
    company: record.company || "",
    jobTitle: record.jobTitle || "",
    appliedAt: record.appliedAt || now.toISOString().slice(0, 10),
    state: APPLICATION_STATES.includes(record.state) ? record.state : "Applied",
    domain: record.domain || "",
    jobUrl: record.jobUrl || "",
    roleFamily: record.roleFamily || "",
    outcomeReason: record.outcomeReason || "",
    notes: record.notes || "",
    updatedAt: now.toISOString()
  };

  rows.push(row);
  await writeAll(rows);
  return { ok: true, id: row.id };
}

export async function listApplications(filter = {}) {
  const rows = await readAll();
  const ordered = [...rows].sort((a, b) =>
    a.appliedAt === b.appliedAt
      ? String(a.updatedAt).localeCompare(String(b.updatedAt))
      : String(a.appliedAt).localeCompare(String(b.appliedAt)));

  const numbered = ordered.map((r, i) => ({ ...r, sno: i + 1 })).reverse();

  return numbered.filter((r) => {
    if (filter.state && r.state !== filter.state) return false;
    if (filter.roleFamily && r.roleFamily !== filter.roleFamily) return false;
    if (filter.from && r.appliedAt < filter.from) return false;
    if (filter.to && r.appliedAt > filter.to) return false;
    if (filter.search &&
        !r.company.toLowerCase().includes(filter.search.toLowerCase())) return false;
    return true;
  });
}

export async function updateApplication(id, patch) {
  if (patch.state && !APPLICATION_STATES.includes(patch.state)) {
    return { ok: false, error: `unknown state: ${patch.state}` };
  }
  const rows = await readAll();
  const i = rows.findIndex((r) => r.id === id);
  if (i === -1) return { ok: false, error: "not found" };
  rows[i] = { ...rows[i], ...patch, id, updatedAt: new Date().toISOString() };
  await writeAll(rows);
  return { ok: true };
}

export async function deleteApplication(id) {
  const rows = await readAll();
  await writeAll(rows.filter((r) => r.id !== id));
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/track-store.test.js`
Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/track/store.js tests/track-store.test.js
git commit -m "feat(track): add application store with duplicate-url protection"
```

---

## Task 12: Page capture and export

**Files:**
- Create: `src/track/capture.js`, `src/track/export.js`
- Test: `tests/track-capture.test.js`, `tests/track-export.test.js`

**Interfaces:**
- Consumes: `normalizeUrl` from `src/track/store.js`.
- Produces:
  - `captureApplication(doc, url, roleKey) -> { company, jobTitle, appliedAt, domain, jobUrl, roleFamily, state }`
  - `toCsv(rows) -> string` — header row, RFC-4180 quoting.
  - `toJson(rows) -> string` — pretty-printed, `sno` excluded.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/track-capture.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { captureApplication } from "../src/track/capture.js";

function load(name, url) {
  return new JSDOM(readFileSync(`tests/fixtures/${name}`, "utf8"), { url }).window.document;
}

describe("captureApplication", () => {
  it("prefers JSON-LD for company and title", () => {
    const doc = load("greenhouse.html", "https://boards.greenhouse.io/acme/jobs/1");
    const c = captureApplication(doc, "https://boards.greenhouse.io/acme/jobs/1", "swe");
    expect(c.company).toBe("Acme Corp");
    expect(c.jobTitle).toBe("Senior Backend Engineer");
  });

  it("falls back to the hostname for company", () => {
    const doc = load("plain.html", "https://careers.swiggy.com/apply/9");
    expect(captureApplication(doc, "https://careers.swiggy.com/apply/9", "swe").company)
      .toBe("swiggy");
  });

  it("records the domain without www", () => {
    const doc = load("plain.html", "https://www.phonepe.com/jobs/1");
    expect(captureApplication(doc, "https://www.phonepe.com/jobs/1", "swe").domain)
      .toBe("phonepe.com");
  });

  it("strips tracking params from the stored url", () => {
    const doc = load("plain.html", "https://a.com/j/1?utm_source=li");
    expect(captureApplication(doc, "https://a.com/j/1?utm_source=li", "swe").jobUrl)
      .toBe("https://a.com/j/1");
  });

  it("stamps today and the selected role", () => {
    const doc = load("plain.html", "https://a.com/j/1");
    const c = captureApplication(doc, "https://a.com/j/1", "trainer");
    expect(c.roleFamily).toBe("trainer");
    expect(c.appliedAt).toBe(new Date().toISOString().slice(0, 10));
    expect(c.state).toBe("Applied");
  });
});
```

```javascript
// tests/track-export.test.js
import { describe, it, expect } from "vitest";
import { toCsv, toJson } from "../src/track/export.js";

const rows = [
  { sno: 1, company: "Acme", jobTitle: "Backend Engineer", appliedAt: "2026-10-10",
    state: "Applied", domain: "acme.com", jobUrl: "https://a.com/1",
    roleFamily: "swe", outcomeReason: "", notes: "" },
  { sno: 2, company: 'Big "Quoted" Co', jobTitle: "Eng, Senior", appliedAt: "2026-10-11",
    state: "Rejected", domain: "big.com", jobUrl: "https://b.com/2",
    roleFamily: "genai", outcomeReason: "Line one\nLine two", notes: "" }
];

describe("toCsv", () => {
  const csv = toCsv(rows);
  const lines = csv.split("\n");

  it("starts with a header row", () => {
    expect(lines[0]).toContain("Company");
    expect(lines[0]).toContain("Job URL");
  });

  it("escapes embedded quotes by doubling them", () => {
    expect(csv).toContain('"Big ""Quoted"" Co"');
  });

  it("quotes values containing a comma", () => {
    expect(csv).toContain('"Eng, Senior"');
  });

  it("quotes values containing a newline", () => {
    expect(csv).toContain('"Line one\nLine two"');
  });

  it("writes one data row per record", () => {
    expect(csv.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(3);
  });
});

describe("toJson", () => {
  it("omits the derived sno", () => {
    expect(JSON.parse(toJson(rows))[0].sno).toBeUndefined();
  });
  it("keeps every stored field", () => {
    expect(JSON.parse(toJson(rows))[0].company).toBe("Acme");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/track-capture.test.js tests/track-export.test.js`
Expected: FAIL — `src/track/capture.js` and `src/track/export.js` do not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/track/capture.js
import { normalizeUrl } from "./store.js";

function jsonLd(doc) {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const list = Array.isArray(data) ? data : [data];
      const posting = list.find((d) => d["@type"] === "JobPosting");
      if (posting) return posting;
    } catch { /* malformed JSON-LD is common; ignore it */ }
  }
  return null;
}

function hostCompany(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    const known = new Set(["com", "co", "in", "io", "org", "net", "ai", "dev"]);
    const meaningful = parts.filter((p) => !known.has(p));
    const generic = new Set(["jobs", "careers", "boards", "apply", "job", "hire", "my"]);
    const picked = meaningful.filter((p) => !generic.has(p));
    return (picked[picked.length - 1] || meaningful[0] || host);
  } catch {
    return "";
  }
}

export function captureApplication(doc, url, roleKey) {
  const ld = jsonLd(doc);
  const og = doc.querySelector('meta[property="og:site_name"]')?.content;
  const h1 = doc.querySelector("h1")?.textContent?.trim();

  let domain = "";
  try { domain = new URL(url).hostname.replace(/^www\./, ""); } catch { /* not a url */ }

  return {
    company: ld?.hiringOrganization?.name || og || hostCompany(url),
    jobTitle: ld?.title || h1 || doc.title?.trim() || "",
    appliedAt: new Date().toISOString().slice(0, 10),
    state: "Applied",
    domain,
    jobUrl: normalizeUrl(url),
    roleFamily: roleKey || ""
  };
}
```

```javascript
// src/track/export.js
const COLUMNS = [
  ["sno", "S.No"], ["company", "Company"], ["jobTitle", "Job Title"],
  ["appliedAt", "Date of Application"], ["state", "State"],
  ["domain", "Company Domain"], ["jobUrl", "Job URL"],
  ["roleFamily", "Role Family"], ["outcomeReason", "Reason"], ["notes", "Notes"]
];

function cell(value) {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const head = COLUMNS.map(([, label]) => cell(label)).join(",");
  const body = rows.map((r) => COLUMNS.map(([key]) => cell(r[key])).join(","));
  return [head, ...body].join("\n");
}

export function toJson(rows) {
  return JSON.stringify(rows.map(({ sno, ...rest }) => rest), null, 2);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/track-capture.test.js tests/track-export.test.js`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/track/capture.js src/track/export.js tests/track-capture.test.js tests/track-export.test.js
git commit -m "feat(track): capture application details from the page and export to CSV/JSON"
```

---

## Task 13: Popup — role switch and "Log this application"

**Files:**
- Create: `src/ui/popup/popup.html`, `src/ui/popup/popup.css`, `src/ui/popup/popup.js`, `src/ui/popup/log-form.js`
- Delete: `popup.html`, `popup.css`, `popup.js` (repo root, v1)
- Test: `tests/popup-log-form.test.js`

**Interfaces:**
- Consumes: `captureApplication`, `addApplication`, `APPLICATION_STATES`, `ROLE_KEYS`.
- Produces: `renderLogForm(capture, { roleLabels }) -> DocumentFragment` and `readLogForm(root) -> record`, both pure DOM so they are testable. The popup persists the chosen role at `chrome.storage.local.selectedRole` and passes it to `fillPage` and to capture.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/popup-log-form.test.js
import { describe, it, expect } from "vitest";
import { renderLogForm, readLogForm } from "../src/ui/popup/log-form.js";
import { APPLICATION_STATES } from "../src/track/store.js";

const capture = {
  company: "Acme", jobTitle: "Backend Engineer", appliedAt: "2026-10-12",
  state: "Applied", domain: "acme.com", jobUrl: "https://a.com/j/1", roleFamily: "swe"
};
const roleLabels = { genai: "GenAI Engineer", swe: "Software Engineer", trainer: "Trainer / L&D" };

function mount(c) {
  const root = document.createElement("div");
  root.appendChild(renderLogForm(c, { roleLabels }));
  return root;
}

describe("renderLogForm", () => {
  it("pre-fills every captured field", () => {
    const root = mount(capture);
    expect(root.querySelector('[name="company"]').value).toBe("Acme");
    expect(root.querySelector('[name="jobTitle"]').value).toBe("Backend Engineer");
    expect(root.querySelector('[name="jobUrl"]').value).toBe("https://a.com/j/1");
    expect(root.querySelector('[name="domain"]').value).toBe("acme.com");
    expect(root.querySelector('[name="appliedAt"]').value).toBe("2026-10-12");
  });

  it("offers every state, defaulting to Applied", () => {
    const sel = mount(capture).querySelector('[name="state"]');
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(APPLICATION_STATES);
    expect(sel.value).toBe("Applied");
  });

  it("preselects the captured role", () => {
    expect(mount(capture).querySelector('[name="roleFamily"]').value).toBe("swe");
  });

  it("leaves every field editable", () => {
    for (const el of mount(capture).querySelectorAll("input, select")) {
      expect(el.disabled).toBe(false);
      expect(el.readOnly).toBeFalsy();
    }
  });
});

describe("readLogForm", () => {
  it("round-trips the capture unedited", () => {
    expect(readLogForm(mount(capture))).toMatchObject(capture);
  });

  it("picks up an edited company name", () => {
    const root = mount(capture);
    root.querySelector('[name="company"]').value = "Acme India";
    expect(readLogForm(root).company).toBe("Acme India");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/popup-log-form.test.js`
Expected: FAIL — `src/ui/popup/log-form.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/ui/popup/log-form.js
import { APPLICATION_STATES } from "../../track/store.js";

const TEXT_FIELDS = [
  ["company", "Company"], ["jobTitle", "Job title"],
  ["appliedAt", "Date"], ["domain", "Domain"], ["jobUrl", "Job URL"]
];

function row(name, label, value, type = "text") {
  const wrap = document.createElement("label");
  wrap.className = "jfa-field";
  const span = document.createElement("span");
  span.className = "jfa-label";
  span.textContent = label;
  const input = document.createElement("input");
  input.type = type;
  input.name = name;
  input.value = value ?? "";
  input.setAttribute("data-jobfill-ui", "1");
  wrap.append(span, input);
  return wrap;
}

function select(name, label, options, value) {
  const wrap = document.createElement("label");
  wrap.className = "jfa-field";
  const span = document.createElement("span");
  span.className = "jfa-label";
  span.textContent = label;
  const sel = document.createElement("select");
  sel.name = name;
  sel.setAttribute("data-jobfill-ui", "1");
  for (const [val, text] of options) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = text;
    sel.appendChild(o);
  }
  sel.value = value;
  wrap.append(span, sel);
  return wrap;
}

export function renderLogForm(capture, { roleLabels }) {
  const frag = document.createDocumentFragment();
  for (const [name, label] of TEXT_FIELDS) {
    frag.appendChild(row(name, label, capture[name], name === "appliedAt" ? "date" : "text"));
  }
  frag.appendChild(select("state", "State",
    APPLICATION_STATES.map((s) => [s, s]), capture.state || "Applied"));
  frag.appendChild(select("roleFamily", "Applied as",
    Object.entries(roleLabels), capture.roleFamily || "genai"));
  return frag;
}

export function readLogForm(root) {
  const out = {};
  for (const el of root.querySelectorAll("[name]")) out[el.name] = el.value;
  return out;
}
```

```html
<!-- src/ui/popup/popup.html -->
<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><link rel="stylesheet" href="popup.css" /></head>
<body>
  <header>
    <strong>JobFill AI</strong>
    <a id="openDashboard" href="#">Dashboard</a>
  </header>

  <label class="jfa-field"><span class="jfa-label">Fill as</span>
    <select id="role"></select></label>

  <button id="fill">Fill this form</button>
  <div id="result" role="status"></div>

  <button id="logToggle" class="secondary">Log this application</button>
  <form id="logForm" hidden>
    <div id="logFields"></div>
    <div id="dupWarning" class="warn" hidden></div>
    <div class="jfa-actions">
      <button id="logSave" type="submit">Save</button>
      <button id="logCancel" type="button" class="secondary">Cancel</button>
    </div>
  </form>

  <a id="openOptions" href="#">Settings</a>
  <script src="popup.js"></script>
</body>
</html>
```

`src/ui/popup/popup.js` must:
1. Load `profile` via `chrome.runtime.sendMessage({ action: "getProfile" })` and populate `#role` from `profile.roles`, restoring `chrome.storage.local.selectedRole` (default `"genai"`) and persisting changes.
2. On `#fill`, send `{ action: "fill", roleKey }` to **every frame** of the active tab (`chrome.webNavigation.getAllFrames`, then `chrome.tabs.sendMessage(tabId, msg, { frameId })`), summing `scanned` and `filled` across frames, and render `Scanned N fields · filled M` in `#result`. This preserves the v1.1 all-frames behaviour.
3. On `#logToggle`, execute `captureApplication` in the active tab via `chrome.scripting.executeScript`, render the form with `renderLogForm`, and reveal it.
4. On submit, call `addApplication(readLogForm(...))`. If the result is `{ ok:false, duplicateOf }`, show `#dupWarning` with an **Update existing** button that calls `updateApplication(duplicateOf, patch)` and a **Save anyway** button that retries with `force: true`.
5. Wire `#openDashboard` to `chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") })` and `#openOptions` to `chrome.runtime.openOptionsPage()`.

Add `"scripting"` to `manifest.json` `permissions`.

Reuse the options-page CSS variables in `src/ui/popup/popup.css`, with `body { width: 320px; }` and `.warn { color: var(--err); font-size: 12px; }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/popup-log-form.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git rm popup.html popup.css popup.js
git add src/ui/popup/ manifest.json tests/popup-log-form.test.js
git commit -m "feat(popup): add role switch and one-click application logging"
```

---

## Task 14: The dashboard page

**Files:**
- Create: `src/ui/dashboard/dashboard.html`, `src/ui/dashboard/dashboard.css`, `src/ui/dashboard/dashboard.js`, `src/ui/dashboard/table.js`
- Modify: `build.mjs` already lists the dashboard entry, so no manifest change is needed — extension pages opened with `chrome.tabs.create` do not require `web_accessible_resources`
- Test: `tests/dashboard-table.test.js`

**Interfaces:**
- Consumes: `listApplications`, `updateApplication`, `deleteApplication`, `APPLICATION_STATES`, `toCsv`, `toJson`.
- Produces: `renderTable(rows, { roleLabels }) -> DocumentFragment` and `summarize(rows) -> { total, byState }`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/dashboard-table.test.js
import { describe, it, expect } from "vitest";
import { renderTable, summarize } from "../src/ui/dashboard/table.js";
import { APPLICATION_STATES } from "../src/track/store.js";

const roleLabels = { genai: "GenAI Engineer", swe: "Software Engineer", trainer: "Trainer / L&D" };
const rows = [
  { id: "a", sno: 2, company: "Swiggy", jobTitle: "SDE-2", appliedAt: "2026-10-11",
    state: "Applied", domain: "swiggy.com", jobUrl: "https://s.com/1",
    roleFamily: "swe", outcomeReason: "", notes: "" },
  { id: "b", sno: 1, company: "Acme", jobTitle: "GenAI Eng", appliedAt: "2026-10-10",
    state: "Rejected", domain: "acme.com", jobUrl: "https://a.com/1",
    roleFamily: "genai", outcomeReason: "No ML depth", notes: "" }
];

function mount() {
  const root = document.createElement("div");
  root.appendChild(renderTable(rows, { roleLabels }));
  return root;
}

describe("renderTable", () => {
  it("renders the columns the spec asks for", () => {
    const heads = Array.from(mount().querySelectorAll("thead th")).map((th) => th.textContent);
    for (const col of ["S.No", "Company", "Date", "State", "Domain", "Reason"]) {
      expect(heads.join("|")).toContain(col);
    }
  });

  it("renders one row per record, in the order given", () => {
    const bodyRows = mount().querySelectorAll("tbody tr");
    expect(bodyRows.length).toBe(2);
    expect(bodyRows[0].dataset.id).toBe("a");
  });

  it("renders the job url as a link", () => {
    const a = mount().querySelector('tbody a[href="https://s.com/1"]');
    expect(a).toBeTruthy();
    expect(a.target).toBe("_blank");
  });

  it("renders state as a select carrying every state", () => {
    const sel = mount().querySelector('tbody select[data-field="state"]');
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(APPLICATION_STATES);
    expect(sel.value).toBe("Applied");
  });

  it("shows the role label rather than the key", () => {
    expect(mount().textContent).toContain("Software Engineer");
    expect(mount().textContent).toContain("GenAI Engineer");
  });

  it("renders the rejection reason as an editable input", () => {
    const inputs = mount().querySelectorAll('tbody input[data-field="outcomeReason"]');
    expect(inputs.length).toBe(2);
    expect(Array.from(inputs).map((i) => i.value)).toContain("No ML depth");
  });

  it("renders an empty-state row when there are no records", () => {
    const root = document.createElement("div");
    root.appendChild(renderTable([], { roleLabels }));
    expect(root.querySelector("tbody").textContent).toContain("No applications");
  });
});

describe("summarize", () => {
  it("counts the total and each state", () => {
    const s = summarize(rows);
    expect(s.total).toBe(2);
    expect(s.byState.Applied).toBe(1);
    expect(s.byState.Rejected).toBe(1);
    expect(s.byState["On Hold"]).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard-table.test.js`
Expected: FAIL — `src/ui/dashboard/table.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/ui/dashboard/table.js
import { APPLICATION_STATES } from "../../track/store.js";

const HEADERS = ["S.No", "Company", "Job Title", "Date", "State",
                 "Domain", "Link", "Applied as", "Reason", ""];

function td(child) {
  const cell = document.createElement("td");
  if (child !== undefined && child !== null) {
    cell.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return cell;
}

function stateSelect(row) {
  const sel = document.createElement("select");
  sel.dataset.field = "state";
  for (const s of APPLICATION_STATES) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    sel.appendChild(o);
  }
  sel.value = row.state;
  return sel;
}

function reasonInput(row) {
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.field = "outcomeReason";
  input.value = row.outcomeReason || "";
  input.placeholder = "reason / notes";
  return input;
}

function link(url) {
  if (!url) return "";
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "open";
  return a;
}

function deleteButton() {
  const b = document.createElement("button");
  b.dataset.action = "delete";
  b.className = "ghost";
  b.textContent = "✕";
  b.title = "Delete this record";
  return b;
}

export function renderTable(rows, { roleLabels }) {
  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const h of HEADERS) {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  }
  thead.appendChild(hr);

  const tbody = document.createElement("tbody");
  if (!rows.length) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = HEADERS.length;
    cell.className = "empty";
    cell.textContent = "No applications logged yet.";
    tr.appendChild(cell);
    tbody.appendChild(tr);
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.append(
      td(String(row.sno)), td(row.company), td(row.jobTitle), td(row.appliedAt),
      td(stateSelect(row)), td(row.domain), td(link(row.jobUrl)),
      td(roleLabels[row.roleFamily] || row.roleFamily || ""),
      td(reasonInput(row)), td(deleteButton())
    );
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  const frag = document.createDocumentFragment();
  frag.appendChild(table);
  return frag;
}

export function summarize(rows) {
  const byState = Object.fromEntries(APPLICATION_STATES.map((s) => [s, 0]));
  for (const r of rows) if (byState[r.state] !== undefined) byState[r.state]++;
  return { total: rows.length, byState };
}
```

`src/ui/dashboard/dashboard.js` must: load rows via `listApplications(filter)`, render `summarize` counts as a chip row plus the table, wire `change` on `[data-field]` to `updateApplication(tr.dataset.id, { [field]: value })`, wire `[data-action="delete"]` to `deleteApplication` after a `confirm()`, wire filter controls (state, role, search, date range) to re-render, and wire two export buttons that download `toCsv(rows)` as `applications.csv` and `toJson(rows)` as `applications.json` via an object URL.

`src/ui/dashboard/dashboard.html` provides `#summary`, `#filters` (a `select#filterState`, `select#filterRole`, `input#search`, `input#from`, `input#to`), `#tableRoot`, `#exportCsv`, `#exportJson`, and a `#usage` section left empty for Task 18.

`src/ui/dashboard/dashboard.css` reuses the options-page variables and adds:
`table { width:100%; border-collapse:collapse; font-size:13px; }`,
`th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); }`,
`th { color:var(--muted); font-weight:500; font-size:11px; text-transform:uppercase; }`,
`td.empty { text-align:center; color:var(--muted); padding:32px; }`,
`.chips { display:flex; gap:8px; margin:12px 0; }`,
`.chip { padding:4px 10px; border:1px solid var(--line); border-radius:999px; font-size:12px; }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard-table.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/ tests/dashboard-table.test.js
git commit -m "feat(dashboard): add application table with inline editing, filters and export"
```

---

# Phase 4 — Cost optimization

## Task 15: Static-first prompt assembly

**Files:**
- Create: `src/ai/prompts.js`
- Test: `tests/ai-prompts.test.js`

**Interfaces:**
- Consumes: `resolveProfile`.
- Produces:
  - `buildMapFieldsMessages({ resolved, fields, pageContext }) -> messages[]`
  - `buildGenerateMessages({ resolved, question, pageContext, currentValue, instruction, length }) -> messages[]`
  - `staticPrefix(resolved) -> string` — the cacheable block, a pure function of the resolved profile only.
  - `LENGTH_TARGETS`, `LENGTH_CAPS`.

The contract: `messages[0]` is the system message and equals `staticPrefix(resolved)` **exactly**. Everything page-specific lives in `messages[1]`. This keeps the cacheable prefix byte-identical across every call with the same profile and role.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/ai-prompts.test.js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveProfile } from "../src/profile/resolve.js";
import { buildMapFieldsMessages, buildGenerateMessages, staticPrefix, LENGTH_CAPS }
  from "../src/ai/prompts.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));
const resolved = resolveProfile(profile, "genai");

describe("staticPrefix", () => {
  it("is byte-identical for the same resolved profile", () => {
    expect(staticPrefix(resolved)).toBe(staticPrefix(resolveProfile(profile, "genai")));
  });

  it("differs between role angles", () => {
    expect(staticPrefix(resolved)).not.toBe(staticPrefix(resolveProfile(profile, "swe")));
  });

  it("contains every truth rule verbatim", () => {
    const prefix = staticPrefix(resolved);
    for (const rule of profile.truthRules) expect(prefix).toContain(rule);
  });

  it("contains no timestamp, random value or page detail", () => {
    const prefix = staticPrefix(resolved);
    expect(prefix).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(prefix).not.toContain("Page:");
  });
});

describe("buildMapFieldsMessages", () => {
  const msgs = buildMapFieldsMessages({
    resolved, fields: [{ id: "f1", kind: "input", label: "Email" }],
    pageContext: "Acme — Backend Engineer"
  });

  it("puts the static prefix first and nothing else in it", () => {
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe(staticPrefix(resolved));
  });

  it("puts all variable content last", () => {
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("Acme — Backend Engineer");
    expect(msgs[1].content).toContain("f1");
  });

  it("keeps the system message identical across different pages", () => {
    const other = buildMapFieldsMessages({
      resolved, fields: [{ id: "zz", kind: "input", label: "Name" }],
      pageContext: "Different Co — Trainer"
    });
    expect(other[0].content).toBe(msgs[0].content);
  });
});

describe("buildGenerateMessages", () => {
  it("shares the same static prefix as mapFields", () => {
    const g = buildGenerateMessages({ resolved, question: "Why us?", pageContext: "p" });
    const m = buildMapFieldsMessages({ resolved, fields: [], pageContext: "p" });
    expect(g[0].content).toBe(m[0].content);
  });

  it("carries the instruction and the length target in the user message", () => {
    const g = buildGenerateMessages({
      resolved, question: "Why us?", pageContext: "p",
      instruction: "mention LangGraph", length: "shorter"
    });
    expect(g[1].content).toContain("mention LangGraph");
    expect(g[1].content).toContain("25-60 words");
  });

  it("caps output per length target", () => {
    expect(LENGTH_CAPS.shorter).toBe(250);
    expect(LENGTH_CAPS.normal).toBe(400);
    expect(LENGTH_CAPS.longer).toBe(700);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai-prompts.test.js`
Expected: FAIL — `src/ai/prompts.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/ai/prompts.js
export const LENGTH_TARGETS = {
  shorter: "25-60 words", normal: "40-150 words", longer: "150-250 words"
};
export const LENGTH_CAPS = { shorter: 250, normal: 400, longer: 700 };

const HARD_RULES = `HARD RULES (violating any of these is a failure):
- Answer ONLY from the profile. Never invent employers, degrees, certifications, permits, or experience.
- Follow every entry in truthRules exactly.
- Work authorization: job in India => eligible "Yes", needs sponsorship "No". Job outside India => needs sponsorship "Yes".
- Dates for a date input: use YYYY-MM-DD. Other date fields: match the format the label or placeholder suggests, else MM/YYYY.
- Salary questions: use jobPreferences.
- For select, radio and checkbox fields, the value MUST be copied verbatim from the provided options list.
- If a field cannot be answered truthfully from the profile and is not a generic motivational or essay question, skip it.`;

const OUTPUT_CONTRACT = `When filling a list of fields, return STRICT JSON only:
{"answers":[{"id":"<field id>","value":"...","source":"profile|generated|skipped"}]}
- "value" is the string to fill, or "" to skip. For checkboxes use "true" or "false".
- Fields with kind "widget" are custom dropdowns whose options are hidden until clicked: answer with the exact short option text a typical form offers (for example "No", "Yes", "India", "Male", "1 month"). Prefer the shortest standard phrasing.
When writing a single answer, return plain text only: no markdown, no surrounding quotes.`;

export function staticPrefix(resolved) {
  return `You complete job application forms for the candidate described below.

PROFILE:
${JSON.stringify(resolved)}

${HARD_RULES}

${OUTPUT_CONTRACT}

Target role angle: ${resolved.roleLabel}
Emphasis: ${resolved.emphasis}
Headline: ${resolved.headline}
Style for prose answers: first person, specific, grounded in real profile facts, professional but human.`;
}

export function buildMapFieldsMessages({ resolved, fields, pageContext }) {
  return [
    { role: "system", content: staticPrefix(resolved) },
    { role: "user", content:
`TASK: fill fields.
Page: ${pageContext}

Fields (JSON):
${JSON.stringify(fields)}` }
  ];
}

export function buildGenerateMessages({
  resolved, question, pageContext, currentValue, instruction, length
}) {
  const key = LENGTH_TARGETS[length] ? length : "normal";
  const lines = [
    "TASK: write one answer.",
    `Page: ${pageContext}`,
    `Question / field label: ${question}`,
    `Length target: ${LENGTH_TARGETS[key]} unless the question implies shorter (a number, a URL, a yes/no).`
  ];
  if (currentValue) lines.push(`Current draft in the field (improve or replace): ${currentValue}`);
  if (instruction) lines.push(`Extra instruction from the candidate: ${instruction}`);
  lines.push("Write the answer text only.");

  return [
    { role: "system", content: staticPrefix(resolved) },
    { role: "user", content: lines.join("\n") }
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai-prompts.test.js`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/prompts.js tests/ai-prompts.test.js
git commit -m "perf(ai): assemble prompts static-first so the cacheable prefix is stable"
```

---

## Task 16: API client — parsing, backoff and usage

**Files:**
- Create: `src/ai/client.js`, `src/ai/usage.js`
- Test: `tests/ai-client.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseAnswers(text) -> { answers: [] }` — strips code fences; throws `BadResponseError` on malformed or truncated JSON or a wrong shape.
  - `callModel({ settings, model, messages, jsonMode, maxTokens, fetchImpl, sleepImpl }) -> { content, usage }` where `usage = { promptTokens, cachedTokens, completionTokens }`.
  - Retries 429 and 5xx up to 3 attempts with exponential backoff and jitter; never retries 400 or 401.
  - `estimateCost({ model, promptTokens, cachedTokens, completionTokens }, rates) -> number` in INR.
  - `recordUsage(entry) -> Promise<void>` and `readUsage() -> Promise<{ entries, totals }>`.

> **Review Focus #3 is covered here.**

- [ ] **Step 1: Write the failing test**

```javascript
// tests/ai-client.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseAnswers, callModel, BadResponseError } from "../src/ai/client.js";
import { estimateCost, recordUsage, readUsage } from "../src/ai/usage.js";

const settings = { apiKey: "sk-test", baseUrl: "https://api.test/v1" };
const nap = async () => {};

function res(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function okBody(content, usage) {
  return {
    choices: [{ message: { content } }],
    usage: usage || { prompt_tokens: 100, completion_tokens: 20,
                      prompt_tokens_details: { cached_tokens: 80 } }
  };
}

describe("parseAnswers", () => {
  it("parses clean JSON", () => {
    expect(parseAnswers('{"answers":[{"id":"a","value":"x","source":"profile"}]}').answers)
      .toHaveLength(1);
  });

  it("strips a markdown code fence", () => {
    expect(parseAnswers('```json\n{"answers":[]}\n```').answers).toEqual([]);
  });

  // Review Focus #3
  it("throws BadResponseError on malformed JSON rather than a raw SyntaxError", () => {
    expect(() => parseAnswers('{"answers": [')).toThrow(BadResponseError);
  });

  it("throws BadResponseError on truncated output", () => {
    expect(() => parseAnswers('{"answers":[{"id":"a","value":"half of a sent'))
      .toThrow(BadResponseError);
  });

  it("throws BadResponseError when answers is not an array", () => {
    expect(() => parseAnswers('{"answers":"nope"}')).toThrow(BadResponseError);
  });

  it("throws BadResponseError on an empty response", () => {
    expect(() => parseAnswers("")).toThrow(BadResponseError);
  });
});

describe("callModel", () => {
  it("returns content and normalised usage", async () => {
    const fetchImpl = async () => res(200, okBody("hello"));
    const out = await callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap });
    expect(out.content).toBe("hello");
    expect(out.usage).toEqual({ promptTokens: 100, cachedTokens: 80, completionTokens: 20 });
  });

  it("sends max_completion_tokens when a cap is given", async () => {
    const fetchImpl = vi.fn(async () => res(200, okBody("x")));
    await callModel({ settings, model: "m", messages: [], maxTokens: 400, fetchImpl, sleepImpl: nap });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).max_completion_tokens).toBe(400);
  });

  it("retries a 429 and succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(res(429, { error: "rate" }))
      .mockResolvedValueOnce(res(200, okBody("ok")));
    const out = await callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap });
    expect(out.content).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts on repeated 500s", async () => {
    const fetchImpl = vi.fn(async () => res(500, { error: "boom" }));
    await expect(callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap }))
      .rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 401", async () => {
    const fetchImpl = vi.fn(async () => res(401, { error: "bad key" }));
    await expect(callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap }))
      .rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 400", async () => {
    const fetchImpl = vi.fn(async () => res(400, { error: "bad request" }));
    await expect(callModel({ settings, model: "m", messages: [], fetchImpl, sleepImpl: nap }))
      .rejects.toThrow(/400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("backs off for longer on each retry", async () => {
    const waits = [];
    const fetchImpl = vi.fn(async () => res(429, {}));
    await callModel({ settings, model: "m", messages: [], fetchImpl,
                      sleepImpl: async (ms) => { waits.push(ms); } }).catch(() => {});
    expect(waits.length).toBe(2);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });
});

describe("estimateCost", () => {
  const rates = { "m": { input: 100, cachedInput: 10, output: 400 } }; // INR per 1M tokens

  it("charges cached input at the cached rate", () => {
    const full = estimateCost({ model: "m", promptTokens: 1e6, cachedTokens: 0, completionTokens: 0 }, rates);
    const cached = estimateCost({ model: "m", promptTokens: 1e6, cachedTokens: 1e6, completionTokens: 0 }, rates);
    expect(full).toBeCloseTo(100, 5);
    expect(cached).toBeCloseTo(10, 5);
  });

  it("charges output at the output rate", () => {
    expect(estimateCost({ model: "m", promptTokens: 0, cachedTokens: 0, completionTokens: 1e6 }, rates))
      .toBeCloseTo(400, 5);
  });

  it("returns 0 for an unknown model rather than NaN", () => {
    expect(estimateCost({ model: "unknown", promptTokens: 1e6, cachedTokens: 0, completionTokens: 0 }, rates))
      .toBe(0);
  });
});

describe("usage log", () => {
  beforeEach(() => chrome.storage.local.__reset());

  it("accumulates totals across calls", async () => {
    await recordUsage({ task: "mapFields", model: "m", promptTokens: 100,
                        cachedTokens: 80, completionTokens: 20, estimatedCost: 1.5 });
    await recordUsage({ task: "generateAnswer", model: "m", promptTokens: 200,
                        cachedTokens: 150, completionTokens: 50, estimatedCost: 2.5 });
    const { totals, entries } = await readUsage();
    expect(entries).toHaveLength(2);
    expect(totals.promptTokens).toBe(300);
    expect(totals.cachedTokens).toBe(230);
    expect(totals.estimatedCost).toBeCloseTo(4, 5);
  });

  it("keeps at most 1000 entries", async () => {
    for (let i = 0; i < 1005; i++) {
      await recordUsage({ task: "t", model: "m", promptTokens: 1,
                          cachedTokens: 0, completionTokens: 1, estimatedCost: 0 });
    }
    expect((await readUsage()).entries.length).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai-client.test.js`
Expected: FAIL — `src/ai/client.js` and `src/ai/usage.js` do not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/ai/client.js
export class BadResponseError extends Error {
  constructor(message) {
    super(`The model returned something unusable: ${message}`);
    this.name = "BadResponseError";
  }
}

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseAnswers(text) {
  const cleaned = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  if (!cleaned) throw new BadResponseError("the response was empty");

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new BadResponseError(`it was not valid JSON (${e.message})`);
  }

  if (!parsed || !Array.isArray(parsed.answers)) {
    throw new BadResponseError('it had no "answers" array');
  }
  return { answers: parsed.answers };
}

function backoffDelay(attempt) {
  const expo = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(expo * (0.5 + Math.random() * 0.5));
}

export async function callModel({
  settings, model, messages, jsonMode, maxTokens,
  fetchImpl = (...a) => fetch(...a), sleepImpl = realSleep
}) {
  const body = { model, messages };
  if (jsonMode) body.response_format = { type: "json_object" };
  if (maxTokens) body.max_completion_tokens = maxTokens;

  const url = `${String(settings.baseUrl).replace(/\/$/, "")}/chat/completions`;
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (res.ok) {
      const data = await res.json();
      const u = data.usage || {};
      return {
        content: data.choices?.[0]?.message?.content || "",
        usage: {
          promptTokens: u.prompt_tokens || 0,
          cachedTokens: u.prompt_tokens_details?.cached_tokens || 0,
          completionTokens: u.completion_tokens || 0
        }
      };
    }

    const detail = (await res.text()).slice(0, 300);
    lastError = new Error(`API ${res.status}: ${detail}`);
    if (!RETRY_STATUS.has(res.status)) throw lastError;
    if (attempt < MAX_ATTEMPTS - 1) await sleepImpl(backoffDelay(attempt));
  }

  throw lastError;
}
```

```javascript
// src/ai/usage.js
const KEY = "usageLog";
const MAX_ENTRIES = 1000;

export const DEFAULT_RATES_INR = {
  "gpt-5-mini": { input: 21, cachedInput: 2.1, output: 168 }
};

export function estimateCost({ model, promptTokens, cachedTokens, completionTokens }, rates) {
  const r = rates?.[model];
  if (!r) return 0;
  const fresh = Math.max(0, (promptTokens || 0) - (cachedTokens || 0));
  return (
    (fresh / 1e6) * r.input +
    ((cachedTokens || 0) / 1e6) * r.cachedInput +
    ((completionTokens || 0) / 1e6) * r.output
  );
}

export async function recordUsage(entry) {
  const got = await chrome.storage.local.get([KEY]);
  const entries = Array.isArray(got[KEY]) ? got[KEY] : [];
  entries.push({ ...entry, at: new Date().toISOString() });
  while (entries.length > MAX_ENTRIES) entries.shift();
  await chrome.storage.local.set({ [KEY]: entries });
}

export async function readUsage() {
  const got = await chrome.storage.local.get([KEY]);
  const entries = Array.isArray(got[KEY]) ? got[KEY] : [];
  const totals = entries.reduce(
    (acc, e) => ({
      calls: acc.calls + 1,
      promptTokens: acc.promptTokens + (e.promptTokens || 0),
      cachedTokens: acc.cachedTokens + (e.cachedTokens || 0),
      completionTokens: acc.completionTokens + (e.completionTokens || 0),
      estimatedCost: acc.estimatedCost + (e.estimatedCost || 0)
    }),
    { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, estimatedCost: 0 }
  );
  return { entries, totals };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai-client.test.js`
Expected: PASS — 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/client.js src/ai/usage.js tests/ai-client.test.js
git commit -m "feat(ai): add resilient client with backoff, strict parsing and usage accounting"
```

---

## Task 17: Answer cache

**Files:**
- Create: `src/ai/cache.js`
- Test: `tests/ai-cache.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `cacheKey({ question, roleKey, profileVersion, length }) -> Promise<string>` — SHA-256 hex via `crypto.subtle`; the question is lowercased and whitespace-collapsed first.
  - `getCached(key) -> Promise<{ answer, model } | null>` — returns `null` past the 30-day TTL and deletes the entry.
  - `setCached(key, { answer, model }) -> Promise<void>` — evicts the oldest entries past `MAX_ENTRIES = 500`, and on a quota failure evicts half and retries once.
  - `clearCache() -> Promise<void>`, `cacheStats() -> Promise<{ entries, hits, misses }>`.

> **Review Focus #4 is covered here.**

- [ ] **Step 1: Write the failing test**

```javascript
// tests/ai-cache.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cacheKey, getCached, setCached, clearCache, cacheStats, TTL_MS, MAX_ENTRIES }
  from "../src/ai/cache.js";

const q = { question: "Why do you want to work here?", roleKey: "genai",
            profileVersion: "2026-10-12", length: "normal" };

beforeEach(() => chrome.storage.local.__reset());

describe("cacheKey", () => {
  it("is stable for the same inputs", async () => {
    expect(await cacheKey(q)).toBe(await cacheKey({ ...q }));
  });

  it("ignores case and surrounding whitespace in the question", async () => {
    expect(await cacheKey(q))
      .toBe(await cacheKey({ ...q, question: "  WHY DO YOU WANT TO WORK HERE?  " }));
  });

  it("collapses internal whitespace", async () => {
    expect(await cacheKey(q))
      .toBe(await cacheKey({ ...q, question: "Why do you    want to work\nhere?" }));
  });

  it("differs by role", async () => {
    expect(await cacheKey(q)).not.toBe(await cacheKey({ ...q, roleKey: "swe" }));
  });

  it("differs by profile version, so an edit invalidates the cache", async () => {
    expect(await cacheKey(q)).not.toBe(await cacheKey({ ...q, profileVersion: "2026-11-01" }));
  });

  it("differs by length target", async () => {
    expect(await cacheKey(q)).not.toBe(await cacheKey({ ...q, length: "shorter" }));
  });
});

describe("get and set", () => {
  it("returns null on a miss", async () => {
    expect(await getCached(await cacheKey(q))).toBeNull();
  });

  it("round-trips an answer", async () => {
    const k = await cacheKey(q);
    await setCached(k, { answer: "Because…", model: "m" });
    expect((await getCached(k)).answer).toBe("Because…");
  });

  it("expires an entry past the TTL and removes it", async () => {
    vi.useFakeTimers();
    const k = await cacheKey(q);
    await setCached(k, { answer: "old", model: "m" });
    vi.setSystemTime(new Date(Date.now() + TTL_MS + 1000));
    expect(await getCached(k)).toBeNull();
    expect((await cacheStats()).entries).toBe(0);
    vi.useRealTimers();
  });

  it("counts hits and misses", async () => {
    const k = await cacheKey(q);
    await getCached(k);
    await setCached(k, { answer: "a", model: "m" });
    await getCached(k);
    const s = await cacheStats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
  });
});

describe("eviction", () => {
  it("never grows past MAX_ENTRIES", async () => {
    for (let i = 0; i < MAX_ENTRIES + 25; i++) {
      await setCached(`k${i}`, { answer: `a${i}`, model: "m" });
    }
    expect((await cacheStats()).entries).toBeLessThanOrEqual(MAX_ENTRIES);
  });

  it("evicts the oldest entries first", async () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      await setCached(`k${i}`, { answer: `a${i}`, model: "m" });
    }
    expect(await getCached("k0")).toBeNull();
    expect((await getCached(`k${MAX_ENTRIES + 4}`)).answer).toBe(`a${MAX_ENTRIES + 4}`);
  });

  // Review Focus #4
  it("recovers from a quota error by evicting and retrying", async () => {
    for (let i = 0; i < 20; i++) await setCached(`k${i}`, { answer: `a${i}`, model: "m" });

    const realSet = chrome.storage.local.set.bind(chrome.storage.local);
    let thrown = false;
    chrome.storage.local.set = async (obj) => {
      if (!thrown) {
        thrown = true;
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      return realSet(obj);
    };

    await expect(setCached("new", { answer: "fits now", model: "m" })).resolves.toBeUndefined();
    chrome.storage.local.set = realSet;

    expect((await getCached("new")).answer).toBe("fits now");
    expect((await cacheStats()).entries).toBeLessThan(21);
  });
});

describe("clearCache", () => {
  it("empties the cache and resets the counters", async () => {
    await setCached("k", { answer: "a", model: "m" });
    await clearCache();
    const s = await cacheStats();
    expect(s.entries).toBe(0);
    expect(s.hits).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai-cache.test.js`
Expected: FAIL — `src/ai/cache.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/ai/cache.js
const KEY = "answerCache";
const STATS_KEY = "answerCacheStats";

export const TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ENTRIES = 500;

function normalize(question) {
  return String(question || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export async function cacheKey({ question, roleKey, profileVersion, length }) {
  const material = [normalize(question), roleKey || "", profileVersion || "", length || "normal"]
    .join("\u0000");
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readMap() {
  const got = await chrome.storage.local.get([KEY]);
  return got[KEY] && typeof got[KEY] === "object" ? got[KEY] : {};
}

async function readStats() {
  const got = await chrome.storage.local.get([STATS_KEY]);
  return { hits: 0, misses: 0, ...(got[STATS_KEY] || {}) };
}

async function bumpStat(field) {
  const stats = await readStats();
  stats[field] = (stats[field] || 0) + 1;
  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

function evictOldest(map, keepCount) {
  const sorted = Object.entries(map).sort((a, b) => a[1].createdAt - b[1].createdAt);
  return Object.fromEntries(sorted.slice(Math.max(0, sorted.length - keepCount)));
}

export async function getCached(key) {
  const map = await readMap();
  const hit = map[key];

  if (!hit) {
    await bumpStat("misses");
    return null;
  }
  if (Date.now() - hit.createdAt > TTL_MS) {
    delete map[key];
    await chrome.storage.local.set({ [KEY]: map });
    await bumpStat("misses");
    return null;
  }

  await bumpStat("hits");
  return { answer: hit.answer, model: hit.model };
}

export async function setCached(key, { answer, model }) {
  let map = await readMap();
  map[key] = { answer, model, createdAt: Date.now() };

  if (Object.keys(map).length > MAX_ENTRIES) map = evictOldest(map, MAX_ENTRIES);

  try {
    await chrome.storage.local.set({ [KEY]: map });
  } catch (e) {
    const half = Math.max(1, Math.floor(Object.keys(map).length / 2));
    const trimmed = evictOldest(map, half);
    trimmed[key] = { answer, model, createdAt: Date.now() };
    await chrome.storage.local.set({ [KEY]: trimmed });
  }
}

export async function clearCache() {
  await chrome.storage.local.set({ [KEY]: {}, [STATS_KEY]: { hits: 0, misses: 0 } });
}

export async function cacheStats() {
  const [map, stats] = await Promise.all([readMap(), readStats()]);
  return { entries: Object.keys(map).length, ...stats };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai-cache.test.js`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/cache.js tests/ai-cache.test.js
git commit -m "perf(ai): cache generated answers with TTL, LRU eviction and quota recovery"
```

---

## Task 18: Routing, deduplication, and wiring the cost layer in

**Files:**
- Create: `src/ai/router.js`, `src/ai/inflight.js`
- Modify: `src/background.js` (replace the inline prompt and fetch code with the `src/ai/*` modules)
- Modify: `src/ui/dashboard/dashboard.js`, `src/ui/dashboard/dashboard.html` (fill the `#usage` section)
- Modify: `src/ui/options/options.html`, `src/ui/options/options.js` (add the rates editor and a "Clear answer cache" button)
- Test: `tests/ai-router.test.js`, `tests/ai-inflight.test.js`, `tests/background-cost.test.js`

**Interfaces:**
- Consumes: everything from `src/ai/*`.
- Produces:
  - `modelFor(task, settings) -> string` — `"mapFields"` → `settings.fastModel`, `"generateAnswer"` → `settings.qualityModel`, unknown task → `settings.qualityModel`.
  - `capFor(task, length) -> number`.
  - `dedupe(key, factory) -> Promise<any>` — concurrent calls with the same key share one promise; the entry is deleted on settle.
  - `handleGenerateAnswer` now returns `{ value, cached: boolean }`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/ai-router.test.js
import { describe, it, expect } from "vitest";
import { modelFor, capFor } from "../src/ai/router.js";

const settings = { fastModel: "fast-m", qualityModel: "quality-m" };

describe("modelFor", () => {
  it("routes field mapping to the fast model", () => {
    expect(modelFor("mapFields", settings)).toBe("fast-m");
  });
  it("routes prose generation to the quality model", () => {
    expect(modelFor("generateAnswer", settings)).toBe("quality-m");
  });
  it("falls back to the quality model for an unknown task", () => {
    expect(modelFor("whatever", settings)).toBe("quality-m");
  });
});

describe("capFor", () => {
  it("caps field mapping", () => {
    expect(capFor("mapFields")).toBe(1500);
  });
  it("caps generation by length target", () => {
    expect(capFor("generateAnswer", "shorter")).toBe(250);
    expect(capFor("generateAnswer", "normal")).toBe(400);
    expect(capFor("generateAnswer", "longer")).toBe(700);
  });
  it("treats an unknown length as normal", () => {
    expect(capFor("generateAnswer", "enormous")).toBe(400);
  });
});
```

```javascript
// tests/ai-inflight.test.js
import { describe, it, expect, vi } from "vitest";
import { dedupe, inflightCount } from "../src/ai/inflight.js";

describe("dedupe", () => {
  it("runs the factory once for concurrent identical keys", async () => {
    const factory = vi.fn(() => new Promise((r) => setTimeout(() => r("value"), 10)));
    const [a, b, c] = await Promise.all([
      dedupe("k", factory), dedupe("k", factory), dedupe("k", factory)
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual(["value", "value", "value"]);
  });

  it("runs the factory again once the first call has settled", async () => {
    const factory = vi.fn(async () => "v");
    await dedupe("k", factory);
    await dedupe("k", factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not share between different keys", async () => {
    const factory = vi.fn(async () => "v");
    await Promise.all([dedupe("a", factory), dedupe("b", factory)]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("propagates a rejection to every waiter and clears the entry", async () => {
    const factory = vi.fn(async () => { throw new Error("boom"); });
    const results = await Promise.allSettled([dedupe("k", factory), dedupe("k", factory)]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(inflightCount()).toBe(0);
  });
});
```

```javascript
// tests/background-cost.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { setDefaultProfile } from "../src/profile/load.js";
import { handleGenerateAnswer, handleMapFields, __setFetch } from "../src/background.js";
import { clearCache, cacheStats } from "../src/ai/cache.js";
import { readUsage } from "../src/ai/usage.js";

const profile = JSON.parse(readFileSync("profile.json", "utf8"));

function okResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 20,
               prompt_tokens_details: { cached_tokens: 80 } }
    }),
    text: async () => ""
  };
}

beforeEach(async () => {
  chrome.storage.local.__reset();
  setDefaultProfile(profile);
  await clearCache();
  await chrome.storage.local.set({
    settings: { apiKey: "sk-test", fastModel: "fast-m",
                qualityModel: "quality-m", baseUrl: "https://api.test/v1" }
  });
});

describe("cost layer", () => {
  it("serves a repeated question from cache without calling the API", async () => {
    const fetchMock = vi.fn(async () => okResponse("My answer."));
    __setFetch(fetchMock);

    const first = await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    const second = await handleGenerateAnswer({ question: "why us?  ", pageContext: "DIFFERENT PAGE", role: "genai" });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toBe("My answer.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache when the user regenerates", async () => {
    const fetchMock = vi.fn(async () => okResponse("Answer."));
    __setFetch(fetchMock);
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai", bypassCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an answer across role angles", async () => {
    const fetchMock = vi.fn(async () => okResponse("Answer."));
    __setFetch(fetchMock);
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "swe" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("routes mapFields to the fast model and generation to the quality model", async () => {
    const fetchMock = vi.fn(async (_url, init) =>
      okResponse(JSON.parse(init.body).model === "fast-m" ? '{"answers":[]}' : "prose"));
    __setFetch(fetchMock);

    await handleMapFields({ fields: [], pageContext: "p", role: "genai" });
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });

    const models = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).model);
    expect(models).toEqual(["fast-m", "quality-m"]);
  });

  it("collapses two concurrent identical generate calls into one API call", async () => {
    const fetchMock = vi.fn(() => new Promise((r) => setTimeout(() => r(okResponse("A")), 15)));
    __setFetch(fetchMock);
    const args = { question: "Why us?", pageContext: "p", role: "genai" };
    await Promise.all([handleGenerateAnswer(args), handleGenerateAnswer(args)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records usage for a real call and not for a cache hit", async () => {
    __setFetch(async () => okResponse("Answer."));
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    await handleGenerateAnswer({ question: "Why us?", pageContext: "p", role: "genai" });
    const { entries } = await readUsage();
    expect(entries).toHaveLength(1);
    expect(entries[0].cachedTokens).toBe(80);
    expect((await cacheStats()).hits).toBe(1);
  });

  it("surfaces a malformed mapFields response as a clean error", async () => {
    __setFetch(async () => okResponse("not json at all"));
    await expect(handleMapFields({ fields: [], pageContext: "p", role: "genai" }))
      .rejects.toThrow(/unusable/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ai-router.test.js tests/ai-inflight.test.js tests/background-cost.test.js`
Expected: FAIL — `src/ai/router.js` and `src/ai/inflight.js` do not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/ai/router.js
import { LENGTH_CAPS } from "./prompts.js";

export const MAP_FIELDS_CAP = 1500;

export function modelFor(task, settings) {
  return task === "mapFields" ? settings.fastModel : settings.qualityModel;
}

export function capFor(task, length) {
  if (task === "mapFields") return MAP_FIELDS_CAP;
  return LENGTH_CAPS[length] || LENGTH_CAPS.normal;
}
```

```javascript
// src/ai/inflight.js
const pending = new Map();

export function dedupe(key, factory) {
  if (pending.has(key)) return pending.get(key);
  const promise = (async () => factory())().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

export function inflightCount() {
  return pending.size;
}
```

Then rewrite the two handlers in `src/background.js` to use the modules. `handleMapFields` becomes:

```javascript
export async function handleMapFields({ fields, pageContext, role }) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("NO_KEY");

  const profile = await loadProfile();
  const resolved = resolveProfile(profile, role);
  const messages = buildMapFieldsMessages({ resolved, fields, pageContext });

  const model = modelFor("mapFields", settings);
  const { content, usage } = await callModel({
    settings, model, messages, jsonMode: true,
    maxTokens: capFor("mapFields"), fetchImpl: _fetch
  });

  await recordUsage({
    task: "mapFields", model, ...usage,
    estimatedCost: estimateCost({ model, ...usage }, await getRates())
  });

  return parseAnswers(content);
}
```

and `handleGenerateAnswer` becomes:

```javascript
export async function handleGenerateAnswer({
  question, pageContext, currentValue, role, instruction, length, bypassCache
}) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("NO_KEY");

  const profile = await loadProfile();
  const resolved = resolveProfile(profile, role);
  const lengthKey = LENGTH_CAPS[length] ? length : "normal";

  // An instruction or an existing draft makes the request one-off, so it is not cached.
  const cacheable = !instruction && !currentValue;
  const key = cacheable
    ? await cacheKey({
        question, roleKey: role,
        profileVersion: profile?._meta?.updatedAt || "0", length: lengthKey
      })
    : null;

  if (key && !bypassCache) {
    const hit = await getCached(key);
    if (hit) return { value: hit.answer, cached: true };
  }

  const dedupeKey = key || `oneoff:${question}:${instruction}:${currentValue}:${role}:${lengthKey}`;

  const value = await dedupe(dedupeKey, async () => {
    const messages = buildGenerateMessages({
      resolved, question, pageContext, currentValue, instruction, length: lengthKey
    });
    const model = modelFor("generateAnswer", settings);
    const { content, usage } = await callModel({
      settings, model, messages, jsonMode: false,
      maxTokens: capFor("generateAnswer", lengthKey), fetchImpl: _fetch
    });

    await recordUsage({
      task: "generateAnswer", model, ...usage,
      estimatedCost: estimateCost({ model, ...usage }, await getRates())
    });

    const trimmed = content.trim();
    if (key) await setCached(key, { answer: trimmed, model });
    return trimmed;
  });

  return { value, cached: false };
}
```

Add `getRates()` to `src/background.js`, reading `chrome.storage.local.rates` and falling
back to `DEFAULT_RATES_INR`. Add `clearCache` to the message switch as `action: "clearCache"`.

Dashboard: render a `#usage` panel showing `calls`, `promptTokens`, `cachedTokens`
(with the cached percentage), `completionTokens`, `estimatedCost` formatted as INR, and the
cache hit rate from `cacheStats()`.

Options: add a JSON textarea bound to `chrome.storage.local.rates` seeded from
`DEFAULT_RATES_INR`, and a **Clear answer cache** button wired to the new message.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — the whole suite, including 14 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/ai/router.js src/ai/inflight.js src/background.js src/ui/ tests/ai-router.test.js tests/ai-inflight.test.js tests/background-cost.test.js
git commit -m "perf(ai): route models, cache answers, dedupe in-flight calls and report spend"
```

---

# Phase 5 — End to end

## Task 19: Playwright smoke test

**Files:**
- Create: `playwright.config.js`, `e2e/extension.spec.js`, `e2e/fixtures/form.html`, `e2e/stub-worker.js`
- Modify: `package.json` (`e2e` script already present)

**Interfaces:**
- Consumes: the built `dist/`.
- Produces: proof that **autofill works** and **the tooltip works** in real Chrome.

The OpenAI endpoint is stubbed with `page.route()` so the test is deterministic, free, and needs no API key. `e2e/fixtures/form.html` is served by Playwright's built-in static server and contains the same controls as `tests/fixtures/workday.html` plus a textarea labelled "Why do you want this role?".

- [ ] **Step 1: Write the failing test**

```javascript
// e2e/extension.spec.js
import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distPath = path.join(root, "dist");

let context;
let extensionId;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      "--headless=new",
      `--disable-extensions-except=${distPath}`,
      `--load-extension=${distPath}`
    ]
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;

  // Seed an API key so the extension does not short-circuit on NO_KEY.
  const seed = await context.newPage();
  await seed.goto(`chrome-extension://${extensionId}/options.html`);
  await seed.evaluate(() => chrome.storage.local.set({
    settings: { apiKey: "sk-e2e", fastModel: "fast-m",
                qualityModel: "quality-m", baseUrl: "https://api.openai.com/v1" }
  }));
  await seed.close();
});

test.afterAll(async () => { await context?.close(); });

async function stubOpenAI(page) {
  await page.route("**/chat/completions", async (route) => {
    const body = route.request().postDataJSON();
    const isMapping = !!body.response_format;
    const content = isMapping
      ? JSON.stringify({
          answers: [
            { id: "jfa-1", value: "Naved Khan", source: "profile" },
            { id: "jfa-2", value: "you@example.com", source: "profile" },
            { id: "jfa-3", value: "+91 90000 00000", source: "profile" },
            { id: "jfa-4", value: "India", source: "profile" }
          ]
        })
      : "I build production LLM systems and teach engineers to do the same.";

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 20,
                 prompt_tokens_details: { cached_tokens: 0 } }
      })
    });
  });
}

test("autofill populates the form from profile.json", async () => {
  const page = await context.newPage();
  await stubOpenAI(page);
  await page.goto("/form.html");

  await page.evaluate(() => chrome.runtime.sendMessage({ action: "ping" }).catch(() => {}));
  const result = await page.evaluate(async () =>
    await window.__jobfillFillForTest({ roleKey: "genai" }));

  expect(result.scanned).toBeGreaterThan(3);
  await expect(page.locator("#fullName")).toHaveValue("Naved Khan");
  await expect(page.locator("#email")).toHaveValue("you@example.com");
  await expect(page.locator("#phone")).toHaveValue("+91 90000 00000");
  await expect(page.locator('button[aria-haspopup="listbox"]')).toContainText("India");
  await page.close();
});

test("the tooltip generates, previews, and only writes on Insert", async () => {
  const page = await context.newPage();
  await stubOpenAI(page);
  await page.goto("/form.html");

  await page.locator("#why").click();
  await page.locator(".jfa-icon").click();

  const popover = page.locator('[data-jobfill-ui="1"]').last();
  const text = popover.locator('[data-part="text"]');

  await expect(text).toHaveValue(/production LLM systems/, { timeout: 10000 });
  await expect(page.locator("#why")).toHaveValue("");

  await popover.locator('[data-part="insert"]').click();
  await expect(page.locator("#why")).toHaveValue(/production LLM systems/);
  await page.close();
});

test("logging an application stores one record", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html`);

  const count = await page.evaluate(async () => {
    const { addApplication, listApplications } = window.__jobfillTrackForTest;
    await addApplication({
      company: "Acme", jobUrl: "https://jobs.acme.com/1",
      domain: "acme.com", roleFamily: "swe"
    });
    return (await listApplications()).length;
  });

  expect(count).toBe(1);
  await page.close();
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `npm run e2e`
Expected: FAIL — `playwright.config.js` and `e2e/fixtures/form.html` do not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// playwright.config.js
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:5577" },
  webServer: {
    command: "npx http-server e2e/fixtures -p 5577 --silent",
    url: "http://127.0.0.1:5577/form.html",
    reuseExistingServer: true
  }
});
```

Add `http-server` to `devDependencies`.

`e2e/fixtures/form.html` contains, in order so the scanner assigns `jfa-1` … `jfa-4`:
`input#fullName` with `<label for="fullName">Full name</label>`,
`input#email` with `<label for="email">Email address</label>`,
`input#phone` with `<label for="phone">Phone number</label>`,
a `<label>Country</label>` followed by `button[aria-haspopup="listbox"]` whose click handler
unhides a `ul[role="listbox"]` of `India` / `United States` / `Germany` and whose option
click handler writes the chosen text back into the button,
and `textarea#why` with `<label for="why">Why do you want this role?</label>`.

In `src/content.js`, inside the IIFE, expose two test hooks guarded by the extension
context so they never reach a normal page's JavaScript scope unintentionally:

```javascript
window.__jobfillFillForTest = ({ roleKey }) =>
  fillPage({ sendMessage: chrome.runtime.sendMessage, doc: document, roleKey });
```

and in `src/ui/dashboard/dashboard.js`:

```javascript
window.__jobfillTrackForTest = { addApplication, listApplications };
```

Both are small, deliberate seams for the E2E test; they expose no profile data.

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm run build && npm run e2e`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.js e2e/ package.json src/content.js src/ui/dashboard/dashboard.js
git commit -m "test(e2e): prove autofill, the tooltip and application logging in real Chrome"
```

---

## Task 20: Ship it

**Files:**
- Create: `MANUAL-CHECKLIST.md`
- Modify: `README.md`

- [ ] **Step 1: Run the full suite**

Run: `npm test && npm run build && npm run e2e`
Expected: every vitest test and all 3 Playwright tests pass.

- [ ] **Step 2: Commit the build output**

```bash
git add -f dist/
git commit -m "build: commit dist/ so the extension loads without a build step"
```

- [ ] **Step 3: Write the manual checklist**

`MANUAL-CHECKLIST.md` lists the steps that automation cannot cover: load `dist/` unpacked
at `chrome://extensions`, open Settings and paste a real API key, check the Preview tab
shows only the selected role, open one real job posting, press Fill, confirm the field
count, use the tooltip on one essay question including Regenerate and Shorter, press
Insert, log the application, and confirm the row and the spend figure appear in the
dashboard.

- [ ] **Step 4: Update the README**

Document: install, `npm install`, `npm run build`, loading `dist/` unpacked, editing
`profile.json` or using the Settings page, the three role angles, the tooltip, the
dashboard, and `npm test` / `npm run e2e`.

- [ ] **Step 5: Commit**

```bash
git add MANUAL-CHECKLIST.md README.md
git commit -m "docs: add manual verification checklist and update the README for v2"
```
