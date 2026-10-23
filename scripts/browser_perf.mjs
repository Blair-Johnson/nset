import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "web/package.json"));
const { chromium } = require("playwright");
const { expect } = require("@playwright/test");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto(process.env.NSET_BROWSER_URL);
  await page
    .getByLabel("Access token", { exact: true })
    .fill(process.env.NSET_BROWSER_TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator(".experiment-link").first().click();
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  const start = performance.now();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  const card = page
    .locator(".dashboard-cell[data-card-kind=timeseries]")
    .first();
  await card.locator("canvas").waitFor();
  await expect(card.locator(".card-status")).toHaveText("");
  const linearMs = performance.now() - start;
  await card
    .getByRole("button", { name: "Add vertical cursor", exact: true })
    .click();
  await card.locator(".card-position-editor > summary").click();
  await card.getByLabel("Cursor A coordinate", { exact: true }).fill("50.5");
  await card.getByLabel("Cursor A coordinate", { exact: true }).press("Tab");
  await card.locator(".card-series-details > summary").click();
  const actual = Number(
    await card
      .locator(".card-value-table tr")
      .filter({ hasText: "Dense 100k" })
      .locator("td")
      .first()
      .innerText(),
  );
  assert.ok(Math.abs(actual - Number(process.env.NSET_EXPECTED_QUERY)) < 1e-5);
  await card.getByLabel("Chart actions", { exact: true }).click();
  await card.getByRole("button", { name: "Edit chart", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit chart", exact: true });
  await editor
    .getByRole("heading", { name: "Smoothing", exact: true })
    .click();
  const cubicStart = performance.now();
  await editor
    .getByLabel("Between observations", { exact: true })
    .selectOption("pchip");
  await editor.locator(".ce-preview-plot canvas").waitFor();
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await editor.waitFor({ state: "hidden" });
  await card.locator("canvas").waitFor();
  const pchipMs = performance.now() - cubicStart;
  await mkdir(path.join(root, "artifacts/screenshots"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "artifacts/screenshots/ux-dense-100k.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      kind: "final",
      phase: "ux-browser-throughput",
      points: 100000,
      linear_load_and_render_ms: linearMs,
      pchip_editor_and_render_ms: pchipMs,
      used_js_heap_bytes: await page.evaluate(
        () => performance.memory?.usedJSHeapSize ?? null,
      ),
      query_actual: actual,
      status: "passed",
      caveat:
        "One local Chromium observation. PCHIP includes editor preview/apply interaction, unlike the old toolbar-only benchmark.",
    }),
  );
} finally {
  await browser.close();
}
