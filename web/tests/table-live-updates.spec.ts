import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, kind: "runs" | "experiments" = "runs") {
  await page.route("**/__table_live_updates", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"><style>.table-scroll { height: 180px; width: 600px; overflow: auto; } .data-table:not(.run-table) { width: 1000px; } td { height: 30px; } .run-browser { height: 320px; width: 600px; } .run-table { width: 100%; } .column-choices { max-height: 100px; overflow: auto; }</style></head><body><main></main></body></html>',
    }),
  );
  await page.goto("/__table_live_updates");
  await page.evaluate(async (kind) => {
    const { experimentTable, runTable, tableState } =
      await import("/src/browser-tables.ts");
    const { RunFilterSession } = await import("/src/run-filter-session.ts");
    const experiments = Array.from(
      { length: kind === "runs" ? 1 : 120 },
      (_, i) => ({
        id: `experiment-${i}`,
        name: `Experiment ${String(i).padStart(3, "0")}`,
        created_at: i,
      }),
    );
    const runs = Array.from({ length: 120 }, (_, i) => ({
      id: `run-${i}`,
      experiment_id: experiments[kind === "runs" ? 0 : i].id,
      name: `Candidate ${String(i).padStart(3, "0")}`,
      status: "running",
      params: { index: i },
      tags: {},
      created_at: i,
      updated_at: i,
    }));
    const series = runs.map((run, i) => ({
      run_id: run.id,
      key: "loss",
      kind: "metric",
      last_value: i,
      last_step: 0,
      last_timestamp: i,
      count: 1,
    }));
    const catalog = { experiments, runs, series } as any;
    const state = tableState();
    state.sort = kind === "runs" ? "metric:loss" : "name";
    state.descending = false;
    state.metrics = ["loss"];
    const selections: string[][] = [];
    const details: unknown[] = [];
    const session = new RunFilterSession();
    const table =
      kind === "runs"
        ? runTable(
            catalog,
            experiments[0],
            ["run-0"],
            (ids) => {
              selections.push(ids);
            },
            () => {},
            (run) => {
              details.push(run);
            },
            state,
            session,
          )
        : experimentTable(
            catalog,
            (id) => {
              details.push(id);
            },
            state,
          );
    document.querySelector("main")!.append(table);
    const calls = { setRuns: 0, notifications: 0, storage: 0 };
    const setRuns = session.setRuns.bind(session);
    session.setRuns = (...args) => {
      calls.setRuns++;
      return setRuns(...args);
    };
    session.subscribe(() => {
      calls.notifications++;
    });
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args) {
      calls.storage++;
      return setItem.apply(this, args);
    };
    (window as any).__liveTable = {
      table,
      catalog,
      state,
      selections,
      details,
      session,
      calls,
      update(next: typeof catalog) {
        this.catalog = next;
        table.updateCatalog(next);
      },
    };
  }, kind);
}

const search = (page: Page) =>
  page.getByRole("searchbox", {
    name: "Search runs, parameters or tags",
    exact: true,
  });
const run = (page: Page, id: number) =>
  page.locator(`tbody tr[data-run-id="run-${id}"]`);

test("metric counts, status and new runs refresh while typing without selection or persistence effects", async ({
  page,
}) => {
  await fixture(page);
  await search(page).fill("Candid");
  await page.evaluate(() => {
    const f = (window as any).__liveTable;
    const input = f.table.querySelector(
      'input[aria-label="Search runs, parameters or tags"]',
    );
    input.setSelectionRange(6, 6);
    const head = f.table.querySelector("thead tr");
    const filter = f.table.querySelector(".run-filter-control");
    const scroll = f.table.querySelector(".table-scroll");
    scroll.scrollTop = 100;
    scroll.scrollLeft = 80;
    const next = structuredClone(f.catalog);
    next.runs[0].status = "finished";
    next.series[0] = {
      ...next.series[0],
      count: 25,
      last_value: 0.25,
      last_step: 24,
    };
    next.runs.push({
      ...next.runs[1],
      id: "run-120",
      name: "Candidate 120",
      created_at: 120,
    });
    f.calls.notifications = 0;
    f.update(next);
    f.retained = {
      input:
        input ===
        f.table.querySelector(
          'input[aria-label="Search runs, parameters or tags"]',
        ),
      head: head === f.table.querySelector("thead tr"),
      filter: filter === f.table.querySelector(".run-filter-control"),
      caret: input.selectionStart,
      scrollTop: scroll.scrollTop,
      scrollLeft: scroll.scrollLeft,
    };
  });
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue("Candid");
  await expect(run(page, 0).locator(".number-cell")).toHaveText("0.25");
  await expect(run(page, 0).locator(".number-cell")).toHaveAttribute(
    "title",
    /Step 24.*25 logged values/,
  );
  await expect(run(page, 0).locator(".status")).toHaveText("Finished");
  await expect(run(page, 0).getByRole("checkbox")).toBeChecked();
  await expect(page.locator(".table-summary")).toContainText("121 runs");
  expect(
    await page.evaluate(() => {
      const f = (window as any).__liveTable;
      return { retained: f.retained, selections: f.selections, calls: f.calls };
    }),
  ).toEqual({
    retained: {
      input: true,
      head: true,
      filter: true,
      caret: 6,
      scrollTop: 100,
      scrollLeft: 80,
    },
    selections: [],
    calls: { setRuns: 0, notifications: 0, storage: 0 },
  });
  await page.keyboard.insertText("ate");
  await expect(search(page)).toHaveValue("Candidate");
  // The retained header must select the new matching run, not its original closure's rows.
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  expect(
    await page.evaluate(() => (window as any).__liveTable.selections.at(-1)),
  ).toHaveLength(121);
});

test("live values preserve sort, checkbox focus and scrolling; equivalent data keeps rows mounted", async ({
  page,
}) => {
  await fixture(page);
  await expect(page.locator("tbody tr")).toHaveCount(120);
  await run(page, 55).getByRole("checkbox").focus();
  const result = await page.evaluate(() => {
    const f = (window as any).__liveTable;
    const wrap = f.table.querySelector(".table-scroll");
    wrap.scrollTop = 110;
    wrap.scrollLeft = 90;
    const sortButton = f.table.querySelector('[data-sort-key="metric:loss"]');
    const next = structuredClone(f.catalog);
    next.series[55].last_value = 51.25;
    next.series[55].count = 2;
    f.update(next);
    const row = f.table.querySelector('tr[data-run-id="run-55"]');
    f.update(structuredClone(next));
    const sameRow = row === f.table.querySelector('tr[data-run-id="run-55"]');
    const offscreen = structuredClone(next);
    offscreen.series[119].count = 10;
    f.update(offscreen);
    return {
      page: f.state.page,
      sort: f.state.sort,
      descending: f.state.descending,
      scrollTop: wrap.scrollTop,
      scrollLeft: wrap.scrollLeft,
      sameRow,
      noPager: !f.table.querySelector(".table-pager"),
      sameSort:
        sortButton === f.table.querySelector('[data-sort-key="metric:loss"]'),
      selections: f.selections,
      calls: f.calls,
    };
  });
  expect(result).toEqual({
    page: 0,
    sort: "metric:loss",
    descending: false,
    scrollTop: 110,
    scrollLeft: 90,
    sameRow: true,
    noPager: true,
    sameSort: true,
    selections: [],
    calls: { setRuns: 0, notifications: 0, storage: 0 },
  });
  await expect(run(page, 55).getByRole("checkbox")).toBeFocused();
  await expect(run(page, 55).locator(".number-cell")).toHaveText("51.25");
  await expect(page.locator("tbody tr").nth(52)).toHaveAttribute(
    "data-run-id",
    "run-55",
  );
  await expect(run(page, 119).locator(".number-cell")).toHaveAttribute(
    "title",
    /10 logged values/,
  );
  // Even an unchanged row's details action resolves the most recent catalog object.
  await run(page, 55)
    .getByRole("button", { name: "Candidate 055", exact: true })
    .click();
  expect(
    await page.evaluate(() => {
      const f = (window as any).__liveTable;
      return f.details[0] === f.catalog.runs[55];
    }),
  ).toBe(true);
});

test("new metric and parameter fields retain the open picker, query, choices and focus", async ({
  page,
}) => {
  await fixture(page);
  await page.getByText("Columns", { exact: true }).click();
  const columns = page.getByRole("searchbox", {
    name: "Search columns",
    exact: true,
  });
  await columns.fill("new");
  await page.evaluate(() => {
    const f = (window as any).__liveTable;
    const next = structuredClone(f.catalog);
    next.runs[0].params.newParameter = 42;
    next.series.push({ ...next.series[0], key: "newMetric" });
    f.update(next);
  });
  await expect(columns).toBeFocused();
  await expect(columns).toHaveValue("new");
  await expect(
    page.getByRole("checkbox", { name: "newMetric", exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "newParameter", exact: true }),
  ).toBeVisible();
  await columns.fill("");
  const loss = page.getByRole("checkbox", { name: "loss", exact: true });
  await loss.focus();
  await page.evaluate(() => {
    const f = (window as any).__liveTable;
    const next = structuredClone(f.catalog);
    next.series.push({ ...next.series[0], key: "anotherMetric" });
    f.update(next);
  });
  await expect(loss).toBeFocused();
  await expect(loss).toBeChecked();
  expect(
    await page.evaluate(() => {
      const f = (window as any).__liveTable;
      return {
        metrics: f.state.metrics,
        parameters: f.state.parameters,
        selections: f.selections,
      };
    }),
  ).toEqual({ metrics: ["loss"], parameters: [], selections: [] });
});

test("shared search/status filtering survives metadata refresh and destroy stops updates", async ({
  page,
}) => {
  await fixture(page);
  await search(page).fill("Candidate 00");
  await page
    .getByRole("combobox", { name: "Run status", exact: true })
    .selectOption("running");
  await search(page).focus();
  await page.evaluate(() => {
    const f = (window as any).__liveTable;
    const next = structuredClone(f.catalog);
    next.runs[0].status = "finished";
    // Caller owns shared-session metadata refresh; the table must not repeat it.
    f.session.setRuns(next.runs, next);
    f.calls.setRuns = 0;
    f.calls.notifications = 0;
    f.update(next);
  });
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue("Candidate 00");
  await expect(
    page.getByRole("combobox", { name: "Run status", exact: true }),
  ).toHaveValue("running");
  await expect(run(page, 0)).toHaveCount(0);
  await expect(page.locator("tbody tr")).toHaveCount(9);
  await expect(page.locator(".selection-count")).toHaveText("1 selected");
  expect(
    await page.evaluate(() => {
      const f = (window as any).__liveTable;
      const before = f.table.innerHTML;
      f.table.destroy();
      f.table.updateCatalog({ experiments: [], runs: [], series: [] });
      return {
        unchanged: before === f.table.innerHTML,
        selections: f.selections,
        calls: f.calls,
      };
    }),
  ).toEqual({
    unchanged: true,
    selections: [],
    calls: { setRuns: 0, notifications: 0, storage: 0 },
  });
});

test("experiment updates refresh counts and additions without resetting search, page, focus or shell", async ({
  page,
}) => {
  await fixture(page, "experiments");
  const input = page.getByRole("searchbox", {
    name: "Search experiments",
    exact: true,
  });
  await input.fill("Experiment");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await input.focus();
  expect(
    await page.evaluate(() => {
      const f = (window as any).__liveTable;
      const head = f.table.querySelector("thead");
      const search = f.table.querySelector("input");
      const wrap = f.table.querySelector(".table-scroll");
      wrap.scrollTop = 120;
      wrap.scrollLeft = 70;
      const next = structuredClone(f.catalog);
      next.experiments.push({
        id: "experiment-120",
        name: "Experiment 120",
        created_at: 120,
      });
      next.runs.push({ ...next.runs[55], id: "new-run" });
      f.update(next);
      const row = f.table.querySelector("tbody tr");
      const metricOnly = structuredClone(next);
      metricOnly.series[55].count++;
      f.update(metricOnly);
      return {
        page: f.state.page,
        sort: f.state.sort,
        query: f.state.query,
        head: head === f.table.querySelector("thead"),
        input: search === f.table.querySelector("input"),
        row: row === f.table.querySelector("tbody tr"),
        scrollTop: wrap.scrollTop,
        scrollLeft: wrap.scrollLeft,
        opened: f.details,
      };
    }),
  ).toEqual({
    page: 1,
    sort: "name",
    query: "Experiment",
    head: true,
    input: true,
    row: true,
    scrollTop: 120,
    scrollLeft: 70,
    opened: [],
  });
  await expect(input).toBeFocused();
  await expect(page.locator(".table-toolbar")).toContainText("121 experiments");
  await expect(
    page
      .locator("tbody tr")
      .filter({ hasText: "Experiment 055" })
      .locator("td")
      .nth(1),
  ).toHaveText("2");
});
