import { test, expect, type Page, type Locator } from "@playwright/test";

test.use({ timezoneId: "America/Los_Angeles" });

const NOW = "2026-10-26T12:00:00Z";
const RX_SOURCE = "rx:time-fixture";
const NATIVE_SOURCE = "native-time-fixture";
type Source = "native" | "rx";
type Call = { path: string; body: any };
const uid = (n: number) => `time-uid-${n}`;
const runId = (source: Source, n: number) =>
  source === "rx" ? `${RX_SOURCE}:${uid(n)}` : `native-time-${n}`;

// r3 is October 26 in UTC, but October 25 in the browser's local timezone.
// r2 is old but recently finished; r4 exercises rx's created-date fallback.
// r5 deliberately maps invalid rx timestamps to the adapter's zero sentinel.
const dates = [
  { created: "2026-10-26T11:30:00Z", started: null, finished: null },
  {
    created: "2026-10-01T12:00:00Z",
    started: "2026-10-02T12:00:00Z",
    finished: "2026-10-26T11:00:00Z",
  },
  {
    created: "2026-10-26T03:00:00Z",
    started: "2026-10-26T04:00:00Z",
    finished: null,
  },
  { created: "2026-10-20T12:00:00Z", started: null, finished: null },
  { created: "invalid-date", started: null, finished: null },
  {
    created: "2026-10-24T12:00:00Z",
    started: null,
    finished: "2026-10-25T12:00:00Z",
  },
];
const emptyRecords = (extra = {}) => ({
  fields: [],
  records: [],
  traces: [],
  next_cursor: null,
  coverage: "bounded",
  diagnostics: {
    scanned: 6,
    matched: 6,
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

async function fixture(page: Page, source: Source) {
  await page.clock.install({ time: new Date(NOW) });
  const calls: Call[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    calls.push({ path, body });
    if (path === "/api/catalog") {
      await route.fulfill({
        json: {
          rx_enabled: source === "rx",
          experiments:
            source === "native"
              ? [
                  {
                    id: NATIVE_SOURCE,
                    name: "Native time fixture",
                    created_at: 0,
                  },
                ]
              : [],
          runs:
            source === "native"
              ? dates.map((date, i) => ({
                  id: runId(source, i + 1),
                  experiment_id: NATIVE_SOURCE,
                  name: `r${i + 1}`,
                  status: "finished",
                  params: {},
                  tags: {},
                  created_at: Number.isFinite(Date.parse(date.created))
                    ? Date.parse(date.created)
                    : 9e15,
                  updated_at: Number.isFinite(
                    Date.parse(date.finished ?? date.started ?? date.created),
                  )
                    ? Date.parse(date.finished ?? date.started ?? date.created)
                    : 9e15,
                }))
              : [],
          series: [],
        },
      });
    } else if (path === "/api/rx/catalog") {
      await route.fulfill({
        json: {
          source: { id: RX_SOURCE, name: "Time fixture", readonly: true },
          next_after: null,
          runs: dates.map((date, i) => ({
            id: String(i + 1),
            run_uid: uid(i + 1),
            state: "succeeded",
            alias: null,
            config: "",
            argv: "[]",
            exit_code: 0,
            created_at: date.created,
            started_at: date.started,
            finished_at: date.finished,
          })),
        },
      });
    } else if (path === "/api/rx/fields") {
      await route.fulfill({
        json: emptyRecords({
          fields: [
            {
              path: "metrics.accuracy",
              types: ["number"],
              values: [0.9],
              present: 2,
            },
          ],
        }),
      });
    } else if (path === "/api/rx/run-filter") {
      await route.fulfill({
        json: {
          source_generation: "time-generation",
          runs: body.runs.map((run: string) => ({
            uid: run,
            conditions: body.conditions.map(
              (condition: any) =>
                condition.path === "metrics.accuracy" &&
                condition.op === "exists" &&
                [uid(1), uid(2)].includes(run),
            ),
          })),
          cursor: null,
          diagnostics: { scanned: 6, partial: false },
        },
      });
    } else if (path === "/api/rx/plot") {
      await route.fulfill({ json: emptyRecords() });
    } else {
      await route.fulfill({
        status: 500,
        json: { error: `Unexpected fixture endpoint ${path}` },
      });
    }
  });
  const experiment = source === "rx" ? RX_SOURCE : NATIVE_SOURCE;
  await page.goto(`/#/experiments/${encodeURIComponent(experiment)}/runs`);
  await page
    .getByLabel("Access token", { exact: true })
    .fill("time-test-token");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Runs", exact: true }),
  ).toBeVisible();
  await expectTable(page, source, [1, 2, 3, 4, 5, 6]);
  await expect(
    page
      .getByRole("table", { name: "Runs", exact: true })
      .getByRole("cell", { name: "Unknown", exact: true }),
  ).toBeVisible();
  return calls;
}

const menu = (page: Page) => page.locator(".run-filter-menu:visible");
const control = (root: Locator, label: string, index = 1) =>
  root.getByLabel(`Condition ${index} ${label}`, { exact: true });
async function openMenu(page: Page) {
  const root = menu(page);
  if ((await root.getAttribute("open")) === null)
    await root.locator("summary").click();
  return root;
}
async function closeMenu(page: Page) {
  const root = menu(page);
  if ((await root.getAttribute("open")) !== null)
    await root.locator("summary").click();
}
async function addTime(page: Page, index = 1) {
  const root = await openMenu(page);
  await root
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  await control(root, "scope", index).selectOption("time");
  return root;
}
async function expectTable(page: Page, source: Source, numbers: number[]) {
  await expect
    .poll(() =>
      page
        .locator("tbody tr[data-run-id]")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-run-id")).sort(),
        ),
    )
    .toEqual(numbers.map((n) => runId(source, n)).sort());
}
async function expectDrawer(page: Page, numbers: number[]) {
  await expect
    .poll(() =>
      page
        .locator(".run-drawer .run-drawer-row:visible input[type=checkbox]")
        .evaluateAll((inputs) =>
          inputs.map((input) => input.getAttribute("aria-label")).sort(),
        ),
    )
    .toEqual(numbers.map((n) => `Show r${n}`).sort());
}
async function charts(page: Page) {
  await closeMenu(page);
  await page
    .getByRole("navigation", { name: "Experiment views" })
    .getByRole("button", { name: "Charts", exact: true })
    .click();
  const expand = page.getByLabel("Expand run list", { exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".run-drawer")).toBeVisible();
}
async function runs(page: Page) {
  await closeMenu(page);
  await page
    .getByRole("navigation", { name: "Experiment views" })
    .getByRole("button", { name: "Runs", exact: true })
    .click();
}
const selected = (page: Page) =>
  page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("nset.workspaces.v2")!);
    return (saved.views[0].selectedRunIds as string[]).slice().sort();
  });

for (const source of ["native", "rx"] as const) {
  test(`${source}: Time defaults and Created/Updated stay shared between table and drawer`, async ({
    page,
  }) => {
    const calls = await fixture(page, source);
    await page
      .getByRole("checkbox", { name: "Select r2", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: "Select r5", exact: true })
      .check();
    const root = await addTime(page);
    await expect(control(root, "time field")).toHaveValue("created_at");
    await expect(control(root, "operator")).toHaveValue("last");
    await expect(control(root, "duration")).toHaveValue("7");
    await expect(control(root, "unit")).toHaveValue("days");
    await expect(control(root, "path")).toHaveCount(0);
    await expectTable(page, source, [1, 3, 4, 6]);
    await charts(page);
    await expectDrawer(page, [1, 3, 4, 6]);
    await expect(page.locator(".drawer-outside-count")).toContainText(
      "2 outside filters",
    );
    const shared = await openMenu(page);
    await expect(control(shared, "scope")).toHaveValue("time");
    await expect(control(shared, "duration")).toHaveValue("7");
    await control(shared, "time field").selectOption("updated_at");
    await expectDrawer(page, [1, 2, 3, 4, 6]);
    await runs(page);
    await expectTable(page, source, [1, 2, 3, 4, 6]);
    await expect(control(await openMenu(page), "time field")).toHaveValue(
      "updated_at",
    );
    expect(await selected(page)).toEqual(
      [runId(source, 2), runId(source, 5)].sort(),
    );
    expect(
      calls.filter((call) => call.path === "/api/rx/run-filter"),
    ).toHaveLength(0);
  });

  test(`${source}: calendar operators use local whole dates, not UTC dates`, async ({
    page,
  }) => {
    await fixture(page, source);
    const root = await addTime(page);
    for (const scenario of [
      { op: "today", expected: [1] },
      { op: "yesterday", expected: [3] },
      { op: "on", date: "2026-10-25", expected: [3] },
      {
        op: "between",
        date: "2026-10-24",
        end: "2026-10-25",
        expected: [3, 6],
      },
      { op: "before", date: "2026-10-24", expected: [2, 4] },
      { op: "after", date: "2026-10-25", expected: [1] },
    ]) {
      await control(root, "operator").selectOption(scenario.op);
      if (scenario.date) {
        await expect(control(root, "date")).toHaveAttribute("type", "date");
        await control(root, "date").fill(scenario.date);
      } else {
        await expect(control(root, "date")).toHaveCount(0);
        await expect(control(root, "duration")).toHaveCount(0);
      }
      if (scenario.end) await control(root, "end date").fill(scenario.end);
      await expect(
        root.getByText(/Local time \(America\/Los_Angeles\)/),
      ).toBeVisible();
      await expectTable(page, source, scenario.expected);
    }
    await control(root, "time field").selectOption("updated_at");
    await control(root, "operator").selectOption("yesterday");
    await expectTable(page, source, [3, 6]);
    await control(root, "operator").selectOption("today");
    await expectTable(page, source, [1, 2]);
  });

  test(`${source}: duration units and stale filters exclude unavailable timestamps`, async ({
    page,
  }) => {
    await fixture(page, source);
    const root = await addTime(page);
    for (const scenario of [
      { value: "60", unit: "minutes", expected: [1] },
      { value: "1", unit: "hours", expected: [1] },
      { value: "1", unit: "days", expected: [1, 3] },
      { value: "1", unit: "weeks", expected: [1, 3, 4, 6] },
    ]) {
      await control(root, "duration").fill(scenario.value);
      await control(root, "unit").selectOption(scenario.unit);
      await expectTable(page, source, scenario.expected);
    }
    await control(root, "operator").selectOption("older");
    await expectTable(page, source, [2]);
    await control(root, "time field").selectOption("updated_at");
    await expectTable(page, source, []);
    await control(root, "duration").fill("2");
    await control(root, "unit").selectOption("days");
    await expectTable(page, source, [4]);
  });

  test(`${source}: invalid duration and reversed dates fail closed and recover`, async ({
    page,
  }) => {
    await fixture(page, source);
    const root = await addTime(page);
    for (const invalid of ["0", "-1", ""]) {
      await control(root, "duration").fill(invalid);
      await expect(control(root, "duration")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      await expect
        .poll(() =>
          control(root, "duration").evaluate(
            (input: HTMLInputElement) => input.validity.valid,
          ),
        )
        .toBe(false);
      await expect(root.locator(".run-filter-time-error")).toContainText(
        /positive duration/i,
      );
      await expectTable(page, source, []);
    }
    await control(root, "duration").fill("7");
    await expect(control(root, "duration")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
    await expectTable(page, source, [1, 3, 4, 6]);
    await control(root, "operator").selectOption("between");
    await control(root, "date").fill("2026-10-25");
    await control(root, "end date").fill("2026-10-24");
    await expect(control(root, "end date")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(root.locator(".run-filter-time-error")).toContainText(
      /on or after/i,
    );
    await expectTable(page, source, []);
    await control(root, "end date").fill("2026-10-25");
    await expect(control(root, "end date")).toHaveAttribute(
      "aria-invalid",
      "false",
    );
    await expectTable(page, source, [3]);
  });

  test(`${source}: relative and absolute time clauses survive reload with their units and OR`, async ({
    page,
  }) => {
    await fixture(page, source);
    const root = await addTime(page);
    await control(root, "time field").selectOption("updated_at");
    await control(root, "operator").selectOption("older");
    await control(root, "duration").fill("48");
    await control(root, "unit").selectOption("hours");
    await addTime(page, 2);
    await control(root, "operator", 2).selectOption("between");
    await control(root, "date", 2).fill("2026-10-24");
    await control(root, "end date", 2).fill("2026-10-25");
    await root
      .getByLabel("Combine conditions", { exact: true })
      .selectOption("any");
    await expectTable(page, source, [3, 4, 6]);
    await page.reload();
    await expect(
      page.getByRole("table", { name: "Runs", exact: true }),
    ).toBeVisible();
    await expectTable(page, source, [3, 4, 6]);
    const restored = await openMenu(page);
    await expect(control(restored, "scope")).toHaveValue("time");
    await expect(control(restored, "time field")).toHaveValue("updated_at");
    await expect(control(restored, "operator")).toHaveValue("older");
    await expect(control(restored, "duration")).toHaveValue("48");
    await expect(control(restored, "unit")).toHaveValue("hours");
    await expect(control(restored, "scope", 2)).toHaveValue("time");
    await expect(control(restored, "time field", 2)).toHaveValue("created_at");
    await expect(control(restored, "operator", 2)).toHaveValue("between");
    await expect(control(restored, "date", 2)).toHaveValue("2026-10-24");
    await expect(control(restored, "end date", 2)).toHaveValue("2026-10-25");
    await expect(
      restored.getByLabel("Combine conditions", { exact: true }),
    ).toHaveValue("any");
    await charts(page);
    await expectDrawer(page, [3, 4, 6]);
  });

  test(`${source}: rolling time refreshes without editing and remains shared in the drawer`, async ({
    page,
  }) => {
    await fixture(page, source);
    const root = await addTime(page);
    await control(root, "duration").fill("1");
    await control(root, "unit").selectOption("hours");
    await expectTable(page, source, [1]);
    await closeMenu(page);
    await page.clock.fastForward(31 * 60_000);
    await expectTable(page, source, []);
    await charts(page);
    await expectDrawer(page, []);
    const shared = await openMenu(page);
    await control(shared, "duration").fill("2");
    await expectDrawer(page, [1]);
    await closeMenu(page);
    await page.clock.fastForward(60 * 60_000);
    await expectDrawer(page, []);
    await runs(page);
    await expectTable(page, source, []);
  });
}

test("rx: Time and Event conditions share AND/OR without sending timestamps to the event scanner", async ({
  page,
}) => {
  const calls = await fixture(page, "rx");
  const root = await addTime(page);
  await root
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  await expect(control(root, "scope", 2)).toHaveValue("event");
  await control(root, "path", 2).fill("metrics.accuracy");
  await control(root, "path", 2).press("Enter");
  await control(root, "operator", 2).selectOption("exists");
  await expectTable(page, "rx", [1]);
  await root
    .getByLabel("Combine conditions", { exact: true })
    .selectOption("any");
  await expectTable(page, "rx", [1, 2, 3, 4, 6]);
  await charts(page);
  await expectDrawer(page, [1, 2, 3, 4, 6]);
  const shared = await openMenu(page);
  await shared
    .getByLabel("Combine conditions", { exact: true })
    .selectOption("all");
  await expectDrawer(page, [1]);
  await control(shared, "operator").selectOption("older");
  await expectDrawer(page, [2]);
  await runs(page);
  await expectTable(page, "rx", [2]);
  const scans = calls.filter((call) => call.path === "/api/rx/run-filter");
  expect(scans.length).toBeGreaterThan(0);
  expect(scans.at(-1)!.body.conditions).toEqual([
    { path: "metrics.accuracy", op: "exists", value: null },
  ]);
  for (const scan of scans) {
    expect(scan.body.source_id).toBe(RX_SOURCE);
    expect(
      scan.body.conditions.every(
        (condition: any) => condition.path === "metrics.accuracy",
      ),
    ).toBe(true);
  }
});

test("record-only chart filters never offer the run-level Time scope", async ({
  page,
}) => {
  await fixture(page, "rx");
  await page.getByRole("checkbox", { name: "Select r1", exact: true }).check();
  await charts(page);
  await page.locator("details[data-menu=add] summary").click();
  await page.getByRole("button", { name: "Line plot", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Add chart", exact: true });
  await expect(editor.getByLabel("Data source", { exact: true })).toHaveValue(
    "records",
  );
  await editor.getByLabel("Filter records", { exact: true }).click();
  const records = editor.locator(".run-filter-menu");
  await records
    .getByRole("button", { name: "+ Add condition", exact: true })
    .click();
  await expect(control(records, "scope")).toBeDisabled();
  await expect(control(records, "scope")).toHaveValue("event");
  await expect(control(records, "scope").locator("option")).toHaveText([
    "Event",
  ]);
  await expect(records.locator('option[value="time"]')).toHaveCount(0);
  await expect(control(records, "time field")).toHaveCount(0);
});

for (const source of ["native", "rx"] as const) {
  test(`${source}: exact local date-times survive reload and remain shared`, async ({
    page,
  }) => {
    await fixture(page, source);
    let root = await addTime(page);
    await control(root, "operator").selectOption("between");
    await control(root, "date").fill("2026-10-26");
    await control(root, "end date").fill("2026-10-26");
    await control(root, "include time").check();
    await expect(control(root, "date")).toHaveAttribute(
      "type",
      "datetime-local",
    );
    await expect(control(root, "date")).toHaveValue("2026-10-26T00:00");
    await control(root, "date").fill("2026-10-26T04:00");
    await control(root, "end date").fill("2026-10-26T04:30");
    await expectTable(page, source, [1]);
    await control(root, "end date").fill("2026-10-26T03:59");
    await expect(control(root, "end date")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expectTable(page, source, []);
    await control(root, "end date").fill("2026-10-26T04:30");
    await page.reload();
    await expectTable(page, source, [1]);
    root = await openMenu(page);
    await expect(control(root, "include time")).toBeChecked();
    await expect(control(root, "date")).toHaveValue("2026-10-26T04:00");
    await expect(control(root, "end date")).toHaveValue("2026-10-26T04:30");
    await charts(page);
    await expectDrawer(page, [1]);
    root = await openMenu(page);
    await control(root, "operator").selectOption("before");
    await control(root, "date").fill("2026-10-26T04:30");
    await expectDrawer(page, [2, 3, 4, 6]);
    await control(root, "operator").selectOption("after");
    await control(root, "date").fill("2026-10-25T00:00");
    await expectDrawer(page, [1, 3]);
    await control(root, "include time").uncheck();
    await expect(control(root, "date")).toHaveAttribute("type", "date");
    await expect(control(root, "date")).toHaveValue("2026-10-25");
    await expectDrawer(page, [1]);
  });
}

test("date-time controls fit the filter popup on a narrow screen", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page, "rx");
  const root = await addTime(page);
  await control(root, "operator").selectOption("between");
  await control(root, "date").fill("2026-10-24");
  await control(root, "end date").fill("2026-10-26");
  await control(root, "include time").check();
  await control(root, "date").fill("2026-10-24T00:00");
  await control(root, "end date").fill("2026-10-26T14:30");
  const bounds = await root.locator(".run-filter-popover").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  for (const input of await root.locator(".run-filter-time-line input").all()) {
    const box = (await input.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(box.x + box.width).toBeLessThanOrEqual(
      bounds!.x + bounds!.width + 1,
    );
  }
  await page.screenshot({
    path: testInfo.outputPath("time-filter-mobile.png"),
  });
});
