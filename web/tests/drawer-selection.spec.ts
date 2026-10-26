import { writeFile } from "node:fs/promises";
import { test, expect, type Page, type TestInfo } from "@playwright/test";

const runs = Array.from({ length: 120 }, (_, index) => ({
  id: `run-${index}`,
  experiment_id: "cohort",
  name: `${index % 10 === 0 ? "Baseline" : "Training"} ${String(index).padStart(3, "0")}`,
  status: index % 2 ? "running" : "finished",
  params: {
    seed: index,
    family: [0, 10, 20].includes(index) ? "seed-family" : "other",
  },
  tags: {},
  created_at: 1700000000000 + index,
  updated_at: 1700000000000 + index,
}));
const selectedIds = runs
  .filter((run) => run.name.startsWith("Baseline"))
  .map((run) => run.id);

async function fixture(page: Page) {
  let histories = 0;
  let requests = 0;
  await page.route("**/api/**", async (route) => {
    requests++;
    const url = new URL(route.request().url());
    if (url.pathname === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [
            {
              id: "cohort",
              name: "Cohort workspace",
              created_at: 1700000000000,
            },
          ],
          runs,
          series: runs.map((run) => ({
            run_id: run.id,
            key: "train/loss",
            kind: "metric",
            count: 3,
            last_step: 2,
            last_timestamp: run.created_at,
            last_value: 1,
          })),
        },
      });
    if (url.pathname.endsWith("/metrics")) {
      histories++;
      return route.fulfill({
        json: {
          points: [0, 1, 2].map((step) => ({
            seq: step + 1,
            step,
            timestamp: 1700000000000 + step,
            value: 3 - step,
          })),
          total: 3,
          snapshot: 3,
          next_after: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await page.getByLabel("Access token", { exact: true }).fill("fixture");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Cohort workspace", exact: true })
    .click();
  await page
    .getByPlaceholder("Search runs, parameters or tags")
    .fill("Baseline");
  for (const run of runs.filter((run) => selectedIds.includes(run.id)))
    await page
      .getByRole("checkbox", { name: `Select ${run.name}`, exact: true })
      .check();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await page.locator(".dashboard-cell canvas").first().waitFor();
  if (await page.getByLabel("Expand run list").isVisible())
    await page.getByLabel("Expand run list").click();
  // Search is now shared with the table; clear it to browse the entire cohort.
  await page.getByLabel("Find runs", { exact: true }).fill("");
  await page.getByLabel("Find runs", { exact: true }).blur();
  await expect.poll(() => histories).toBe(12);
  return Object.assign(() => histories, { requests: () => requests });
}

async function filters(page: Page) {
  await page.getByLabel("Find runs", { exact: true }).fill("seed-family");
  await page.getByLabel("Filter chart runs by status").selectOption("finished");
  await expect(page.locator(".run-drawer-row:visible")).toHaveCount(3);
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: false,
  });
  const geometry = await page.locator(".run-drawer").evaluate((drawer) => {
    const box = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      drawer: box(drawer),
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      controls: [
        ...drawer.querySelectorAll(
          ".run-drawer-heading > *, input[type=search], select, .run-drawer-actions button, .drawer-clear-filters",
        ),
      ]
        .filter((node) => node.getClientRects().length)
        .map((node) => ({
          text: node.textContent || node.getAttribute("aria-label"),
          ...box(node),
          padding: getComputedStyle(node).padding,
          borderRadius: getComputedStyle(node).borderRadius,
          fontSize: getComputedStyle(node).fontSize,
        })),
      row: box(drawer.querySelector(".run-drawer-row:not([hidden])")!),
      list: box(drawer.querySelector(".run-drawer-list")!),
      headingGap: getComputedStyle(drawer.querySelector(".run-drawer-heading")!)
        .gap,
    };
  });
  await writeFile(
    info.outputPath(`${name}.json`),
    JSON.stringify(geometry, null, 2),
  );
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.row.height).toBeLessThanOrEqual(34);
  for (const control of geometry.controls) {
    expect(control.x).toBeGreaterThanOrEqual(geometry.drawer.x);
    expect(control.x + control.width).toBeLessThanOrEqual(
      geometry.drawer.x + geometry.drawer.width,
    );
  }
}

const drawer = (page: Page) => page.locator(".run-drawer");
const visibleRows = (page: Page) =>
  drawer(page).locator(".run-drawer-row:visible");
const toggle = (page: Page) => drawer(page).locator(".drawer-selection-count");
const choice = (page: Page, index: number) =>
  drawer(page).getByRole("checkbox", {
    name: `Show ${runs[index].name}`,
    exact: true,
  });
const savedSelection = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("nset.workspaces.v2")!).views[0]
        .selectedRunIds as string[],
  );

for (const width of [1440, 390]) {
  test(`narrowing updates selected cohort and clearing does not restore it at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const histories = await fixture(page);
    const check = await choice(page, 0).elementHandle();
    const before = histories();
    await filters(page);
    await expect(toggle(page)).toHaveText("Selected (3)");
    await expect(drawer(page).locator(".drawer-outside-count")).toBeHidden();
    expect((await savedSelection(page)).sort()).toEqual([
      "run-0",
      "run-10",
      "run-20",
    ]);
    await toggle(page).focus();
    await toggle(page).press("Space");
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(visibleRows(page)).toHaveCount(3);
    await capture(page, info, `selected-filtered-${width}`);
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await expect(page.getByLabel("Find runs", { exact: true })).toBeFocused();
    await expect(visibleRows(page)).toHaveCount(3);
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await capture(page, info, `selected-cohort-${width}`);
    expect((await savedSelection(page)).sort()).toEqual([
      "run-0",
      "run-10",
      "run-20",
    ]);
    expect(
      await choice(page, 0).evaluate((node, old) => node === old, check),
    ).toBe(true);
    await toggle(page).press("Enter");
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(visibleRows(page)).toHaveCount(120);
    expect(histories()).toBe(before); // Cached histories are reused, but chart scope changed.
  });
}

test("selected-only deselection focuses next, previous, then toggle when empty", async ({
  page,
}) => {
  await fixture(page);
  await toggle(page).click();
  await choice(page, 10).focus();
  await choice(page, 10).press("Space");
  await expect(choice(page, 0)).toBeFocused();
  await expect(toggle(page)).toHaveText("Selected (11)");
  await expect(visibleRows(page)).toHaveCount(11);
  await choice(page, 0).focus();
  await choice(page, 0).press("Space");
  await expect(choice(page, 20)).toBeFocused();
  await expect(toggle(page)).toHaveText("Selected (10)");
  while (await visibleRows(page).count()) {
    const first = visibleRows(page).first().getByRole("checkbox");
    await first.focus();
    await first.press("Space");
    if (await visibleRows(page).count())
      await expect(
        visibleRows(page).first().getByRole("checkbox"),
      ).toBeFocused();
  }
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveText("Selected (0)");
  await expect(drawer(page).locator(".drawer-empty")).toHaveText(
    "No runs selected. Turn off Selected to browse runs.",
  );
  expect(await savedSelection(page)).toEqual([]);
  await toggle(page).press("Space");
  await expect(visibleRows(page)).toHaveCount(120);
  await expect(drawer(page).locator(".drawer-empty")).toBeHidden();
});

test("selected-only storage failure keeps keyed checkbox, focus, counts and scroll", async ({
  page,
}) => {
  const histories = await fixture(page);
  await filters(page);
  await toggle(page).click();
  const check = choice(page, 10);
  await check.focus();
  const handle = await check.elementHandle();
  const before = histories();
  const scroll = await drawer(page)
    .locator(".run-drawer-list")
    .evaluate((node) => node.scrollTop);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "nset.workspaces.v2") throw new Error("Storage full");
      original.call(this, key, value);
    };
  });
  await check.press("Space");
  await expect(check).toBeChecked();
  await expect(check).toBeFocused();
  expect(await check.evaluate((node, old) => node === old, handle)).toBe(true);
  await expect(toggle(page)).toHaveText("Selected (3)");
  await expect(visibleRows(page)).toHaveCount(3);
  await expect(drawer(page).locator(".drawer-outside-count")).toBeHidden();
  await expect(page.locator("#global-error")).toContainText("Storage full");
  expect(
    await drawer(page)
      .locator(".run-drawer-list")
      .evaluate((node) => node.scrollTop),
  ).toBe(scroll);
  expect((await savedSelection(page)).sort()).toEqual([
    "run-0",
    "run-10",
    "run-20",
  ]);
  expect(histories()).toBe(before);
});

test("normal mode retains checkbox identity, Space and scroll; new matching selections exclude previously filtered runs", async ({
  page,
}) => {
  await fixture(page);
  const check = choice(page, 100);
  await check.scrollIntoViewIfNeeded();
  await check.focus();
  const handle = await check.elementHandle();
  const scroll = await drawer(page)
    .locator(".run-drawer-list")
    .evaluate((node) => node.scrollTop);
  for (const checked of [false, true]) {
    await check.press("Space");
    await expect(check).toBeChecked({ checked });
    await expect(check).toBeFocused();
    expect(await check.evaluate((node, old) => node === old, handle)).toBe(
      true,
    );
    expect(
      await drawer(page)
        .locator(".run-drawer-list")
        .evaluate((node) => node.scrollTop),
    ).toBe(scroll);
  }
  await page.getByLabel("Find runs", { exact: true }).fill("Training 001");
  await expect(toggle(page)).toHaveText("Selected (0)");
  await page
    .getByRole("button", { name: "Select matching", exact: true })
    .click();
  expect((await savedSelection(page)).sort()).toEqual(["run-1"]);
  await expect(toggle(page)).toHaveText("Selected (1)");
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  expect(await savedSelection(page)).toEqual([]);
  await expect(drawer(page).locator(".drawer-outside-count")).toBeHidden();
});

for (const width of [1440, 390]) {
  test(`selected mode survives collapse/reopen with focus and filters at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await fixture(page);
    await filters(page);
    await toggle(page).click();
    await choice(page, 10).focus();
    await choice(page, 10).press("Escape");
    await expect(drawer(page)).toBeHidden();
    await expect(page.getByLabel("Expand run list")).toBeFocused();
    await page.getByLabel("Expand run list").press("Enter");
    await expect(choice(page, 10)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Find runs", { exact: true })).toHaveValue(
      "seed-family",
    );
    await expect(visibleRows(page)).toHaveCount(3);
    if (width === 390) {
      const bounds = (await drawer(page).boundingBox())!;
      expect(bounds.x).toBe(0);
      expect(bounds.width).toBeLessThanOrEqual(350);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
      await toggle(page).focus();
      await toggle(page).press("Shift+Tab");
      await expect(page.getByLabel("Collapse run list")).toBeFocused();
      await page.getByLabel("Collapse run list").press("Tab");
      await expect(toggle(page)).toBeFocused();
    }
  });
}

for (const width of [1440, 390]) {
  test(`inspect and remove retained baseline after narrowing at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await fixture(page);
    await filters(page);
    let steps = 0;
    await toggle(page).click();
    steps++;
    await expect(visibleRows(page)).toHaveCount(3);
    await expect(drawer(page).locator(".drawer-outside-count")).toBeHidden();
    expect((await savedSelection(page)).sort()).toEqual([
      "run-0",
      "run-10",
      "run-20",
    ]);
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    steps++;
    const inspectRows = await visibleRows(page).count();
    expect(inspectRows).toBe(3);
    await choice(page, 10).focus();
    await choice(page, 10).press("Space");
    steps++;
    await expect(choice(page, 0)).toBeFocused();
    await expect(visibleRows(page)).toHaveCount(2);
    await expect(toggle(page)).toHaveText("Selected (2)");
    expect((await savedSelection(page)).sort()).toEqual(["run-0", "run-20"]);
    await capture(page, info, `after-removal-${width}`);
    await writeFile(
      info.outputPath("workflow.json"),
      JSON.stringify(
        {
          candidate: "shipped A",
          width,
          steps,
          inspectRows,
          remainingSelected: 2,
          caveat:
            "Three deliberate control activations, excluding pointing/focus and scan time; not a human timing study.",
        },
        null,
        2,
      ),
    );
  });
}

// Real touch capability, rather than merely a narrow desktop viewport.
test.describe("mobile drawer focus", () => {
  test.use({ hasTouch: true });
  for (const width of [390, 1024]) {
    test(`opening and reopening never autofocuses search at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await fixture(page);
      const search = page.getByLabel("Find runs", { exact: true });
      const close = page.getByLabel("Collapse run list", { exact: true });
      await expect(search).not.toBeFocused();
      await close.tap();
      await page.getByLabel("Expand run list", { exact: true }).tap();
      await expect(close).toBeFocused();
      await expect(search).not.toBeFocused();
      await search.tap();
      await expect(search).toBeFocused();
      await search.fill("Baseline");
      await search.press("Escape");
      await page.getByLabel("Expand run list", { exact: true }).tap();
      await expect(close).toBeFocused();
      await expect(search).not.toBeFocused();
      await expect(search).toHaveValue("Baseline");
      await page
        .getByRole("button", { name: "Clear filters", exact: true })
        .tap();
      await expect(search).not.toBeFocused();
      await search.tap();
      await expect(search).toBeFocused();
    });
  }
});
