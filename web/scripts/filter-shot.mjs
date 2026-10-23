// Screenshot the run-filter typeahead against a running server.
// Usage (from web/): node scripts/filter-shot.mjs <url> <token> <outprefix>
import { chromium } from "@playwright/test";

const [url, token, out] = process.argv.slice(2);
const catalog = await (
  await fetch(`${url}/api/catalog`, { headers: { authorization: `Bearer ${token}` } })
).json();
const experiment = catalog.experiments.find((e) =>
  catalog.runs.some((r) => r.experiment_id === e.id),
);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${url}/#/experiments`);
await page.locator("#token").fill(token);
await page.locator("#login-form button[type=submit]").click();
await page.locator("#login-dialog").waitFor({ state: "hidden" });
await page.goto(`${url}/#/experiments/${encodeURIComponent(experiment.id)}/runs`);
await page
  .getByRole("checkbox", { name: "Select all matching runs", exact: true })
  .check();
await page.getByRole("button", { name: "View charts", exact: true }).click();
await page.locator(".dashboard-cell canvas").first().waitFor({ timeout: 20000 });
// The run filter lives in the dashboard's run drawer.
const filter = page.getByLabel("Filter runs by config or tags", { exact: true });
if (!(await filter.isVisible())) await page.locator(".run-pane-toggle").click();
await filter.click();
await page.getByRole("button", { name: "+ Add condition", exact: true }).click();
const path = page.getByLabel("Condition 1 path", { exact: true });
await path.focus();
await page.waitForTimeout(200);
const listOnFocus = await page.locator(".suggest-option").allTextContents();
await page.screenshot({ path: `${out}-focus.png` });
await path.pressSequentially("tr");
await page.waitForTimeout(200);
const listTyped = await page.locator(".suggest-option").allTextContents();
await page.screenshot({ path: `${out}-typed.png` });
await page.keyboard.press("Tab");
await page.waitForTimeout(200);
const afterTab = await path.inputValue();
await page.screenshot({ path: `${out}-tab.png` });
console.log(JSON.stringify({ listOnFocus, listTyped, afterTab }, null, 1));
await browser.close();
