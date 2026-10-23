import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, reorder = false) {
  await page.route("**/__table_focus_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><button id="outside">Outside table</button><main></main><div style="height:2000px"></div></body></html>',
    }),
  );
  await page.goto("/__table_focus_fixture");
  await page.evaluate(async (reorder) => {
    const { runTable, tableState } = await import("/src/browser-tables.ts");
    const experiment = { id: "experiment", name: "Experiment", created_at: 0 };
    const runs = Array.from({ length: 60 }, (_, i) => ({
      id: `run-"${i}"`,
      experiment_id: experiment.id,
      name: "Duplicate name",
      status: "finished",
      params: { index: i },
      tags: { group: "matching" },
      created_at: i,
      updated_at: i,
    }));
    const state = tableState();
    state.descending = false;
    const selections: string[][] = [];
    const focusCalls: {
      runId?: string;
      selectAll: boolean;
      preventScroll?: boolean;
    }[] = [];
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (options) {
      if (this instanceof HTMLInputElement && this.closest(".run-table"))
        focusCalls.push({
          runId: this.dataset.runId,
          selectAll: this.dataset.selectAll !== undefined,
          preventScroll: options?.preventScroll,
        });
      focus.call(this, options);
    };
    (window as any).__table = { selections, focusCalls };
    document.querySelector("main")!.append(
      runTable(
        { experiments: [experiment], runs, series: [] } as any,
        experiment,
        ["other-experiment-run"],
        (ids: string[]) => {
          selections.push(ids);
          // Change row positions during a selection to catch index/name restoration.
          if (reorder) state.descending = !state.descending;
        },
        () => {},
        () => {},
        state,
      ),
    );
  }, reorder);
}
const run = (page: Page, index: number) =>
  page.locator(`tbody input[data-run-id='run-"${index}"']`);
const selections = (page: Page) =>
  page.evaluate(() => (window as any).__table.selections as string[][]);

test("Space preserves the same run checkbox through row reordering and duplicate names", async ({
  page,
}) => {
  await fixture(page, true);
  const checkbox = run(page, 20);
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await expect(checkbox).toBeFocused();
  expect((await selections(page)).at(-1)).toEqual([
    "other-experiment-run",
    'run-"20"',
  ]);
  await page.keyboard.press("Space");
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeFocused();
  expect((await selections(page)).at(-1)).toEqual(["other-experiment-run"]);
  await page.keyboard.press("Tab");
  await expect(
    checkbox
      .locator("xpath=ancestor::tr")
      .getByRole("button", { name: "Duplicate name", exact: true }),
  ).toBeFocused();
  const calls = await page.evaluate(() => (window as any).__table.focusCalls);
  expect(calls.slice(-2)).toEqual([
    { runId: 'run-"20"', selectAll: false, preventScroll: true },
    { runId: 'run-"20"', selectAll: false, preventScroll: true },
  ]);
});

test("select-all retains focus, covers all matching pages, and preserves other selections", async ({
  page,
}) => {
  await fixture(page);
  const all = page.getByRole("checkbox", {
    name: "Select all matching runs",
    exact: true,
  });
  await all.focus();
  await page.keyboard.press("Space");
  await expect(all).toBeChecked();
  await expect(all).toBeFocused();
  expect((await selections(page)).at(-1)).toHaveLength(61);
  await page.keyboard.press("Space");
  await expect(all).not.toBeChecked();
  await expect(all).toBeFocused();
  expect((await selections(page)).at(-1)).toEqual(["other-experiment-run"]);
  await page.getByRole("searchbox").fill('"index":20');
  await run(page, 20).focus();
  await page.keyboard.press("Space");
  await expect(run(page, 20)).toBeFocused();
  await page.getByRole("searchbox").fill("matching");
  await expect(all).toHaveJSProperty("indeterminate", true);
  await all.focus();
  await page.keyboard.press("Space");
  await expect(all).toBeChecked();
  await expect(all).toBeFocused();
  expect((await selections(page)).at(-1)).toHaveLength(61);
  expect(
    await page.evaluate(() => (window as any).__table.focusCalls.at(-1)),
  ).toEqual({
    selectAll: true,
    preventScroll: true,
  });
});

for (const target of ["run", "all"]) {
  test(`${target} checkbox restoration does not scroll the page`, async ({
    page,
  }) => {
    await fixture(page);
    const checkbox =
      target === "run"
        ? run(page, 20)
        : page.getByRole("checkbox", {
            name: "Select all matching runs",
            exact: true,
          });
    await checkbox.evaluate((node: HTMLInputElement) =>
      node.focus({ preventScroll: true }),
    );
    await page.evaluate(() => window.scrollTo(0, 700));
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBe(700);
    await page.keyboard.press("Space");
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  });
}

test("render does not steal focus from search or an outside control", async ({
  page,
}) => {
  await fixture(page);
  const search = page.getByRole("searchbox");
  await search.fill("matching");
  await expect(search).toBeFocused();
  await page.locator("#outside").focus();
  await run(page, 20).evaluate((node: HTMLInputElement) => node.click());
  await expect(run(page, 20)).toBeChecked();
  await expect(page.locator("#outside")).toBeFocused();
});
