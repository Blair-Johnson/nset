import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, nested = false) {
  const requests: { path: string; body: any }[] = [];
  let delayOld = false;
  const rows = Array.from({ length: 6 }, (_, i) =>
    nested
      ? {
          kind: "metric",
          phase: "train",
          step: i + 1,
          epochs_seen: i / 4,
          metrics: { loss: 1 / (i + 1), learning_rate: 0.01 },
          "metrics.loss": 9,
        }
      : {
          kind: "epoch",
          phase: "validation",
          epoch: i + 1,
          train_loss: 1 / (i + 1),
          val_loss: 2 / (i + 1),
        },
  );
  const diagnostics = {
    scanned: 6,
    matched: 6,
    bytes: 1024,
    invalid_json: 0,
    oversized: 0,
    skipped_axes: 0,
    skipped_groups: 0,
    omitted_traces: 0,
    points: 12,
    partial: false,
    reasons: [],
  };
  await page.route("**/api/rx/**", async (route) => {
    const body = route.request().postDataJSON(),
      path = new URL(route.request().url()).pathname;
    requests.push({ path, body });
    const base = {
      diagnostics,
      records: [],
      fields: [],
      traces: [],
      next_cursor: null,
      coverage: "sampled hints, not a complete schema",
    };
    if (path.endsWith("fields")) {
      if (delayOld && body.prefix === "met")
        await new Promise((resolve) => setTimeout(resolve, 600));
      let fields = nested
        ? [
            { path: "metrics", types: ["object"], values: [] },
            { path: "metrics.loss", types: ["number"], values: [1] },
            {
              path: "metrics.learning_rate",
              types: ["number"],
              values: [0.01],
            },
            { path: '$["metrics.loss"]', types: ["number"], values: [9] },
            { path: "epochs_seen", types: ["number"], values: [0, 0.25] },
            { path: "step", types: ["number"], values: [1] },
            { path: "kind", types: ["string"], values: ["metric"] },
            { path: "phase", types: ["string"], values: ["train"] },
          ]
        : ["epoch", "train_loss", "val_loss", "kind", "phase"].map((path) => ({
            path,
            types: [
              path.includes("loss") || path === "epoch" ? "number" : "string",
            ],
            values: [],
          }));
      fields = fields.filter((f) => f.path.startsWith(body.prefix));
      if (body.prefix === "met")
        fields = fields.filter((f) => f.path === "metrics");
      await route.fulfill({
        json: { ...base, fields: fields.map((f) => ({ ...f, present: 6 })) },
      });
    } else if (path.endsWith("plot")) {
      if (body.x === "offline") {
        await route.fulfill({
          status: 503,
          json: { error: "source unavailable" },
        });
        return;
      }
      const value = (r: any, path: string): number =>
        path === '$["metrics.loss"]'
          ? r["metrics.loss"]
          : path.split(".").reduce((v, k) => v?.[k], r);
      await route.fulfill({
        json: {
          ...base,
          traces: body.ys.map((y: string) => ({
            run_uid: "uid",
            y,
            group: null,
            points: rows
              .map((r, i) => [value(r, body.x), value(r, y), i + 5])
              .filter(
                (p) => typeof p[0] === "number" && typeof p[1] === "number",
              ),
          })),
        },
      });
    } else if (path.endsWith("records")) {
      await route.fulfill({
        json: {
          ...base,
          records: [
            {
              run_uid: "uid",
              seq: body.cursor ? 10 : 5,
              received_at: "2026-10-12T23:51:22Z",
              data: rows[body.cursor ? 5 : 0],
            },
          ],
          next_cursor: body.cursor ? null : { sample: "cursor" },
        },
      });
    }
  });
  await page.route("**/__records_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><button id="launch">Open records</button></body></html>',
    }),
  );
  await page.goto("/__records_fixture");
  await page.evaluate(async (nested) => {
    await import("/src/style.css");
    const { openChartEditor } = await import("/src/chart-editor.ts");
    const { newChart, validateChart } = await import("/src/workspace.ts");
    const { Api } = await import("/src/api.ts");
    const { PlotPanel } = await import("/src/plot.ts");
    const render = PlotPanel.prototype.render;
    const state: any = { saved: [], plots: [] };
    PlotPanel.prototype.render = function (
      data: any,
      config: any,
      pins: any,
      options: any,
    ) {
      state.plots.push(
        structuredClone(
          data.map((d: any) => ({
            points: d.points,
            observations: d.observations,
            count: d.count,
          })),
        ),
      );
      return render.call(this, data, config, pins, options);
    };
    const catalog: any = {
      experiments: [{ id: "rx:test", name: "rx repo", created_at: 0 }],
      runs: [
        {
          id: "rx:test:uid",
          experiment_id: "rx:test",
          name: nested ? "r241" : "r859",
          status: "finished",
          params: {},
          tags: {},
          created_at: 0,
          updated_at: 0,
          rx: { sourceId: "rx:test", uid: "uid", state: "succeeded" },
        },
      ],
      series: [],
      rx: { id: "rx:test", name: "repo" },
    };
    const card = newChart("timeseries", [], "Recorded losses");
    card.config.smoothing = false;
    card.records = {
      sourceId: "rx:test",
      runUids: [],
      x: nested ? "epochs_seen" : "epoch",
      ys: nested ? ["metrics.loss"] : ["train_loss", "val_loss"],
      filters: {
        any: false,
        conditions: [
          { path: "kind", op: "eq", value: nested ? "metric" : "epoch" },
          ...(nested ? [{ path: "phase", op: "eq", value: "train" }] : []),
        ],
      },
    };
    const open = () =>
      openChartEditor({
        card: validateChart(state.saved.at(-1) ?? card),
        catalog,
        selectedRunIds: ["rx:test:uid"],
        api: new Api(() => "test"),
        onSave: (value: any) => {
          state.saved.push(structuredClone(value));
        },
      });
    document.getElementById("launch")!.onclick = open;
    (window as any).recordsState = state;
    open();
  }, nested);
  return {
    requests,
    delayOld: () => {
      delayOld = true;
    },
  };
}

test("r859 paired preview, scoped Tab completion, raw inspection and saved reopen", async ({
  page,
}) => {
  const { requests } = await fixture(page);
  const editor = page.getByRole("dialog");
  await expect(editor.locator('[data-role="preview"]')).toHaveAttribute(
    "data-observation-count",
    "12",
  );
  const x = editor.getByLabel("Record X field", { exact: true });
  await x.fill("epo");
  await expect(page.getByRole("option", { name: /^epoch / })).toBeVisible();
  await x.press("Tab");
  await expect(x).toHaveValue("epoch");
  expect(
    requests.filter((r) => r.path.endsWith("fields")).at(-1)?.body.runs,
  ).toEqual(["uid"]);
  expect(
    requests.filter((r) => r.path.endsWith("fields")).at(-1)?.body.filters
      .conditions[0],
  ).toEqual({ path: "kind", op: "eq", value: "epoch" });
  await editor.getByText("Inspect records", { exact: true }).click();
  await editor
    .getByRole("button", { name: "Load records", exact: true })
    .click();
  await expect(editor.locator(".record-inspection summary")).toContainText(
    "seq 5",
  );
  await editor.locator(".record-inspection summary").click();
  await expect(editor.locator(".record-inspection pre")).toContainText(
    '"train_loss": 1',
  );
  await editor
    .getByRole("button", { name: "Next records", exact: true })
    .click();
  await expect(editor.locator(".record-inspection summary")).toContainText(
    "seq 10",
  );
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  await page.getByRole("button", { name: "Open records", exact: true }).click();
  await expect(page.getByLabel("Record X field", { exact: true })).toHaveValue(
    "epoch",
  );
  await expect(
    page.getByRole("button", {
      name: "Remove Y field train_loss",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).recordsState.saved[0].records.filters.conditions[0]
          .value,
    ),
  ).toBe("epoch");
});

test("nested container completion, stale hints and last-good preview", async ({
  page,
}) => {
  const f = await fixture(page, true);
  await expect(page.locator('[data-role="preview"]')).toHaveAttribute(
    "data-observation-count",
    "6",
  );
  const y = page.getByLabel("Add Y field", { exact: true });
  f.delayOld();
  await y.fill("met");
  await page.waitForTimeout(160);
  await y.fill("metrics.lo");
  await expect(
    page.getByRole("option", { name: /^metrics.loss / }),
  ).toBeVisible();
  await page.waitForTimeout(650);
  await expect(
    page.getByRole("option", { name: /^metrics object/ }),
  ).not.toBeVisible();
  await expect(y).toHaveValue("metrics.lo");
  await y.press("Tab");
  await expect(y).toHaveValue("");
  const x = page.getByLabel("Record X field", { exact: true });
  await x.fill("offline");
  await x.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Previous preview" }),
  ).toContainText("source unavailable");
  await expect(page.locator('[data-role="preview"]')).toHaveAttribute(
    "data-observation-count",
    "6",
  );
  await x.fill("metrics.");
  await x.press("Tab");
  await expect(page.getByRole("dialog")).toBeVisible();
  const plots = await page.evaluate(
    () => (window as any).recordsState.plots[0],
  );
  expect(plots[0].points[1][0]).toBe(0.25);
  expect(
    f.requests.some(
      (r) =>
        r.path.endsWith("fields") && r.body.filters.conditions.length === 2,
    ),
  ).toBeTruthy();
});

test("record filter own hints omit itself and typed filter changes persist", async ({
  page,
}) => {
  const { requests } = await fixture(page);
  await page.getByText("Filter records (1)", { exact: true }).click();
  const path = page.getByLabel("Record filter 1 path", { exact: true });
  await path.fill("ki");
  await expect(page.getByRole("option", { name: /^kind / })).toBeVisible();
  await path.press("Tab");
  const fields = requests.filter(
    (r) => r.path.endsWith("fields") && r.body.prefix === "ki",
  );
  expect(fields.at(-1)?.body.filters.conditions).toEqual([]);
  await page
    .getByLabel("Record filter 1 JSON value", { exact: true })
    .fill("true");
  await page
    .getByRole("button", { name: "Apply record filters", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (window as any).recordsState.saved[0].records.filters.conditions[0]
          .value,
    ),
  ).toBe(true);
});

test("container completion retains focus, literal paths remain distinct, Escape and Shift+Tab work", async ({
  page,
}) => {
  await fixture(page, true);
  const y = page.getByLabel("Add Y field", { exact: true });
  await y.fill("met");
  await expect(
    page.getByRole("option", { name: /^metrics object/ }),
  ).toBeVisible();
  await y.press("Tab");
  await expect(y).toHaveValue("metrics.");
  await expect(y).toBeFocused();
  await expect(
    page.getByRole("option", { name: /^metrics.loss number/ }),
  ).toBeVisible();
  await y.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await y.fill('$["metrics.loss"]');
  await y.press("Enter");
  await expect(
    page.getByRole("button", {
      name: 'Remove Y field $["metrics.loss"]',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Remove Y field metrics.loss",
      exact: true,
    }),
  ).toBeVisible();
  await y.fill("met");
  await expect(
    page.getByRole("option", { name: /^metrics object/ }),
  ).toBeVisible();
  await y.press("Shift+Tab");
  await expect(y).not.toBeFocused();
});

test("partial hint sets never imply unique Tab completion", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/rx/fields", (route) =>
    route.fulfill({
      json: {
        diagnostics: {
          scanned: 2000,
          matched: 3,
          bytes: 300,
          invalid_json: 0,
          oversized: 0,
          skipped_axes: 0,
          skipped_groups: 0,
          omitted_traces: 0,
          points: 0,
          partial: true,
          reasons: ["scan budget reached"],
        },
        fields: [{ path: "epoch", types: ["number"], present: 3, values: [1] }],
        coverage: "sampled hints",
        records: [],
        traces: [],
        next_cursor: null,
      },
    }),
  );
  const x = page.getByLabel("Record X field", { exact: true });
  await x.fill("epo");
  await expect(
    page.getByRole("option", { name: /^epoch number/ }),
  ).toBeVisible();
  await x.press("Tab");
  await expect(x).toHaveValue("epo");
  await expect(x).not.toBeFocused();
  await x.focus();
  await expect(
    page.getByRole("option", { name: /^epoch number/ }),
  ).toBeVisible();
  await x.press("ArrowDown");
  await x.press("Tab");
  await expect(x).toHaveValue("epoch");
});

test("shell exposes rx beside native data, saves a record chart, and hides run mutation controls", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/catalog", (route) =>
    route.fulfill({
      json: {
        rx_enabled: true,
        experiments: [{ id: "native", name: "Native data", created_at: 0 }],
        runs: [],
        series: [],
      },
    }),
  );
  await page.route("**/api/rx/catalog", (route) =>
    route.fulfill({
      json: {
        source: { id: "rx:test", name: "fixture", readonly: true },
        next_after: null,
        runs: [
          {
            id: 859,
            run_uid: "uid",
            state: "succeeded",
            alias: null,
            config: "Fixture summary",
            argv: "[]",
            created_at: "2026-10-12T00:00:00Z",
            started_at: null,
            finished_at: null,
            exit_code: 0,
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.getByLabel("Access token", { exact: true }).fill("test-secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Native data", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "rx \u00b7 fixture", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await page.locator("details[data-menu=add] summary").click();
  await page.getByRole("button", { name: "Line plot", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Add chart", exact: true });
  await expect(editor.getByLabel("Data source", { exact: true })).toHaveValue(
    "records",
  );
  await editor.getByLabel("Chart title", { exact: true }).fill("rx losses");
  const x = editor.getByLabel("Record X field", { exact: true });
  await x.fill("epoch");
  await x.press("Enter");
  const y = editor.getByLabel("Add Y field", { exact: true });
  await y.fill("train_loss");
  await y.press("Enter");
  await y.fill("val_loss");
  await y.press("Enter");
  await expect(editor.locator('[data-role="preview"]')).toHaveAttribute(
    "data-observation-count",
    "12",
  );
  await editor.getByRole("button", { name: "Add chart", exact: true }).click();
  await expect(page.locator(".dashboard-cell")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".dashboard-cell")).toHaveCount(1);
  await expect(page.locator(".card-title")).toHaveText("rx losses");
  await page
    .locator(".dashboard-cell")
    .getByLabel("Chart actions", { exact: true })
    .click();
  await page.getByRole("button", { name: "Edit chart", exact: true }).click();
  await expect(page.getByLabel("Record X field", { exact: true })).toHaveValue(
    "epoch",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(async () => {
    const { renderRunDetail } = await import("/src/run-detail.ts");
    const run: any = {
      id: "rx:test:uid",
      experiment_id: "rx:test",
      name: "r859",
      status: "finished",
      params: {},
      tags: { owner: "original" },
      created_at: 0,
      updated_at: 0,
      rx: { sourceId: "rx:test", uid: "uid", state: "succeeded" },
    };
    document.body.replaceChildren(
      renderRunDetail(run, {
        onBack() {},
        onTags: async () => {
          throw new Error("must not mutate rx");
        },
      }),
    );
  });
  await expect(
    page.getByRole("button", { name: /Add tag|Edit tag|Remove tag/ }),
  ).toHaveCount(0);
  await expect(page.locator(".run-detail-status")).toHaveText("succeeded");
});
