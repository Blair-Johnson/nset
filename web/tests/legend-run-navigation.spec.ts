import { expect, test, type Page } from "@playwright/test";

const experimentId = "rx:source/α %?#";
const runIds = [`${experimentId}:uid/one`, `${experimentId}:uid/two`];
const runHash = (id: string) =>
  `#/experiments/${encodeURIComponent(experimentId)}/runs/${encodeURIComponent(id)}`;

async function fixture(page: Page) {
  // A blank entry document also makes native new-tab navigation deterministic.
  await page.context().route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/");
  await page.evaluate(
    async ({ experimentId, runIds }) => {
      const { ChartCard } = await import("/src/cards.ts");
      const { newChart, seriesId } = await import("/src/workspace.ts");
      document.body.style.cssText =
        "margin:12px;background:#191c20;color:#ddd;font:13px system-ui;--surface:#202429;--surface-raised:#252a30;--border:#42474e;--text:#ddd;--muted:#aaa;--accent:#7dd3fc";
      const host = document.createElement("div");
      host.style.width = "660px";
      host.style.maxWidth = "100%";
      document.body.append(host);
      const runs = runIds.map((id) => ({
        id,
        experiment_id: experimentId,
        name: "Duplicate",
        status: "finished",
        params: {},
        tags: {},
        created_at: 0,
        updated_at: 0,
      }));
      const keys = ["train/loss", "eval/loss"];
      const context = {
        api: {},
        catalog: {
          experiments: [
            { id: experimentId, name: "External study", created_at: 0 },
          ],
          runs,
          series: runs.flatMap((run) =>
            keys.map((key) => ({
              run_id: run.id,
              key,
              kind: "metric",
              count: 5,
              last_step: 4,
              last_timestamp: 4000,
              last_value: 0,
            })),
          ),
        },
        selectedRunIds: runIds,
        runLabels: Object.fromEntries(
          runIds.map((id) => [id, "Same alias / %"]),
        ),
        store: {
          clear() {},
          async load() {
            return [0, 2, 0, 2, 0].map((value, step) => ({
              seq: step + 1,
              step,
              timestamp: step * 1000,
              value,
            }));
          },
        },
      };
      const spec = newChart("timeseries", keys, "Run navigation");
      spec.layout = { width: 660, height: 450 };
      for (const [index, run] of runs.entries())
        for (const key of keys)
          spec.config.runs[seriesId({ runId: run.id, key, kind: "metric" })] = {
            color: index ? "#00ccff" : "#ff0000",
            dash: key === "eval/loss" ? [5, 3] : [],
          };
      const card = new ChartCard(host, spec, context, {
        onEdit() {},
        onRemove() {},
        onMove() {},
        onDuplicate() {},
        onResize() {},
      });
      (window as any).legendNavigation = { card, context, rowEvents: [] };
    },
    { experimentId, runIds },
  );
  await expect(page.locator(".u-over")).toBeVisible();
  await expect(page.locator(".card-legend-item")).toHaveCount(4);
  await page.locator(".card-legend-details > summary").click();
}

const links = (page: Page) => page.locator(".card-legend a.card-legend-name");

async function identities(page: Page, surface = ".card-legend") {
  return page.locator(`${surface} .card-series-identity`).evaluateAll((nodes) =>
    nodes.map((node) => ({
      runId: (node as HTMLElement).dataset.runId,
      seriesId: (node as HTMLElement).dataset.seriesId,
      name: node.querySelector(".card-legend-name")?.textContent,
      href: node.querySelector("a")?.getAttribute("href"),
      color: node.querySelector("line")?.getAttribute("stroke"),
      dash: node.querySelector("line")?.getAttribute("stroke-dasharray"),
    })),
  );
}

test("same-run metrics, duplicate aliases and names link by encoded run identity", async ({
  page,
}) => {
  await fixture(page);
  await expect(links(page)).toHaveText(Array(4).fill("Same alias / %"));
  const before = await identities(page);
  expect(new Set(before.map((row) => row.seriesId)).size).toBe(4);
  for (const id of runIds) {
    const rows = before.filter((row) => row.runId === id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.href)).toEqual([runHash(id), runHash(id)]);
    expect(rows.map((row) => row.dash).sort()).toEqual(["", "5 3"]);
    expect(new Set(rows.map((row) => row.color)).size).toBe(1);
    await expect(page.locator(".card-legend")).not.toContainText(id);
  }
  await expect(links(page).locator("[title]")).toHaveCount(0);
  expect(
    await links(page).evaluateAll((nodes) =>
      nodes.every((node) => !node.hasAttribute("title")),
    ),
  ).toBe(true);
  expect(
    await links(page).evaluateAll((nodes) =>
      nodes.every(
        (node) => getComputedStyle(node).color === "rgb(221, 221, 221)",
      ),
    ),
  ).toBe(true);

  await page.evaluate(() => {
    const s = (window as any).legendNavigation;
    s.card.setContext({ ...s.context, labelMode: "original" });
  });
  await expect(links(page)).toHaveText(Array(4).fill("Duplicate"));
  expect((await identities(page)).map(({ name, ...row }) => row)).toEqual(
    before.map(({ name, ...row }) => row),
  );
  expect(
    await links(page).evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).color),
    ),
  ).toEqual([
    "rgb(255, 0, 0)",
    "rgb(255, 0, 0)",
    "rgb(0, 204, 255)",
    "rgb(0, 204, 255)",
  ]);
});

test("name click and keyboard activation navigate without row actions or dragging", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const row = document.querySelector(".card-legend-item")!;
    for (const type of ["click", "pointerdown", "mousedown", "dragstart"])
      row.addEventListener(type, () =>
        (window as any).legendNavigation.rowEvents.push(type),
      );
  });
  const first = links(page).first();
  const href = (await first.getAttribute("href"))!;
  await first.click();
  expect(new URL(page.url()).hash).toBe(href);
  expect(
    await page.evaluate(() => (window as any).legendNavigation.rowEvents),
  ).toEqual([]);
  await expect(page.locator(".card-legend-item")).toHaveCount(4);
  await expect(first).toHaveAttribute("draggable", "false");
  expect(
    await first.evaluate((link) => {
      const event = new Event("dragstart", { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);

  await page.evaluate(() => history.replaceState(null, "", "#/charts"));
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  expect(new URL(page.url()).hash).toBe(href);
  expect(
    await page.evaluate(() => (window as any).legendNavigation.rowEvents),
  ).toEqual([]);

  // The line now opens the shared color picker without a row click action.
  await page.locator(".card-legend-item .card-legend-swatch").first().click();
  expect(
    await page.evaluate(() => (window as any).legendNavigation.rowEvents),
  ).toEqual(["pointerdown", "mousedown"]);
  await expect(
    page.getByRole("dialog", { name: "Color for Duplicate" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

for (const activation of ["middle", "modifier"] as const) {
  test(`${activation} click keeps native new-tab navigation`, async ({
    page,
  }) => {
    await fixture(page);
    const link = links(page).first();
    const href = (await link.getAttribute("href"))!;
    const original = page.url();
    const opened = page.context().waitForEvent("page");
    await link.click(
      activation === "middle"
        ? { button: "middle" }
        : { modifiers: ["ControlOrMeta"] },
    );
    const tab = await opened;
    await tab.waitForURL((url) => url.hash === href);
    expect(page.url()).toBe(original);
    await expect(page.locator(".card-legend-item")).toHaveCount(4);
    await tab.close();
  });
}

test("cursor readouts link to runs while hover stays pointer-transparent", async ({
  page,
}) => {
  await fixture(page);
  const legend = await identities(page);
  await page.evaluate(() =>
    (window as any).legendNavigation.card.showMeasurement({
      axis: "x",
      a: 1,
      b: 3,
    }),
  );
  expect(await identities(page, ".card-value-table")).toEqual(legend);
  await expect(page.locator(".card-series-details")).toHaveAttribute(
    "open",
    "",
  );
  await page.locator(".card-value-table a.card-legend-name").first().click();
  expect(new URL(page.url()).hash).toBe(legend[0].href);

  await page.evaluate(() =>
    (window as any).legendNavigation.card.showMeasurement({ axis: "y", a: 1 }),
  );
  expect(await identities(page, ".card-crossings")).toEqual(legend);
  const crossing = page.locator(".card-crossings").first();
  await crossing.locator("a.card-legend-name").click();
  await expect(crossing).not.toHaveAttribute("open", "");
  const point = await page.evaluate(() => {
    const chart = (window as any).legendNavigation.card.plot.chart;
    const box = chart.over.getBoundingClientRect();
    return {
      x: box.left + chart.valToPos(1.5, "x"),
      y: box.top + chart.valToPos(1, "y"),
    };
  });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".card-hover-row")).toHaveCount(4);
  await expect(page.locator(".card-hover a")).toHaveCount(0);
  expect(
    await page
      .locator(".card-hover")
      .evaluate((node) => getComputedStyle(node).pointerEvents),
  ).toBe("none");
});

test("long semantic names retain compact truncation without exposing IDs", async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const s = (window as any).legendNavigation;
    s.card.setContext({
      ...s.context,
      runLabels: Object.fromEntries(
        s.context.selectedRunIds.map((id: string) => [
          id,
          "Long semantic name ".repeat(20),
        ]),
      ),
    });
  });
  const rows = await links(page).evaluateAll((nodes) =>
    nodes.map((node) => {
      const row = node.closest(".card-legend-item")!;
      return {
        truncated: node.scrollWidth > node.clientWidth,
        overflow: row.scrollWidth > row.clientWidth + 1,
        whitespace: getComputedStyle(node).whiteSpace,
        ellipsis: getComputedStyle(node).textOverflow,
        tooltip: node.hasAttribute("title"),
      };
    }),
  );
  expect(rows).toEqual(
    Array(4).fill({
      truncated: true,
      overflow: false,
      whitespace: "nowrap",
      ellipsis: "ellipsis",
      tooltip: false,
    }),
  );
});

test("legend navigation opens the actual run detail and Back restores the dashboard", async ({
  page,
}) => {
  await page.route("**/__legend_setup", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/__legend_setup");
  await page.evaluate(
    async ({ experimentId, runIds }) => {
      const { newChart } = await import("/src/workspace.ts");
      const workspace = {
        version: 2,
        id: "view:legend-navigation",
        name: "Legend navigation",
        experimentId,
        selectedRunIds: runIds,
        runLabels: Object.fromEntries(runIds.map((id) => [id, "Same alias"])),
        sections: [
          {
            id: "section:legend-navigation",
            title: "Metrics",
            collapsed: false,
            cards: [
              newChart("timeseries", ["train/loss", "eval/loss"], "Comparison"),
            ],
          },
        ],
        updatedAt: 1,
      };
      sessionStorage.setItem("nset.token", "test");
      localStorage.setItem(
        "nset.workspaces.v2",
        JSON.stringify({
          version: 2,
          views: [workspace],
          activeByExperiment: { [experimentId]: workspace.id },
        }),
      );
    },
    { experimentId, runIds },
  );
  const runs = runIds.map((id, index) => ({
    id,
    experiment_id: experimentId,
    name: "Duplicate",
    status: "finished",
    params: {
      marker: index ? "Second run configuration" : "First run configuration",
    },
    tags: {},
    created_at: 0,
    updated_at: 0,
  }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [
            { id: experimentId, name: "External study", created_at: 0 },
          ],
          runs,
          series: runs.flatMap((run) =>
            ["train/loss", "eval/loss"].map((key) => ({
              run_id: run.id,
              key,
              kind: "metric",
              count: 2,
              last_step: 1,
              last_timestamp: 1000,
              last_value: 1,
            })),
          ),
        },
      });
    if (path === "/api/views") return route.fulfill({ json: { views: [] } });
    if (path.endsWith("/metrics"))
      return route.fulfill({
        json: {
          points: [
            { seq: 1, step: 0, timestamp: 0, value: 2 },
            { seq: 2, step: 1, timestamp: 1000, value: 1 },
          ],
          snapshot: 2,
          total: 2,
          next_after: null,
        },
      });
    return route.fulfill({ status: 404, json: { error: "Not in fixture" } });
  });
  const dashboard = `#/experiments/${encodeURIComponent(experimentId)}/charts`;
  await page.goto(`/${dashboard}`);
  await expect(links(page)).toHaveCount(4);
  await page.locator(".card-legend-details > summary").click();
  await links(page).nth(2).click();
  await expect(page.locator(".run-detail h1")).toHaveText("Duplicate");
  expect(new URL(page.url()).hash).toBe(runHash(runIds[1]));
  await expect(page.locator(".run-detail")).toContainText(
    "Second run configuration",
  );
  await expect(page.locator(".run-detail")).not.toContainText(
    "First run configuration",
  );
  await page.goBack();
  await expect(page.locator(".card-title")).toHaveText("Comparison");
  expect(new URL(page.url()).hash).toBe(dashboard);
  await expect(links(page)).toHaveText(Array(4).fill("Same alias"));
});
