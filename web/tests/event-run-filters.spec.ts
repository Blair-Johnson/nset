import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Call = { path: string; body: any; method: string; authorization?: string };
const source = "rx:filter-fixture";
const uid = (n: number) => `exact-uid-${n}`;
const id = (n: number) => `${source}:${uid(n)}`;
const result = (extra = {}) => ({
  fields: [],
  records: [],
  traces: [],
  next_cursor: null,
  coverage: "bounded",
  diagnostics: {
    scanned: 3,
    matched: 3,
    bytes: 100,
    invalid_json: 0,
    oversized: 0,
    skipped_axes: 0,
    skipped_groups: 0,
    omitted_traces: 0,
    points: 0,
    partial: false,
    reasons: [],
  },
  ...extra,
});

// Exercise the real app/router/table/drawer; no live backend or persisted user context.
async function fixture(
  page: Page,
  handler?: (route: Route, call: Call) => Promise<boolean>,
) {
  const calls: Call[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const call = {
      path: new URL(request.url()).pathname,
      body: request.postDataJSON(),
      method: request.method(),
      authorization: request.headers().authorization,
    };
    calls.push(call);
    if (handler && (await handler(route, call))) return;
    if (call.path === "/api/views") {
      await route.fulfill({ json: { views: [] } });
    } else if (call.path === "/api/catalog") {
      await route.fulfill({
        json: { experiments: [], runs: [], series: [], rx_enabled: true },
      });
    } else if (call.path === "/api/rx/catalog") {
      await route.fulfill({
        json: {
          source: { id: source, name: "Filter fixture" },
          next_after: null,
          runs: [1, 2, 3].map((n) => ({
            id: String(n),
            run_uid: uid(n),
            state: "succeeded",
            alias: null,
            config: "native-only",
            argv: [],
            exit_code: 0,
            created_at: "2026-10-01T00:00:00Z",
            started_at: null,
            finished_at: null,
          })),
        },
      });
    } else if (call.path === "/api/rx/fields") {
      const fields = [
        {
          path: "metrics.loss",
          types: ["number"],
          values: [0.25, 1],
          present: 2,
        },
      ].filter((f) =>
        f.path.includes(call.body.search ?? call.body.prefix ?? ""),
      );
      await route.fulfill({ json: result({ fields }) });
    } else if (call.path === "/api/rx/run-filter") {
      const values = (run: string, path: string): unknown[] => {
        if (path === "metrics.accuracy")
          return run === uid(1) ? [0.9] : run === uid(3) ? [null] : [];
        if (path === "config.optimizer.lr")
          return run === uid(3) ? [0.02] : [0.001];
        if (path === "metrics.loss")
          return run === uid(1) ? [0.25] : run === uid(2) ? [1] : [];
        if (path === 'config["rare.dot"]')
          return run === uid(2) ? ["0.001"] : [];
        if (path === '$["rx config summary"]')
          return run === uid(2) ? ["event-only"] : [];
        return [];
      };
      await route.fulfill({
        json: {
          source_generation: "generation-a",
          runs: call.body.runs.map((run: string) => ({
            uid: run,
            conditions: call.body.conditions.map((c: any) => {
              const present = values(run, c.path);
              if (c.op === "missing") return !present.length;
              if (c.op === "exists") return !!present.length;
              return present.some((value) =>
                c.op === "eq"
                  ? value === c.value
                  : c.op === "ne"
                    ? value !== c.value
                    : c.op === "lt"
                      ? Number(value) < c.value
                      : false,
              );
            }),
          })),
          cursor: null,
          diagnostics: { scanned: 3, partial: false },
        },
      });
    } else if (call.path === "/api/rx/plot") {
      await route.fulfill({ json: result() });
    } else {
      await route.fulfill({
        status: 500,
        json: { error: `Unexpected fixture endpoint ${call.path}` },
      });
    }
  });
  await page.goto(`/#/experiments/${encodeURIComponent(source)}/runs`);
  await page
    .getByLabel("Access token", { exact: true })
    .fill("filter-test-token");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Runs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select r1", exact: true }),
  ).toBeVisible();
  return calls;
}
const menu = (page: Page) => page.locator(".run-filter-menu:visible");
async function openMenu(page: Page) {
  const root = menu(page);
  if ((await root.getAttribute("open")) === null)
    await root.locator("summary").click();
  return root;
}
async function expectEventControls(
  page: Page,
  path: string,
  op: string,
  value = "",
) {
  const root = menu(page);
  await expect(
    root.locator(".run-filter-count, .run-filter-missing"),
  ).toHaveCount(0);
  expect(await root.evaluate((node) => node.outerHTML)).not.toMatch(
    /any logged event|\bverified\b|any present, unequal event value|no event has this path/i,
  );
  await expect(
    root.getByLabel("Condition 1 scope", { exact: true }),
  ).toHaveValue("event");
  await expect(
    root.getByLabel("Condition 1 path", { exact: true }),
  ).toHaveValue(path);
  await expect(
    root.getByLabel("Condition 1 operator", { exact: true }),
  ).toHaveValue(op);
  const input = root.getByLabel("Condition 1 value", { exact: true });
  if (op === "missing" || op === "exists") await expect(input).toBeHidden();
  else await expect(input).toHaveValue(value);
  await expect(
    root.getByRole("button", { name: "Remove condition 1", exact: true }),
  ).toBeVisible();
  await expect(
    root.getByRole("button", { name: "+ Add condition", exact: true }),
  ).toBeVisible();
  await expect(
    root.getByRole("button", { name: "Clear all", exact: true }),
  ).toBeVisible();
  await expect(
    root.getByLabel("Combine conditions", { exact: true }),
  ).toBeVisible();
}
async function addEvent(page: Page, path: string, op: string, value = "") {
  const root = await openMenu(page);
  await root
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  await expect(
    root.getByLabel("Condition 1 scope", { exact: true }),
  ).toHaveValue("event");
  const input = root.getByLabel("Condition 1 path", { exact: true });
  await input.fill(path);
  await input.press("Enter");
  await root
    .getByLabel("Condition 1 operator", { exact: true })
    .selectOption(op);
  if (op !== "missing" && op !== "exists")
    await root.getByLabel("Condition 1 value", { exact: true }).fill(value);
  await expectEventControls(page, path, op, value);
  return root;
}
const selected = (page: Page) =>
  page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("nset.workspaces.v2")!);
    return (saved.views[0].selectedRunIds as string[]).slice().sort();
  });

test("Event Tab completion and shared table/drawer filtering reconcile hidden selections without restoring confirmed nonmatches", async ({
  page,
}) => {
  const calls = await fixture(page);
  await page.getByRole("checkbox", { name: "Select r2", exact: true }).check();
  await page.getByRole("checkbox", { name: "Select r3", exact: true }).check();
  const root = await openMenu(page);
  await root
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  await expect(
    root.getByLabel("Condition 1 scope", { exact: true }),
  ).toHaveValue("event");
  const path = root.getByLabel("Condition 1 path", { exact: true });
  await path.fill("met");
  // Tab must wait for asynchronous discovery and complete the actual logged path.
  await path.press("Tab");
  await expect(path).toHaveValue("metrics.loss");
  await expect(
    root.getByLabel("Condition 1 value", { exact: true }),
  ).toBeFocused();
  await root
    .getByLabel("Condition 1 operator", { exact: true })
    .selectOption("lt");
  await root.getByLabel("Condition 1 value", { exact: true }).fill("0.5");
  await expect(root.locator(".run-filter-count")).toHaveCount(0);
  await expect(page.locator("tbody tr[data-run-id]")).toHaveCount(1);
  await root.locator("summary").click();
  await expect(
    page.getByRole("checkbox", { name: /^Select r\d/, exact: false }),
  ).toHaveCount(1);
  await expect(page.locator(".selection-count")).toHaveText("0 selected");
  const all = page.getByRole("checkbox", {
    name: "Select all matching runs",
    exact: true,
  });
  await all.check();
  await expect(page.locator(".selection-count")).toHaveText("1 selected");
  await all.uncheck();
  await expect(page.locator(".selection-count")).toHaveText("0 selected");
  expect(await selected(page)).toEqual([]);

  await page
    .getByRole("navigation", { name: "Experiment views" })
    .getByRole("button", { name: "Charts", exact: true })
    .click();
  if (await page.getByLabel("Expand run list", { exact: true }).isVisible())
    await page.getByLabel("Expand run list", { exact: true }).click();
  const drawer = page.locator(".run-drawer");
  await expect(drawer.locator(".run-drawer-row:visible")).toHaveCount(1);
  await expect(drawer.locator(".drawer-outside-count")).toBeHidden();
  const shared = await openMenu(page);
  await expect(
    shared.getByLabel("Condition 1 path", { exact: true }),
  ).toHaveValue("metrics.loss");
  await expect(
    shared.getByLabel("Condition 1 operator", { exact: true }),
  ).toHaveValue("lt");
  await shared.locator("summary").click();
  await drawer
    .getByRole("button", { name: "Select matching", exact: true })
    .click();
  await expect.poll(() => selected(page)).toEqual([id(1)]);
  await drawer
    .getByRole("checkbox", { name: "Show r1", exact: true })
    .uncheck();
  await expect.poll(() => selected(page)).toEqual([]);
  await (
    await openMenu(page)
  )
    .getByRole("button", { name: "Clear all", exact: true })
    .click();
  await expect(drawer.locator(".run-drawer-row:visible")).toHaveCount(3);
  await expect(
    drawer.getByRole("checkbox", { name: "Show r2", exact: true }),
  ).not.toBeChecked();
  await expect(
    drawer.getByRole("checkbox", { name: "Show r3", exact: true }),
  ).not.toBeChecked();
  await drawer.getByRole("checkbox", { name: "Show r3", exact: true }).check();
  // Change the shared session from the drawer and navigate back to the real table.
  await addEvent(page, "metrics.loss", "missing");
  await expect(drawer.locator(".run-drawer-row:visible")).toHaveCount(1);
  await menu(page).locator("summary").click();
  await page
    .getByRole("navigation", { name: "Experiment views" })
    .getByRole("button", { name: "Runs", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Select r3", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Select r2", exact: true }),
  ).toHaveCount(0);
  await expect(
    (await openMenu(page)).getByLabel("Condition 1 operator", { exact: true }),
  ).toHaveValue("missing");
  expect(await selected(page)).toEqual([id(3)]);
  const scans = calls.filter((c) => c.path === "/api/rx/run-filter");
  expect(scans.length).toBeGreaterThan(0);
  for (const call of scans) {
    expect(call.method).toBe("POST");
    expect(call.authorization).toBe("Bearer filter-test-token");
    expect(call.body.source_id).toBe(source);
    expect(call.body.runs).toEqual([uid(1), uid(2), uid(3)]);
  }
});

test("exact unsuggested Event paths accept quoted scalars and reject unsafe numeric/object values", async ({
  page,
}) => {
  const calls = await fixture(page);
  const root = await addEvent(page, 'config["rare.dot"]', "eq", '"0.001"');
  await expect(
    root.getByLabel("Condition 1 path", { exact: true }),
  ).toHaveValue('config["rare.dot"]');
  await expect(root.locator(".run-filter-count")).toHaveCount(0);
  await expect(page.locator("tbody tr[data-run-id]")).toHaveCount(1);
  await expect(
    page.getByRole("checkbox", { name: "Select r2", exact: true }),
  ).toBeVisible();
  expect(
    calls.filter((c) => c.path.endsWith("/run-filter")).at(-1)!.body.conditions,
  ).toEqual([{ path: 'config["rare.dot"]', op: "eq", value: "0.001" }]);
  const value = root.getByLabel("Condition 1 value", { exact: true });
  for (const invalid of ["9007199254740993", '{"x":1}']) {
    const before = calls.filter((c) => c.path.endsWith("/run-filter")).length;
    await value.fill(invalid);
    await expect
      .poll(() =>
        value.evaluate((input: HTMLInputElement) => input.validity.valid),
      )
      .toBe(false);
    await expect(page.locator(".run-filter-progress")).toHaveAttribute(
      "aria-label",
      /Filter failed:/,
    );
    expect(calls.filter((c) => c.path.endsWith("/run-filter"))).toHaveLength(
      before,
    );
    await expect(
      page.getByRole("checkbox", { name: /^Select r\d/ }),
    ).toHaveCount(0);
  }
});

test("Event and Config scopes remain separate even for the same exact path", async ({
  page,
}) => {
  const calls = await fixture(page);
  const root = await addEvent(
    page,
    '$["rx config summary"]',
    "neq",
    "native-only",
  );
  await expectEventControls(
    page,
    '$["rx config summary"]',
    "neq",
    "native-only",
  );
  await expect(
    root.getByLabel("Condition 1 missing-path handling", { exact: true }),
  ).toHaveCount(0);
  await expect(root.locator(".run-filter-count")).toHaveCount(0);
  await expect(page.locator("tbody tr[data-run-id]")).toHaveCount(1);
  expect(
    calls.filter((c) => c.path.endsWith("/run-filter")).at(-1)!.body
      .conditions[0],
  ).toEqual({
    path: '$["rx config summary"]',
    op: "ne",
    value: "native-only",
  });
  await root
    .getByLabel("Condition 1 scope", { exact: true })
    .selectOption("params");
  const input = root.getByLabel("Condition 1 path", { exact: true });
  await input.fill('$["rx config summary"]');
  await input.press("Enter");
  await root
    .getByLabel("Condition 1 operator", { exact: true })
    .selectOption("eq");
  await expect(root.locator(".run-filter-count")).toHaveText(
    "3 match · 0 lack path",
  );
  await expect(page.getByRole("checkbox", { name: /^Select r\d/ })).toHaveCount(
    3,
  );
  await expect(
    root.getByLabel("Condition 1 missing-path handling", { exact: true }),
  ).toBeVisible();
});

test("failed Event scans expose unknown and Retry scan instead of accepting all runs", async ({
  page,
}) => {
  let fail = true;
  await fixture(page, async (route, call) => {
    if (!call.path.endsWith("/run-filter") || !fail) return false;
    await route.fulfill({ status: 503, json: { error: "source unavailable" } });
    return true;
  });
  await addEvent(page, "metrics.loss", "lt", "0.5");
  await expect(page.locator(".run-filter-progress")).toHaveAttribute(
    "aria-label",
    "Filter failed: open filters for details",
  );
  await expect(page.getByRole("checkbox", { name: /^Select r\d/ })).toHaveCount(
    0,
  );
  fail = false;
  await openMenu(page);
  await page
    .getByRole("button", { name: "Retry filter search", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "Select r1", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".run-filter-progress")).toHaveText("");
});

for (const teardown of ["logout", "beforeunload"] as const) {
  test(`production ${teardown} aborts active filtering and ignores late responses`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      (window as any).__filterRequests = [];
      window.fetch = (input, init) => {
        if (String(input).endsWith("/rx/run-filter")) {
          const entry = { aborted: init?.signal?.aborted ?? false };
          (window as any).__filterRequests.push(entry);
          init?.signal?.addEventListener("abort", () => {
            entry.aborted = true;
          });
        }
        return original(input, init);
      };
    });
    let release: (() => void) | undefined;
    const calls = await fixture(page, async (route, call) => {
      if (!call.path.endsWith("/run-filter")) return false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route
        .fulfill({
          json: {
            source_generation: "generation-a",
            runs: call.body.runs.map((uid: string) => ({
              uid,
              conditions: [true],
            })),
            cursor: "more",
            diagnostics: { scanned: 3, partial: true },
          },
        })
        .catch(() => {});
      return true;
    });
    try {
      await addEvent(page, "metrics.loss", "lt", "0.5");
      await expect.poll(() => !!release).toBe(true);
      if (teardown === "logout") await page.locator("#logout").click();
      else
        await page.evaluate(() =>
          window.dispatchEvent(new Event("beforeunload")),
        );
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as any).__filterRequests.every((r: any) => r.aborted),
          ),
        )
        .toBe(true);
      release!();
      await page.waitForTimeout(300); // Past the scan debounce: teardown must not schedule another page.
      expect(calls.filter((c) => c.path.endsWith("/run-filter"))).toHaveLength(
        1,
      );
      if (teardown === "logout") {
        await expect(page.locator("#connection")).toHaveText("Disconnected");
        await expect(page.locator(".run-table")).toHaveCount(0);
      }
    } finally {
      release?.();
    }
  });
}

test("accuracy exists and a separately logged config clause share run-level AND/OR", async ({
  page,
}) => {
  const calls = await fixture(page, async (route, call) => {
    if (
      call.path !== "/api/rx/fields" ||
      !call.body.search.startsWith("metrics.acc")
    )
      return false;
    await route.fulfill({
      json: result({
        fields: [
          {
            path: "metrics.accuracy",
            types: ["number", "null"],
            present: 2,
            values: [0.9, null],
          },
        ],
      }),
    });
    return true;
  });
  await page.getByRole("checkbox", { name: "Select r2", exact: true }).check();
  const root = await openMenu(page);
  await root
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  const accuracy = root.getByLabel("Condition 1 path", { exact: true });
  await accuracy.fill("metrics.acc");
  await accuracy.press("Tab");
  await expect(accuracy).toHaveValue("metrics.accuracy");
  await root
    .getByLabel("Condition 1 operator", { exact: true })
    .selectOption("exists");
  await expect(page.locator("tbody tr[data-run-id]")).toHaveCount(2);
  await root
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  const config = root.getByLabel("Condition 2 path", { exact: true });
  await config.fill("config.optimizer.lr");
  await config.press("Enter");
  await root.getByLabel("Condition 2 value", { exact: true }).fill("0.001");
  await expect(page.locator("tbody tr[data-run-id]")).toHaveCount(1);
  await expect(
    page.getByRole("checkbox", { name: "Select r1", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".selection-count")).toHaveText("0 selected");
  await root
    .getByLabel("Combine conditions", { exact: true })
    .selectOption("any");
  await expect(page.locator("tbody tr[data-run-id]")).toHaveCount(3);
  const request = calls.filter((c) => c.path === "/api/rx/run-filter").at(-1)!;
  expect(request.body.conditions).toEqual([
    { path: "metrics.accuracy", op: "exists", value: null },
    { path: "config.optimizer.lr", op: "eq", value: 0.001 },
  ]);
  expect(await selected(page)).toEqual([]);
});

test("bounded requests automatically finish and refresh committed event evidence", async ({
  page,
}) => {
  let pages = 0;
  let catalogLoads = 0;
  const calls = await fixture(page, async (route, call) => {
    if (call.path === "/api/rx/catalog") catalogLoads++;
    if (call.path !== "/api/rx/run-filter") return false;
    pages++;
    const incomplete = pages <= 4;
    await route.fulfill({
      json: {
        source_generation: "generation-a",
        runs: call.body.runs.map((run: string) => ({
          uid: run,
          conditions: [
            incomplete ? null : run === uid(catalogLoads > 1 ? 2 : 1),
          ],
        })),
        cursor: incomplete ? `scan-page-${pages}` : null,
        diagnostics: { scanned: 20000, partial: incomplete },
      },
    });
    return true;
  });
  await page.getByRole("checkbox", { name: "Select r3", exact: true }).check();
  const root = await addEvent(page, "metrics.accuracy", "exists");
  await root.locator("summary").click();
  await expect(
    page.getByRole("button", { name: "Continue scan", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "Select r1", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".selection-count")).toHaveText("0 selected");
  expect(
    calls.filter((c) => c.path === "/api/rx/run-filter")[4].body.cursor,
  ).toBe("scan-page-4");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Select r2", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select r1", exact: true }),
  ).toHaveCount(0);
  expect(await selected(page)).toEqual([]);
  expect(
    calls.filter((c) => c.path === "/api/rx/run-filter").at(-1)!.body.cursor,
  ).toBeUndefined();
});

for (const failure of ["stale cursor", "cursorless replacement"] as const) {
  test(`${failure} revokes verified matches before Retry and cannot add drawer selections`, async ({
    page,
  }) => {
    let pages = 0;
    const calls = await fixture(page, async (route, call) => {
      if (
        failure === "cursorless replacement" &&
        call.path === "/api/rx/catalog"
      ) {
        await route.fulfill({
          json: {
            source: { id: source, name: "Replacement fixture" },
            next_after: null,
            runs: Array.from({ length: 160 }, (_, i) => ({
              id: String(i + 1),
              run_uid: uid(i + 1),
              state: "succeeded",
              alias: null,
              config: "",
              argv: [],
              exit_code: 0,
              created_at: "2026-10-01T00:00:00Z",
              started_at: null,
              finished_at: null,
            })),
          },
        });
        return true;
      }
      if (call.path !== "/api/rx/run-filter") return false;
      pages++;
      if (failure === "stale cursor" && pages > 4) {
        await route.fulfill({
          status: 400,
          json: { error: "invalid/stale run filter cursor; restart filtering" },
        });
      } else {
        await route.fulfill({
          json: {
            source_generation: pages > 4 ? "generation-b" : "generation-a",
            runs: call.body.runs.map((run: string) => ({
              uid: run,
              conditions: [run === uid(1)],
            })),
            cursor: failure === "stale cursor" ? `page-${pages}` : null,
            diagnostics: {
              scanned: call.body.runs.length,
              partial: failure === "stale cursor",
            },
          },
        });
      }
      return true;
    });
    await page
      .getByRole("checkbox", { name: "Select r3", exact: true })
      .check();
    await addEvent(page, "metrics.accuracy", "exists");
    await menu(page).locator("summary").click();
    await expect(menu(page).locator(".run-filter-progress")).toHaveText("!");
    await expect(
      page.getByRole("button", { name: "Retry filter search", exact: true }),
    ).toBeHidden();
    await openMenu(page);
    await expect(menu(page).locator(".run-filter-error")).toBeVisible();
    await menu(page).locator("summary").click();
    await expect(page.locator("tbody tr[data-run-id]")).toHaveCount(0);
    expect(await selected(page)).toEqual([]);
    await page
      .getByRole("navigation", { name: "Experiment views" })
      .getByRole("button", { name: "Charts", exact: true })
      .click();
    if (await page.getByLabel("Expand run list", { exact: true }).isVisible())
      await page.getByLabel("Expand run list", { exact: true }).click();
    const drawer = page.locator(".run-drawer");
    await expect(drawer.locator(".run-drawer-row:visible")).toHaveCount(0);
    await drawer
      .getByRole("button", { name: "Select matching", exact: true })
      .click();
    expect(await selected(page)).toEqual([]);
    expect(calls.filter((c) => c.path === "/api/rx/run-filter")).toHaveLength(
      5,
    );
  });
}

for (const surface of ["table", "drawer"] as const) {
  test(`production ${surface} keeps filter failures inside popup without layout shifts`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.addInitScript((source) => {
      localStorage.setItem(
        `nset.run-pane.${source}`,
        JSON.stringify({ open: true, width: 250 }),
      );
    }, source);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fail = true;
    const detail =
      "rx source unavailable: failed reading event records. " +
      "diagnostic/".repeat(24);
    const calls = await fixture(page, async (route, call) => {
      if (call.path !== "/api/rx/run-filter" || !fail) return false;
      await held;
      await route.fulfill({ status: 503, json: { error: detail } });
      return true;
    });
    // A healthy rx runlist has only its actual control toolbar, not an empty note row.
    await expect(
      page.getByText("Read-only rx records.", { exact: false }),
    ).toHaveCount(0);
    await expect(page.locator(".table-toolbar")).toHaveCount(1);
    await page
      .getByRole("checkbox", { name: "Select r3", exact: true })
      .check();
    if (surface === "drawer") {
      await page
        .getByRole("button", { name: "View charts", exact: true })
        .click();
      if (await page.getByLabel("Expand run list", { exact: true }).isVisible())
        await page.getByLabel("Expand run list", { exact: true }).click();
      await expect(page.locator(".run-drawer")).toBeVisible();
      expect(
        (await page.locator(".run-drawer").boundingBox())!.width,
      ).toBeLessThanOrEqual(250);
    }
    const evidence =
      process.env.RX_UI_EVIDENCE_DIR ?? testInfo.outputPath("ui");
    await mkdir(evidence, { recursive: true });
    const capture = async (state: string) => {
      const path = join(evidence, `${surface}-${state}.png`);
      await page.screenshot({ path });
      await testInfo.attach(`${surface}-${state}`, {
        path,
        contentType: "image/png",
      });
    };
    const geometry = () =>
      menu(page).evaluate((root) => {
        const control = root.closest(".run-filter-control")!;
        const toolbar = root.closest(".run-drawer-search, .table-toolbar")!;
        const rect = (node: Element) => {
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          trigger: rect(root.querySelector("summary")!),
          control: rect(control),
          toolbar: rect(toolbar),
          search: rect(toolbar.querySelector('input[type="search"]')!),
          status: toolbar.querySelector(":scope > select")
            ? rect(toolbar.querySelector(":scope > select")!)
            : null,
        };
      });
    const idle = await geometry();
    if (surface === "drawer") {
      expect(idle.status).not.toBeNull();
      expect(idle.control.x + idle.control.width + 6).toBeLessThanOrEqual(
        idle.status!.x,
      );
      expect(idle.status!.x + idle.status!.width).toBeLessThanOrEqual(
        idle.toolbar.x + idle.toolbar.width,
      );
    }
    await capture("idle");
    try {
      await addEvent(page, "metrics.loss", "lt", "0.5");
      await expect(menu(page).locator(".run-filter-progress")).toHaveText("…");
      await expectEventControls(page, "metrics.loss", "lt", "0.5");
      await capture("loading-popup");
      await menu(page).locator("summary").click();
      await expect(menu(page).locator(".run-filter-progress")).toHaveText("…");
      const loading = await geometry();
      expect(loading).toEqual(idle);
      await capture("loading");
      release();
      await expect(menu(page).locator(".run-filter-progress")).toHaveText("!");
      const failed = await geometry();
      expect(failed).toEqual(loading);
      expect(failed.control.width).toBe(failed.trigger.width);
      const indicator = (await menu(page)
        .locator(".run-filter-progress")
        .boundingBox())!;
      expect(indicator.x).toBeGreaterThanOrEqual(failed.trigger.x);
      expect(indicator.y).toBeGreaterThanOrEqual(failed.trigger.y);
      expect(indicator.x + indicator.width).toBeLessThanOrEqual(
        failed.trigger.x + failed.trigger.width,
      );
      expect(indicator.y + indicator.height).toBeLessThanOrEqual(
        failed.trigger.y + failed.trigger.height,
      );
      await expect(
        page.getByRole("button", { name: "Retry filter search", exact: true }),
      ).toBeHidden();
      await expect(menu(page).locator(".run-filter-error")).toBeHidden();
      await expect(
        page.locator(".run-filter-control > .run-filter-retry"),
      ).toHaveCount(0);
      await expect(page.locator(".toast:visible")).toHaveCount(0);
      expect
        .soft(
          await page.evaluate(() => {
            const outside = document.body.cloneNode(true) as HTMLElement;
            outside
              .querySelectorAll(".run-filter-popover")
              .forEach((popup) => popup.remove());
            return outside.textContent;
          }),
        )
        .not.toMatch(/Retry|rx source unavailable|Filter failed\./);
      await capture("error-closed");
      const failedCalls = calls.filter(
        (call) => call.path === "/api/rx/run-filter",
      ).length;
      await page.waitForTimeout(250);
      expect(
        calls.filter((call) => call.path === "/api/rx/run-filter"),
      ).toHaveLength(failedCalls);
      const root = await openMenu(page);
      await expectEventControls(page, "metrics.loss", "lt", "0.5");
      await expect(root.locator(".run-filter-error")).toHaveText(
        `Filter failed: ${detail}`,
      );
      await expect(
        root.locator(".run-filter-popover .run-filter-retry"),
      ).toBeVisible();
      const popupGeometry = await root
        .locator(".run-filter-popover")
        .evaluate((popup) => {
          const bounds = popup.getBoundingClientRect();
          const error = popup.querySelector(".run-filter-error")!;
          const retry = popup.querySelector(".run-filter-retry")!;
          return {
            x: bounds.x,
            right: bounds.right,
            bottom: bounds.bottom,
            width: bounds.width,
            scrollWidth: popup.scrollWidth,
            clientWidth: popup.clientWidth,
            errorWidth: error.getBoundingClientRect().width,
            retryBottom: retry.getBoundingClientRect().bottom,
          };
        });
      expect(popupGeometry.x).toBeGreaterThanOrEqual(0);
      expect(popupGeometry.right).toBeLessThanOrEqual(1100);
      expect(popupGeometry.bottom).toBeLessThanOrEqual(850);
      expect(popupGeometry.scrollWidth).toBeLessThanOrEqual(
        popupGeometry.clientWidth,
      );
      expect(popupGeometry.errorWidth).toBeLessThan(popupGeometry.width);
      expect(popupGeometry.retryBottom).toBeLessThanOrEqual(
        popupGeometry.bottom,
      );
      expect(await geometry()).toEqual(loading);
      await capture("error-popup");
      fail = false;
      await root
        .getByRole("button", { name: "Retry filter search", exact: true })
        .click();
      await expect(root.locator(".run-filter-progress")).toHaveText("");
      await expect(root.locator(".run-filter-failure")).toBeHidden();
      await openMenu(page);
      await expectEventControls(page, "metrics.loss", "lt", "0.5");
      await capture("success-popup");
      await root.locator("summary").click();
      const success = await geometry();
      expect(success).toEqual(loading);
      await capture("success");
      await writeFile(
        join(evidence, `${surface}-geometry.json`),
        JSON.stringify(
          { idle, loading, failed, success, popupGeometry },
          null,
          2,
        ),
      );
      expect(await selected(page)).toEqual([]);
    } finally {
      release();
    }
  });
}

test("rx runlist retains a genuine catalog error without the routine instruction toolbar", async ({
  page,
}) => {
  let unavailable = false;
  const detail = "Cannot read rx catalog: fixture repository is unavailable";
  await fixture(page, async (route, call) => {
    if (call.path !== "/api/rx/catalog" || !unavailable) return false;
    await route.fulfill({
      json: {
        source: { id: source, name: "Filter fixture", readonly: true },
        runs: [],
        next_after: null,
        error: detail,
      },
    });
    return true;
  });
  await expect(page.locator(".table-toolbar")).toHaveCount(1);
  unavailable = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.locator(".table-toolbar > .muted").filter({ hasText: detail }),
  ).toBeVisible();
  await expect(
    page.getByText("Read-only rx records.", { exact: false }),
  ).toHaveCount(0);
});
