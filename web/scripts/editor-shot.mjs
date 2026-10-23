// Screenshot the chart editor for review against a running server.
// Usage (from web/): node scripts/editor-shot.mjs <url> <token> <outprefix> [scenario]
// Writes <outprefix>.png (dialog) and <outprefix>-full.png (scrolled settings).
import { chromium } from "@playwright/test";

const [url, token, out, scenario = "open"] = process.argv.slice(2);
const catalog = await (
  await fetch(`${url}/api/catalog`, { headers: { authorization: `Bearer ${token}` } })
).json();
const experiment = catalog.experiments.find((e) =>
  catalog.runs.some((r) => r.experiment_id === e.id),
);
const runIds = catalog.runs
  .filter((r) => r.experiment_id === experiment.id)
  .map((r) => r.id);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`${url}/#/experiments`);
await page.locator("#token").fill(token);
await page.locator("#login-form button[type=submit]").click();
await page.locator("#login-dialog").waitFor({ state: "hidden" });
// Select every run in the experiment's table, then open charts.
await page.goto(`${url}/#/experiments/${encodeURIComponent(experiment.id)}/runs`);
await page
  .getByRole("checkbox", { name: "Select all matching runs", exact: true })
  .check();
await page.getByRole("button", { name: "View charts", exact: true }).click();
const card = page
  .locator(".dashboard-cell")
  .filter({ has: page.locator(".card-title", { hasText: /^loss$/ }) })
  .first();
await card.locator("canvas").waitFor({ timeout: 20000 });
await card.getByLabel("Chart actions", { exact: true }).click();
await card.getByRole("button", { name: "Edit chart", exact: true }).click();
const dialog = page.getByRole("dialog", { name: "Edit chart", exact: true });
await dialog.waitFor();
if (scenario === "xy") {
  const x = dialog.getByLabel("X", { exact: true });
  await x.selectOption("key:train/learning_rate");
}
if (scenario === "open-folds")
  for (const fold of await dialog.locator("details.ce-fold").all())
    await fold.evaluate((n) => (n.open = true));
await page.waitForTimeout(1500);
await dialog.screenshot({ path: `${out}.png` });
const settings = dialog.locator(".ce-settings");
const [sh, ch] = await settings.evaluate((n) => [n.scrollHeight, n.clientHeight]);
await settings.evaluate((n) => {
  n.style.maxHeight = "none";
  n.style.overflow = "visible";
});
await settings.screenshot({ path: `${out}-full.png` });
console.log(`${out}.png settings scroll/client ${sh}/${ch}; runs ${runIds.length}`);
await browser.close();
