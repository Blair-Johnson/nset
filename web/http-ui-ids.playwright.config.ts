import { defineConfig } from "@playwright/test";

const port = Number(process.env.NSET_HTTP_UI_IDS_PORT ?? 43979);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid NSET_HTTP_UI_IDS_PORT");

export default defineConfig({
  testDir: "tests",
  testMatch: "http-ui-ids.spec.ts",
  workers: 1,
  timeout: 30000,
  use: {
    viewport: { width: 1500, height: 1100 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "insecure-http",
      use: {
        // A non-loopback origin: Chromium must actually withhold randomUUID.
        baseURL: `http://http-ui.test:${port}`,
        launchOptions: {
          args: [
            "--host-resolver-rules=MAP http-ui.test 127.0.0.1",
            "--no-proxy-server",
          ],
        },
      },
    },
    {
      name: "localhost-fallback",
      use: { baseURL: `http://127.0.0.1:${port}` },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    env: { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "http-ui.test" },
    reuseExistingServer: false,
  },
  reporter: "list",
});
