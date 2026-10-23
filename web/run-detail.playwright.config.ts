import { defineConfig } from "@playwright/test";

// Dedicated component suite: never reuses another worker's Vite process.
const port = Number(process.env.NSET_RUN_DETAIL_PORT ?? 43971);
export default defineConfig({
  testDir: "tests",
  testMatch: "run-detail.spec.ts",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
  reporter: "list",
});
