// Repro: vertical drag that turns into a box drag; screenshot during and after.
// Usage (from web/): node scripts/zoom-drag-repro.mjs <url> <token> <outprefix>
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
const card = page.locator(".dashboard-cell").filter({ has: page.locator("canvas") }).first();
await card.locator("canvas").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(800);
const over = card.locator(".u-over");
const b = await over.boundingBox();
const sel = () =>
  card.locator(".u-select").evaluate((n) => {
    const s = getComputedStyle(n);
    return { style: n.getAttribute("style"), vis: s.visibility, root: n.closest(".uplot").className };
  });
const x0 = b.x + b.width * 0.5,
  y0 = b.y + b.height * 0.3;
await page.mouse.move(x0, y0);
await page.mouse.down();
await page.mouse.move(x0 + 2, y0 + 60, { steps: 6 }); // vertical → y band
await card.screenshot({ path: `${out}-1-vertical.png` });
console.log("vertical", JSON.stringify(await sel()));
await page.mouse.move(x0 + 160, y0 + 90, { steps: 10 }); // pull sideways → box
await card.screenshot({ path: `${out}-2-box.png` });
console.log("box", JSON.stringify(await sel()));
await page.mouse.up();
await page.waitForTimeout(700);
await card.screenshot({ path: `${out}-3-released.png` });
console.log("released", JSON.stringify(await sel()));
const extra = await card.evaluate((n) =>
  [...n.querySelectorAll("*")]
    .filter((e) => {
      const s = getComputedStyle(e);
      return /rgba?\(115, 190, 255|rgba?\(125, 211, 176/.test(s.backgroundColor) && s.visibility !== "hidden";
    })
    .map((e) => `${e.className} ${e.getAttribute("style")}`),
);
console.log("visible tinted elements after release", JSON.stringify(extra));
await browser.close();
