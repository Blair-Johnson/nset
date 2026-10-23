import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

async function fixture(page: Page) {
  await page.route("**/__table_fields", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body><main style="padding:16px"><div id="view"></div></main></body></html>',
    }),
  );
  await page.goto("/__table_fields");
  await page.evaluate(async () => {
    const { runTable, tableState } = await import("/src/browser-tables.ts");
    const { renderRunDetail } = await import("/src/run-detail.ts");
    const experiment = { id: "sweep", name: "Sweep", created_at: 0 };
    const runs = Array.from({ length: 120 }, (_, i) => ({
      id: `run-${i}`,
      experiment_id: "sweep",
      name: `Candidate ${String(i).padStart(3, "0")} — a deliberately long training run name`,
      status: "finished",
      created_at: i,
      updated_at: i,
      params: {
        "train.optim.lr": i === 0 ? 0 : 0.01,
        train: { optim: { lr: 0.001 } },
        augment: false,
        nullable: null,
        ...(i === 0 ? { optional: "present" } : {}),
        list: [1, false],
        empty: "",
      },
      tags: {},
    }));
    const keys = [
      ...Array.from(
        { length: 99 },
        (_, i) => `metric/${String(i).padStart(3, "0")}`,
      ),
      "validation/loss",
    ];
    const series = runs.flatMap((run, i) =>
      keys.map((key, k) => ({
        kind: "metric",
        run_id: run.id,
        key,
        last_value: i + k / 100,
        last_step: 99,
        count: 100,
      })),
    );
    const catalog = { experiments: [experiment], runs, series } as any;
    const state = tableState();
    state.descending = false;
    const selections: string[][] = [];
    const host = document.querySelector("#view")!;
    const show = () => {
      host.replaceChildren(
        runTable(
          catalog,
          experiment,
          ["run-0"],
          (ids) => {
            selections.push(ids);
          },
          () => {
            host.replaceChildren(
              Object.assign(document.createElement("button"), {
                textContent: "Back from Charts",
                onclick: show,
              }),
            );
          },
          (run) =>
            host.replaceChildren(
              renderRunDetail(run, { onBack: show, onCharts: show }),
            ),
          state,
        ),
      );
    };
    (window as any).__fields = { state, selections, runs, show };
    show();
  });
}

for (const width of [1440, 390])
  test(`${width}px searchable scalar columns preserve exact values and keyboard access`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page);
    await page.getByText("Columns", { exact: true }).click();
    const search = page.getByRole("searchbox", {
      name: "Search columns",
      exact: true,
    });
    await expect(
      page.getByRole("group", { name: "Metrics · latest", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Parameters", exact: true }),
    ).toBeVisible();
    await search.fill("validation/loss");
    await page.keyboard.press("Tab");
    const metric = page.getByRole("checkbox", {
      name: "validation/loss",
      exact: true,
    });
    await expect(metric).toBeFocused();
    await page.keyboard.press("Space");
    await expect(metric).toBeChecked();
    await expect(metric).toBeFocused();
    await search.fill("lr");
    const literal = '$["train.optim.lr"]',
      nested = '$["train"]["optim"]["lr"]';
    for (const path of [literal, nested])
      await page.getByRole("checkbox", { name: path, exact: true }).check();
    expect(
      await page.locator(".column-choices").evaluate((node) => node.scrollTop),
    ).toBe(0);
    await page.screenshot({ path: info.outputPath("searched-picker.png") });
    // Unambiguous keys read as plain dotted names; colliding ones keep JSONPath.
    for (const name of ["nullable", "augment", "optional", "empty"]) {
      await search.fill(name);
      await page.getByRole("checkbox", { name, exact: true }).check();
    }
    await search.fill("not-a-field");
    await expect(page.getByRole("status")).toHaveText("No matching columns");
    await search.fill("");
    const bounds = await page.locator(".column-picker").boundingBox();
    expect(bounds!.height).toBeLessThanOrEqual(340);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await search.press("Escape");
    await expect(page.locator(".menu > summary")).toBeFocused();
    await expect(
      page.getByRole("button", {
        name: "validation/loss · latest",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.locator("tbody tr").first().locator(".parameter-cell"),
    ).toHaveText(["0", "0.001", "null", "false", '"present"', '""']);
    await expect(
      page.locator("tbody tr").nth(1).locator(".parameter-cell"),
    ).toHaveText(["0.01", "0.001", "null", "false", "—", '""']);
    await expect(
      page.locator("tbody tr").nth(1).locator(".parameter-cell").nth(4),
    ).toHaveAttribute("title", /Missing parameter/);
    expect(
      await page.evaluate(() => (window as any).__fields.selections),
    ).toEqual([]);
    await writeFile(
      info.outputPath("picker-geometry.json"),
      JSON.stringify({ width, bounds }, null, 2),
    );
  });

test("column state survives detail/export and Charts return; removal never changes selected IDs", async ({
  page,
}, info) => {
  await fixture(page);
  await page.getByText("Columns", { exact: true }).click();
  const search = page.getByRole("searchbox", {
    name: "Search columns",
    exact: true,
  });
  await search.fill("lr");
  await page
    .getByRole("checkbox", { name: '$["train.optim.lr"]', exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: '$["train"]["optim"]["lr"]', exact: true })
    .check();
  await search.press("Escape");
  await page
    .getByRole("button", { name: '$["train.optim.lr"]', exact: true })
    .click();
  const params = await page.evaluate(
    () => (window as any).__fields.runs[0].params,
  );
  await page.locator(".run-link").first().click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  const download = await downloadEvent;
  const path = info.outputPath("exported-config.json");
  await download.saveAs(path);
  const { readFile } = await import("node:fs/promises");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(params);
  await page.getByRole("button", { name: "← Runs", exact: true }).click();
  await expect(
    page.locator("tbody tr").first().locator(".parameter-cell"),
  ).toHaveText(["0", "0.001"]);
  await expect(
    page
      .getByRole("button", { name: '$["train.optim.lr"] ↑', exact: true })
      .locator(".."),
  ).toHaveAttribute("aria-sort", "ascending");
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await page
    .getByRole("button", { name: "Back from Charts", exact: true })
    .click();
  await page.getByText("Columns", { exact: true }).click();
  await expect(search).toHaveValue("lr");
  await page
    .getByRole("checkbox", { name: '$["train.optim.lr"]', exact: true })
    .uncheck();
  await expect(
    page.getByRole("checkbox", { name: '$["train.optim.lr"]', exact: true }),
  ).toBeFocused();
  await search.press("Escape");
  await expect(
    page.locator("tbody tr").first().locator(".parameter-cell"),
  ).toHaveText(["0.001"]);
  expect(
    await page.evaluate(() => (window as any).__fields.selections),
  ).toEqual([]);
});

test("existing shell routes retain columns, search, sort, page and selection", async ({
  page,
}, info) => {
  const runs = Array.from({ length: 120 }, (_, i) => ({
    id: `run-${i}`,
    experiment_id: "sweep",
    name: `Candidate ${String(i).padStart(3, "0")}`,
    status: "finished",
    created_at: i,
    updated_at: i,
    params: { "train.optim.lr": i, train: { optim: { lr: i / 1000 } } },
    tags: {},
  }));
  let histories = 0;
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [{ id: "sweep", name: "Sweep", created_at: 0 }],
          runs,
          series: runs.map((run, i) => ({
            kind: "metric",
            run_id: run.id,
            key: "validation/loss",
            last_value: i,
            last_step: 2,
            last_timestamp: 2,
            count: 3,
          })),
        },
      });
    if (url.pathname.endsWith("/metrics")) {
      histories++;
      return route.fulfill({
        json: {
          points: [0, 1, 2].map((step) => ({
            seq: step + 1,
            step,
            timestamp: step,
            value: 3 - step,
          })),
          total: 3,
          snapshot: 3,
          next_after: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await page.getByLabel("Access token", { exact: true }).fill("fixture");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Sweep", exact: true }).click();
  await page
    .getByRole("searchbox", {
      name: "Search runs, parameters or tags",
      exact: true,
    })
    .fill("Candidate");
  await page
    .getByRole("button", { name: "validation/loss · latest", exact: true })
    .click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Select Candidate 050", exact: true })
    .check();
  const selectedBefore = await page.locator(".selection-count").innerText();
  const historiesBefore = histories;
  await page.getByText("Columns", { exact: true }).click();
  const search = page.getByRole("searchbox", {
    name: "Search columns",
    exact: true,
  });
  await search.fill("lr");
  for (const name of ['$["train.optim.lr"]', '$["train"]["optim"]["lr"]'])
    await page.getByRole("checkbox", { name, exact: true }).check();
  await search.press("Escape");
  expect(histories).toBe(historiesBefore);
  await expect(page.locator(".selection-count")).toHaveText(selectedBefore);
  await page
    .getByRole("button", { name: "Candidate 050", exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs\/run-50$/);
  await page.getByRole("button", { name: "← Runs", exact: true }).click();
  await expect(page.getByText("51–100 of 120", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("searchbox", {
      name: "Search runs, parameters or tags",
      exact: true,
    }),
  ).toHaveValue("Candidate");
  await expect(
    page
      .getByRole("button", { name: "validation/loss · latest ↑", exact: true })
      .locator(".."),
  ).toHaveAttribute("aria-sort", "ascending");
  await expect(
    page.locator("tbody tr").first().locator(".parameter-cell"),
  ).toHaveText(["50", "0.05"]);
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await page.locator(".dashboard-cell canvas").first().waitFor();
  await page
    .locator(".view-switch")
    .getByRole("button", { name: "Runs", exact: true })
    .click();
  await expect(page.getByText("51–100 of 120", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Select Candidate 050", exact: true }),
  ).toBeChecked();
  await expect(
    page.locator("tbody tr").first().locator(".parameter-cell"),
  ).toHaveText(["50", "0.05"]);
  await page.getByText("Columns", { exact: true }).click();
  await expect(search).toHaveValue("lr");
  await page.screenshot({
    path: info.outputPath("shell-restored-columns.png"),
  });
});
