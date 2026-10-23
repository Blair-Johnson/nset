import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1500, height: 1100 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
  reporter: "list",
});
