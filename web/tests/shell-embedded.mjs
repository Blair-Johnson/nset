import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const output = "artifacts/shell-embedded";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(process.env.NSET_SHELL_URL);
  await page
    .getByLabel("Access token", { exact: true })
    .fill(process.env.NSET_SHELL_TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Dense embedded workspace", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  await expect(page.locator(".selection-count")).toHaveText("60 selected");
  const rowHeight = (
    await page.locator(".run-table tbody tr").first().boundingBox()
  ).height;
  expect(rowHeight).toBeLessThanOrEqual(34);
  await page.screenshot({
    path: `${output}/table-desktop.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  const card = page.locator(".dashboard-cell").first();
  await card.locator("canvas").waitFor();
  await expect(page.locator(".run-drawer-row")).toHaveCount(60);
  const contentY = (
    await page.locator(".section-heading").first().boundingBox()
  ).y;
  expect(contentY).toBeLessThanOrEqual(140);
  const canvas = await card.locator("canvas").elementHandle();
  await card.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page
    .locator(".run-drawer")
    .getByRole("button", { name: "Run 00 training", exact: true })
    .click();
  await expect(page.locator(".run-detail")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Experiment views" })
    .getByRole("button", { name: "Charts", exact: true })
    .click();
  expect(
    await card.locator("canvas").evaluate((node, old) => node === old, canvas),
  ).toBe(true);
  await expect(
    card.getByRole("button", { name: "Previous view", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: `${output}/drawer-desktop.png`,
    fullPage: true,
  });
  const resize = card.getByRole("button", {
    name: "Resize chart",
    exact: true,
  });
  await resize.focus();
  await resize.press("ArrowRight");
  await resize.press("ArrowDown");
  const layout = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("nset.workspaces.v2")).views[0]
        .sections[0].cards[0].layout,
  );
  await card
    .getByRole("button", { name: "Maximize chart", exact: true })
    .click();
  await page.screenshot({ path: `${output}/maximized.png`, fullPage: true });
  await card
    .getByRole("button", { name: "Restore chart", exact: true })
    .click();
  await page.reload();
  await page.locator(".dashboard-cell canvas").first().waitFor();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("nset.workspaces.v2")).views[0]
          .sections[0].cards[0].layout,
    ),
  ).toEqual(layout);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".run-drawer")).toBeHidden();
  await page.getByLabel("Toggle runs drawer").click();
  await expect(page.getByRole("dialog", { name: "Chart runs" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${output}/drawer-390.png`, fullPage: true });
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      kind: "final",
      metrics: {
        runs: 60,
        table_row_height: rowHeight,
        first_content_y: contentY,
        page_errors: errors.length,
        persisted_width: layout.width,
        persisted_height: layout.height,
      },
      artifacts: { directory: output },
      evidence:
        "Actual embedded Rust assets/API; computed layout and DOM identity assertions; screenshots retained, not visually reviewed",
    }),
  );
} finally {
  await browser.close();
}
