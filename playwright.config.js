import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:5577" },
  webServer: {
    command: "node e2e/serve.mjs",
    url: "http://127.0.0.1:5577/form.html",
    reuseExistingServer: true
  }
});
