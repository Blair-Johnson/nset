import { expect, test, type Page } from "@playwright/test";

const experimentId = "curated-study";
const runIds = ["run/one", "run/two", "run/unselected"];
const workspaceId = "curated-legend-controls";
const workspaceKey = "nset.workspaces.v2";
const colorKey = "nset:run-colors:v1";
const keys = ["train/loss", "eval/loss"];
const primary = (page: Page) =>
  page.locator('[data-card-id="curated-primary"]');
const identities = (page: Page, runId: string) =>
  page.locator(`.card-legend .card-series-identity[data-run-id="${runId}"]`);
const drawerRow = (page: Page, runId: string) =>
  page.locator(`.run-drawer-row[data-run-id="${runId}"]`);

async function savedWorkspace(page: Page) {
  return page.evaluate(
    ({ workspaceKey, workspaceId }) =>
      JSON.parse(localStorage.getItem(workspaceKey)!).views.find(
        (view: { id: string }) => view.id === workspaceId,
      ),
    { workspaceKey, workspaceId },
  );
}

async function openLegends(page: Page) {
  for (const legend of await page.locator(".card-legend-details").all()) {
    if ((await legend.getAttribute("open")) === null)
      await legend.locator("summary").click();
  }
}

async function fixture(page: Page) {
  // Observe actual curve drawing as well as the legend's derived color.
  await page.addInitScript(() => {
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    CanvasRenderingContext2D.prototype.stroke = function (...args: any[]) {
      if (
        this.strokeStyle === "#123456" &&
        this.canvas instanceof HTMLCanvasElement
      )
        this.canvas.dataset.curatedColor = "#123456";
      return (stroke as any).apply(this, args);
    };
  });
  await page.route("**/__curated_setup", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/__curated_setup");
  await page.evaluate(
    async ({ experimentId, runIds, workspaceId, workspaceKey, keys }) => {
      const { newChart, seriesId } = await import("/src/workspace.ts");
      const curated = newChart("timeseries", [], "Curated comparison");
      curated.id = "curated-primary";
      curated.source = {
        mode: "explicit",
        series: runIds.flatMap((runId) =>
          keys.map((key) => ({ runId, key, kind: "metric" as const })),
        ),
      };
      curated.config.runs[seriesId(curated.source.series[0])] = {
        dash: [4, 2],
        alpha: 0.5,
        width: 3,
      };
      const sibling = newChart("timeseries", [keys[1]], "Selected comparison");
      sibling.id = "selected-sibling";
      const workspace = {
        version: 2,
        id: workspaceId,
        name: "Curated legend controls",
        experimentId,
        selectedRunIds: runIds.slice(0, 2),
        runLabels: Object.fromEntries(runIds.map((id) => [id, "Same alias"])),
        sections: [
          {
            id: "metrics",
            title: "Metrics",
            collapsed: false,
            cards: [curated, sibling],
          },
        ],
        updatedAt: 1,
      };
      sessionStorage.setItem("nset.token", "test");
      localStorage.setItem(
        workspaceKey,
        JSON.stringify({
          version: 2,
          views: [workspace],
          activeByExperiment: { [experimentId]: workspaceId },
        }),
      );
    },
    { experimentId, runIds, workspaceId, workspaceKey, keys },
  );
  const runs = runIds.map((id, index) => ({
    id,
    experiment_id: experimentId,
    name: `Run ${index + 1}`,
    status: "finished",
    params: {},
    tags: {},
    created_at: index,
    updated_at: index,
  }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [
            { id: experimentId, name: "Curated study", created_at: 0 },
          ],
          runs,
          series: runs.flatMap((run) =>
            keys.map((key) => ({
              run_id: run.id,
              key,
              kind: "metric",
              count: 3,
              last_step: 2,
              last_timestamp: 2000,
              last_value: 1,
            })),
          ),
        },
      });
    if (path === "/api/views") return route.fulfill({ json: { views: [] } });
    if (path.endsWith("/metrics"))
      return route.fulfill({
        json: {
          points: [3, 2, 1].map((value, step) => ({
            seq: step + 1,
            step,
            timestamp: step * 1000,
            value,
          })),
          snapshot: 3,
          total: 3,
          next_after: null,
        },
      });
    return route.fulfill({ status: 404, json: { error: "Not in fixture" } });
  });
  await page.goto(`/#/experiments/${experimentId}/charts`);
  await expect(page.locator(".card-legend-item")).toHaveCount(6);
  await openLegends(page);
}

test("curated explicit sources remain a subset of persisted global selection", async ({
  page,
}) => {
  await fixture(page);
  const authored = (await savedWorkspace(page)).sections;
  await expect(primary(page).locator(".card-legend-item")).toHaveCount(4);
  await expect(identities(page, runIds[2])).toHaveCount(0);
  await expect(identities(page, runIds[0])).toHaveCount(3);
  const ids = await primary(page)
    .locator(".card-legend-item")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.seriesId),
    );
  expect(new Set(ids).size).toBe(4);

  // A native keyboard checkbox affects the real run, not its duplicate alias
  // or one synthetic metric identity. The sibling chart and drawer agree.
  await identities(page, runIds[0])
    .first()
    .getByRole("checkbox")
    .press("Space");
  await expect(identities(page, runIds[0])).toHaveCount(0);
  await expect(identities(page, runIds[1])).toHaveCount(3);
  await expect(
    drawerRow(page, runIds[0]).getByRole("checkbox"),
  ).not.toBeChecked();
  expect((await savedWorkspace(page)).selectedRunIds).toEqual([runIds[1]]);
  expect((await savedWorkspace(page)).sections).toEqual(authored);
  await expect(page.locator(".card-notice")).toHaveText(["", ""]);

  await page.reload();
  await expect(page.locator(".card-legend-item")).toHaveCount(3);
  await expect(identities(page, runIds[0])).toHaveCount(0);
  await drawerRow(page, runIds[0]).getByRole("checkbox").check();
  await expect(page.locator(".card-legend-item")).toHaveCount(6);
  await drawerRow(page, runIds[1]).getByRole("checkbox").uncheck();
  await expect(identities(page, runIds[1])).toHaveCount(0);
  await expect(identities(page, runIds[0])).toHaveCount(3);

  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect(page.locator(".chart-card")).toHaveCount(0);
  await expect(page.locator(".uplot")).toHaveCount(0);
  expect((await savedWorkspace(page)).selectedRunIds).toEqual([]);
  expect((await savedWorkspace(page)).sections).toEqual(authored);
  await page.reload();
  await expect(drawerRow(page, runIds[0])).toBeVisible();
  await expect(page.locator(".chart-card")).toHaveCount(0);
  await drawerRow(page, runIds[1]).getByRole("checkbox").check();
  await expect(identities(page, runIds[1])).toHaveCount(3);
  await expect(identities(page, runIds[2])).toHaveCount(0);
});

test("legend line edits the shared run color across plots and drawer, and survives reload", async ({
  page,
}) => {
  await fixture(page);
  const authored = (await savedWorkspace(page)).sections;
  const otherColors = await identities(page, runIds[1])
    .locator("line")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("stroke")));
  const swatch = identities(page, runIds[0])
    .first()
    .getByRole("button", { name: "Change color for Run 1" });
  await expect(swatch.locator(".card-legend-swatch")).toBeVisible();
  await expect(swatch.locator("line")).toHaveAttribute(
    "stroke-dasharray",
    "4 2",
  );
  expect(
    await swatch.evaluate((node) => getComputedStyle(node, "::before").display),
  ).toBe("none");
  await swatch.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Color for Run 1" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(swatch).toBeFocused();
  await swatch.locator(".card-legend-swatch").click();
  await expect(
    page.getByRole("dialog", { name: "Color for Run 1" }),
  ).toBeVisible();
  await page.getByLabel("Custom color", { exact: true }).fill("#123456");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Color for Run 1" }),
  ).toHaveCount(0);
  await expect(swatch).toBeFocused();
  for (const line of await identities(page, runIds[0]).locator("line").all())
    await expect(line).toHaveAttribute("stroke", "#123456");
  await expect(
    page.locator('.card-plot canvas[data-curated-color="#123456"]'),
  ).toHaveCount(2);
  await expect(
    drawerRow(page, runIds[0]).locator("[data-run-color-id]"),
  ).toHaveCSS("--run-color", "#123456");
  expect(
    await identities(page, runIds[1])
      .locator("line")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("stroke"))),
  ).toEqual(otherColors);
  await expect(
    identities(page, runIds[0]).first().locator("line"),
  ).toHaveAttribute("stroke-dasharray", "4 2");
  await expect(
    identities(page, runIds[0]).first().locator("line"),
  ).toHaveAttribute("stroke-opacity", "0.5");
  expect((await savedWorkspace(page)).sections).toEqual(authored);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!),
      colorKey,
    ),
  ).toEqual({ [runIds[0]]: "#123456" });

  await page.reload();
  await expect(page.locator(".card-legend-item")).toHaveCount(6);
  for (const line of await identities(page, runIds[0]).locator("line").all())
    await expect(line).toHaveAttribute("stroke", "#123456");
  await expect(
    drawerRow(page, runIds[0]).locator("[data-run-color-id]"),
  ).toHaveCSS("--run-color", "#123456");
  await expect(
    page.locator('.card-plot canvas[data-curated-color="#123456"]'),
  ).toHaveCount(2);
});

test("failed selection and color writes keep the curated view and controls unchanged", async ({
  page,
}) => {
  await fixture(page);
  const before = await savedWorkspace(page);
  const colors = await identities(page, runIds[0])
    .locator("line")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("stroke")));
  await page.evaluate(
    ({ workspaceKey, colorKey }) => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === workspaceKey || key === colorKey)
          throw new DOMException("Storage full", "QuotaExceededError");
        return set.call(this, key, value);
      };
    },
    { workspaceKey, colorKey },
  );
  await identities(page, runIds[0])
    .first()
    .getByRole("checkbox")
    .press("Space");
  await expect(identities(page, runIds[0])).toHaveCount(3);
  for (const check of await identities(page, runIds[0])
    .getByRole("checkbox")
    .all())
    await expect(check).toBeChecked();
  await expect(drawerRow(page, runIds[0]).getByRole("checkbox")).toBeChecked();
  expect(await savedWorkspace(page)).toEqual(before);

  await identities(page, runIds[0]).first().getByRole("button").click();
  await page.getByLabel("Custom color", { exact: true }).fill("#123456");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".run-color-error")).toContainText(
    "Could not save this color",
  );
  expect(
    await identities(page, runIds[0])
      .locator("line")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("stroke"))),
  ).toEqual(colors);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), colorKey),
  ).toBeNull();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    identities(page, runIds[0]).first().getByRole("button"),
  ).toBeFocused();
});
