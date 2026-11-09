import { test, expect, chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distPath = path.join(root, "dist");
const profile = JSON.parse(readFileSync(path.join(root, "profile.json"), "utf8"));

let context;
let extensionId;
const stubFailures = [];

test.beforeAll(async () => {
  if (!existsSync(path.join(distPath, "manifest.json"))) {
    throw new Error("dist/ not built \u2014 run `npm run build` first (or use `npm run e2e`).");
  }
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

  // Seed a dummy API key so the worker does not short-circuit on NO_KEY.
  const seed = await context.newPage();
  await seed.goto(`chrome-extension://${extensionId}/options.html`);
  await seed.evaluate(() => chrome.storage.local.set({
    settings: { apiKey: "sk-e2e", fastModel: "fast-m",
                qualityModel: "quality-m", baseUrl: "https://api.openai.com/v1" }
  }));
  await seed.close();

  // The model call is made by the service worker, so stub at context level.
  // The stub verifies the request really carries the profile and the scanned labels,
  // and answers only for ids that are actually in the request (matched by label).
  await context.route("**/chat/completions", async (route) => {
    const body = route.request().postDataJSON();
    let content = "I build production LLM systems and teach engineers to do the same.";
    if (body.response_format) {
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      const user = body.messages.find((m) => m.role === "user")?.content ?? "";
      if (!system.includes(profile.personal.email)) stubFailures.push("system prompt lacks profile email");
      if (!system.includes(profile.truthRules[0])) stubFailures.push("system prompt lacks truthRules[0]");
      let fields = [];
      try {
        fields = JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
      } catch { stubFailures.push("user message has no parseable fields JSON"); }
      const labelOf = (re) => fields.find((f) => re.test(f.label || ""));
      const wanted = [
        [/full name/i, profile.personal.fullName],
        [/email/i, profile.personal.email],
        [/phone/i, profile.personal.phone],
        [/country/i, profile.personal.country]
      ];
      const answers = [];
      for (const [re, value] of wanted) {
        const f = labelOf(re);
        if (!f) stubFailures.push(`scanned fields lack a label matching ${re}`);
        else answers.push({ id: f.id, value, source: "profile" });
      }
      content = JSON.stringify({ answers });
    }
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
});

test.afterAll(async () => { await context?.close(); });

async function openForm() {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__submits = 0;
    document.addEventListener("submit", () => { window.__submits++; }, true);
  });
  await page.goto("/form.html");
  return page;
}

test("autofill populates the form from profile.json", async () => {
  const page = await openForm();

  // Same path as the popup: an extension page messages the tab's content script.
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extensionId}/options.html`);
  const res = await ext.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
    // Content scripts attach at document_idle, so the first send can race them.
    // Retry only the "no listener yet" rejection, for up to 3s; anything else throws.
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        return await chrome.tabs.sendMessage(tab.id, { action: "fill", roleKey: "genai" });
      } catch (e) {
        const msg = String(e && e.message);
        const noListener = /Receiving end does not exist|Could not establish connection/i.test(msg);
        if (!noListener || Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });
  await ext.close();

  expect(stubFailures).toEqual([]);
  expect(res.ok).toBe(true);
  expect(res.summary.errors).toEqual([]);
  expect(res.summary.scanned).toBeGreaterThan(3);
  await expect(page.locator("#fullName")).toHaveValue(profile.personal.fullName);
  await expect(page.locator("#email")).toHaveValue(profile.personal.email);
  await expect(page.locator("#phone")).toHaveValue(profile.personal.phone);
  await expect(page.locator('button[aria-haspopup="listbox"]')).toContainText("India");
  expect(await page.evaluate(() => window.__submits)).toBe(0);
  await page.close();
});

test("the tooltip generates, previews, and only writes on Insert", async () => {
  const page = await openForm();

  await page.locator("#why").click();
  await page.locator(".jfa-icon").click();

  const popover = page.locator('[data-jobfill-ui="1"]').last();
  const text = popover.locator('[data-part="text"]');

  await expect(text).toHaveValue(/production LLM systems/, { timeout: 10000 });
  await expect(page.locator("#why")).toHaveValue("");

  await popover.locator('[data-part="insert"]').click();
  await expect(page.locator("#why")).toHaveValue(/production LLM systems/);
  expect(await page.evaluate(() => window.__submits)).toBe(0);
  await page.close();
});

test("logging an application stores a readable record", async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dashboard.html`);

  const rows = await page.evaluate(async () => {
    const { addApplication, listApplications } = window.__jobfillTrackForTest;
    await addApplication({
      company: "Acme", jobUrl: "https://jobs.acme.com/1",
      domain: "acme.com", roleFamily: "swe"
    });
    return await listApplications({});
  });

  expect(rows).toHaveLength(1);
  expect(rows[0].company).toBe("Acme");
  await page.close();
});
