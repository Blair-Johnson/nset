import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { newChart } from "../src/workspace";
import type { Workspace } from "../src/workspace-types";

const id = "server:00000000-0000-0000-0000-000000000042";
const hash = `#/views/${encodeURIComponent(id)}`;
function fixture() {
  const chart = newChart(
    "timeseries",
    ["train", "validation"],
    "Depth comparison",
  );
  chart.id = "comparison";
  chart.source = {
    mode: "explicit",
    series: [
      { runId: "r1", key: "train", kind: "metric" },
      { runId: "r1", key: "validation", kind: "metric" },
      { runId: "r2", key: "validation", kind: "metric" },
    ],
  };
  chart.details = {
    markdown:
      "### Findings\n\n**Authored** report with $x^2$.\n\n$$\n\\Delta = v_1-v_2\n$$\n\n[Inspect interval](measurement:window) and [Inspect level](measurement:level).\n\n<script>window.bad=true</script>",
    configRunLabels: { r1: "A", r2: "D" },
    configFields: [
      { path: ["optimizer", "lr"], label: "Learning rate" },
      { path: ["data.window"], label: "Window" },
      { path: ["absent"], label: "Missing" },
    ],
    measurements: {
      window: { axis: "x", a: 0, b: 2 },
      level: { axis: "y", a: 0.5, b: null },
    },
  };
  let workspace: Workspace = {
    version: 2,
    id,
    name: "Agent review",
    experimentId: "exp",
    selectedRunIds: ["r1", "r2"],
    runLabels: { r1: "A · two layers", r2: "B · four layers" },
    sections: [
      { id: "metrics", title: "Metrics", collapsed: false, cards: [chart] },
    ],
    updatedAt: 1,
  };
  let revision = 1,
    histories = 0;
  const writes: string[] = [];
  const runs = ["r1", "r2"].map((id, index) => ({
    id,
    experiment_id: "exp",
    name: "same raw name",
    status: "finished",
    params: {
      optimizer: { lr: index ? 0.02 : 0.01 },
      "data.window": index ? 64 : 32,
      secret: "NOT DISPLAYED",
    },
    tags: {},
    created_at: index + 1,
    updated_at: 1,
  }));
  async function install(context: BrowserContext) {
    await context.addInitScript(() =>
      sessionStorage.setItem("nset.token", "test"),
    );
    await context.route("**/api/**", (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const json = (value: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(value),
        });
      if (!["GET", "HEAD"].includes(request.method())) {
        writes.push(url.pathname);
        return json({ error: "Unexpected write" }, 500);
      }
      if (url.pathname === "/api/catalog")
        return json({
          experiments: [{ id: "exp", name: "Experiment", created_at: 1 }],
          runs,
          series: runs.flatMap((run) =>
            ["train", "validation"].map((key) => ({
              run_id: run.id,
              key,
              kind: "metric",
              count: 3,
              last_step: 2,
              last_timestamp: 3,
              last_value: 0.8,
            })),
          ),
        });
      if (url.pathname === "/api/views")
        return json({
          views: [
            {
              id,
              name: workspace.name,
              experimentId: "exp",
              revision,
              updatedAt: revision,
            },
          ],
        });
      if (decodeURIComponent(url.pathname) === `/api/views/${id}`) {
        if (Number(url.searchParams.get("revision")) === revision)
          return route.fulfill({ status: 204 });
        return json({ id, revision, workspace });
      }
      if (url.pathname.endsWith("/metrics")) {
        histories++;
        return json({
          points: [
            { seq: 1, step: 0, timestamp: 1, value: 0.2 },
            { seq: 2, step: 1, timestamp: 2, value: 0.6 },
            { seq: 3, step: 2, timestamp: 3, value: 0.8 },
          ],
          next_after: null,
          snapshot: 3,
          total: 3,
        });
      }
      return json({ error: `Unexpected GET ${url.pathname}` }, 404);
    });
  }
  return {
    install,
    writes,
    get histories() {
      return histories;
    },
    get workspace() {
      return workspace;
    },
    update(change: (next: Workspace) => void) {
      workspace = structuredClone(workspace);
      change(workspace);
      workspace.updatedAt = ++revision;
    },
  };
}
const card = (page: Page) => page.locator('[data-card-id="comparison"]');
const pane = (page: Page) =>
  page.getByRole("complementary", { name: "Chart details" });
async function start(page: Page, context: BrowserContext) {
  const server = fixture();
  await server.install(context);
  await page.goto(hash);
  await expect(page.locator("#connection")).toHaveText("Connected");
  await expect(card(page).locator(".uplot")).toBeVisible();
  return server;
}
async function open(page: Page) {
  await card(page)
    .getByRole("button", { name: "Chart details", exact: true })
    .click();
  await expect(pane(page)).toBeVisible();
}

test("authored Markdown, LaTeX and selected parameter paths; measurements use native controls", async ({
  page,
  context,
}) => {
  const server = await start(page, context);
  await expect(pane(page)).toHaveCount(0);
  await open(page);
  await expect(pane(page)).toContainText("Authored");
  const table = pane(page).locator(".chart-details-table");
  await expect(table.locator("thead th")).toHaveText(["Setting", "A", "D"]);
  await expect(table.locator("thead th[data-run-id=r1]")).toHaveAttribute(
    "title",
    "same raw name",
  );
  await expect(table.locator(".chart-details-swatch")).toHaveCount(0);
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator(".chart-details-difference")).toHaveCount(2);
  await expect(table.locator("tbody tr").last()).not.toHaveClass(
    /chart-details-difference/,
  );
  await expect(table.locator("tbody th").first()).toHaveCSS(
    "font-size",
    "10px",
  );
  await expect(table.locator("tbody th").first()).toHaveCSS(
    "font-weight",
    "400",
  );
  await expect(table.locator("td").first()).toHaveCSS("padding-top", "5px");
  await expect(table.locator("td").first()).toHaveCSS("white-space", "nowrap");
  const selected = await table
    .locator(".chart-details-difference td")
    .first()
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  await expect(table.locator(".chart-details-difference th").first()).toHaveCSS(
    "background-color",
    selected,
  );
  await expect(pane(page).locator(".katex").first()).toBeVisible();
  await expect(pane(page)).toContainText("Learning rate");
  await expect(pane(page)).toContainText("0.01");
  await expect(pane(page)).toContainText("64");
  await expect(pane(page)).toContainText("—");
  await expect(pane(page)).not.toContainText("NOT DISPLAYED");
  expect(await page.evaluate(() => (window as any).bad)).toBeUndefined();
  await pane(page).getByRole("button", { name: "Inspect interval" }).click();
  await expect(
    card(page).getByRole("spinbutton", {
      includeHidden: true,
      name: "Cursor A coordinate",
    }),
  ).toHaveValue("0");
  await expect(
    card(page).getByRole("spinbutton", {
      includeHidden: true,
      name: "Cursor B coordinate",
    }),
  ).toHaveValue("2");
  await expect(card(page).locator(".card-value-table")).toBeVisible();
  await expect(
    pane(page).locator(".chart-details-report > [role=status]:last-child"),
  ).toHaveText("Cursors placed at steps 0 and 2.");
  await expect(pane(page).getByRole("status")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(
    pane(page).locator(".chart-details-report + .chart-details-configuration"),
  ).toBeVisible();
  await expect(
    pane(page).getByRole("button", { name: /clear cursors/i }),
  ).toHaveCount(0);
  await pane(page).getByRole("button", { name: "Inspect level" }).click();
  await expect(
    card(page).getByRole("spinbutton", {
      includeHidden: true,
      name: "Cursor A level",
    }),
  ).toHaveValue("0.5");
  await expect(card(page).locator(".card-crossings")).toHaveCount(3);
  await expect(pane(page).getByRole("status")).toHaveText(
    "Cursor placed at Y = 0.5.",
  );
  await card(page)
    .getByRole("button", { name: /^Clear cursors$/i })
    .click();
  await expect(card(page).locator(".card-inspection")).toBeHidden();
  expect(server.writes).toEqual([]);
});

test("local naming mode preserves plots and cursors without saving the view", async ({
  page,
  context,
}) => {
  const server = await start(page, context);
  await open(page);
  await pane(page).getByRole("button", { name: "Inspect interval" }).click();
  await page.evaluate(() => {
    (window as any).__plot = document.querySelector(
      '[data-card-id="comparison"] .uplot',
    );
  });
  const requests = server.histories;
  await page
    .getByRole("combobox", { name: "Run labels", exact: true })
    .selectOption("original");
  await expect(card(page).locator(".card-legend-name").first()).toContainText(
    "same raw name",
  );
  await expect(
    card(page).getByRole("spinbutton", {
      includeHidden: true,
      name: "Cursor B coordinate",
    }),
  ).toHaveValue("2");
  expect(
    await page.evaluate(
      () =>
        (window as any).__plot ===
        document.querySelector('[data-card-id="comparison"] .uplot'),
    ),
  ).toBe(true);
  await expect(pane(page).locator(".chart-details-table thead th")).toHaveText([
    "Setting",
    "A",
    "D",
  ]);
  expect(server.histories).toBe(requests);
  expect(server.writes).toEqual([]);
  await page
    .getByRole("combobox", { name: "Run labels", exact: true })
    .selectOption("semantic");
  await expect(card(page).locator(".card-legend-name").first()).toContainText(
    "A · two layers",
  );
  await expect(page.locator("#view-modified")).toBeHidden();
});

test("open details follows server revisions without replacing the plot, then closes on removal", async ({
  page,
  context,
}) => {
  const server = await start(page, context);
  await open(page);
  await pane(page).getByRole("button", { name: "Inspect interval" }).click();
  await page.evaluate(() => {
    (window as any).__plot = document.querySelector(
      '[data-card-id="comparison"] .uplot',
    );
  });
  server.update((workspace) => {
    workspace.sections[0].cards[0].details!.markdown =
      "### Revised interpretation\n\nNew evidence.";
    workspace.runLabels!.r1 = "A · revised";
  });
  await expect(pane(page)).toContainText("Revised interpretation", {
    timeout: 20000,
  });
  await expect(card(page).locator(".card-legend-name").first()).toContainText(
    "A · revised",
  );
  await expect(
    card(page).getByRole("spinbutton", {
      includeHidden: true,
      name: "Cursor B coordinate",
    }),
  ).toHaveValue("2");
  expect(
    await page.evaluate(
      () =>
        (window as any).__plot ===
        document.querySelector('[data-card-id="comparison"] .uplot'),
    ),
  ).toBe(true);
  server.update((workspace) => {
    workspace.sections[0].cards = [];
  });
  await expect(pane(page)).toHaveCount(0, { timeout: 20000 });
  expect(server.writes).toEqual([]);
});

test("pane resize is local, cancellable, keyboard accessible, persisted and responsive", async ({
  page,
  context,
}) => {
  const server = await start(page, context);
  await open(page);
  const handle = pane(page).getByRole("separator", {
    name: /Resize chart details/i,
  });
  const initial = (await pane(page).boundingBox())!.width;
  let bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 100, bounds.y + 30, { steps: 8 });
  await page.mouse.up();
  const expanded = (await pane(page).boundingBox())!.width;
  expect(expanded).toBeGreaterThan(initial + 80);
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  const retained = (await pane(page).boundingBox())!.width;
  expect(retained).toBe(expanded - 20);
  await page.keyboard.press("Shift+ArrowLeft");
  expect((await pane(page).boundingBox())!.width).toBe(retained + 80);
  await page.keyboard.press("Shift+ArrowRight");
  expect((await pane(page).boundingBox())!.width).toBe(retained);
  bounds = (await handle.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 70, bounds.y + 30);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await pane(page).boundingBox())!.width).toBe(retained);
  await pane(page)
    .getByRole("button", { name: "Close chart details", exact: true })
    .click();
  await expect(
    card(page).getByRole("button", { name: "Chart details", exact: true }),
  ).toBeFocused();
  await page.reload();
  await expect(card(page).locator(".uplot")).toBeVisible();
  await open(page);
  expect((await pane(page).boundingBox())!.width).toBe(retained);
  await page.setViewportSize({ width: 800, height: 1000 });
  await expect(handle).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(server.writes).toEqual([]);
});

test("filtering and navigation close chart details and reset reserved space", async ({
  page,
  context,
}) => {
  await start(page, context);
  await open(page);
  await page
    .getByRole("searchbox", { name: "Search charts" })
    .fill("unmatched");
  await expect(pane(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveClass(/has-chart-details/);
  await page.getByRole("searchbox", { name: "Search charts" }).fill("");
  await open(page);
  await page.evaluate(() => {
    location.hash = "#/experiments";
  });
  await expect(pane(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveClass(/has-chart-details/);
});
