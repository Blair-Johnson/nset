import { expect, test, type Page, type Route } from "@playwright/test";
import { newChart } from "../src/workspace";
import type { Run } from "../src/api";
import type { Catalog, Workspace } from "../src/workspace-types";

const viewId = "server:00000000-0000-0000-0000-000000000071";
async function fixture(page: Page, initialStatus: Run["status"] = "finished") {
  const run: Run = {
    id: "r1",
    experiment_id: "exp",
    name: "Training run",
    status: initialStatus,
    params: { layers: 2 },
    tags: {},
    created_at: 1,
    updated_at: 2,
  };
  const catalog: Catalog = {
    experiments: [{ id: "exp", name: "Status experiment", created_at: 1 }],
    runs: [run],
    metric_seq: 2,
    series: [
      {
        run_id: run.id,
        key: "loss",
        kind: "metric",
        count: 2,
        last_step: 1,
        last_timestamp: 2,
        last_value: 0.5,
      },
    ],
  };
  const chart = newChart("timeseries", ["loss"], "Training loss");
  chart.id = "loss";
  const workspace: Workspace = {
    version: 2,
    id: viewId,
    name: "Training",
    experimentId: "exp",
    selectedRunIds: [run.id],
    runLabels: { r1: "Two-layer model" },
    sections: [
      { id: "section", title: "Metrics", collapsed: false, cards: [chart] },
    ],
    updatedAt: 1,
  };
  const polls: Route[] = [];
  const patches: unknown[] = [];
  const unexpected: string[] = [];
  let cursor = 0;
  let fail = false;
  let holdPatch = false;
  let pendingPatch: { route: Route; saved: Run } | undefined;
  await page.addInitScript(() => sessionStorage.setItem("nset.token", "test"));
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = decodeURIComponent(new URL(req.url()).pathname);
    if (path === "/api/live") {
      if (req.method() === "GET")
        return route.fulfill({ json: { cursor: `live:${cursor}` } });
      polls.push(route);
      return;
    }
    if (path === "/api/catalog") return route.fulfill({ json: catalog });
    if (path === "/api/views")
      return route.fulfill({
        json: {
          views: [
            {
              id: viewId,
              name: workspace.name,
              experimentId: "exp",
              revision: 1,
              updatedAt: 1,
            },
          ],
        },
      });
    if (path === `/api/views/${viewId}`) {
      if (new URL(req.url()).searchParams.has("revision"))
        return route.fulfill({ status: 204 });
      return route.fulfill({ json: { id: viewId, revision: 1, workspace } });
    }
    if (path === "/api/runs/r1") {
      if (req.method() === "PATCH") {
        patches.push(req.postDataJSON());
        if (fail)
          return route.fulfill({
            status: 503,
            json: { error: "Temporary save failure" },
          });
        Object.assign(run, req.postDataJSON());
        run.updated_at++;
        if (holdPatch) {
          holdPatch = false;
          pendingPatch = { route, saved: structuredClone(run) };
          return;
        }
      }
      return route.fulfill({ json: run });
    }
    if (path === "/api/runs/r1/metrics")
      return route.fulfill({
        json: {
          points: [
            { seq: 1, step: 0, timestamp: 1, value: 1 },
            { seq: 2, step: 1, timestamp: 2, value: 0.5 },
          ],
          snapshot: 2,
          total: 2,
          next_after: null,
        },
      });
    unexpected.push(`${req.method()} ${path}`);
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected request" },
    });
  });
  await page.goto(`/#/views/${encodeURIComponent(viewId)}`);
  await expect(page.locator(".card-legend-name").first()).toHaveText(
    "Two-layer model",
  );
  return {
    patches,
    unexpected,
    workspace,
    fail(value: boolean) {
      fail = value;
    },
    holdPatch() {
      holdPatch = true;
    },
    async waitForPatch() {
      await expect.poll(() => !!pendingPatch).toBe(true);
    },
    async releasePatch() {
      await pendingPatch!.route.fulfill({ json: pendingPatch!.saved });
    },
    async status(status: Run["status"], sameTime = false, updatedAt?: number) {
      run.status = status;
      if (!sameTime) run.updated_at++;
      if (updatedAt !== undefined) run.updated_at = updatedAt;
      await expect.poll(() => polls.length).toBeGreaterThan(0);
      await polls.shift()!.fulfill({
        json: {
          cursor: `live:${++cursor}`,
          reset: false,
          changes: [{ kind: "catalog" }],
        },
      });
    },
  };
}

test("legend navigation and all three status surfaces share server state", async ({
  page,
}) => {
  const state = await fixture(page);
  const drawerPill = page.locator(".run-pane .run-status-pill");
  await expect(drawerPill).toContainText("Finished");
  await drawerPill.click();
  await page
    .getByRole("menuitemradio", { name: "Canceled", exact: true })
    .click();
  await expect(drawerPill).toContainText("Canceled");
  expect(state.patches).toEqual([{ status: "canceled" }]);
  await page.locator(".card-legend-details > summary").click();
  const name = page.locator(".card-legend a.card-legend-name").first();
  await expect(name).toHaveAttribute("href", "#/experiments/exp/runs/r1");
  await name.click();
  await expect(page.locator(".run-detail h1")).toHaveText("Training run");
  const detailPill = page.locator(".run-detail .run-status-pill");
  await expect(detailPill).toContainText("Canceled");
  await detailPill.click();
  await page
    .getByRole("menuitemradio", { name: "Failed", exact: true })
    .click();
  await expect(detailPill).toContainText("Failed");
  await expect(
    page.getByRole("button", { name: "← Runs", exact: true }),
  ).toHaveCount(0);
  await page
    .locator(".view-switch")
    .getByRole("button", { name: "Runs", exact: true })
    .click();
  const tablePill = page.locator("table .run-status-pill");
  await expect(tablePill).toContainText("Failed");
  await tablePill.click();
  await page
    .getByRole("menuitemradio", { name: "Running", exact: true })
    .click();
  await expect(tablePill).toContainText("Running");
  expect(state.patches).toEqual([
    { status: "canceled" },
    { status: "failed" },
    { status: "running" },
  ]);
  expect(state.unexpected).toEqual([]);
});

test("live status changes refresh detail pill without replacing an open tag editor", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.evaluate(() => {
    location.hash = "/experiments/exp/runs/r1";
  });
  await page.getByRole("button", { name: "+ Add tag", exact: true }).click();
  const value = page.getByRole("textbox", { name: "Tag value", exact: true });
  await value.fill("unsaved note");
  await state.status("running");
  await expect(page.locator(".run-detail .run-status-pill")).toContainText(
    "Running",
  );
  await expect(value).toHaveValue("unsaved note");
  await expect(value).toBeFocused();
  await state.status("canceled");
  await expect(page.locator(".run-detail .run-status-pill")).toContainText(
    "Canceled",
  );
  await expect(value).toHaveValue("unsaved note");
  expect(state.patches).toEqual([]);
});

test("failed status save retains prior value and allows retry without a page reload", async ({
  page,
}) => {
  const state = await fixture(page);
  state.fail(true);
  const pill = page.locator(".run-pane .run-status-pill");
  await pill.click();
  await page
    .getByRole("menuitemradio", { name: "Canceled", exact: true })
    .click();
  await expect(pill).toContainText("Finished");
  await expect(page.locator(".run-pane .run-status-error")).toContainText(
    "Temporary save failure",
  );
  state.fail(false);
  await pill.click();
  await page
    .getByRole("menuitemradio", { name: "Canceled", exact: true })
    .click();
  await expect(pill).toContainText("Canceled");
  await expect(page.locator(".run-pane .run-status-error")).toBeHidden();
});

test("a delayed save response cannot overwrite newer live status with the same timestamp", async ({
  page,
}) => {
  const state = await fixture(page, "running");
  state.holdPatch();
  const pill = page.locator(".run-pane .run-status-pill");
  await pill.click();
  await page
    .getByRole("menuitemradio", { name: "Canceled", exact: true })
    .click();
  await state.waitForPatch();
  await state.status("running", true);
  await expect(pill).toContainText("Running");
  await state.releasePatch();
  await expect(pill).toHaveAttribute("aria-busy", "false");
  await expect(pill).toContainText("Running");
});

test("a newer save response wins over an older live snapshot", async ({
  page,
}) => {
  const state = await fixture(page, "running");
  state.holdPatch();
  const pill = page.locator(".run-pane .run-status-pill");
  await pill.click();
  await page
    .getByRole("menuitemradio", { name: "Canceled", exact: true })
    .click();
  await state.waitForPatch();
  await state.status("failed", true, 2);
  await expect(pill).toContainText("Failed");
  await state.releasePatch();
  await expect(pill).toHaveAttribute("aria-busy", "false");
  await expect(pill).toContainText("Canceled");
});

test("delayed tag saves cannot roll back a newer status", async ({ page }) => {
  const state = await fixture(page, "running");
  await page.evaluate(() => {
    location.hash = "/experiments/exp/runs/r1";
  });
  await page.getByRole("button", { name: "+ Add tag", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Tag key", exact: true })
    .fill("owner");
  await page
    .getByRole("textbox", { name: "Tag value", exact: true })
    .fill("team");
  state.holdPatch();
  await page
    .getByRole("form", { name: "Add tag", exact: true })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await state.waitForPatch();
  const pill = page.locator(".run-detail .run-status-pill");
  await pill.click();
  await page
    .getByRole("menuitemradio", { name: "Canceled", exact: true })
    .click();
  await expect(pill).toContainText("Canceled");
  await state.releasePatch();
  await expect(
    page.getByRole("form", { name: "Add tag", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".run-detail-tag")).toContainText("team");
  await expect(pill).toContainText("Canceled");
});
