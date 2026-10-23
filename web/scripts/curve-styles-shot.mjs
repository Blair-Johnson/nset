// Screenshot curve styles on a step chart and an XY chart, zoomed, with points.
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
  .filter({ has: page.locator(".card-title", { hasText: /^loss$/ }) })
  .first();
await card.locator("canvas").waitFor({ timeout: 20000 });
await card.getByLabel("Chart actions", { exact: true }).click();
await card.getByRole("button", { name: "Edit chart", exact: true }).click();
const dialog = page.getByRole("dialog", { name: "Edit chart", exact: true });
await dialog.waitFor();
for (const fold of await dialog.locator("details").all())
  await fold.evaluate((n) => (n.open = true));
const defaults = dialog.locator(".ce-default-style");
await defaults.getByLabel("Points", { exact: true }).selectOption("true");
const zoom = async (from, to) => {
  // Shift+Ctrl+wheel zooms X only; the curve stays in the Y range.
  const box = await dialog.locator(".ce-preview-plot .u-over").boundingBox();
  await page.mouse.move(box.x + box.width * from, box.y + box.height * 0.5);
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  for (let i = 0; i < to; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(40);
  }
  await page.keyboard.up("Shift");
  for (let i = 0; i < 9; i++) {
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.88);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(40);
  }
  await page.keyboard.up("Control");
  await page.waitForTimeout(600);
};
for (const [mode, x, window] of [
  ["step", "param:step", [0.3, 14]],
  ["xy", "key:train/learning_rate", [0.45, 10]],
]) {
  await dialog.getByLabel("X", { exact: true }).selectOption(x);
  await page.waitForTimeout(1200);
  for (const style of ["matched", "spline", "stepped-after", "area"]) {
    await defaults.getByLabel("Curve style", { exact: true }).selectOption(style);
    await page.waitForTimeout(800);
    await dialog.locator(".ce-preview-plot .u-over").dblclick();
    await page.waitForTimeout(300);
    await zoom(...window);
    await dialog.locator(".ce-preview-plot").screenshot({ path: `${out}-${mode}-${style}.png` });
    console.log(mode, style);
  }
}
await defaults.getByLabel("Curve style", { exact: true }).selectOption("stepped-after");
await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
await dialog.waitFor({ state: "hidden" });
await page.waitForTimeout(1500);
await card.screenshot({ path: `${out}-saved-xy-steps.png` });
console.log("saved card");
await browser.close();
