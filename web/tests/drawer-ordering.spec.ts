import { test, expect, type Page } from "@playwright/test";

const values = [2, undefined, 10, 2, null, 0];
const runs = values.map((value, index) => ({
  id: `run-${index}`,
  experiment_id: "ordering",
  name: `Run ${index}`,
  status: index % 2 ? "running" : "finished",
  params: value === undefined ? {} : { score: value },
  tags: {},
  created_at: 1700000000000 + index,
  updated_at: 1700000000000 + index,
}));
const otherRuns = runs
  .slice(0, 3)
  .map((run) => ({ ...run, id: `other-${run.id}`, experiment_id: "other" }));
const allRuns = [...runs, ...otherRuns];

async function fixture(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: ["ordering", "other"].map((id) => ({
            id,
            name: id,
            created_at: 1700000000000,
          })),
          runs: allRuns,
          series: allRuns
            .filter((run) => run.params.score != null)
            .map((run) => ({
              run_id: run.id,
              key: "loss",
              kind: "metric",
              count: 1,
              last_step: 0,
              last_timestamp: run.created_at,
              last_value: run.params.score,
            })),
        },
      });
    if (url.pathname.endsWith("/metrics"))
      return route.fulfill({
        json: {
          points: [{ seq: 1, step: 0, timestamp: 1700000000000, value: 1 }],
          total: 1,
          snapshot: 1,
          next_after: null,
        },
      });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await page
    .getByLabel("Access token", { exact: true })
    .fill("isolated-ordering-fixture");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "ordering", exact: true }).click();
  await expect(page.locator(".run-table")).toBeVisible();
}
const tableOrder = (page: Page) =>
  page
    .locator(".run-table tbody input[data-run-id]")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.runId!),
    );
const drawerOrder = (page: Page) =>
  page
    .locator(".run-drawer-row:visible")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.runId!),
    );
async function charts(page: Page) {
  await page
    .getByRole("navigation", { name: "Experiment views" })
    .getByRole("button", { name: "Charts", exact: true })
    .click();
  await expect(page.locator(".run-drawer")).toBeVisible();
}
async function table(page: Page) {
  await page
    .getByRole("navigation", { name: "Experiment views" })
    .getByRole("button", { name: "Runs", exact: true })
    .click();
  await expect(page.locator(".run-table")).toBeVisible();
}
async function sort(page: Page, key: string) {
  await page
    .locator(`.run-table button[data-sort-key=${JSON.stringify(key)}]`)
    .click();
}

test("added parameter reverse sort is shared with drawer and selected-only subsets", async ({
  page,
}) => {
  await fixture(page);
  await page.locator(".column-picker").locator("..").locator("summary").click();
  await page
    .locator(".column-picker")
    .getByRole("checkbox", { name: "score", exact: true })
    .check();
  await page.locator(".column-picker").locator("..").locator("summary").click();
  await sort(page, 'parameter:$["score"]');
  await sort(page, 'parameter:$["score"]');
  const expected = ["run-2", "run-0", "run-3", "run-5", "run-4", "run-1"];
  await expect.poll(() => tableOrder(page)).toEqual(expected);
  for (const index of [0, 2, 4])
    await page
      .getByRole("checkbox", { name: `Select Run ${index}`, exact: true })
      .check();
  await charts(page);
  await expect.poll(() => drawerOrder(page)).toEqual(expected);
  const selectionBefore = await page.evaluate(() =>
    localStorage.getItem("nset.workspaces.v2"),
  );
  await page.locator(".drawer-selection-count").click();
  await expect
    .poll(() => drawerOrder(page))
    .toEqual(["run-2", "run-0", "run-4"]);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("nset.workspaces.v2")))
    .toBe(selectionBefore);
  // Preserve the actual drawer/checkbox nodes when returning from a table sort.
  await page.locator('.run-drawer-row[data-run-id="run-0"]').evaluate((row) => {
    (window as any).orderingRow = row;
  });
  await table(page);
  await sort(page, 'parameter:$["score"]');
  await expect
    .poll(() => tableOrder(page))
    .toEqual(["run-5", "run-0", "run-3", "run-2", "run-4", "run-1"]);
  await charts(page);
  await expect
    .poll(() => drawerOrder(page))
    .toEqual(["run-0", "run-2", "run-4"]);
  expect(
    await page
      .locator('.run-drawer-row[data-run-id="run-0"]')
      .evaluate((row) => row === (window as any).orderingRow),
  ).toBe(true);
  await page.locator(".drawer-selection-count").click();
  await expect
    .poll(() => drawerOrder(page))
    .toEqual(["run-5", "run-0", "run-3", "run-2", "run-4", "run-1"]);
  await page.locator(".drawer-selection-count").click();
  const choice = (index: number) =>
    page.getByRole("checkbox", { name: `Show Run ${index}`, exact: true });
  await choice(2).focus();
  await choice(2).press("Space");
  await expect(choice(4)).toBeFocused();
  await choice(4).press("Space");
  await expect(choice(0)).toBeFocused();
  await choice(0).press("Space");
  await expect(page.locator(".drawer-selection-count")).toBeFocused();
  await expect.poll(() => drawerOrder(page)).toEqual([]);
});

test("metric, name and default sorts stay experiment-local across chart resumes", async ({
  page,
}) => {
  await fixture(page);
  const initial = await tableOrder(page);
  await charts(page);
  await expect.poll(() => drawerOrder(page)).toEqual(initial);
  await table(page);
  await sort(page, "metric:loss");
  await sort(page, "metric:loss");
  const descending = ["run-2", "run-0", "run-3", "run-5", "run-1", "run-4"];
  await expect.poll(() => tableOrder(page)).toEqual(descending);
  await charts(page);
  await expect.poll(() => drawerOrder(page)).toEqual(descending);
  await page.getByLabel("Find runs", { exact: true }).fill("Run 0");
  await expect.poll(() => drawerOrder(page)).toEqual(["run-0"]);
  await page.getByLabel("Find runs", { exact: true }).fill("");
  // A different experiment starts with its own default rather than this metric sort.
  await page.evaluate(() => {
    location.hash = "#/experiments/other";
  });
  await expect(page.locator(".run-table")).toBeVisible();
  const otherOrder = ["other-run-2", "other-run-1", "other-run-0"];
  await expect.poll(() => tableOrder(page)).toEqual(otherOrder);
  await charts(page);
  await expect.poll(() => drawerOrder(page)).toEqual(otherOrder);
  await page.evaluate(() => {
    location.hash = "#/experiments/ordering";
  });
  await expect(page.locator(".run-table")).toBeVisible();
  await expect.poll(() => tableOrder(page)).toEqual(descending);
  await sort(page, "name");
  const byName = await tableOrder(page);
  await charts(page);
  await expect.poll(() => drawerOrder(page)).toEqual(byName);
});
