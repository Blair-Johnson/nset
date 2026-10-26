import { test, expect, type Page, type Route } from "@playwright/test";

// Real app entrypoint/router/views, with an isolated, metadata-only rx source.
const source = "rx:complete-filter-fixture";
const count = 1007; // Six catalog pages, 32 filter batches; beyond the old 1000/160 caps.
const uid = (n: number) => `completion-${String(n).padStart(4, "0")}`;
const generation = "completion-generation";
type Call = { url: URL; body: any; method: string };
const emptyResult = {
  fields: [],
  records: [],
  traces: [],
  next_cursor: null,
  coverage: "bounded",
  diagnostics: {
    scanned: 0,
    matched: 0,
    bytes: 0,
    invalid_json: 0,
    oversized: 0,
    skipped_axes: 0,
    skipped_groups: 0,
    omitted_traces: 0,
    points: 0,
    partial: false,
    reasons: [],
  },
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(
  page: Page,
  intercept?: (route: Route, call: Call) => Promise<boolean>,
  startAtHome = false,
) {
  const calls: Call[] = [];
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    (window as any).__completionRequests = [];
    (window as any).__maxCompletionInFlight = 0;
    let active = 0;
    window.fetch = (input, init) => {
      if (String(input).endsWith("/rx/run-filter")) {
        const entry = { body: JSON.parse(String(init?.body)), aborted: false };
        (window as any).__completionRequests.push(entry);
        init?.signal?.addEventListener("abort", () => {
          entry.aborted = true;
        });
        active++;
        (window as any).__maxCompletionInFlight = Math.max(
          (window as any).__maxCompletionInFlight,
          active,
        );
        return original(input, init).finally(() => {
          active--;
        });
      }
      return original(input, init);
    };
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const call = {
      url: new URL(request.url()),
      body: request.postDataJSON(),
      method: request.method(),
    };
    calls.push(call);
    if (intercept && (await intercept(route, call))) return;
    switch (call.url.pathname) {
      case "/api/catalog":
        await route.fulfill({
          json: { experiments: [], runs: [], series: [], rx_enabled: true },
        });
        break;
      case "/api/rx/catalog": {
        const after = Number(call.url.searchParams.get("after") ?? 0);
        const end = Math.min(after + 200, count);
        await route.fulfill({
          json: {
            source: { id: source, name: "Completion fixture" },
            high_water: String(count),
            source_generation: generation,
            next_after: end < count ? String(end) : null,
            runs: Array.from({ length: end - after }, (_, index) => ({
              id: String(after + index + 1),
              run_uid: uid(after + index + 1),
              state: "succeeded",
              alias: null,
              config: "metadata only",
              argv: [],
              exit_code: 0,
              created_at: "2026-10-01T00:00:00Z",
              started_at: null,
              finished_at: null,
            })),
          },
        });
        break;
      }
      case "/api/rx/fields":
      case "/api/rx/plot":
        await route.fulfill({ json: emptyResult });
        break;
      case "/api/rx/run-filter":
        await answer(route, call);
        break;
      default:
        await route.fulfill({
          status: 500,
          json: { error: `Unexpected endpoint ${call.url.pathname}` },
        });
    }
  });
  await page.goto(
    startAtHome
      ? "/#/experiments"
      : `/#/experiments/${encodeURIComponent(source)}/runs`,
  );
  await page
    .getByLabel("Access token", { exact: true })
    .fill("completion-test-token");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  if (startAtHome)
    await expect(
      page.getByRole("button", {
        name: "rx · Completion fixture",
        exact: true,
      }),
    ).toBeVisible();
  else
    await expect(
      page.getByRole("table", { name: "Runs", exact: true }),
    ).toBeVisible();
  return calls;
}
const scans = (calls: Call[]) =>
  calls.filter((c) => c.url.pathname === "/api/rx/run-filter");
const pageNumber = (call: Call) =>
  Number(call.body.cursor?.split(":").at(-1) ?? 0);
const isLast = (call: Call) => call.body.runs.includes(uid(count));
async function answer(route: Route, call: Call) {
  const page = pageNumber(call);
  const partial = isLast(call) && page < 5;
  await route.fulfill({
    json: {
      source_generation: generation,
      runs: call.body.runs.map((run: string) => ({
        uid: run,
        // Independent witnesses arrive on pages 2 and 5; absence only on the final page.
        conditions: call.body.conditions.map((c: any) =>
          run !== uid(count)
            ? false
            : c.op === "missing"
              ? partial
                ? null
                : true
              : c.path === "config.optimizer.lr"
                ? page >= 2
                  ? true
                  : null
                : partial
                  ? null
                  : true,
        ),
      })),
      cursor: partial ? `late:${page + 1}` : null,
      diagnostics: {
        scanned: partial ? 20000 : call.body.runs.length,
        partial,
      },
    },
  });
}
const menu = (page: Page) => page.locator(".run-filter-menu:visible");
async function addClause(
  page: Page,
  n: number,
  path: string,
  op: string,
  value?: string,
) {
  const root = menu(page);
  if ((await root.getAttribute("open")) === null)
    await root.locator("summary").click();
  await root
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  await root
    .getByLabel(`Condition ${n} scope`, { exact: true })
    .selectOption("event");
  const input = root.getByLabel(`Condition ${n} path`, { exact: true });
  await input.fill(path);
  await input.press("Enter");
  await root
    .getByLabel(`Condition ${n} operator`, { exact: true })
    .selectOption(op);
  if (value !== undefined)
    await root.getByLabel(`Condition ${n} value`, { exact: true }).fill(value);
}
async function drawer(page: Page) {
  await page
    .getByRole("navigation", { name: "Experiment views" })
    .getByRole("button", { name: "Charts", exact: true })
    .click();
  if (await page.getByLabel("Expand run list", { exact: true }).isVisible())
    await page.getByLabel("Expand run list", { exact: true }).click();
  return page.locator(".run-drawer");
}
async function compactGeometry(page: Page) {
  return page.locator(".run-drawer").evaluate((root) => {
    const rect = (selector: string) => {
      const r = root.querySelector(selector)!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      control: rect(".run-filter-control"),
      toggle: rect(".run-filter-menu > summary"),
      search: rect(".run-drawer-search"),
    };
  });
}
async function expectBusy(page: Page) {
  const control = page.locator(".run-filter-control:visible");
  await expect(control).toHaveAttribute("aria-busy", "true");
  await expect(control.locator("summary .run-filter-progress")).toHaveText("…");
  await expect(control.locator("summary .run-filter-progress")).toHaveAttribute(
    "aria-label",
    /^Searching/,
  );
  await expect(page.getByRole("button", { name: /Continue/i })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry filter search", exact: true }),
  ).toBeHidden();
  await expect(control).not.toContainText(/unchecked|bounded|Continue/);
}
function expectCompleteRequests(calls: Call[], clauses: number) {
  const catalog = calls.filter((c) => c.url.pathname === "/api/rx/catalog");
  expect(catalog).toHaveLength(6);
  expect(catalog.map((c) => c.url.searchParams.get("after"))).toEqual([
    null,
    "200",
    "400",
    "600",
    "800",
    "1000",
  ]);
  expect(catalog[0].url.searchParams.has("high_water")).toBe(false);
  expect(catalog[0].url.searchParams.has("source_generation")).toBe(false);
  for (const call of catalog.slice(1)) {
    expect(call.url.searchParams.get("high_water")).toBe(String(count));
    expect(call.url.searchParams.get("source_generation")).toBe(generation);
  }
  const requests = scans(calls).filter(
    (c) => c.body.conditions.length === clauses,
  );
  const starts = requests.filter((c) => !c.body.cursor);
  expect(starts).toHaveLength(Math.ceil(count / 32));
  expect(starts.flatMap((c) => c.body.runs)).toEqual(
    Array.from({ length: count }, (_, i) => uid(i + 1)),
  );
  expect(requests.filter(isLast).map((c) => c.body.cursor ?? null)).toEqual([
    null,
    "late:1",
    "late:2",
    "late:3",
    "late:4",
    "late:5",
  ]);
  for (const call of requests) {
    expect(call.method).toBe("POST");
    expect(call.body.source_id).toBe(source);
    expect(call.body.runs.length).toBeLessThanOrEqual(32);
  }
}

for (const flow of ["table", "drawer"] as const) {
  test(`${flow}-first automatically completes six metadata pages, all batches, and late cursor evidence`, async ({
    page,
  }) => {
    const pending = gate();
    let held = false;
    const clauses = flow === "table" ? 2 : 1;
    const calls = await fixture(page, async (route, call) => {
      if (
        call.url.pathname !== "/api/rx/run-filter" ||
        call.body.conditions.length !== clauses ||
        !isLast(call) ||
        pageNumber(call) !== 5
      )
        return false;
      held = true;
      await pending.promise;
      await answer(route, call).catch(() => {});
      return true;
    });
    try {
      await page
        .getByRole("checkbox", { name: "Select r1", exact: true })
        .check();
      if (flow === "drawer") await drawer(page);
      if (flow === "table") {
        await addClause(page, 1, "config.optimizer.lr", "eq", "0.001");
        await addClause(page, 2, "metrics.accuracy", "exists");
      } else await addClause(page, 1, "metrics.absent", "missing");
      await menu(page).locator("summary").click();
      await expect.poll(() => held).toBe(true);
      await expectBusy(page);
      const row =
        flow === "table" ? "tbody tr[data-run-id]" : ".run-drawer-row:visible";
      await expect(page.locator(row)).toHaveCount(0);
      const busyGeometry =
        flow === "drawer" ? await compactGeometry(page) : undefined;
      const requestCount = scans(calls).length;
      await page.waitForTimeout(220); // Holding one response must backpressure all later work.
      expect(scans(calls)).toHaveLength(requestCount);
      pending.release();
      await expect(page.locator(".run-filter-control:visible")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      await expect(page.locator(row)).toHaveCount(1);
      await expect(
        page.getByRole("checkbox", {
          name: `${flow === "table" ? "Select" : "Show"} r1007`,
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator(".run-filter-progress:visible")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /Continue|Retry filter search/ }),
      ).toBeHidden();
      if (flow === "drawer") {
        expect(await compactGeometry(page)).toEqual(busyGeometry);
        await expect(page.locator(".drawer-outside-count")).toBeHidden();
        await page
          .getByRole("navigation", { name: "Experiment views" })
          .getByRole("button", { name: "Runs", exact: true })
          .click();
        await expect(
          page.getByRole("checkbox", { name: "Select r1007", exact: true }),
        ).toBeVisible();
      } else {
        await expect(page.locator(".selection-count")).toHaveText("0 selected");
        await drawer(page);
        await expect(
          page.getByRole("checkbox", { name: "Show r1007", exact: true }),
        ).toBeVisible();
      }
      expectCompleteRequests(calls, clauses);
      expect(
        await page.evaluate(() => (window as any).__maxCompletionInFlight),
      ).toBe(1);
      const saved = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("nset.workspaces.v2")!).views[0]
            .selectedRunIds,
      );
      expect(saved).toEqual([]);
    } finally {
      pending.release();
    }
  });
}

test("late cursor failure stops automatic search and only explicit Retry restarts it", async ({
  page,
}) => {
  let fail = true;
  const calls = await fixture(page, async (route, call) => {
    if (
      call.url.pathname !== "/api/rx/run-filter" ||
      !isLast(call) ||
      pageNumber(call) !== 5 ||
      !fail
    )
      return false;
    await route.fulfill({
      status: 503,
      json: { error: "late fixture unavailable" },
    });
    return true;
  });
  await addClause(page, 1, "metrics.absent", "missing");
  await menu(page).locator("summary").click();
  const retry = page.getByRole("button", {
    name: "Retry filter search",
    exact: true,
  });
  await expect(page.locator("summary .run-filter-progress")).toHaveText("!");
  await expect(retry).toBeHidden();
  await menu(page).locator("summary").click();
  await expect(retry).toBeVisible();
  await expect(menu(page).locator(".run-filter-error")).toContainText(
    "late fixture unavailable",
  );
  await expect(page.locator(".run-filter-control:visible")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator("summary .run-filter-progress")).toHaveAttribute(
    "aria-label",
    "Filter failed: open filters for details",
  );
  await expect(page.locator("tbody tr[data-run-id]")).toHaveCount(0);
  const failedCount = scans(calls).length;
  await page.waitForTimeout(250);
  expect(scans(calls)).toHaveLength(failedCount);
  fail = false;
  await retry.click();
  await expect(
    page.getByRole("checkbox", { name: "Select r1007", exact: true }),
  ).toBeVisible();
  expect(scans(calls)[failedCount].body.cursor).toBeUndefined();
  expect(scans(calls)[failedCount].body.runs[0]).toBe(uid(1));
  await expect(retry).toBeHidden();
});

for (const action of ["refresh", "navigation", "logout"] as const) {
  test(`${action} cancels a late automatic cursor without accepting its stale response`, async ({
    page,
  }) => {
    const pending = gate();
    let held = false;
    let oldCall: Call | undefined;
    const calls = await fixture(page, async (route, call) => {
      if (
        held ||
        call.url.pathname !== "/api/rx/run-filter" ||
        !isLast(call) ||
        pageNumber(call) !== 2
      )
        return false;
      held = true;
      oldCall = call;
      await pending.promise;
      await answer(route, call).catch(() => {});
      return true;
    });
    try {
      if (action === "navigation") {
        await page
          .getByRole("checkbox", { name: "Select r1", exact: true })
          .check();
        await drawer(page);
      }
      await addClause(page, 1, "metrics.absent", "missing");
      await menu(page).locator("summary").click();
      await expect.poll(() => held).toBe(true);
      await expectBusy(page);
      const before = scans(calls).length;
      if (action === "refresh")
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
      else if (action === "logout") await page.locator("#logout").click();
      else
        await page
          .getByRole("link", { name: "NSET home", exact: true })
          .click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as any).__completionRequests.some(
              (r: any) => r.body.cursor === "late:2" && r.aborted,
            ),
          ),
        )
        .toBe(true);
      pending.release();
      if (action === "refresh") {
        await expect(
          page.getByRole("checkbox", { name: "Select r1007", exact: true }),
        ).toBeVisible();
        expect(scans(calls)[before].body.cursor).toBeUndefined();
        expect(scans(calls)[before].body.runs[0]).toBe(uid(1));
      } else {
        await page.waitForTimeout(250);
        expect(scans(calls)).toHaveLength(before);
        await expect(page.locator(".run-filter-control")).toHaveCount(0);
        if (action === "logout")
          await expect(page.locator("#connection")).toHaveText("Disconnected");
      }
      expect(oldCall?.body.cursor).toBe("late:2");
    } finally {
      pending.release();
    }
  });
}

test("catalog is not rendered until the sixth pinned metadata page completes", async ({
  page,
}) => {
  const pending = gate();
  let held = false;
  const loading = fixture(page, async (_route, call) => {
    if (
      call.url.pathname !== "/api/rx/catalog" ||
      call.url.searchParams.get("after") !== "1000"
    )
      return false;
    held = true;
    await pending.promise;
    return false;
  });
  try {
    await expect.poll(() => held).toBe(true);
    await expect(
      page.getByRole("table", { name: "Runs", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: /^Select r\d/ }),
    ).toHaveCount(0);
  } finally {
    pending.release();
  }
  const calls = await loading;
  expect(
    calls.filter((call) => call.url.pathname === "/api/rx/catalog"),
  ).toHaveLength(6);
  await expect(
    page.getByRole("table", { name: "Runs", exact: true }),
  ).toBeVisible();
});

test("new filter sessions and condition edits during Refresh wait for the new catalog", async ({
  page,
}) => {
  const pending = gate();
  let catalogStarts = 0;
  let held = false;
  const calls = await fixture(
    page,
    async (route, call) => {
      if (
        call.url.pathname === "/api/rx/catalog" &&
        !call.url.searchParams.has("after")
      ) {
        catalogStarts++;
        if (catalogStarts === 2) {
          held = true;
          await pending.promise;
        }
      }
      return false;
    },
    true,
  );
  try {
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await page
      .getByRole("button", { name: "rx · Completion fixture", exact: true })
      .click();
    await addClause(page, 1, "metrics.absent", "missing");
    await menu(page).locator("summary").click();
    await expectBusy(page);
    await page.waitForTimeout(300);
    expect(scans(calls)).toHaveLength(0);
    pending.release();
    await expect(
      page.getByRole("checkbox", { name: "Select r1007", exact: true }),
    ).toBeVisible();
    expect(scans(calls)[0].body.runs[0]).toBe(uid(1));
  } finally {
    pending.release();
  }
});
