import { test, expect, type Page } from "@playwright/test";

const now = Date.parse("2026-10-26T12:00:00Z");
const hour = 3_600_000;
const source = "rx:selection";
const uid = (n: number) => `uid-${n}`;
const id = (kind: string, n: number) =>
  kind === "rx" ? `${source}:${uid(n)}` : `run-${n}`;
const emptyRecords = (extra = {}) => ({
  fields: [],
  records: [],
  traces: [],
  next_cursor: null,
  coverage: "complete",
  diagnostics: {
    scanned: 3,
    matched: 3,
    bytes: 100,
    invalid_json: 0,
    oversized: 0,
    skipped_axes: 0,
    skipped_groups: 0,
    omitted_traces: 0,
    points: 6,
    partial: false,
    reasons: [],
  },
  ...extra,
});
const saved = (page: Page) =>
  page.evaluate(() => {
    const w = JSON.parse(localStorage.getItem("nset.workspaces.v2")!).views[0];
    return {
      selected: [...w.selectedRunIds].sort(),
      pending: [...(w.pendingSelectedRunIds ?? [])].sort(),
    };
  });
const card = (page: Page, explicit = false) =>
  page.locator(`[data-card-id="${explicit ? "fixed" : "active"}"]`);
const traces = (page: Page, explicit = false) =>
  card(page, explicit).locator(".card-legend-item");
const drawer = (page: Page) => page.locator(".run-drawer");

async function fixture(page: Page, kind = "native") {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.clock.install({ time: new Date(now) });
  const experiment = kind === "rx" ? source : "native";
  const state = {
    mode: "match" as "match" | "hold" | "error" | "partial",
    scans: 0,
    plots: [] as string[][],
    release: () => {},
  };
  const runs = [1, 2, 3].map((n) => ({
    id: id(kind, n),
    experiment_id: experiment,
    name: `r${n}`,
    status: n === 3 ? "running" : "finished",
    params: n < 3 ? { keep: true } : {},
    tags: n < 3 ? { keep: true } : {},
    created_at: now - (n === 1 ? 23 : n === 2 ? 48 : 240) * hour,
    updated_at: now - (n === 1 ? 23 : n === 2 ? 48 : 240) * hour,
  }));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    if (path === "/api/catalog")
      return route.fulfill({
        json: {
          rx_enabled: kind === "rx",
          experiments:
            kind === "rx"
              ? []
              : [{ id: experiment, name: "Selection", created_at: now }],
          runs: kind === "rx" ? [] : runs,
          series:
            kind === "rx"
              ? []
              : runs.map((run) => ({
                  run_id: run.id,
                  key: "loss",
                  kind: "metric",
                  count: 2,
                  last_step: 1,
                  last_timestamp: now,
                  last_value: 1,
                })),
        },
      });
    if (path === "/api/rx/catalog")
      return route.fulfill({
        json: {
          source: { id: source, name: "Selection", readonly: true },
          next_after: null,
          runs: runs.map((run, i) => ({
            id: String(i + 1),
            run_uid: uid(i + 1),
            state: run.status === "running" ? "active" : "succeeded",
            alias: null,
            config: "",
            argv: [],
            exit_code: 0,
            created_at: new Date(run.created_at).toISOString(),
            started_at: null,
            finished_at: null,
          })),
        },
      });
    if (path.endsWith("/metrics"))
      return route.fulfill({
        json: {
          points: [0, 1].map((step) => ({
            seq: step + 1,
            step,
            timestamp: now + step,
            value: 2 - step,
          })),
          total: 2,
          snapshot: 2,
          next_after: null,
        },
      });
    if (path === "/api/rx/fields")
      return route.fulfill({ json: emptyRecords() });
    if (path === "/api/rx/run-filter") {
      state.scans++;
      const mode = state.mode;
      if (mode === "partial" && !body.cursor) return route.fulfill({ json: {
        source_generation: "generation",
        runs: body.runs.map((run: string) => ({ uid: run, conditions: body.conditions.map(() => run === uid(1) ? true : null) })),
        cursor: "next", diagnostics: { scanned: 1, partial: true },
      } });
      if (mode === "hold" || mode === "partial")
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      if (mode === "error")
        return route.fulfill({ status: 500, json: { error: "Scan failed" } });
      return route.fulfill({
        json: {
          source_generation: "generation",
          runs: body.runs.map((run: string) => ({
            uid: run,
            conditions: body.conditions.map(() => run !== uid(3)),
          })),
          cursor: null,
          diagnostics: { scanned: 3, partial: false },
        },
      });
    }
    if (path === "/api/rx/plot") {
      state.plots.push(body.runs);
      return route.fulfill({
        json: emptyRecords({
          traces: body.runs.map((run: string) => ({
            run_uid: run,
            y: "loss",
            group: null,
            points: [
              [0, 2, "1"],
              [1, 1, "2"],
            ],
          })),
        }),
      });
    }
    return route.fulfill({
      status: 404,
      json: { error: `Unexpected ${path}` },
    });
  });
  await page.goto(`/#/experiments/${encodeURIComponent(experiment)}/runs`);
  await page
    .getByLabel("Access token", { exact: true })
    .fill("selection-fixture");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  await expect
    .poll(() => saved(page))
    .toEqual({
      selected: [1, 2, 3].map((n) => id(kind, n)).sort(),
      pending: [],
    });
  await page.evaluate(
    async ({ kind, source, fixedId }) => {
      const modulePath = "/src/workspace.ts";
      const { newChart } = await import(modulePath);
      const library = JSON.parse(localStorage.getItem("nset.workspaces.v2")!);
      const active = newChart("timeseries", ["loss"], "Active selection");
      active.id = "active";
      if (kind === "rx")
        active.records = {
          sourceId: source,
          runUids: [],
          x: "step",
          ys: ["loss"],
          filters: { any: false, conditions: [] },
        };
      const fixed = structuredClone(active);
      fixed.id = "fixed";
      fixed.title = "Explicit control";
      if (kind === "rx") fixed.records.runUids = ["uid-3"];
      else
        fixed.source = {
          mode: "explicit",
          series: [{ runId: fixedId, key: "loss", kind: "metric" }],
        };
      library.views[0].sections = [
        { id: "s", title: "Metrics", collapsed: false, cards: [active, fixed] },
      ];
      localStorage.setItem("nset.workspaces.v2", JSON.stringify(library));
    },
    { kind, source, fixedId: id(kind, 3) },
  );
  await page.reload();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await expect(traces(page)).toHaveCount(3);
  await expect(traces(page, true)).toHaveCount(1);
  return state;
}
async function openFilter(page: Page) {
  const menu = page.locator(".run-filter-menu:visible");
  if ((await menu.getAttribute("open")) === null)
    await menu.locator("summary").click();
  return menu;
}
async function presence(page: Page, scope: string) {
  const menu = await openFilter(page);
  await menu
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  await menu
    .getByLabel("Condition 1 scope", { exact: true })
    .selectOption(scope);
  await menu
    .getByLabel("Condition 1 operator", { exact: true })
    .selectOption("exists");
  await menu
    .getByLabel("Condition 1 path", { exact: true })
    .fill(scope === "event" ? "loss" : "keep");
  await menu.getByLabel("Condition 1 path", { exact: true }).press("Enter");
  return menu;
}
async function expectSelection(
  page: Page,
  kind: string,
  numbers: number[],
  pending: number[] = [],
) {
  await expect
    .poll(() => saved(page))
    .toEqual({
      selected: numbers.map((n) => id(kind, n)).sort(),
      pending: pending.map((n) => id(kind, n)).sort(),
    });
  await expect(drawer(page).locator(".drawer-selection-count")).toHaveText(
    `Selected (${numbers.length})`,
  );
  await expect(traces(page)).toHaveCount(numbers.length);
  await expect(card(page).locator(".card-legend-name")).toHaveText(
    numbers.map((n) => `r${n}`),
  );
  await expect(traces(page, true)).toHaveCount(1);
}

test("search prunes live charts and persistence; typing keeps focus; both lists and reload agree", async ({
  page,
}) => {
  await fixture(page);
  const search = page.getByLabel("Find runs", { exact: true });
  await search.focus();
  await search.pressSequentially("r1");
  await expect(search).toBeFocused();
  await expectSelection(page, "native", [1]);
  await drawer(page)
    .getByRole("checkbox", { name: "Show r1", exact: true })
    .uncheck();
  await expectSelection(page, "native", []);
  await drawer(page)
    .getByRole("checkbox", { name: "Show r1", exact: true })
    .check();
  await expectSelection(page, "native", [1]);
  await drawer(page)
    .getByRole("button", { name: "Open run table", exact: true })
    .click();
  const tableSearch = page.getByLabel("Search runs, parameters or tags", {
    exact: true,
  });
  await expect(tableSearch).toHaveValue("r1");
  await expect(page.locator(".selection-count")).toHaveText("1 selected");
  await expect(
    page.getByRole("checkbox", { name: "Select r1", exact: true }),
  ).toBeChecked();
  await tableSearch.fill("");
  await expect(tableSearch).toBeFocused();
  await expect(
    page.getByRole("checkbox", { name: "Select r2", exact: true }),
  ).not.toBeChecked();
  await page.getByLabel("Run status", { exact: true }).selectOption("running");
  await expect(page.locator(".selection-count")).toHaveText("0 selected");
  await expect.poll(() => saved(page)).toEqual({ selected: [], pending: [] });
  await page
    .getByRole("navigation", { name: "Experiment views" })
    .getByRole("button", { name: "Charts", exact: true })
    .click();
  await expectSelection(page, "native", []);
  await expect(page.getByLabel("Filter chart runs by status")).toHaveValue(
    "running",
  );
  await drawer(page)
    .getByRole("button", { name: "Select matching", exact: true })
    .click();
  await expectSelection(page, "native", [3]);
  await page.reload();
  await expectSelection(page, "native", [3]);
  await expect(page.getByLabel("Filter chart runs by status")).toHaveValue(
    "running",
  );
  await drawer(page)
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expectSelection(page, "native", [3]);
});

for (const scope of ["params", "tags"]) {
  test(`${scope} narrows selection and clearing does not resurrect excluded runs`, async ({
    page,
  }) => {
    await fixture(page);
    const menu = await presence(page, scope);
    await expectSelection(page, "native", [1, 2]);
    await menu.getByRole("button", { name: "Clear all", exact: true }).click();
    await expectSelection(page, "native", [1, 2]);
    await menu.locator("summary").click();
    await drawer(page).locator(".drawer-selection-count").click();
    await expect(drawer(page).locator(".run-drawer-row:visible")).toHaveCount(
      2,
    );
    await expectSelection(page, "native", [1, 2]);
    await drawer(page)
      .getByRole("checkbox", { name: "Show r2", exact: true })
      .uncheck();
    await expectSelection(page, "native", [1]);
    await drawer(page).locator(".drawer-selection-count").click();
    await drawer(page)
      .getByRole("checkbox", { name: "Show r3", exact: true })
      .check();
    await expectSelection(page, "native", [1, 3]);
  });
}

for (const kind of ["native", "rx"]) {
  test(`${kind} Time narrowing, reload and clock aging while viewing run details`, async ({
    page,
  }) => {
    await fixture(page, kind);
    const menu = await openFilter(page);
    await menu
      .getByRole("button", { name: "+ Add condition", exact: true })
      .click();
    await menu
      .getByLabel("Condition 1 scope", { exact: true })
      .selectOption("time");
    await menu.getByLabel("Condition 1 duration", { exact: true }).fill("1");
    await expectSelection(page, kind, [1]);
    await menu.locator("summary").click();
    await page.reload();
    await expectSelection(page, kind, [1]);
    await drawer(page).getByRole("button", { name: "r1", exact: true }).click();
    await page.clock.fastForward(2 * hour);
    await page
      .getByRole("navigation", { name: "Experiment views" })
      .getByRole("button", { name: "Charts", exact: true })
      .click();
    await expectSelection(page, kind, []);
    await drawer(page)
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();
    await expectSelection(page, kind, []);
  });
}

test("Event pending withholds traces, then confirms matches and irreversibly removes nonmatches", async ({
  page,
}) => {
  const state = await fixture(page, "rx");
  state.mode = "hold";
  try {
    await presence(page, "event");
    await expect.poll(() => state.scans).toBeGreaterThan(0);
    await expectSelection(page, "rx", [], [1, 2, 3]);
    state.release();
    await expectSelection(page, "rx", [1, 2]);
    expect(state.plots.at(-1)).toEqual([uid(1), uid(2)]);
    await (
      await openFilter(page)
    )
      .getByRole("button", { name: "Clear all", exact: true })
      .click();
    await expectSelection(page, "rx", [1, 2]);
  } finally {
    state.release();
  }
});

test("failed Event evidence and reload retain pending intent; retry restores only confirmed matches", async ({
  page,
}) => {
  const state = await fixture(page, "rx");
  state.mode = "error";
  await presence(page, "event");
  await expect(page.locator(".run-filter-control:visible")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expectSelection(page, "rx", [], [1, 2, 3]);
  await page.reload();
  await expectSelection(page, "rx", [], [1, 2, 3]);
  const menu = await openFilter(page);
  await expect(
    menu.getByRole("button", { name: "Retry filter search", exact: true }),
  ).toBeVisible();
  state.mode = "match";
  await menu
    .getByRole("button", { name: "Retry filter search", exact: true })
    .click();
  await expectSelection(page, "rx", [1, 2]);
});

test("clearing a pending Event filter restores unresolved intent but ignores its late response", async ({
  page,
}) => {
  const state = await fixture(page, "rx");
  state.mode = "hold";
  try {
    const menu = await presence(page, "event");
    await expect.poll(() => state.scans).toBeGreaterThan(0);
    await expectSelection(page, "rx", [], [1, 2, 3]);
    await menu.getByRole("button", { name: "Clear all", exact: true }).click();
    await expectSelection(page, "rx", [1, 2, 3]);
    state.release();
    await expectSelection(page, "rx", [1, 2, 3]);
  } finally {
    state.release();
  }
});

test("the shared relative clock prunes active charts without recursive renders", async ({
  page,
}) => {
  await fixture(page);
  const menu = await openFilter(page);
  await menu
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  await menu
    .getByLabel("Condition 1 scope", { exact: true })
    .selectOption("time");
  await menu.getByLabel("Condition 1 duration", { exact: true }).fill("1");
  await expectSelection(page, "native", [1]);
  await page.clock.fastForward(2 * hour);
  await expectSelection(page, "native", []);
  await expect(
    menu.getByLabel("Condition 1 duration", { exact: true }),
  ).toBeFocused();
});

test("explicit Clear selection cancels pending intent before a late Event response", async ({
  page,
}) => {
  const state = await fixture(page, "rx");
  state.mode = "hold";
  try {
    await presence(page, "event");
    await expect.poll(() => state.scans).toBeGreaterThan(0);
    await expectSelection(page, "rx", [], [1, 2, 3]);
    await (await openFilter(page)).locator("summary").click();
    await drawer(page)
      .getByRole("button", { name: "Clear selection", exact: true })
      .click();
    await expectSelection(page, "rx", []);
    state.release();
    await expect(page.locator(".run-filter-control:visible")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expectSelection(page, "rx", []);
  } finally {
    state.release();
  }
});

test("text exclusions during pending Event evidence stay removed after resolution", async ({
  page,
}) => {
  const state = await fixture(page, "rx");
  state.mode = "hold";
  try {
    const menu = await presence(page, "event");
    await expect.poll(() => state.scans).toBeGreaterThan(0);
    await expectSelection(page, "rx", [], [1, 2, 3]);
    await menu.locator("summary").click();
    await page.getByLabel("Find runs", { exact: true }).fill("r1");
    await expectSelection(page, "rx", [], [1]);
    await page.getByLabel("Find runs", { exact: true }).fill("");
    state.release();
    await expectSelection(page, "rx", [1]);
  } finally {
    state.release();
  }
});

test("unchecking the last confirmed match preserves unrelated pending intent", async ({ page }) => {
  const state = await fixture(page, "rx");
  state.mode = "partial";
  try {
    const menu = await presence(page, "event");
    await expect.poll(() => state.scans).toBe(2);
    await expectSelection(page, "rx", [1], [2, 3]);
    await menu.locator("summary").click();
    await drawer(page).getByRole("checkbox", { name: "Show r1", exact: true }).uncheck();
    await expectSelection(page, "rx", [], [2, 3]);
    state.release();
    await expectSelection(page, "rx", [2]);
  } finally { state.release(); }
});

test("the main table can explicitly clear pending-only selection", async ({ page }) => {
  const state = await fixture(page, "rx");
  state.mode = "error";
  const menu = await presence(page, "event");
  await expectSelection(page, "rx", [], [1, 2, 3]);
  await menu.locator("summary").click();
  await drawer(page).getByRole("button", { name: "Open run table", exact: true }).click();
  await expect(page.locator(".selection-count")).toHaveText("0 selected");
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect.poll(() => saved(page)).toEqual({ selected: [], pending: [] });
  await page.getByRole("navigation", { name: "Experiment views" }).getByRole("button", { name: "Charts", exact: true }).click();
  await drawer(page).getByRole("button", { name: "Clear filters", exact: true }).click();
  await expectSelection(page, "rx", []);
});

for (const restorePending of [false, true]) {
  test(`Undo ${restorePending ? "restores cleared pending intent" : "removes pending intent absent from its snapshot"}`, async ({ page }) => {
    const state = await fixture(page, "rx");
    if (!restorePending) {
      await drawer(page).getByRole("button", { name: "Clear selection", exact: true }).click();
      await drawer(page).getByRole("checkbox", { name: "Show r1", exact: true }).check();
      await expectSelection(page, "rx", [1]);
    }
    state.mode = "hold";
    try {
      const menu = await presence(page, "event");
      await expect.poll(() => state.scans).toBeGreaterThan(0);
      await expectSelection(page, "rx", [], restorePending ? [1, 2, 3] : [1]);
      await menu.locator("summary").click();
      if (restorePending) {
        await drawer(page).getByRole("button", { name: "Clear selection", exact: true }).click();
        await expectSelection(page, "rx", []);
      }
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expectSelection(page, "rx", [], restorePending ? [1, 2, 3] : []);
      state.release();
      await expect(page.locator(".run-filter-control:visible")).toHaveAttribute("aria-busy", "false");
      await expectSelection(page, "rx", restorePending ? [1, 2] : []);
      await (await openFilter(page)).getByRole("button", { name: "Clear all", exact: true }).click();
      await expectSelection(page, "rx", restorePending ? [1, 2] : []);
    } finally {
      state.release();
    }
  });
}
