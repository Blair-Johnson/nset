import { expect, test, type Page } from "@playwright/test";

const pane = (page: Page) =>
  page.getByRole("complementary", { name: "Chart details" });
const handle = (page: Page) =>
  page.getByRole("separator", { name: "Resize chart details" });
const emptyPins = { a: null, b: null, threshold: null, yA: null, yB: null };

async function fixture(page: Page, delayed = false) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><main id="main"><div id="chart"></div></main></body></html>',
    }),
  );
  await page.goto("/");
  await page.evaluate(async (delayed) => {
    await import("/src/style.css");
    const { ChartCard } = await import("/src/cards.ts");
    const { ChartDetailsPanel } = await import("/src/chart-details.ts");
    const { newChart } = await import("/src/workspace.ts");
    const state: any = { signals: [], pending: [], loads: 0 };
    const ready = new Promise<void>((resolve) => {
      state.release = resolve;
    });
    if (!delayed) state.release();
    const runs = ["a", "b"].map((id) => ({
      id,
      name: id,
      experiment_id: "e",
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
    }));
    const context = {
      api: {},
      selectedRunIds: ["a"],
      catalog: {
        experiments: [],
        runs,
        series: runs.map((run) => ({
          run_id: run.id,
          key: "loss",
          kind: "metric",
          count: 3,
          last_step: 2,
          last_timestamp: 2000,
          last_value: 2,
        })),
      },
      store: {
        clear() {},
        async load() {
          state.loads++;
          await ready;
          return [0, 1, 2].map((value) => ({
            seq: value + 1,
            step: value,
            timestamp: value * 1000,
            value,
          }));
        },
      },
    };
    const chart = newChart("timeseries", ["loss"], "Lifecycle fixture");
    chart.layout = { width: 660, height: 450 };
    chart.details = {
      markdown:
        "[Inspect interval](measurement:interval) and [Inspect level](measurement:level).",
      measurements: {
        interval: { axis: "x", a: 0, b: 2 },
        level: { axis: "y", a: 1 },
      },
    };
    state.input = { workspaceId: "lifecycle", chart, context };
    state.panel = new ChartDetailsPanel({
      onClose() {
        state.card.setDetailsOpen(false);
      },
      onMeasure(_workspace, _card, measurement, signal) {
        state.signals.push(signal);
        const pending = state.card.showMeasurement(measurement, signal);
        state.pending.push(pending);
        return pending;
      },
    });
    const host = document.getElementById("chart")!;
    state.card = new ChartCard(host, chart, context, {
      onEdit() {},
      onRemove() {},
      onMove() {},
      onDuplicate() {},
      onResize() {},
      onDetails() {
        state.panel.open(state.input);
        state.card.setDetailsOpen(true);
      },
    });
    (window as any).lifecycle = state;
  }, delayed);
  await page
    .getByRole("button", { name: "Chart details", exact: true })
    .click();
  await expect(pane(page)).toBeVisible();
  await page.evaluate(() => {
    const s = (window as any).lifecycle;
    s.status = document.querySelector(".chart-details-status");
    s.separator = document.querySelector(".chart-details-resizer");
    s.separator.addEventListener("pointerdown", (event: PointerEvent) => {
      s.pointer = event.pointerId;
    });
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).lifecycle.loads))
    .toBeGreaterThan(0);
  if (!delayed) await expect(page.locator(".u-over")).toBeVisible();
}

async function measure(page: Page, name: string, count: number) {
  await pane(page).getByRole("button", { name }).click();
  await expect.poll(() => signals(page)).toHaveLength(count);
}
const signals = (page: Page) =>
  page.evaluate(() =>
    (window as any).lifecycle.signals.map((s: AbortSignal) => s.aborted),
  );

async function release(page: Page) {
  return page.evaluate(async () => {
    const s = (window as any).lifecycle;
    s.release();
    return Promise.all(s.pending);
  });
}

for (const change of ["close", "details", "source"] as const) {
  test(`measurement aborted on ${change}`, async ({ page }) => {
    await fixture(page, true);
    const initialPins = await page.evaluate(
      () => (window as any).lifecycle.card.pins,
    );
    await measure(page, "Inspect interval", 1);
    await expect(pane(page).getByRole("status")).toHaveText(
      "Placing measurement…",
    );
    await page.evaluate((change) => {
      const s = (window as any).lifecycle;
      if (change === "close") s.panel.close();
      else {
        const chart = structuredClone(s.input.chart);
        if (change === "details") chart.details.markdown = "Replacement report";
        else
          chart.source = {
            mode: "explicit",
            series: [{ runId: "b", key: "loss", kind: "metric" }],
          };
        // Keep the card unchanged: its own source revision must not mask missing signal wiring.
        s.panel.update({ ...s.input, chart });
      }
    }, change);
    expect(await signals(page)).toEqual([true]);
    expect(await release(page)).toEqual([false]);
    expect(
      await page.evaluate(() => ({
        pins: (window as any).lifecycle.card.pins,
        status: (window as any).lifecycle.status.textContent,
      })),
    ).toEqual({ pins: initialPins, status: "" });
    await expect(page.locator(".card-inspection")).toBeHidden();
    if (change === "close") await expect(pane(page)).toHaveCount(0);
  });
}

test("newer measurement alone supplies pins and status", async ({ page }) => {
  await fixture(page, true);
  await measure(page, "Inspect interval", 1);
  await measure(page, "Inspect level", 2);
  expect(await signals(page)).toEqual([true, false]);
  expect(await release(page)).toEqual([false, true]);
  expect(
    await page.evaluate(() => (window as any).lifecycle.card.pins),
  ).toEqual({ ...emptyPins, yA: 1 });
  await expect(pane(page).getByRole("status")).toHaveText(
    "Measurement shown on chart.",
  );
});

for (const interruption of [
  "pointercancel",
  "lostpointercapture",
  "blur",
  "window-blur",
  "close",
] as const) {
  test(`resize interruption: ${interruption}`, async ({ page }) => {
    await fixture(page);
    const initial = await handle(page).getAttribute("aria-valuenow");
    const bounds = (await handle(page).boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30);
    await page.mouse.down();
    await page.mouse.move(bounds.x - 80, bounds.y + 30);
    await expect(page.locator("body")).toHaveClass(/chart-details-resizing/);
    await expect(handle(page)).not.toHaveAttribute("aria-valuenow", initial!);
    expect(
      await page.evaluate(() => {
        const s = (window as any).lifecycle;
        return s.separator.hasPointerCapture(s.pointer);
      }),
    ).toBe(true);
    await page.evaluate((interruption) => {
      const s = (window as any).lifecycle;
      if (interruption === "close") s.panel.close();
      else if (interruption === "blur") s.separator.blur();
      else if (interruption === "window-blur")
        window.dispatchEvent(new Event("blur"));
      else if (interruption === "lostpointercapture")
        s.separator.releasePointerCapture(s.pointer);
      else
        s.separator.dispatchEvent(
          new PointerEvent("pointercancel", { pointerId: s.pointer }),
        );
    }, interruption);
    // Deliver native lostpointercapture before mouseup could accidentally commit the drag.
    await page.mouse.move(bounds.x - 90, bounds.y + 30);
    await expect(page.locator("body")).not.toHaveClass(
      /chart-details-resizing/,
    );
    expect(
      await page.evaluate(() => {
        const s = (window as any).lifecycle;
        return {
          captured: s.separator.hasPointerCapture(s.pointer),
          width: s.separator.getAttribute("aria-valuenow"),
          saved: localStorage.getItem("nset:chart-details-width:v1"),
        };
      }),
    ).toEqual({ captured: false, width: initial, saved: null });
    await page.mouse.up();
    if (interruption === "close") {
      await expect(pane(page)).toHaveCount(0);
      await expect(page.locator("body")).not.toHaveClass(/has-chart-details/);
      const style = await page.locator("body").getAttribute("style");
      expect(style).not.toContain("--chart-details-width");
    }
  });
}

test("Home and End enforce advertised bounds", async ({ page }) => {
  await fixture(page);
  await handle(page).focus();
  for (const [key, attribute, outward] of [
    ["Home", "aria-valuemin", "ArrowRight"],
    ["End", "aria-valuemax", "ArrowLeft"],
  ]) {
    await page.keyboard.press(key);
    const limit = (await handle(page).getAttribute(attribute))!;
    await expect(handle(page)).toHaveAttribute("aria-valuenow", limit);
    expect((await pane(page).boundingBox())!.width).toBe(Number(limit));
    await page.keyboard.press(outward);
    await expect(handle(page)).toHaveAttribute("aria-valuenow", limit);
  }
});

test("wide and narrow maximized layouts remain operable", async ({ page }) => {
  await fixture(page);
  for (const maximized of [false, true]) {
    if (maximized)
      await page
        .getByRole("button", { name: "Maximize chart", exact: true })
        .click();
    const chart = (await page.locator(".chart-card").boundingBox())!;
    const details = (await pane(page).boundingBox())!;
    expect(chart.x + chart.width).toBeLessThanOrEqual(details.x);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(handle(page)).toBeHidden();
  const chart = (await page.locator(".chart-card").boundingBox())!;
  const details = (await pane(page).boundingBox())!;
  expect(details.y).toBeGreaterThanOrEqual(chart.y + chart.height);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(391);
  const inspect = pane(page).getByRole("button", { name: "Inspect level" });
  await inspect.scrollIntoViewIfNeeded();
  await expect(inspect).toBeInViewport();
  await inspect.click();
  await expect(pane(page).getByRole("status")).toHaveText(
    "Measurement shown on chart.",
  );
  const restore = page.getByRole("button", {
    name: "Restore chart",
    exact: true,
  });
  await restore.scrollIntoViewIfNeeded();
  await expect(restore).toBeInViewport();
  await restore.click();
  await expect(page.locator(".card-maximized")).toHaveCount(0);
  await pane(page).getByRole("button", { name: "Close chart details" }).click();
  await expect(pane(page)).toHaveCount(0);
});
