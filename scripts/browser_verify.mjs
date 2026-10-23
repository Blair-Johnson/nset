import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pixelStats } from "./pixels.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "web/package.json"));
const { chromium } = require("playwright");
const { expect } = require("@playwright/test");
const artifacts = path.join(root, "artifacts/screenshots");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1500, height: 1100 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const screenshot = (name) =>
  page.screenshot({
    path: path.join(artifacts, name + ".png"),
    fullPage: true,
  });
const card = (title) =>
  page.locator(".dashboard-cell").filter({
    has: page.locator(".card-title", {
      hasText: new RegExp("^" + title + "$"),
    }),
  });
const positions = async (root) => {
  const editor = root.locator(".card-position-editor");
  if (!(await editor.evaluate((node) => node.open)))
    await editor.locator("summary").click();
};
const coordinate = async (root, label, value) => {
  await positions(root);
  await root.getByLabel(label, { exact: true }).fill(String(value));
  await root.getByLabel(label, { exact: true }).press("Tab");
  await root.locator(".card-position-editor > summary").click();
};
const value = async (root, run, column) => {
  const details = root.locator(".card-series-details");
  if (!(await details.evaluate((node) => node.open)))
    await details.locator(":scope > summary").click();
  return Number(
    await root
      .locator(".card-value-table tr")
      .filter({ hasText: run })
      .locator("td")
      .nth(column)
      .innerText(),
  );
};
const edit = async (root) => {
  await root.getByLabel("Chart actions", { exact: true }).click();
  await root.getByRole("button", { name: "Edit chart", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit chart", exact: true }).waitFor();
  return page.getByRole("dialog", { name: "Edit chart", exact: true });
};
try {
  await page.goto(process.env.NSET_BROWSER_URL);
  const theme = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body).backgroundColor,
  }));
  assert.equal(theme.scheme, "dark");
  assert.ok(
    Math.max(...theme.background.match(/\d+/g).map(Number)) < 65,
    "embedded app uses charcoal surfaces",
  );
  await page
    .getByLabel("Access token", { exact: true })
    .fill(process.env.NSET_BROWSER_TOKEN);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#connection")).toHaveText("Connected");
  await expect(
    page.getByRole("heading", { name: "Experiments", exact: true }),
  ).toBeVisible();
  await screenshot("ux-01-experiments");
  await page
    .getByRole("button", { name: "Browser verification", exact: true })
    .click();
  await expect(
    page.getByRole("table", { name: "Runs", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  await expect(page.locator(".selection-count")).toHaveText("2 selected");
  await screenshot("ux-02-runs");
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  const loss = card("loss"),
    image = card("prediction"),
    score = card("score");
  await loss.locator("canvas").waitFor();
  await score.locator("canvas").waitFor();
  await expect(image.locator(".frame-info")).toContainText("1 / 4");
  assert.equal(
    await page.getByRole("tab", { name: "Images", exact: true }).count(),
    0,
  );
  assert.equal(await loss.locator(".card-inspection").isVisible(), false);
  assert.ok(
    !/raw-derived|canonical|authoritative snapshot/i.test(
      await page.locator("#page").innerText(),
    ),
  );
  const train = page
    .locator(".chart-section")
    .filter({ has: page.locator(".section-toggle", { hasText: "train" }) });
  await expect(train.locator(".dashboard-cell")).toHaveCount(2);
  await screenshot("ux-03-mixed-dashboard");
  await loss.locator(".u-over").hover();
  await page.keyboard.press("c");
  await expect(loss.locator(".uplot")).toHaveAttribute(
    "data-cursor-placement",
    "vertical",
  );
  await coordinate(loss, "Cursor A coordinate", 5);
  await coordinate(loss, "Cursor B coordinate", 10);
  assert.equal(await value(loss, "Curve A", 0), 2);
  assert.equal(await value(loss, "Curve A", 1), 3);
  assert.equal(await value(loss, "Curve B", 0), 2);
  const answers = await loss.locator(".card-value-table").textContent();
  await loss.getByRole("button", { name: "Zoom in", exact: true }).click();
  await loss.getByRole("button", { name: "Zoom out", exact: true }).click();
  await loss
    .getByRole("button", { name: "Fit configured range", exact: true })
    .click();
  assert.equal(await loss.locator(".card-value-table").textContent(), answers);
  const surface = loss.locator(".u-over");
  const bounds = await surface.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width * 0.5,
    bounds.y + bounds.height * 0.5,
  );
  await page.mouse.down({ button: "right" });
  await expect(loss.locator(".uplot")).toHaveClass(/plot-pan-hover-hidden/);
  await page.mouse.move(
    bounds.x + bounds.width * 0.65,
    bounds.y + bounds.height * 0.55,
    { steps: 5 },
  );
  await page.mouse.up({ button: "right" });
  await loss
    .getByRole("button", { name: "Previous view", exact: true })
    .click();
  await loss.locator(".uplot").focus();
  await page.keyboard.press("+");
  await page.keyboard.press("0");
  await loss
    .getByRole("button", { name: "Add vertical cursor", exact: true })
    .click();
  assert.equal(await loss.locator(".card-value-table").textContent(), answers);
  await loss.locator(".u-over").hover();
  await page.keyboard.press("c");
  await expect(loss.locator(".uplot")).toHaveAttribute(
    "data-cursor-placement",
    "horizontal",
  );
  await coordinate(loss, "Cursor A level", 2);
  const crossingDetails = loss.locator(".card-series-details");
  if (!(await crossingDetails.evaluate((node) => node.open)))
    await crossingDetails.locator(":scope > summary").click();
  const aCross = loss.locator(".card-crossings").filter({ hasText: "Curve A" }),
    bCross = loss.locator(".card-crossings").filter({ hasText: "Curve B" });
  await aCross.locator("summary").click();
  await bCross.locator("summary").click();
  await expect(aCross).toContainText("5, 15");
  await expect(bCross).toContainText("0 – 5");
  await coordinate(loss, "Cursor B level", 3);
  await expect(loss.locator(".card-position-readout output").last()).toHaveText(
    "1",
  );
  await screenshot("ux-04-cursors");
  await score
    .locator("canvas")
    .evaluate((el) => (window.__neighborCanvas = el));
  let editor = await edit(loss);
  await editor
    .getByRole("heading", { name: "Axes", exact: true })
    .scrollIntoViewIfNeeded();
  await editor.getByLabel("Y scale", { exact: true }).selectOption("log");
  await screenshot("ux-05-chart-editor");
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await editor.waitFor({ state: "hidden" });
  await loss.locator("canvas").waitFor();
  assert.equal(
    await score
      .locator("canvas")
      .evaluate((el) => el === window.__neighborCanvas),
    true,
    "editing a chart does not remount its neighbor",
  );
  await loss
    .getByRole("button", { name: "Add vertical cursor", exact: true })
    .click();
  await coordinate(loss, "Cursor A coordinate", 5);
  await coordinate(loss, "Cursor B coordinate", 10);
  assert.equal(await value(loss, "Curve A", 0), 2);
  await screenshot("ux-06-log-and-inspect");
  editor = await edit(loss);
  await editor
    .getByLabel("Chart title", { exact: true })
    .fill("Discard this title");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(loss.locator(".card-title")).toHaveText("loss");
  editor = await edit(loss);
  await editor
    .getByRole("heading", { name: "Appearance", exact: true })
    .scrollIntoViewIfNeeded();
  await editor
    .getByLabel("Between observations", { exact: true })
    .selectOption("pchip");
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await editor.waitFor({ state: "hidden" });
  await loss.locator("canvas").waitFor();
  await loss
    .getByRole("button", { name: "Add vertical cursor", exact: true })
    .click();
  await coordinate(loss, "Cursor A coordinate", 5);
  assert.equal(await value(loss, "Curve A", 0), 2.5);
  editor = await edit(loss);
  await editor
    .getByRole("heading", { name: "Appearance", exact: true })
    .scrollIntoViewIfNeeded();
  await editor
    .getByLabel("Between observations", { exact: true })
    .selectOption("linear");
  await editor
    .getByRole("slider", { name: "Smoothing strength", exact: true })
    .fill("50");
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await editor.waitFor({ state: "hidden" });
  await loss.locator("canvas").waitFor();
  await loss
    .getByRole("button", { name: "Add vertical cursor", exact: true })
    .click();
  await coordinate(loss, "Cursor A coordinate", 5);
  assert.equal(await value(loss, "Curve A", 0), 1.1);
  editor = await edit(loss);
  await editor
    .getByRole("heading", { name: "Appearance", exact: true })
    .scrollIntoViewIfNeeded();
  await editor
    .getByRole("slider", { name: "Smoothing strength", exact: true })
    .fill("0");
  await editor
    .getByRole("heading", { name: "Axes", exact: true })
    .scrollIntoViewIfNeeded();
  await editor.getByLabel("Y scale", { exact: true }).selectOption("linear");
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await editor.waitFor({ state: "hidden" });
  await loss.locator("canvas").waitFor();
  await loss
    .getByRole("button", { name: "Add vertical cursor", exact: true })
    .click();
  await positions(loss);
  await loss
    .getByRole("button", { name: "Clear cursors", exact: true })
    .click();
  const plotPixels = await pixelStats(page, loss.locator(".u-over"));
  assert.ok(
    plotPixels.blue > 50 && plotPixels.violet > 50,
    "both actual curve colors are rendered",
  );
  const fixture = JSON.parse(process.env.NSET_BROWSER_FIXTURE);
  const imageCanvas = await image.locator(".image-canvas").elementHandle();
  for (const [axis, x, expected] of [
    ["relative", 5000, 2],
    ["timestamp", fixture.startA + 5000, 2],
    ["step", 5, 2],
  ]) {
    await page
      .getByLabel("Dashboard X axis", { exact: true })
      .selectOption(axis);
    await loss.locator("canvas").waitFor();
    await loss
      .getByRole("button", { name: "Add vertical cursor", exact: true })
      .click();
    await coordinate(loss, "Cursor A coordinate", x);
    assert.equal(await value(loss, "Curve A", 0), expected);
  }
  await page.getByLabel("Dashboard smoothing", { exact: true }).fill("50");
  await loss.locator("canvas").waitFor();
  await loss
    .getByRole("button", { name: "Add vertical cursor", exact: true })
    .click();
  await coordinate(loss, "Cursor A coordinate", 5);
  assert.equal(await value(loss, "Curve A", 0), 1.1);
  await page.getByLabel("Dashboard smoothing", { exact: true }).fill("0");
  await loss.locator("canvas").waitFor();
  assert.equal(
    await image
      .locator(".image-canvas")
      .evaluate((el, old) => el === old, imageCanvas),
    true,
    "global scalar settings preserve the mounted image viewer",
  );
  await screenshot("ux-06-global-controls");
  await page.locator("details[data-menu=add] summary").click();
  await page.getByRole("button", { name: "Line plot", exact: true }).click();
  editor = page.getByRole("dialog", { name: "Add chart", exact: true });
  await editor.waitFor();
  await editor
    .getByLabel("Chart title", { exact: true })
    .fill("Cross-experiment comparison");
  await editor
    .getByLabel("Data sources", { exact: true })
    .selectOption("explicit");
  await editor
    .getByLabel("Find metrics", { exact: true })
    .fill("Remote baseline");
  await editor.getByRole("checkbox", { name: /Remote baseline/ }).check();
  await editor.getByLabel("Find metrics", { exact: true }).fill("Curve A");
  await editor
    .getByRole("checkbox", {
      name: /train\/loss.*Curve A|Curve A.*train\/loss/,
    })
    .check();
  await editor.locator(".ce-preview-plot canvas").waitFor();
  await screenshot("ux-07-custom-series");
  await editor.getByRole("button", { name: "Add chart", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
  const custom = card("Cross-experiment comparison");
  await custom.scrollIntoViewIfNeeded();
  await custom.locator("canvas").waitFor();
  await custom
    .getByRole("button", { name: "Add vertical cursor", exact: true })
    .click();
  await coordinate(custom, "Cursor A coordinate", 5);
  assert.equal(await value(custom, "Curve A", 0), 2);
  assert.equal(await value(custom, "Remote baseline", 0), 3);
  await page.getByLabel("View actions", { exact: true }).click();
  await page
    .getByRole("button", { name: "Save view as…", exact: true })
    .click();
  const saveDialog = page.getByRole("dialog", {
    name: "Save view as",
    exact: true,
  });
  await saveDialog
    .getByLabel("View name", { exact: true })
    .fill("My comparison");
  await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByLabel("Saved view", { exact: true }).locator("option:checked"),
  ).toHaveText("My comparison");
  await page.getByLabel("View actions", { exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export view", exact: true }).click();
  const downloaded = await downloading;
  await downloaded.saveAs(path.join(artifacts, "workspace.json"));
  const exported = await readFile(
    path.join(artifacts, "workspace.json"),
    "utf8",
  );
  assert.ok(!exported.includes(process.env.NSET_BROWSER_TOKEN));
  assert.equal(JSON.parse(exported).version, 2);
  await page.reload();
  await expect(page.locator("#connection")).toHaveText("Connected");
  await expect(
    page.getByLabel("Saved view", { exact: true }).locator("option:checked"),
  ).toHaveText("My comparison");
  await expect(card("Cross-experiment comparison")).toHaveCount(1);
  const beforeImport = await page
    .getByLabel("Saved view", { exact: true })
    .inputValue();
  await page.getByLabel("View actions", { exact: true }).click();
  await page
    .getByLabel("Import view file", { exact: true })
    .setInputFiles(path.join(artifacts, "workspace.json"));
  await expect(page.getByLabel("Saved view", { exact: true })).not.toHaveValue(
    beforeImport,
  );
  await expect(card("Cross-experiment comparison")).toHaveCount(1);
  await expect(page.locator("#global-error")).toBeHidden();
  await image.scrollIntoViewIfNeeded();
  await expect(image.locator(".frame-info")).toContainText("1 / 4");
  const imageViewer = image.locator("[data-role=image-viewer]");
  await image.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.waitForTimeout(250);
  const before = await imageViewer.evaluate((el) => ({ ...el.dataset }));
  await image.getByLabel("Image frame timeline", { exact: true }).fill("2");
  await expect(image.locator(".frame-info")).toContainText("3 / 4");
  await page.waitForTimeout(150);
  const after = await imageViewer.evaluate((el) => ({ ...el.dataset }));
  for (const key of ["zoom", "centerX", "centerY"])
    assert.ok(
      Math.abs(Number(before[key]) - Number(after[key])) < 1e-8,
      `camera ${key} stable while scrubbing`,
    );
  await image
    .getByRole("button", { name: "Maximize chart", exact: true })
    .click();
  await expect(
    image.getByLabel("Image frame timeline", { exact: true }),
  ).toBeVisible();
  await image.getByRole("button", { name: "← Previous", exact: true }).click();
  await expect(image.locator(".frame-info")).toContainText("2 / 4");
  await screenshot("ux-08-image-maximized");
  await image
    .getByRole("button", { name: "Restore chart", exact: true })
    .click();
  await image.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(250);
  const imagePixels = await pixelStats(page, imageViewer);
  assert.ok(
    imagePixels.gold > 100 && imagePixels.blue > 1000,
    "image features are decoded and rendered",
  );
  await image.getByLabel("Chart actions", { exact: true }).click();
  await image.getByRole("button", { name: "Duplicate", exact: true }).click();
  const copy = card("prediction copy");
  await copy.scrollIntoViewIfNeeded();
  await expect(copy.locator(".frame-info")).toContainText("1 / 4");
  await copy.getByLabel("Image frame timeline", { exact: true }).fill("3");
  await expect(copy.locator(".frame-info")).toContainText("4 / 4");
  await expect(image.locator(".frame-info")).toContainText("2 / 4");
  await screenshot("ux-09-independent-images");
  await page.setViewportSize({ width: 820, height: 1050 });
  await page.evaluate(() => scrollTo(0, 0));
  await screenshot("ux-10-narrow-dashboard");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 2,
    ),
    false,
    "no horizontal page overflow",
  );
  await page.locator("#logout").click();
  await page.locator("#login-dialog").waitFor({ state: "visible" });
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("nset.token")),
    null,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      kind: "final",
      phase: "ux-browser",
      status: "passed",
      assertions: [
        "bundled dark theme",
        "experiment/run tables",
        "namespace mixed cards",
        "direct cursors and all crossings",
        "pan/zoom/fit/keyboard invariance",
        "per-chart log/PCHIP/EMA editing",
        "global step/wall/relative axes and smoothing preserve image viewer",
        "cancel and neighbor preservation",
        "cross-experiment custom sources",
        "named views reload import export",
        "image camera and maximize",
        "independent image cards",
        "responsive layout",
        "token cleanup",
      ],
      rendered_pixels: { plot: plotPixels, image: imagePixels },
      screenshots: artifacts,
    }),
  );
} catch (error) {
  await screenshot("ux-failure");
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
