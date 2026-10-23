import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, extra: Record<string, unknown> = {}) {
  await page.goto("/");
  await page.evaluate(async (extra) => {
    const { PlotPanel } = await import("/src/plot.ts");
    const { validateConfig } = await import("/src/config.ts");
    const { makeInterpolator } = await import("/src/math.ts");
    document.body.style.cssText =
      "margin:0;background:white;min-height:3000px;overflow:auto";
    const host = document.createElement("div");
    host.style.width = "900px";
    const toolbar = document.createElement("div");
    document.body.replaceChildren(toolbar, host);
    const s: any = {
      host,
      hover: null,
      changes: 0,
      picks: [],
      pins: { a: 20, b: 80, threshold: 50 },
      events: [],
      config: validateConfig({
        xMin: 0,
        xMax: 100,
        yMin: 0,
        yMax: 100,
        height: 400,
        ...extra,
      }),
    };
    const points = [
      [1, 1],
      [23, 90],
      [100, 100],
    ];
    s.data = [
      {
        run: { id: "r", name: "Irregular" },
        points,
        observations: points,
        count: points.length,
        fn: makeInterpolator(points, "linear"),
      },
    ];
    s.panel = new PlotPanel(
      host,
      (x: number) => s.picks.push(x),
      () => {},
    );
    s.options = {
      mode: "pan",
      axis: "both",
      activePin: "a",
      onPin: (pin: string, value: number) => {
        s.pins[pin] = value;
        s.events.push([pin, value]);
      },
      onHover: (x: number | null) => (s.hover = x),
      onViewChange: () => s.changes++,
    };
    s.configure = (patch: any) => {
      Object.assign(s.options, patch);
      s.panel.configureInteraction(s.options);
    };
    s.configure({});
    s.panel.render(s.data, s.config, s.pins);
    for (const [name, action] of [
      ["Zoom in", () => s.panel.zoom(2)],
      ["Fit", () => s.panel.reset()],
      ["Back", () => s.panel.back()],
      ["Pan right", () => s.panel.pan(0.1, 0)],
    ] as const) {
      const b = document.createElement("button");
      b.textContent = name;
      b.onclick = action;
      toolbar.append(b);
    }
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Coordinate");
    host.append(input);
    (window as any).__nav = s;
  }, extra);
  await expect(page.locator(".u-over")).toBeVisible();
}
const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__nav;
    return {
      view: s.panel.viewport(),
      pins: s.pins,
      hover: s.hover,
      changes: s.changes,
      back: s.panel.canGoBack(),
      picks: s.picks,
      values: [s.data[0].fn.at(s.pins.a), s.data[0].fn.at(s.pins.b)],
      points: s.data[0].points,
    };
  });
async function drag(page: Page, from = [0.5, 0.5], to = [0.7, 0.6]) {
  const box = (await page.locator(".u-over").boundingBox())!;
  await page.mouse.move(
    box.x + box.width * from[0],
    box.y + box.height * from[1],
  );
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], {
    steps: 8,
  });
  await page.mouse.up();
}

test("pan gestures and external API buttons preserve pins and numeric truth; bounded back history", async ({
  page,
}) => {
  await fixture(page);
  const initial = await state(page);
  await drag(page);
  const moved = await state(page);
  expect(moved.view.x[0]).toBeCloseTo(-20, 0);
  expect(moved.view.y[0]).toBeCloseTo(10, 0);
  expect(moved.pins).toEqual(initial.pins);
  expect(moved.values).toEqual(initial.values);
  expect(moved.points).toEqual(initial.points);
  expect(moved.picks).toEqual([]);
  expect(moved.back).toBe(true);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  expect((await state(page)).view).toEqual(initial.view);
  expect((await state(page)).back).toBe(false);
  await page.getByRole("button", { name: "Zoom in" }).click();
  expect((await state(page)).view.x).toEqual([25, 75]);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  expect((await state(page)).view).toEqual(initial.view);
  const count = await page.evaluate(() => {
    const p = (window as any).__nav.panel;
    for (let i = 0; i < 100; i++) p.pan(0.01, 0);
    let count = 0;
    while (p.canGoBack()) {
      p.back();
      count++;
    }
    return count;
  });
  expect(count).toBe(64);
});

test("ordinary wheel scrolls dashboard; Alt-wheel is pointer-anchored and Shift limits x", async ({
  page,
}) => {
  await fixture(page);
  const initial = await state(page),
    box = (await page.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.4);
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  expect((await state(page)).view).toEqual(initial.view);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.4);
  await page.keyboard.down("Alt");
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, -150);
  await page.keyboard.up("Shift");
  await page.keyboard.up("Alt");
  await expect
    .poll(async () => (await state(page)).view.x[0])
    .toBeGreaterThan(0);
  const after = await state(page),
    x = after.view.x;
  expect(x[0] + (x[1] - x[0]) * 0.25).toBeCloseTo(25, 0);
  expect(after.view.y).toEqual(initial.view.y);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("focused keys, editable exclusions, box zoom and Space temporary pan", async ({
  page,
}) => {
  await fixture(page);
  await page.locator(".uplot").focus();
  await page.keyboard.press("+");
  expect((await state(page)).view.x).toEqual([10, 90]);
  await page.keyboard.press("ArrowRight");
  expect((await state(page)).view.x).toEqual([18, 98]);
  await page.keyboard.press("Backspace");
  expect((await state(page)).view.x).toEqual([10, 90]);
  await page.keyboard.press("0");
  expect((await state(page)).view.x).toEqual([0, 100]);
  await page.evaluate(() => {
    const input = document.querySelector("input")!;
    document.querySelector(".uplot")!.append(input);
  });
  await page.getByRole("textbox", { name: "Coordinate" }).fill("123");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("-");
  expect((await state(page)).view.x).toEqual([0, 100]);
  await page.evaluate(() =>
    (window as any).__nav.configure({ mode: "zoom", axis: "x" }),
  );
  await drag(page, [0.25, 0.3], [0.75, 0.7]);
  expect((await state(page)).view.x[0]).toBeCloseTo(25, 0);
  expect((await state(page)).view.y).toEqual([0, 100]);
  await page.keyboard.press("0");
  await page.evaluate(() =>
    (window as any).__nav.configure({ mode: "inspect", axis: "both" }),
  );
  const pins = (await state(page)).pins;
  await page.locator(".uplot").focus();
  await page.keyboard.down("Space");
  await drag(page);
  await page.keyboard.up("Space");
  expect((await state(page)).view.x[0]).toBeCloseTo(-20, 0);
  expect((await state(page)).pins).toEqual(pins);
});

test("inspect places continuous A/B coordinates and drags either nearby pin; threshold uses y", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() =>
    (window as any).__nav.configure({ mode: "inspect", activePin: "b" }),
  );
  await drag(page, [0.2, 0.5], [0.333, 0.5]);
  const a = await state(page);
  expect(a.pins.a).toBeCloseTo(33.3, 0);
  expect(a.pins.b).toBe(80);
  expect(a.picks).toEqual([]);
  expect(a.hover).toBeCloseTo(33.3, 0);
  const box = (await page.locator(".u-over").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.573, box.y + box.height * 0.5);
  expect((await state(page)).pins.b).toBeCloseTo(57.3, 0);
  await page.evaluate(() =>
    (window as any).__nav.configure({ mode: "threshold" }),
  );
  await drag(page, [0.5, 0.5], [0.5, 0.273]);
  expect((await state(page)).pins.threshold).toBeCloseTo(72.7, 0);
  await page.mouse.move(1200, 900);
  expect((await state(page)).hover).toBeNull();
  const before = await state(page);
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  expect((await state(page)).pins).toEqual(before.pins);
  expect((await state(page)).values).toEqual(before.values);
});

for (const kind of ["log", "asinh"] as const)
  test(`${kind} reversed axes pan and zoom in transformed space`, async ({
    page,
  }) => {
    await fixture(page, {
      xScale: kind,
      yScale: kind,
      xMin: kind === "log" ? 1 : -100,
      xMax: 100,
      yMin: kind === "log" ? 1 : -100,
      yMax: 100,
      advanced: {
        scales: { x: { dir: -1, asinh: 3 }, y: { dir: -1, asinh: 3 } },
      },
    });
    const before = await state(page);
    await drag(page, [0.4, 0.4], [0.6, 0.6]);
    const after = await state(page);
    const f = (x: number) => (kind === "log" ? Math.log(x) : Math.asinh(x / 3));
    const span = f(before.view.x[1]) - f(before.view.x[0]);
    expect(f(after.view.x[0]) - f(before.view.x[0])).toBeCloseTo(span * 0.2, 1);
    expect(f(after.view.y[0]) - f(before.view.y[0])).toBeCloseTo(
      -span * 0.2,
      1,
    );
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    const zoom = await state(page);
    expect(f(zoom.view.x[1]) - f(zoom.view.x[0])).toBeCloseTo(span / 2, 8);
    expect(zoom.pins).toEqual(before.pins);
    expect(zoom.values).toEqual(before.values);
  });

test("cancel, resize, rerender, rejection and destroy release gestures without stale handlers", async ({
  page,
}) => {
  await fixture(page, { yScale: "asinh" });
  const initial = await state(page),
    box = (await page.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await state(page)).view).toEqual(initial.view);
  expect((await state(page)).back).toBe(false);
  const result = await page.evaluate(() => {
    const s = (window as any).__nav,
      chart = s.panel.chart;
    try {
      s.panel.render(s.data, { ...s.config, advanced: { hooks: {} } }, s.pins);
    } catch {}
    const rejected = chart === s.panel.chart;
    s.calls = 0;
    const path = chart.series[1].paths;
    chart.series[1].paths = (...args: any[]) => {
      s.calls++;
      return path(...args);
    };
    s.panel.zoom(2);
    s.host.style.width = "700px";
    return rejected;
  });
  expect(result).toBe(true);
  await expect
    .poll(() => page.evaluate(() => (window as any).__nav.calls))
    .toBeGreaterThan(1);
  const end = await page.evaluate(() => {
    const s = (window as any).__nav;
    s.panel.render(s.data, s.config, s.pins);
    const view = s.panel.viewport();
    s.panel.destroy();
    s.panel.zoom(2);
    s.panel.pan(1, 1);
    s.panel.back();
    return {
      view,
      after: s.panel.viewport(),
      nodes: s.host.childElementCount,
      pins: s.pins,
    };
  });
  expect(end.view).toEqual(initial.view);
  expect(end.after).toBeNull();
  expect(end.nodes).toBe(0);
  expect(end.pins).toEqual(initial.pins);
});

test("pointer capture survives leaving the plot, cancellation rolls back, and late configuration works", async ({
  page,
}) => {
  await fixture(page);
  const initial = await state(page),
    box = (await page.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 50, box.y + box.height / 2, {
    steps: 5,
  });
  expect((await state(page)).view.x[0]).toBeLessThan(-40);
  expect((await state(page)).hover).toBeNull();
  await page
    .locator(".u-over")
    .dispatchEvent("pointercancel", { pointerId: 1, isPrimary: true });
  await page.mouse.up();
  expect((await state(page)).view).toEqual(initial.view);
  expect((await state(page)).back).toBe(false);
  await page.evaluate(async () => {
    const s = (window as any).__nav,
      { PlotPanel } = await import("/src/plot.ts");
    s.panel.destroy();
    s.panel = new PlotPanel(
      s.host,
      (x: number) => s.picks.push(x),
      () => {},
    );
    s.panel.render(s.data, s.config, s.pins);
    s.configure({ mode: "pan" });
  });
  await drag(page);
  expect((await state(page)).view.x[0]).toBeCloseTo(-20, 0);
  expect((await state(page)).picks).toEqual([]);
});

test("editable controls inside the plot do not consume navigation keys", async ({
  page,
}) => {
  await fixture(page);
  const initial = await state(page);
  const result = await page.evaluate(() => {
    const root = document.querySelector(".uplot")!;
    return ["input", "select", "textarea", "div"].map((tag) => {
      const el = document.createElement(tag);
      if (tag === "div") el.contentEditable = "true";
      root.append(el);
      const event = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      const prevented = event.defaultPrevented;
      el.remove();
      return prevented;
    });
  });
  expect(result).toEqual([false, false, false, false]);
  expect((await state(page)).view).toEqual(initial.view);
});
