import { expect, test } from "@playwright/test";

for (const axis of ["relative", "timestamp"] as const) {
  test(`${axis}: imported run starts remain distinct from import creation and cached origins refresh`, async ({
    page,
  }) => {
    await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body></body>",
      }),
    );
    await page.goto("/");
    await page.evaluate(async (axis) => {
      const { ChartCard } = await import("/src/cards.ts");
      const { newChart } = await import("/src/workspace.ts");
      const starts = [1700000000000, 1700000000000 + 21 * 86400000];
      const runs = starts.map((start, i) => ({
        id: `r${i}`,
        name: `Imported ${i}`,
        experiment_id: "e",
        status: "finished",
        params: {},
        tags: { "mlflow_import.start_time": start },
        created_at: 1800000000000 + i,
        updated_at: 1800000000000 + i,
      }));
      const histories = starts.map((start) =>
        [1000, 2000].map((delay, i) => ({
          seq: i + 1,
          step: i,
          timestamp: start + delay,
          value: i + 1,
        })),
      );
      const catalog = {
        experiments: [],
        runs,
        series: runs.map((run) => ({
          run_id: run.id,
          key: "loss",
          kind: "metric",
          count: 2,
          last_step: 1,
          last_timestamp: starts[Number(run.id.slice(1))] + 2000,
          last_value: 2,
        })),
      };
      const store = {
        load: async (ref: any) => histories[Number(ref.runId.slice(1))],
        watch: () => () => {},
      };
      const spec = newChart("timeseries", ["loss"], "Imported relative time");
      spec.config.axis = axis;
      const host = document.createElement("div");
      host.style.width = "900px";
      document.body.append(host);
      const actions = Object.fromEntries(
        [
          "onEdit",
          "onRemove",
          "onDuplicate",
          "onMove",
          "onResize",
          "onDimensions",
        ].map((name) => [name, () => {}]),
      );
      const card = new ChartCard(
        host,
        spec,
        {
          api: {},
          catalog,
          selectedRunIds: runs.map((run) => run.id),
          store,
        } as any,
        actions as any,
      );
      (window as any).relative = { card, catalog, histories, starts };
    }, axis);
    await expect(page.locator(".u-over")).toBeVisible();
    const coordinates = () =>
      page.evaluate(() =>
        (window as any).relative.card.data.map((series: any) =>
          series.observations.map((point: number[]) => point[0]),
        ),
      );
    const starts = [1700000000000, 1700000000000 + 21 * 86400000];
    await expect.poll(coordinates).toEqual(
      axis === "relative"
        ? [
            [1000, 2000],
            [1000, 2000],
          ]
        : starts.map((start) => [start + 1000, start + 2000]),
    );
    await page.evaluate(() => {
      const s = (window as any).relative;
      s.catalog = {
        ...s.catalog,
        runs: s.catalog.runs.map((run: any, i: number) =>
          i
            ? run
            : {
                ...run,
                tags: {
                  ...run.tags,
                  "mlflow_import.start_time": s.starts[0] + 500,
                },
              },
        ),
      };
      s.card.updateCatalog(s.catalog);
    });
    await expect.poll(coordinates).toEqual(
      axis === "relative"
        ? [
            [500, 1500],
            [1000, 2000],
          ]
        : starts.map((start) => [start + 1000, start + 2000]),
    );
    expect(
      await page.evaluate(() =>
        (window as any).relative.histories.map((points: any[]) =>
          points.map((point) => point.timestamp),
        ),
      ),
    ).toEqual(starts.map((start) => [start + 1000, start + 2000]));
  });
}
