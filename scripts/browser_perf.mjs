import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "web/package.json"));
const { chromium } = require("playwright");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(process.env.NSET_BROWSER_URL);
  await page.locator("#token").fill(process.env.NSET_BROWSER_TOKEN);
  await page.locator("#login-form button[type=submit]").click();
  await page.getByLabel("Compare Dense 100k", { exact: true }).waitFor();
  const start = performance.now();
  await page.locator("#select-all").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#load-status")
      .textContent.startsWith("Snapshot complete"),
  );
  assert.match(
    await page.locator("#data-note").innerText(),
    /100,000 observations/,
  );
  const linearMs = performance.now() - start;
  await page.locator("#pin-a").fill("50.5");
  const actual = Number(
    await page.locator("#readout tbody tr td").nth(2).innerText(),
  );
  assert.ok(Math.abs(actual - Number(process.env.NSET_EXPECTED_QUERY)) < 1e-7);
  const cubicStart = performance.now();
  await page.locator("#interpolation").selectOption("pchip");
  await page.waitForFunction(() =>
    document.querySelector("#data-note").textContent.includes("pchip"),
  );
  const pchipMs = performance.now() - cubicStart;
  await mkdir(path.join(root, "artifacts/screenshots"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "artifacts/screenshots/dense-100k.png"),
    fullPage: true,
  });
  const memory = await page.evaluate(
    () => performance.memory?.usedJSHeapSize ?? null,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      kind: "final",
      phase: "browser-throughput",
      points: 100000,
      linear_load_and_render_ms: linearMs,
      pchip_switch_and_render_ms: pchipMs,
      used_js_heap_bytes: memory,
      query_actual: actual,
      status: "passed",
      caveat:
        "One local Chromium measurement; includes UI and HTTP work, not a general performance guarantee.",
    }),
  );
} finally {
  await browser.close();
}
