import { expect, test, type Page, type Route } from "@playwright/test";
import type { Catalog } from "../src/workspace-types";

const day = 86_400_000;
const start = Date.UTC(2026, 0, 1);
const at = (days: number) => start + days * day;

async function fixture(page: Page) {
  const catalog: Catalog = {
    metric_seq: 1,
    experiments: ["Alpha", "Beta", "Images", "Empty"].map((name, i) => ({
      id: name.toLowerCase(),
      name,
      created_at: at(i + 1),
    })),
    runs: [
      ["alpha-run", "alpha", 6],
      ["alpha-old", "alpha", 3],
      ["beta-run", "beta", 8],
      ["image-run", "images", 7],
    ].map(([id, experiment_id, updated]) => ({
      id: String(id),
      experiment_id: String(experiment_id),
      name: String(id),
      status: "running",
      params: {},
      tags: {},
      created_at: at(2),
      updated_at: at(Number(updated)),
    })),
    series: [
      {
        run_id: "alpha-run",
        key: "loss",
        kind: "metric",
        count: 1,
        last_step: 0,
        last_timestamp: at(600),
        last_value: 1,
      },
      {
        run_id: "image-run",
        key: "preview",
        kind: "image",
        count: 1,
        last_step: 0,
        last_timestamp: at(700),
        last_value: null,
      },
    ],
  };
  const polls: Route[] = [];
  const unexpected: string[] = [];
  let catalogRequests = 0;
  let cursor = 0;
  await page.addInitScript(() => sessionStorage.setItem("nset.token", "test"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/catalog") {
      catalogRequests++;
      return route.fulfill({ json: catalog });
    }
    if (path === "/api/views") return route.fulfill({ json: { views: [] } });
    if (path === "/api/live") {
      if (request.method() === "GET")
        return route.fulfill({ json: { cursor: `live:${cursor}` } });
      polls.push(route);
      return;
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected request" },
    });
  });
  await page.goto("/");
  await expect(page.locator(".experiment-link")).toHaveCount(4);
  await expect(page.locator("#connection")).toHaveText("Connected");
  return {
    catalog,
    counts: () => ({ catalog: catalogRequests, unexpected: [...unexpected] }),
    async metric(timestamp: number, runUpdatedAt?: number) {
      await expect.poll(() => polls.length).toBeGreaterThan(0);
      const summary = catalog.series[0];
      summary.last_timestamp = timestamp;
      summary.last_step++;
      summary.count++;
      const seq = (catalog.metric_seq ?? 0) + 1;
      catalog.metric_seq = seq;
      if (runUpdatedAt !== undefined)
        catalog.runs[0].updated_at = Math.max(
          catalog.runs[0].updated_at,
          runUpdatedAt,
        );
      await polls.shift()!.fulfill({
        json: {
          cursor: `live:${++cursor}`,
          reset: false,
          changes: [
            {
              kind: "metric",
              runId: summary.run_id,
              key: summary.key,
              high: seq,
              count: 1,
              ...(runUpdatedAt === undefined ? {} : { runUpdatedAt }),
              last: { seq, step: summary.last_step, timestamp, value: 1 },
            },
          ],
        },
      });
      await expect.poll(() => polls.length).toBeGreaterThan(0);
    },
  };
}
const order = (page: Page) => page.locator(".experiment-link");
const updatedHeader = (page: Page) =>
  page.locator('th:has(button[data-sort-key="updated_at"])');
const updatedCell = (page: Page, id: string) =>
  page.locator(`tr:has([data-experiment-id="${id}"]) td`).nth(3);
const label = (page: Page, timestamp: number) =>
  page.evaluate(
    (time) =>
      new Date(time).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    timestamp,
  );

test("Updated sorts authoritative run activity, ignoring future metric/image samples", async ({
  page,
}) => {
  const live = await fixture(page);
  // Existing default remains Created descending, not implicitly Updated.
  await expect(order(page)).toHaveText(["Empty", "Images", "Beta", "Alpha"]);
  const updated = updatedHeader(page).getByRole("button");
  await updated.click();
  await expect(updatedHeader(page)).toHaveAttribute("aria-sort", "descending");
  await expect(updated).toBeFocused();
  await expect(order(page)).toHaveText(["Beta", "Images", "Alpha", "Empty"]);
  for (const [id, days] of [
    ["beta", 8],
    ["images", 7],
    ["alpha", 6],
    ["empty", 4],
  ] as const)
    await expect(updatedCell(page, id)).toHaveText(await label(page, at(days)));
  await updated.click();
  await expect(updatedHeader(page)).toHaveAttribute("aria-sort", "ascending");
  await expect(order(page)).toHaveText(["Empty", "Alpha", "Images", "Beta"]);
  // Route changes reuse the existing experiment table state.
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(page.locator(".run-table")).toBeVisible();
  await page.evaluate(() => {
    location.hash = "";
  });
  await expect(updatedHeader(page)).toHaveAttribute("aria-sort", "ascending");
  await expect(order(page)).toHaveText(["Empty", "Alpha", "Images", "Beta"]);
  expect(live.counts()).toEqual({ catalog: 1, unexpected: [] });
});

test("metric-only live arrivals refresh Updated, reorder, and retain search/focus", async ({
  page,
}) => {
  const live = await fixture(page);
  await updatedHeader(page).getByRole("button").click();
  const search = page.getByRole("searchbox", { name: "Search experiments" });
  await search.fill("a");
  await expect(order(page)).toHaveText(["Beta", "Images", "Alpha"]);
  const alpha = page.getByRole("button", { name: "Alpha", exact: true });
  await alpha.focus();
  const before = live.counts();
  // Old-server hints and future sample times cannot manufacture activity.
  await live.metric(at(1000));
  await expect(order(page)).toHaveText(["Beta", "Images", "Alpha"]);
  await expect(updatedCell(page, "alpha")).toHaveText(await label(page, at(6)));
  await live.metric(at(1000), at(6));
  await expect(order(page)).toHaveText(["Beta", "Images", "Alpha"]);
  await live.metric(at(0), at(10));
  await expect(order(page)).toHaveText(["Alpha", "Beta", "Images"]);
  await expect(updatedCell(page, "alpha")).toHaveText(
    await label(page, at(10)),
  );
  await expect(alpha).toBeFocused();
  await expect(search).toHaveValue("a");
  await expect(updatedHeader(page)).toHaveAttribute("aria-sort", "descending");
  // Same ordering and run count: the server activity timestamp refreshes the row.
  await live.metric(at(0), at(11));
  await expect(updatedCell(page, "alpha")).toHaveText(
    await label(page, at(11)),
  );
  await expect(alpha).toBeFocused();
  expect(live.catalog.runs[0].updated_at).toBe(at(11));
  expect(live.counts()).toEqual(before); // no catalog or per-run fetches
  await updatedHeader(page).getByRole("button").click();
  await expect(order(page)).toHaveText(["Images", "Beta", "Alpha"]);
  await live.metric(at(1000), at(12));
  await expect(updatedCell(page, "alpha")).toHaveText(
    await label(page, at(12)),
  );
  await expect(order(page)).toHaveText(["Images", "Beta", "Alpha"]);
  await expect(updatedHeader(page)).toHaveAttribute("aria-sort", "ascending");
  // Neither backdated samples nor older effective activity hints lower Updated.
  await live.metric(at(0), at(11));
  await expect(updatedCell(page, "alpha")).toHaveText(
    await label(page, at(12)),
  );
  await expect(order(page)).toHaveText(["Images", "Beta", "Alpha"]);
  expect(live.counts()).toEqual(before);
  await page.reload();
  await updatedHeader(page).getByRole("button").click();
  await expect(order(page)).toHaveText(["Alpha", "Beta", "Images", "Empty"]);
  await expect(updatedCell(page, "alpha")).toHaveText(
    await label(page, at(12)),
  );
});

test("creation fallbacks, stable ties, ignored samples and equivalent refreshes", async ({
  page,
}) => {
  // Isolate malformed/missing timestamp fallbacks that the HTTP parser rejects.
  await page.route("**/table-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/table-fixture");
  const result = await page.evaluate(async () => {
    const { experimentTable, tableState, timeLabel } =
      await import("/src/browser-tables.ts");
    const catalog = {
      experiments: [
        { id: "unknown", name: "Unknown", created_at: NaN },
        { id: "zero", name: "Zero", created_at: 0 },
        { id: "tie", name: "Tie", created_at: 0 },
        { id: "run", name: "Run fallback", created_at: NaN },
      ],
      runs: [
        {
          id: "r",
          experiment_id: "run",
          name: "r",
          status: "running" as const,
          params: {},
          tags: {},
          created_at: 1000,
          updated_at: NaN,
        },
      ],
      series: [
        {
          run_id: "r",
          key: "future",
          kind: "metric" as const,
          count: 1,
          last_step: 0,
          last_timestamp: 99999,
          last_value: 0,
        },
        {
          run_id: "r",
          key: "future-image",
          kind: "image" as const,
          count: 1,
          last_step: 0,
          last_timestamp: 999999,
          last_value: 0,
        },
        {
          run_id: "orphan",
          key: "loss",
          kind: "metric" as const,
          count: 1,
          last_step: 0,
          last_timestamp: 99999,
          last_value: 0,
        },
      ],
    };
    const state = { ...tableState(), sort: "updated_at", descending: true };
    const table = experimentTable(catalog, () => {}, state);
    document.body.append(table);
    const names = () =>
      [...table.querySelectorAll(".experiment-link")].map(
        (node) => node.textContent,
      );
    const descending = names();
    const firstBody = table.querySelector("tbody tr");
    table.updateCatalog(structuredClone(catalog));
    const retainedRow = table.querySelector("tbody tr") === firstBody;
    const times = [...table.querySelectorAll("tbody tr")].map(
      (row) => row.lastElementChild?.textContent,
    );
    table
      .querySelector<HTMLButtonElement>('[data-sort-key="updated_at"]')!
      .click();
    const ascending = names();
    table.updateCatalog({ experiments: [], runs: [], series: [] });
    return {
      descending,
      ascending,
      retainedRow,
      times,
      expectedTimes: [timeLabel(1000), timeLabel(0), timeLabel(0), "Unknown"],
      emptySpan: table.querySelector("td")?.colSpan,
    };
  });
  expect(result.descending).toEqual(["Run fallback", "Zero", "Tie", "Unknown"]);
  expect(result.ascending).toEqual(["Zero", "Tie", "Run fallback", "Unknown"]);
  expect(result.times).toEqual(result.expectedTimes);
  expect(result.retainedRow).toBe(true);
  expect(result.emptySpan).toBe(4);
});
