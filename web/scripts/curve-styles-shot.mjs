// Screenshot the editor preview for each default "Curve style".
// Usage (from web/): node scripts/curve-styles-shot.mjs <url> <token> <outprefix>
import { chromium } from "@playwright/test";

const [url, token, out] = process.argv.slice(2);
const catalog = await (
  await fetch(`${url}/api/catalog`, { headers: { authorization: `Bearer ${token}` } })
).json();
const experiment = catalog.experiments.find((e) =>
  catalog.runs.some((r) => r.experiment_id === e.id),
);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`${url}/#/experiments`);
await page.locator("#token").fill(token);
await page.locator("#login-form button[type=submit]").click();
await page.locator("#login-dialog").waitFor({ state: "hidden" });
await page.goto(`${url}/#/experiments/${encodeURIComponent(experiment.id)}/runs`);
await page
  .getByRole("checkbox", { name: "Select all matching runs", exact: true })
  .check();
await page.getByRole("button", { name: "View charts", exact: true }).click();
const card = page
  .locator(".dashboard-cell")
  .filter({ has: page.locator(".card-title", { hasText: /^learning_rate$/ }) })
  .first();
await card.locator("canvas").waitFor({ timeout: 20000 });
await card.getByLabel("Chart actions", { exact: true }).click();
await card.getByRole("button", { name: "Edit chart", exact: true }).click();
const dialog = page.getByRole("dialog", { name: "Edit chart", exact: true });
await dialog.waitFor();
for (const fold of await dialog.locator("details").all())
  await fold.evaluate((n) => (n.open = true));
const style = dialog.locator(".ce-default-style").getByLabel("Curve style", { exact: true });
const values = await style.locator("option").evaluateAll((o) => o.map((x) => x.value));
for (const value of values) {
  await style.selectOption(value);
  await page.waitForTimeout(900);
  const info = await page.evaluate(() => {
    const series = [...document.querySelectorAll(".ce-preview .u-legend .u-series")].length;
    return { warnings: document.querySelector(".ce-preview .ce-help")?.textContent ?? "" };
  });
  await dialog.locator(".ce-preview-plot").screenshot({ path: `${out}-${value}.png` });
  console.log(value, JSON.stringify(info).slice(0, 300));
}
await browser.close();
