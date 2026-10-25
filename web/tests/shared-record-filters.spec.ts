import { test, expect, type Page, type Locator } from "@playwright/test";
import { recordValue } from "../src/records";

async function fixture(page: Page, selectedCount = 1) {
  const requests: { path: string; body: any }[] = [];
  let failHints = false;
  let delayPrefix = "";
  const rows = Array.from({ length: 62 }, (_, i) => ({
    step: i + 1,
    phase: i < 51 ? "train" : "probe",
    phase_detail: "detail",
    kind: i < 51 ? "metric" : "probe",
    loss: 1 / (i + 1),
    metrics: { loss: i + 0.5 },
    "metrics.loss": 100 + i,
    items: [{ loss: i }],
    flag: i < 51,
    nullable: null,
  }));
  const paths = [
    "phase_detail",
    "phase",
    "kind",
    "step",
    "loss",
    "metrics.loss",
    '$["metrics.loss"]',
    "items[0].loss",
    "flag",
    "nullable",
  ];
  const matches = (row: unknown, c: any) => {
    const v = recordValue(row, c.path);
    if (c.op === "exists") return v !== undefined;
    if (c.op === "missing") return v === undefined;
    if (v === undefined) return false;
    if (c.op === "eq") return v === c.value;
    if (c.op === "ne") return v !== c.value;
    if (
      typeof v !== typeof c.value ||
      !(typeof v === "number" || typeof v === "string")
    )
      return false;
    return c.op === "gt"
      ? v > c.value
      : c.op === "gte"
        ? v >= c.value
        : c.op === "lt"
          ? v < c.value
          : v <= c.value;
  };
  await page.route("**/api/rx/**", async (route) => {
    const body = route.request().postDataJSON();
    const path = new URL(route.request().url()).pathname;
    requests.push({ path, body });
    const conditions = body.filters?.conditions ?? [];
    const selected = rows.filter(
      (row) =>
        !conditions.length ||
        (body.filters.any
          ? conditions.some((c: any) => matches(row, c))
          : conditions.every((c: any) => matches(row, c))),
    );
    const base: any = {
      fields: [],
      records: [],
      traces: [],
      next_cursor: null,
      coverage: "sampled",
      diagnostics: {
        scanned: 62,
        matched: selected.length,
        bytes: 1000,
        invalid_json: 0,
        oversized: 0,
        skipped_axes: 0,
        skipped_groups: 0,
        omitted_traces: 0,
        points: selected.length,
        partial: false,
        reasons: [],
      },
    };
    if (path.endsWith("fields")) {
      if (delayPrefix && body.prefix === delayPrefix)
        await new Promise((resolve) => setTimeout(resolve, 650));
      if (failHints)
        return route.fulfill({
          status: 503,
          json: { error: "fixture hints offline" },
        });
      base.fields = paths
        .filter((p) => p.includes(body.prefix))
        .map((p) => {
          const values = [
            ...new Set(selected.map((r) => recordValue(r, p))),
          ].slice(0, 8);
          return {
            path: p,
            types: [
              ...new Set(values.map((v) => (v === null ? "null" : typeof v))),
            ],
            present: selected.length,
            values,
          };
        });
    } else if (path.endsWith("plot")) {
      const groups = body.group
        ? [...new Set(selected.map((r) => recordValue(r, body.group)))]
        : [null];
      base.traces = body.ys.flatMap((y: string) =>
        groups.map((group) => ({
          run_uid: "uid0",
          y,
          group,
          points: selected
            .filter((r) => !body.group || recordValue(r, body.group) === group)
            .map((r) => [
              recordValue(r, body.x),
              recordValue(r, y),
              String(r.step),
            ])
            .filter(
              (p) => typeof p[0] === "number" && typeof p[1] === "number",
            ),
        })),
      );
    }
    await route.fulfill({ json: base });
  });
  await page.route("**/__shared_record_filters", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><button id="launch">Open records</button><div id="native"></div></body></html>',
    }),
  );
  await page.goto("/__shared_record_filters");
  await page.evaluate(async (selectedCount) => {
    await import("/src/style.css");
    await import("/src/run-drawer.css");
    const { openChartEditor } = await import("/src/chart-editor.ts");
    const { newChart } = await import("/src/workspace.ts");
    const { Api } = await import("/src/api.ts");
    const { RunFilterMenu } = await import("/src/run-filter-menu.ts");
    const api = new Api(() => "test");
    const runs = Array.from({ length: selectedCount }, (_, i) => ({
      id: `rx:test:uid${i}`,
      experiment_id: "rx:test",
      name: `r${i + 219}`,
      status: "finished",
      params: { batch: 4 },
      tags: { split: "train" },
      created_at: 0,
      updated_at: 0,
      rx: { sourceId: "rx:test", uid: `uid${i}`, state: "succeeded" },
    }));
    const catalog: any = {
      experiments: [{ id: "rx:test", name: "rx", created_at: 0 }],
      runs,
      series: [],
      rx: { id: "rx:test", name: "fixture" },
    };
    const card = newChart("timeseries", [], "Record phases");
    card.config.smoothing = false;
    card.records = {
      sourceId: "rx:test",
      runUids: [],
      x: "step",
      ys: ["loss"],
      filters: { any: false, conditions: [] },
    };
    const state: any = { saved: [], original: structuredClone(card) };
    const native = new RunFilterMenu(
      {
        combine: "all",
        conditions: [
          {
            scope: "event",
            path: "phase",
            op: "eq",
            value: "train",
            missing: "exclude",
          },
        ],
      },
      () => {},
      () => 1,
    );
    native.setRuns(runs as any);
    document.getElementById("native")!.append(native.root);
    const open = () =>
      openChartEditor({
        card: state.saved.at(-1) ?? card,
        catalog,
        selectedRunIds: runs.map((r) => r.id),
        api,
        isNew: state.saved.length === 0,
        onSave: (value) => {
          state.saved.push(structuredClone(value));
        },
      });
    document.getElementById("launch")!.onclick = open;
    (window as any).sharedRecords = state;
    open();
  }, selectedCount);
  return {
    requests,
    failHints: (value: boolean) => {
      failHints = value;
    },
    delay: (prefix: string) => {
      delayPrefix = prefix;
    },
  };
}
const editor = (page: Page) => page.getByRole("dialog");
const menu = (page: Page) => editor(page).locator(".run-filter-menu");
const preview = (page: Page) => editor(page).locator('[data-role="preview"]');
async function openMenu(page: Page) {
  await editor(page).getByLabel("Filter records", { exact: true }).click();
  await expect(menu(page).locator(".run-filter-popover")).toBeVisible();
}
async function add(page: Page, path: string, value: string, index = 1) {
  await menu(page)
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  const field = menu(page).getByLabel(`Condition ${index} path`, {
    exact: true,
  });
  await field.fill("");
  await field.pressSequentially(path, { delay: 10 });
  await field.press("Tab");
  await expect(
    menu(page).getByLabel(`Condition ${index} value`, { exact: true }),
  ).toBeFocused();
  await menu(page)
    .getByLabel(`Condition ${index} value`, { exact: true })
    .fill(value);
}
async function count(page: Page, n: number) {
  await expect(preview(page)).toHaveAttribute(
    "data-observation-count",
    String(n),
  );
}
const lastPlot = (requests: { path: string; body: any }[]) =>
  requests.filter((r) => r.path.endsWith("plot")).at(-1)?.body;

test("shared Event editor: phase Tab, equals, natural train Tab/Enter, preview and saved reopen", async ({
  page,
}) => {
  const f = await fixture(page);
  await count(page, 62);
  await openMenu(page);
  await add(page, "phase", "tra");
  const value = menu(page).getByLabel("Condition 1 value", { exact: true });
  await expect(
    menu(page).getByLabel("Condition 1 path", { exact: true }),
  ).toHaveValue("phase");
  await menu(page)
    .getByLabel("Condition 1 operator", { exact: true })
    .selectOption({ label: "=" });
  await value.focus();
  await value.press("Tab");
  await expect(value).toHaveValue("train");
  await value.press("Enter");
  await expect(editor(page)).toBeVisible();
  await count(page, 51);
  expect(lastPlot(f.requests).filters).toEqual({
    any: false,
    conditions: [{ path: "phase", op: "eq", value: "train" }],
  });
  await expect(
    menu(page).getByLabel("Condition 1 scope", { exact: true }),
  ).toBeDisabled();
  expect(
    await menu(page).locator(".run-filter-scope option").allTextContents(),
  ).toEqual(["Event"]);
  expect(
    await menu(page).locator(".run-filter-op option").allTextContents(),
  ).not.toContain("contains");
  await editor(page).getByLabel("Group by", { exact: true }).fill("phase");
  await editor(page).getByLabel("Group by", { exact: true }).press("Tab");
  await expect.poll(() => lastPlot(f.requests)?.group).toBe("phase");
  await editor(page)
    .getByRole("button", { name: "Add chart", exact: true })
    .click();
  await expect(editor(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Open records", exact: true }).click();
  await count(page, 51);
  await openMenu(page);
  await expect(
    menu(page).getByLabel("Condition 1 value", { exact: true }),
  ).toHaveValue("train");
  await expect(
    editor(page).getByLabel("Group by", { exact: true }),
  ).toHaveValue("phase");
  expect(
    await page.evaluate(
      () =>
        (window as any).sharedRecords.saved[0].records.filters.conditions[0]
          .value,
    ),
  ).toBe("train");
  await menu(page)
    .getByLabel("Condition 1 value", { exact: true })
    .fill("probe");
  await count(page, 11);
  await editor(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("button", { name: "Open records", exact: true }).click();
  await count(page, 51);
});

test("AND shares one event, OR is normal, and both path/value hints omit their own condition", async ({
  page,
}) => {
  const f = await fixture(page);
  await openMenu(page);
  await add(page, "phase", "train");
  await count(page, 51);
  await add(page, "kind", "probe", 2);
  await expect
    .poll(() => lastPlot(f.requests)?.filters.conditions.length)
    .toBe(2);
  await count(page, 0);
  expect(lastPlot(f.requests).filters.any).toBe(false);
  const phase = menu(page).getByLabel("Condition 1 path", { exact: true });
  await phase.focus();
  await expect
    .poll(
      () =>
        f.requests
          .filter((r) => r.path.endsWith("fields") && r.body.prefix === "phase")
          .at(-1)?.body.filters.conditions,
    )
    .toEqual([{ path: "kind", op: "eq", value: "probe" }]);
  const value = menu(page).getByLabel("Condition 1 value", { exact: true });
  await value.fill("pro");
  await value.press("Tab");
  await expect(value).toHaveValue("probe");
  await count(page, 11);
  await value.fill("train");
  await menu(page)
    .getByLabel("Combine conditions", { exact: true })
    .selectOption("any");
  await count(page, 62);
  expect(lastPlot(f.requests).filters.any).toBe(true);
  await menu(page)
    .getByRole("button", { name: "Remove condition 2", exact: true })
    .click();
  await count(page, 51);
  await menu(page)
    .getByRole("button", { name: "Clear all", exact: true })
    .click();
  await count(page, 62);
});

test("exact-first completion preserves literal/nested/array paths and typed scalar operators", async ({
  page,
}) => {
  const f = await fixture(page);
  await openMenu(page);
  await add(page, "phase", "train");
  const path = menu(page).getByLabel("Condition 1 path", { exact: true });
  const value = menu(page).getByLabel("Condition 1 value", { exact: true });
  await path.fill("phase");
  await expect(
    page.locator(".suggest-list:popover-open [role=option]").first(),
  ).toHaveAttribute("aria-label", /^phase Event/);
  await path.press("Tab");
  await expect(path).toHaveValue("phase");
  for (const [field, text, expected] of [
    ["metrics.loss", "0.5", 1],
    ['$["metrics.loss"]', "100", 1],
    ["items[0].loss", "0", 1],
    ['items["0"].loss', "0", 0],
    ["flag", "true", 51],
    ["nullable", "null", 62],
  ] as const) {
    await path.fill(field);
    await path.press("Tab");
    await value.fill(text);
    await expect
      .poll(() => lastPlot(f.requests)?.filters.conditions[0])
      .toEqual({ path: field, op: "eq", value: JSON.parse(text) });
    await count(page, expected);
  }
  await path.fill("not_in_hints");
  await path.press("Tab");
  await menu(page)
    .getByLabel("Condition 1 operator", { exact: true })
    .selectOption("missing");
  await count(page, 62);
  await expect(
    menu(page).getByLabel("Condition 1 value", { exact: true }),
  ).toBeHidden();
  await menu(page)
    .getByLabel("Condition 1 operator", { exact: true })
    .selectOption("exists");
  await expect
    .poll(() => lastPlot(f.requests)?.filters.conditions[0].op)
    .toBe("exists");
  await path.fill("step");
  await path.press("Tab");
  await menu(page)
    .getByLabel("Condition 1 operator", { exact: true })
    .selectOption("gte");
  await menu(page).getByLabel("Condition 1 value", { exact: true }).fill("52");
  await count(page, 11);
});

test("cancel isolates drafts; unsafe numeric edits retain last good preview and cannot save", async ({
  page,
}) => {
  const f = await fixture(page);
  await openMenu(page);
  await add(page, "phase", "train");
  await count(page, 51);
  const value = menu(page).getByLabel("Condition 1 value", { exact: true });
  await value.fill("9007199254740993");
  await expect(menu(page).locator(".run-filter-error")).toContainText(
    "safe integers",
  );
  await count(page, 51);
  await editor(page)
    .getByRole("button", { name: "Add chart", exact: true })
    .click();
  await expect(editor(page)).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).sharedRecords.saved.length),
  ).toBe(0);
  expect(lastPlot(f.requests).filters.conditions[0].value).toBe("train");
  await editor(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("button", { name: "Open records", exact: true }).click();
  await count(page, 62);
  await openMenu(page);
  await expect(menu(page).locator(".run-filter-row")).toHaveCount(0);
});

test("slow/stale hints, Shift+Tab, Escape and popup-only error/retry", async ({
  page,
}) => {
  const f = await fixture(page);
  await openMenu(page);
  await menu(page)
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  const path = menu(page).getByLabel("Condition 1 path", { exact: true });
  f.delay("pha");
  await path.fill("pha");
  await path.press("Tab");
  await path.fill("kind");
  await path.press("Tab");
  await expect(path).toHaveValue("kind");
  await page.waitForTimeout(700);
  await expect(path).toHaveValue("kind");
  const value = menu(page).getByLabel("Condition 1 value", { exact: true });
  await value.fill("met");
  await value.press("Tab");
  await expect(value).toHaveValue("metric");
  await value.press("Shift+Tab");
  await expect(
    menu(page).getByLabel("Condition 1 operator", { exact: true }),
  ).toBeFocused();
  await path.fill("pha");
  await expect(
    page.locator(".suggest-list:popover-open [role=option]").first(),
  ).toBeVisible();
  await path.press("Escape");
  await expect(menu(page)).toHaveAttribute("open", "");
  await path.press("Escape");
  await expect(menu(page)).not.toHaveAttribute("open", "");
  await expect(editor(page)).toBeVisible();
  await openMenu(page);
  f.failHints(true);
  await path.fill("phase");
  await expect(menu(page).locator(".run-filter-error")).toContainText(
    "fixture hints offline",
  );
  f.failHints(false);
  await menu(page)
    .getByRole("button", { name: "Retry filter search", exact: true })
    .click();
  await expect(menu(page).locator(".run-filter-failure")).toBeHidden();
  await path.fill("unsuggested_valid_path");
  await path.press("Tab");
  await value.fill("train");
  await expect(menu(page).locator(".run-filter-failure")).toBeHidden();
  f.failHints(true);
  await path.fill("phase");
  await expect(menu(page).locator(".run-filter-error")).toContainText(
    "fixture hints offline",
  );
  await menu(page)
    .getByRole("button", { name: "Clear all", exact: true })
    .click();
  await expect(menu(page).locator(".run-filter-failure")).toBeHidden();
});

test("same compact shared menu styling at narrow and full viewport, no legacy form", async ({
  page,
}, info) => {
  await fixture(page);
  await editor(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.locator("#native summary").click();
  const native = page.locator("#native .run-filter-popover");
  await native.screenshot({ path: info.outputPath("run-menu.png") });
  const dimensions = (host: Locator) =>
    host.locator(".run-filter-path").evaluate((el) => {
      const css = getComputedStyle(el);
      return {
        height: css.height,
        font: css.fontSize,
        padding: css.padding,
        radius: css.borderRadius,
      };
    });
  const expected = await dimensions(native);
  await page.getByRole("button", { name: "Open records", exact: true }).click();
  await openMenu(page);
  await add(page, "phase", "train");
  await menu(page)
    .getByLabel("Condition 1 value", { exact: true })
    .press("Escape");
  // Escape may close the menu when there is no open value list.
  if ((await menu(page).getAttribute("open")) === null) await openMenu(page);
  expect(await dimensions(menu(page))).toEqual(expected);
  expect(
    await menu(page)
      .locator(".run-filter-line")
      .evaluate((el) =>
        [...el.children]
          .filter((n) => !n.classList.contains("suggest-list"))
          .map((n) => n.className),
      ),
  ).toEqual([
    "run-filter-scope",
    "run-filter-path",
    "run-filter-op",
    "run-filter-value",
    "run-filter-remove",
  ]);
  await expect(
    editor(page).getByText(
      /JSON value|Apply record filters|Add record condition|maximum 32|Only finite numeric X\/Y/,
    ),
  ).toHaveCount(0);
  for (const width of [760, 1500]) {
    await page.setViewportSize({ width, height: 1100 });
    const popup = menu(page).locator(".run-filter-popover");
    await expect(popup).toBeVisible();
    const box = await popup.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.width).toBeGreaterThan(450);
    await popup.screenshot({
      path: info.outputPath(`chart-menu-${width}.png`),
    });
  }
});

test("many selected runs do not constrain the editor or its discovery provider", async ({
  page,
}) => {
  const f = await fixture(page, 70);
  await openMenu(page);
  await add(page, "phase", "train");
  await expect(
    menu(page).getByLabel("Condition 1 value", { exact: true }),
  ).toHaveValue("train");
  await expect
    .poll(
      () =>
        f.requests.filter((r) => r.path.endsWith("fields")).at(-1)?.body.runs
          .length,
    )
    .toBe(70);
  await expect(editor(page).getByText(/maximum 32|at most 32/)).toHaveCount(0);
});

test("typed numeric values are not replaced by sampled prefixes; corrected paths can save", async ({
  page,
}) => {
  await fixture(page);
  await openMenu(page);
  await add(page, "metrics.loss", "1");
  const path = menu(page).getByLabel("Condition 1 path", { exact: true });
  const value = menu(page).getByLabel("Condition 1 value", { exact: true });
  await value.press("Tab");
  await expect(value).toHaveValue("1"); // Sample contains 1.5, not 1.
  await count(page, 0);
  await path.fill("metrics.");
  await path.press("Enter");
  await expect(menu(page).locator(".run-filter-error")).toContainText("Finish");
  await page.getByRole("option", { name: /^metrics\.loss Event/ }).click();
  await value.fill("0.5");
  await expect(menu(page).locator(".run-filter-failure")).toBeHidden();
  expect(
    await path.evaluate((input: HTMLInputElement) => input.validity.valid),
  ).toBe(true);
  await count(page, 1);
  await editor(page)
    .getByRole("button", { name: "Add chart", exact: true })
    .click();
  await expect(editor(page)).toHaveCount(0);
});
