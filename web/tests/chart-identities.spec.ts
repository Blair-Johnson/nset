import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, delayed = false) {
  await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async (delayed) => {
    const { ChartCard } = await import("/src/cards.ts");
    const { newChart, seriesId } = await import("/src/workspace.ts");
    document.body.style.cssText =
      "margin:12px;background:#191c20;color:#ddd;font:13px system-ui;--surface:#202429;--surface-raised:#252a30;--border:#42474e;--text:#ddd;--muted:#aaa;--accent:#7dd3fc";
    const host = document.createElement("div");
    host.style.width = "660px";
    host.style.maxWidth = "100%";
    document.body.append(host);
    const runs = ["a", "b"].map((id) => ({
      id,
      name: "Duplicate",
      experiment_id: "e",
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
    }));
    const keys = ["train/loss", "eval/loss"];
    const catalog = {
      experiments: [],
      runs,
      series: runs.flatMap((run) =>
        keys.map((key) => ({
          run_id: run.id,
          key,
          kind: "metric",
          count: 7,
          last_step: 6,
          last_timestamp: 6000,
          last_value: 2,
        })),
      ),
    };
    const state: any = { loads: 0, details: [], releases: [] };
    const context = {
      api: {},
      catalog,
      selectedRunIds: ["a", "b"],
      runLabels: { a: "Baseline", b: "Candidate" },
      store: {
        clear() {},
        async load(ref: any) {
          state.loads++;
          if (delayed)
            await new Promise<void>((resolve) => state.releases.push(resolve));
          return [0, 2, 0, 2, 0, 2, 0].map((value, step) => ({
            seq: step + 1,
            step,
            timestamp: step * 1000,
            value: value + (ref.key === "eval/loss" ? 0.2 : 0),
          }));
        },
      },
    };
    const spec = newChart("timeseries", keys, "Identity fixture");
    spec.id = "identity-fixture";
    spec.layout = { width: 660, height: 450 };
    spec.details = {
      markdown: "## Comparison",
      measurements: { interval: { axis: "x", a: 1, b: 4 } },
    };
    for (const run of runs)
      for (const key of keys)
        spec.config.runs[seriesId({ runId: run.id, key, kind: "metric" })] = {
          color: run.id === "a" ? "#ff0000" : "#00ccff",
          dash: key === "eval/loss" ? [5, 3] : [],
        };
    state.context = context;
    state.card = new ChartCard(host, spec, context, {
      onEdit() {},
      onRemove() {},
      onMove() {},
      onDuplicate() {},
      onResize() {},
      onDetails(id: string) {
        state.details.push(id);
        state.card.setDetailsOpen(true);
      },
    });
    state.release = () =>
      state.releases.splice(0).forEach((release: () => void) => release());
    (window as any).identities = state;
  }, delayed);
  if (!delayed) await expect(page.locator(".u-over")).toBeVisible();
}

async function moveTo(page: Page, x: number, y: number) {
  const point = await page.evaluate(
    ({ x, y }) => {
      const u = (window as any).identities.card.plot.chart;
      const r = u.over.getBoundingClientRect();
      return { x: r.left + u.valToPos(x, "x"), y: r.top + u.valToPos(y, "y") };
    },
    { x, y },
  );
  await page.mouse.move(point.x, point.y);
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).identities;
    return {
      loads: s.loads,
      pins: s.card.pins,
      view: s.card.plot.viewport(),
      raw: s.card.raw.length,
    };
  });
}

test("resolved identities, metrics, colors and dash samples agree across native surfaces", async ({
  page,
}) => {
  await fixture(page);
  await expect(page.locator(".card-legend-item")).toHaveCount(4);
  await expect(page.locator(".card-legend")).toContainText(
    "Baseline · train/loss",
  );
  await expect(page.locator(".card-legend")).toContainText(
    "Baseline · eval/loss",
  );
  await moveTo(page, 2.5, 1);
  await expect(page.locator(".card-hover-row")).toHaveCount(4);
  const hoverIds = await page
    .locator(".card-hover-row")
    .evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.seriesId),
    );
  expect(new Set(hoverIds).size).toBe(4);
  await expect(page.locator(".card-hover")).toContainText(
    "Baseline / eval/loss",
  );
  await page.evaluate(() =>
    (window as any).identities.card.showMeasurement({ axis: "x", a: 1, b: 4 }),
  );
  await expect(page.locator(".card-value-table tr")).toHaveCount(5);
  const samples = await page.evaluate(() => {
    const collect = (selector: string) =>
      [...document.querySelectorAll(selector)].map((node) => ({
        id: (node as HTMLElement).dataset.seriesId,
        label: node.querySelector(".card-series-label")?.textContent,
        color: node.querySelector("line")?.getAttribute("stroke"),
        dash: node.querySelector("line")?.getAttribute("stroke-dasharray"),
      }));
    return {
      legend: collect(".card-legend .card-series-identity"),
      cursor: collect(".card-value-table .card-series-identity"),
    };
  });
  expect(samples.cursor).toEqual(samples.legend);
  expect(samples.legend.some((s) => s.dash === "5 3")).toBe(true);
  await page.evaluate(() =>
    (window as any).identities.card.showMeasurement({ axis: "y", a: 1 }),
  );
  await expect(page.locator(".card-crossings")).toHaveCount(4);
  await expect(page.locator(".card-crossings").first()).toContainText(
    "6 crossings",
  );
  await expect(page.locator(".card-crossings").first()).toContainText(
    "Baseline",
  );
  const crossingValues = await page
    .locator(".card-crossings > div")
    .allTextContents();
  await page.evaluate(() => {
    const s = (window as any).identities;
    s.card.setContext({ ...s.context, labelMode: "original" });
  });
  await expect(page.locator(".card-crossings .card-legend-name")).toHaveText([
    "Duplicate",
    "Duplicate",
    "Duplicate",
    "Duplicate",
  ]);
  expect(await page.locator(".card-crossings > div").allTextContents()).toEqual(
    crossingValues,
  );
  await page.evaluate(() => {
    const s = (window as any).identities;
    s.card.setContext({ ...s.context, labelMode: "semantic" });
  });
  await expect(page.locator(".card-crossings .card-legend-name")).toHaveText([
    "Baseline",
    "Baseline",
    "Candidate",
    "Candidate",
  ]);
  expect(await page.locator(".card-crossings > div").allTextContents()).toEqual(
    crossingValues,
  );
});

test("presentation changes preserve data, camera and cursors; duplicate labels retain distinct trace IDs", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const c = (window as any).identities.card;
    await c.showMeasurement({ axis: "x", a: 1, b: 4 });
    c.plot.showView({ x: [0.5, 4.5], y: [0.1, 1.9] });
  });
  const before = await snapshot(page);
  const traceIds = await page
    .locator(".card-legend-item")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.seriesId),
    );
  expect(new Set(traceIds).size).toBe(4);
  const values = await page.locator(".card-value-table td").allTextContents();
  const expectNames = async (name: string) => {
    await moveTo(page, 2.5, 1);
    for (const surface of [
      ".card-legend",
      ".card-hover",
      ".card-value-table",
    ]) {
      await expect(page.locator(`${surface} .card-legend-name`)).toHaveText([
        name,
        name,
        name,
        name,
      ]);
      const ids = await page
        .locator(`${surface} .card-series-identity`)
        .evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLElement).dataset.seriesId),
        );
      expect(ids.sort()).toEqual([...traceIds].sort());
    }
    expect(
      await page.locator(".card-value-table td").allTextContents(),
    ).toEqual(values);
  };
  await page.evaluate(() => {
    const s = (window as any).identities;
    s.card.setContext({ ...s.context, labelMode: "original" });
    s.card.setSpec({
      ...s.card.spec,
      details: { markdown: "Updated narrative" },
    });
  });
  await expectNames("Duplicate");
  expect(await snapshot(page)).toEqual(before);
  await page.evaluate(() => {
    const s = (window as any).identities;
    s.card.setContext({ ...s.context, runLabels: { a: "Same", b: "Same" } });
  });
  await expectNames("Same");
  expect(await snapshot(page)).toEqual(before);
  await page.evaluate(() => {
    const s = (window as any).identities;
    s.card.setContext({ ...s.context, runLabels: undefined });
  });
  await expectNames("Duplicate");
});

test("hover exit clears readings, no coordinate heading, compact content fits a narrow chart", async ({
  page,
}) => {
  await fixture(page);
  await moveTo(page, 2.5, 1);
  await expect(page.locator(".card-hover")).toBeVisible();
  await expect(page.locator(".card-legend-coordinate")).toHaveCount(0);
  expect(
    await page.locator(".card-legend-value").first().textContent(),
  ).not.toBe("");
  await page.mouse.move(2, 2);
  await expect(page.locator(".card-hover")).toBeEmpty();
  await expect(page.locator(".card-legend-value")).toHaveText(["", "", "", ""]);
  await expect(page.locator(".card-hover")).toBeHidden();
  expect(
    await page.evaluate(() => (window as any).identities.card.lastHoverX),
  ).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    const s = (window as any).identities;
    s.card.setContext({
      ...s.context,
      runLabels: { a: "A very long semantic label ".repeat(12), b: "Short" },
    });
  });
  await moveTo(page, 2.5, 1);
  await expect(page.locator(".card-hover-row")).toHaveCount(4);
  const boxes = await page.evaluate(() => {
    const popup = document
      .querySelector(".card-hover")!
      .getBoundingClientRect();
    const over = document.querySelector(".u-over")!.getBoundingClientRect();
    const label = document.querySelector(".card-hover .card-legend-name")!;
    return {
      left: popup.left,
      right: popup.right,
      plotLeft: over.left,
      plotRight: over.right,
      truncated: label.scrollWidth > label.clientWidth,
    };
  });
  expect(boxes.left).toBeGreaterThanOrEqual(boxes.plotLeft - 1);
  expect(boxes.right).toBeLessThanOrEqual(boxes.plotRight + 1);
  expect(boxes.truncated).toBe(true);
});

test("inline hover matches compact prototype geometry and neutral text hierarchy", async ({
  page,
}) => {
  await fixture(page);
  await moveTo(page, 2.5, 1);
  await expect(page.locator(".card-hover-row")).toHaveCount(4);
  await expect(page.locator(".card-hover-separator")).toHaveText([
    " / ",
    " / ",
    " / ",
    " / ",
  ]);
  expect(
    (
      await page.locator(".card-hover .card-legend-key").allTextContents()
    ).sort(),
  ).toEqual(["eval/loss", "eval/loss", "train/loss", "train/loss"]);
  const geometry = await page.locator(".card-hover-row").evaluateAll((rows) =>
    rows.map((row) => {
      const run = row.querySelector(".card-legend-name")!;
      const metric = row.querySelector(".card-legend-key")!;
      const value = row.querySelector(".card-hover-value")!;
      const stroke = row.querySelector("svg")!;
      const r = run.getBoundingClientRect(),
        m = metric.getBoundingClientRect(),
        v = value.getBoundingClientRect();
      return {
        inline: Math.abs(r.y - m.y) < 1,
        ordered: r.right < m.x && m.right < v.x,
        height: row.getBoundingClientRect().height,
        strokeWidth: stroke.getBoundingClientRect().width,
        strokeHeight: stroke.getBoundingClientRect().height,
        metricColor: getComputedStyle(metric).color,
        runColor: getComputedStyle(run).color,
        dash: stroke.querySelector("line")!.getAttribute("stroke-dasharray"),
      };
    }),
  );
  expect(geometry.every((g) => g.inline && g.ordered && g.height < 30)).toBe(
    true,
  );
  expect(
    geometry.every((g) => g.strokeWidth === 14 && g.strokeHeight === 8),
  ).toBe(true);
  expect(geometry.every((g) => g.metricColor === "rgb(221, 221, 221)")).toBe(
    true,
  );
  expect(geometry.map((g) => g.dash).sort()).toEqual(["", "", "5 3", "5 3"]);
  expect(geometry.map((g) => g.runColor).sort()).toEqual([
    "rgb(0, 204, 255)",
    "rgb(0, 204, 255)",
    "rgb(255, 0, 0)",
    "rgb(255, 0, 0)",
  ]);
  expect((await page.locator(".card-hover").boundingBox())!.width).toBeLessThan(
    360,
  );
  expect(
    await page
      .locator(".card-legend .card-legend-name")
      .evaluateAll((nodes) =>
        nodes.every(
          (node) => getComputedStyle(node).color === "rgb(221, 221, 221)",
        ),
      ),
  ).toBe(true);
  await expect(page.locator(".card-hover")).not.toContainText("At step");
  const overflow = await page.locator(".card-hover").evaluate((hover) => {
    const clone = hover.cloneNode(true) as HTMLElement;
    clone.style.cssText =
      "position:fixed;left:10px;top:10px;display:block;font:13px/1.45 system-ui";
    document.body.append(clone);
    const result: boolean[] = [];
    for (const width of [440, 280]) {
      clone.style.width = `${width}px`;
      for (const row of clone.querySelectorAll<HTMLElement>(
        ".card-hover-row",
      )) {
        const run = row.querySelector<HTMLElement>(".card-legend-name")!;
        const metric = row.querySelector<HTMLElement>(".card-legend-key")!;
        const value = row.querySelector<HTMLElement>(".card-hover-value")!;
        run.textContent = metric.textContent = "very_long_name_".repeat(12);
        const r = run.getBoundingClientRect(),
          m = metric.getBoundingClientRect(),
          v = value.getBoundingClientRect();
        result.push(
          r.width > 20 &&
            m.width > 20 &&
            r.right < m.x &&
            m.right < v.x &&
            Math.abs(r.y - m.y) < 1 &&
            run.scrollWidth > run.clientWidth &&
            metric.scrollWidth > metric.clientWidth &&
            row.scrollWidth <= row.clientWidth + 1 &&
            value.scrollWidth <= value.clientWidth + 1,
        );
      }
    }
    clone.remove();
    return result;
  });
  expect(overflow.every(Boolean)).toBe(true);
});

test("details hook and native measurement replacement retain data and authoritative Clear cursors", async ({
  page,
}) => {
  await fixture(page);
  const trigger = page.getByRole("button", {
    name: "Chart details",
    exact: true,
  });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => (window as any).identities.details)).toEqual(
    ["identity-fixture"],
  );
  const before = await snapshot(page);
  expect(
    await page.evaluate(() =>
      (window as any).identities.card.showMeasurement({
        axis: "x",
        a: 20,
        b: 25,
      }),
    ),
  ).toBe(true);
  const x = await snapshot(page);
  expect(x.view.x[1]).toBeGreaterThan(25);
  expect(x.loads).toBe(before.loads);
  expect(
    await page.evaluate(() =>
      (window as any).identities.card.showMeasurement({
        axis: "y",
        a: 1,
        b: null,
      }),
    ),
  ).toBe(true);
  const y = await snapshot(page);
  // Each report reference starts from the configured range, not the previous zoom.
  expect(y.view).toEqual(before.view);
  expect(y.pins).toEqual({
    a: null,
    b: null,
    threshold: null,
    yA: 1,
    yB: null,
  });
  expect(y.raw).toBe(before.raw);
  await expect(
    page.getByRole("button", { name: "Clear cursors", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Clear cursors", exact: true })
    .click();
  expect((await snapshot(page)).pins).toEqual({
    a: null,
    b: null,
    threshold: null,
    yA: null,
    yB: null,
  });
  await page.evaluate(() =>
    (window as any).identities.card.setSpec({
      ...(window as any).identities.card.spec,
      details: { markdown: "  " },
    }),
  );
  await expect(trigger).toHaveCount(0);
});

for (const change of [
  "source",
  "details",
  "context",
  "deactivate",
  "destroy",
] as const) {
  test(`loading measurement cannot commit after ${change} change`, async ({
    page,
  }) => {
    await fixture(page, true);
    await page.evaluate((change) => {
      const s = (window as any).identities,
        c = s.card;
      s.pending = c.showMeasurement({ axis: "x", a: 1, b: 3 });
      if (change === "source")
        c.setSpec({
          ...c.spec,
          source: { mode: "selected", keys: ["train/loss"] },
        });
      if (change === "details")
        c.setSpec({ ...c.spec, details: { markdown: "Replaced" } });
      if (change === "context")
        c.setContext({ ...s.context, labelMode: "original" });
      if (change === "deactivate") c.setActive(false);
      if (change === "destroy") c.destroy();
      s.release();
    }, change);
    expect(await page.evaluate(() => (window as any).identities.pending)).toBe(
      false,
    );
    expect(
      await page.evaluate(() => (window as any).identities.card.pins.a),
    ).toBeNull();
  });
}

test("waiting for data applies only the latest measurement", async ({
  page,
}) => {
  await fixture(page, true);
  await page.evaluate(() => {
    const s = (window as any).identities;
    s.first = s.card.showMeasurement({ axis: "x", a: 1 });
    s.second = s.card.showMeasurement({ axis: "y", a: 1, b: 2 });
    s.release();
  });
  expect(await page.evaluate(() => (window as any).identities.first)).toBe(
    false,
  );
  expect(await page.evaluate(() => (window as any).identities.second)).toBe(
    true,
  );
  expect((await snapshot(page)).pins).toEqual({
    a: null,
    b: null,
    threshold: null,
    yA: 1,
    yB: 2,
  });
});

test("popup keeps nearby crossings separate per resolved trace and excludes hidden traces", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const c = (window as any).identities.card;
    c.mode = "inspect";
    c.cursorAxis = "y";
    c.configure();
  });
  await moveTo(page, 3, 1);
  await expect(page.locator(".card-hover-row")).toHaveCount(4);
  const values = await page.locator(".card-hover-value").allTextContents();
  expect(values.every((value) => value.split(",").length === 2)).toBe(true);
  await page.evaluate(() => {
    const c = (window as any).identities.card;
    const id = c.data[0].run.id;
    c.setSpec({
      ...c.spec,
      config: {
        ...c.spec.config,
        runs: {
          ...c.spec.config.runs,
          [id]: { ...c.spec.config.runs[id], visible: false },
        },
      },
    });
  });
  await expect(page.locator(".card-legend-item")).toHaveCount(3);
  await page.evaluate(() =>
    (window as any).identities.card.showMeasurement({ axis: "x", a: 1 }),
  );
  await expect(page.locator(".card-value-table tr")).toHaveCount(4);
});

for (const axis of ["timestamp", "relative"] as const) {
  test(`measurement X uses displayed ${axis} units`, async ({ page }) => {
    await fixture(page);
    expect(
      await page.evaluate(async (axis) => {
        const c = (window as any).identities.card;
        c.setSpec({ ...c.spec, config: { ...c.spec.config, axis } });
        return c.showMeasurement({ axis: "x", a: 1000, b: 4000 });
      }, axis),
    ).toBe(true);
    expect((await snapshot(page)).pins.a).toBe(1000);
    expect((await snapshot(page)).pins.b).toBe(4000);
    await expect(page.locator(".card-position-readout")).toContainText(
      axis === "timestamp" ? "Time (UTC)" : "Elapsed time",
    );
  });
}

test("XY popup retains nearby trace crossings and measurement uses metric X", async ({
  page,
}) => {
  await fixture(page);
  expect(
    await page.evaluate(async () => {
      const s = (window as any).identities,
        c = s.card;
      c.setContext({
        ...s.context,
        store: {
          clear() {},
          async load(ref: any) {
            return (
              ref.key === "eval/loss"
                ? [0, 2, 0, 2, 0, 2, 0]
                : [0, 2, 4, 6, 8, 10, 12]
            ).map((value, step) => ({
              seq: step + 1,
              step,
              timestamp: step,
              value,
            }));
          },
        },
      });
      c.setSpec({
        ...c.spec,
        source: { mode: "selected", keys: ["train/loss"] },
        x: { mode: "key", key: "eval/loss" },
      });
      return c.showMeasurement({ axis: "x", a: 0.5, b: 1.5 });
    }),
  ).toBe(true);
  expect((await snapshot(page)).pins.a).toBe(0.5);
  await expect(page.locator(".card-position-readout")).toContainText(
    "eval/loss",
  );
  await moveTo(page, 1, 6);
  await expect(page.locator(".card-hover-row")).toHaveCount(2);
  const values = await page.locator(".card-hover-value").allTextContents();
  expect(values.every((value) => value.split(",").length === 2)).toBe(true);
});

test("invalid coordinates and image measurements are rejected; color refresh updates existing cursor samples", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() =>
    (window as any).identities.card.showMeasurement({ axis: "x", a: 1 }),
  );
  const before = await snapshot(page);
  await page.evaluate(() => {
    const c = (window as any).identities.card;
    for (const style of Object.values(c.spec.config.runs) as any[])
      style.color = "#33ff44";
    c.refreshColors();
  });
  expect(await snapshot(page)).toEqual(before);
  expect(
    await page
      .locator(".card-value-table line")
      .evaluateAll((lines) =>
        lines.every((line) => line.getAttribute("stroke") === "#33ff44"),
      ),
  ).toBe(true);
  expect(
    await page.evaluate(() =>
      (window as any).identities.card.showMeasurement({ axis: "x", a: NaN }),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(async () => {
      const c = (window as any).identities.card;
      c.setSpec({ ...c.spec, config: { ...c.spec.config, xScale: "log" } });
      return c.showMeasurement({ axis: "x", a: 0 });
    }),
  ).toBe(false);
  expect(
    await page.evaluate(async () => {
      const { newChart } = await import("/src/workspace.ts");
      const c = (window as any).identities.card;
      c.setSpec(newChart("image", ["camera"], "Image"));
      return c.showMeasurement({ axis: "y", a: 1 });
    }),
  ).toBe(false);
});

test("aborting a pane action while data loads never places its measurement", async ({
  page,
}) => {
  await fixture(page, true);
  await page.evaluate(() => {
    const s = (window as any).identities;
    const controller = new AbortController();
    s.pending = s.card.showMeasurement(
      { axis: "x", a: 1, b: 3 },
      controller.signal,
    );
    controller.abort();
    s.release();
  });
  expect(await page.evaluate(() => (window as any).identities.pending)).toBe(
    false,
  );
  expect((await snapshot(page)).pins.a).toBeNull();
});
