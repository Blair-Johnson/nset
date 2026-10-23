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
      onHorizontalPin: (pin: string, value: number) => {
        s.pins[pin === "a" ? "yA" : "yB"] = value;
        s.events.push([`horizontal-${pin}`, value]);
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
      values: [s.pins.a, s.pins.b].map((value) =>
        value == null ? null : s.data[0].fn.at(value),
      ),
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

async function directFixture(page: Page, extra: Record<string, unknown> = {}) {
  await fixture(page, extra);
  await page.evaluate(() =>
    (window as any).__nav.configure({
      mode: "zoom",
      axis: "both",
      directGestures: true,
      inferZoomAxes: true,
    }),
  );
}

for (const [name, dx, dy, axis] of [
  ["horizontal exactly at tolerance", 240, 12, "x"],
  ["vertical exactly at tolerance", 12, 120, "y"],
  ["diagonal beyond tolerance", 240, 13, "both"],
  ["reverse horizontal", -240, -11, "x"],
  ["reverse vertical", -11, -110, "y"],
] as const)
  test(`direct zoom ${name}: preview and release agree`, async ({ page }) => {
    await directFixture(page);
    const before = await state(page);
    const box = (await page.locator(".u-over").boundingBox())!;
    const x = box.x + box.width * 0.5,
      y = box.y + box.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    const selection = await page.locator(".u-select").evaluate((el) => {
      const r = el.getBoundingClientRect(),
        css = getComputedStyle(el);
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        border: css.borderTopColor,
        borderWidth: css.borderTopWidth,
        fill: css.backgroundColor,
      };
    });
    expect(selection.width).toBeCloseTo(
      axis === "y" ? box.width : Math.abs(dx),
      0,
    );
    expect(selection.height).toBeCloseTo(
      axis === "x" ? box.height : Math.abs(dy),
      0,
    );
    expect(selection.x).toBeCloseTo(
      axis === "y" ? box.x : Math.min(x, x + dx),
      0,
    );
    expect(selection.y).toBeCloseTo(
      axis === "x" ? box.y : Math.min(y, y + dy),
      0,
    );
    expect(selection.border).toBe("rgb(117, 189, 255)");
    expect(selection.borderWidth).toBe("2px");
    expect(selection.fill).toBe("rgba(115, 190, 255, 0.22)");
    await page.mouse.up();
    const after = await state(page);
    for (const [key, span, pixels] of [
      ["x", box.width, dx],
      ["y", box.height, dy],
    ] as const) {
      if ((axis === "x" && key === "y") || (axis === "y" && key === "x"))
        expect(after.view[key]).toEqual(before.view[key]);
      else
        expect(after.view[key][1] - after.view[key][0]).toBeCloseTo(
          (100 * Math.abs(pixels)) / span,
          0,
        );
    }
    expect(after.pins).toEqual(before.pins);
    await page.keyboard.press("Backspace");
    expect((await state(page)).view).toEqual(before.view);
    expect((await state(page)).back).toBe(false);
  });

test("tiny direct clicks, cancelled selection and lost capture create no history", async ({
  page,
}) => {
  await directFixture(page);
  const before = await state(page);
  const box = (await page.locator(".u-over").boundingBox())!;
  const x = box.x + box.width * 0.5,
    y = box.y + box.height * 0.5;
  await page.mouse.click(x, y);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 2, y + 2);
  await page.mouse.up();
  expect((await state(page)).view).toEqual(before.view);
  for (const cancel of [
    "escape",
    "pointercancel",
    "blur",
    "lostpointercapture",
  ]) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 170, y + 70);
    if (cancel === "escape") await page.keyboard.press("Escape");
    else if (cancel === "blur")
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else
      await page
        .locator(".u-over")
        .dispatchEvent(cancel, { pointerId: 1, isPrimary: true });
    await page.mouse.up();
    expect((await state(page)).view).toEqual(before.view);
    expect((await state(page)).back).toBe(false);
    expect(
      await page
        .locator(".u-select")
        .evaluate((el) => (el as HTMLElement).style.width),
    ).toBe("0px");
  }
});

for (const mechanism of ["right", "space"] as const)
  test(`${mechanism} pan clears hover until fresh movement, keeps pins, and records one history step`, async ({
    page,
  }) => {
    await directFixture(page);
    const before = await state(page);
    const box = (await page.locator(".u-over").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    expect((await state(page)).hover).not.toBeNull();
    if (mechanism === "space") {
      // No preliminary plot focus/click: Space is held before pointerdown.
      await page.keyboard.down("Space");
    }
    const button = mechanism === "right" ? "right" : "left";
    await page.mouse.down({ button });
    const hidden = () =>
      page
        .locator(".u-cursor-x, .u-cursor-y, .u-cursor-pt")
        .evaluateAll(
          (nodes) =>
            nodes.length > 0 &&
            nodes.every((el) => getComputedStyle(el).visibility === "hidden"),
        );
    expect(await hidden()).toBe(true);
    expect((await state(page)).hover).toBeNull();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, {
      steps: 8,
    });
    expect(await hidden()).toBe(true);
    expect((await state(page)).hover).toBeNull();
    await page.mouse.up({ button });
    if (mechanism === "space") await page.keyboard.up("Space");
    expect((await state(page)).hover).toBeNull();
    expect(await hidden()).toBe(true);
    const after = await state(page);
    expect(after.view.x[0]).toBeCloseTo(-20, 0);
    expect(after.view.y[0]).toBeCloseTo(10, 0);
    expect(after.pins).toEqual(before.pins);
    expect(after.values).toEqual(before.values);
    const cursor = await page.evaluate(() => {
      const { left, top } = (window as any).__nav.panel.chart.cursor;
      return { left, top };
    });
    expect(cursor.left).toBeLessThan(0);
    expect(cursor.top).toBeLessThan(0);
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
    expect(await hidden()).toBe(false);
    expect((await state(page)).hover).not.toBeNull();
    await page.keyboard.press("Backspace");
    expect((await state(page)).view).toEqual(before.view);
    expect((await state(page)).back).toBe(false);
  });

test("right pan context menu suppression is plot-local and legacy mode remains native", async ({
  page,
}) => {
  await directFixture(page);
  const prevented = () =>
    page.evaluate(() =>
      [document.querySelector(".u-over")!, document.body].map((el) => {
        const e = new MouseEvent("contextmenu", {
          button: 2,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      }),
    );
  expect(await prevented()).toEqual([true, false]);
  await page.evaluate(() =>
    (window as any).__nav.configure({ directGestures: false }),
  );
  expect(await prevented()).toEqual([false, false]);
});

test("direct dragging prioritizes vertical and horizontal comparisons over zoom; armed y placement is one-shot", async ({
  page,
}) => {
  await directFixture(page);
  const before = await state(page);
  await drag(page, [0.2, 0.5], [0.33, 0.55]);
  expect((await state(page)).pins.a).toBeCloseTo(33, 0);
  expect((await state(page)).view).toEqual(before.view);
  expect((await state(page)).back).toBe(false);
  await page.evaluate(() =>
    (window as any).__nav.configure({
      mode: "inspect",
      cursorAxis: "y",
      activePin: "b",
    }),
  );
  const box = (await page.locator(".u-over").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.27);
  expect((await state(page)).pins.yB).toBeCloseTo(73, 0);
  const events = await page.evaluate(() => (window as any).__nav.events);
  expect(events.at(-1)[0]).toBe("horizontal-b");
  await drag(page, [0.5, 0.27], [0.57, 0.4]);
  expect((await state(page)).pins.yB).toBeCloseTo(60, 0);
  expect((await state(page)).view).toEqual(before.view);
  const pins = (await state(page)).pins;
  await drag(page, [0.5, 0.6], [0.7, 0.8]);
  expect((await state(page)).view.x[0]).toBeCloseTo(50, 0);
  expect((await state(page)).pins).toEqual(pins);
});

for (const kind of ["log", "asinh"] as const)
  test(`direct inferred ${kind} reversed zoom and right pan preserve transformed coordinates`, async ({
    page,
  }) => {
    await directFixture(page, {
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
    // Remove fixture pins so this case measures selection, not proximity capture.
    await page.evaluate(() => {
      const s = (window as any).__nav;
      s.pins = { a: null, b: null, threshold: null };
      s.panel.setPins(s.pins);
    });
    const before = await state(page),
      box = (await page.locator(".u-over").boundingBox())!;
    const f = (x: number) => (kind === "log" ? Math.log(x) : Math.asinh(x / 3));
    const span = f(before.view.x[1]) - f(before.view.x[0]);
    await drag(page, [0.25, 0.5], [0.75, 0.5]);
    const zoomed = await state(page);
    expect(f(zoomed.view.x[1]) - f(zoomed.view.x[0])).toBeCloseTo(
      span * 0.5,
      1,
    );
    expect(f(zoomed.view.x[0])).toBeCloseTo(
      f(before.view.x[0]) + span * 0.25,
      1,
    );
    expect(zoomed.view.y).toEqual(before.view.y);
    await page.keyboard.press("Backspace");
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, {
      steps: 8,
    });
    await page.mouse.up({ button: "right" });
    const panned = await state(page);
    expect(f(panned.view.x[0]) - f(before.view.x[0])).toBeCloseTo(
      span * 0.2,
      1,
    );
    expect(f(panned.view.y[0]) - f(before.view.y[0])).toBeCloseTo(
      -span * 0.2,
      1,
    );
    await page.keyboard.press("Backspace");
    expect((await state(page)).view).toEqual(before.view);
    expect((await state(page)).back).toBe(false);
  });

test("blue selection border and translucent fill survive decoded screenshot pixels", async ({
  page,
}, testInfo) => {
  await directFixture(page);
  const box = (await page.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
    steps: 6,
  });
  const png = await page
    .locator(".u-over")
    .screenshot({ path: testInfo.outputPath("blue-selection.png") });
  await testInfo.attach("blue-selection", {
    body: png,
    contentType: "image/png",
  });
  const pixels = await page.evaluate(async (encoded) => {
    const img = new Image();
    img.src = `data:image/png;base64,${encoded}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    let border = 0,
      fill = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i] - 117) <= 2 &&
        Math.abs(data[i + 1] - 189) <= 2 &&
        Math.abs(data[i + 2] - 255) <= 2
      )
        border++;
      if (
        data[i + 2] > data[i] + 15 &&
        data[i + 2] > data[i + 1] + 5 &&
        data[i] > 150
      )
        fill++;
    }
    return { border, fill };
  }, png.toString("base64"));
  expect(pixels.border).toBeGreaterThan(200);
  expect(pixels.fill).toBeGreaterThan(1000);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await state(page)).back).toBe(false);
});

for (const cancellation of [
  "Escape",
  "pointercancel",
  "configure",
  "resize",
] as const)
  test(`direct right-pan ${cancellation} rolls back without history or stale hover`, async ({
    page,
  }) => {
    await directFixture(page);
    const initial = await state(page),
      box = (await page.locator(".u-over").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width + 50, box.y + box.height * 0.7, {
      steps: 5,
    });
    expect((await state(page)).view).not.toEqual(initial.view);
    expect((await state(page)).hover).toBeNull();
    if (cancellation === "Escape") await page.keyboard.press("Escape");
    else if (cancellation === "pointercancel")
      await page
        .locator(".u-over")
        .dispatchEvent("pointercancel", { pointerId: 1, isPrimary: true });
    else if (cancellation === "configure")
      await page.evaluate(() =>
        (window as any).__nav.configure({ activePin: "b" }),
      );
    else {
      await page.evaluate(
        () => ((window as any).__nav.host.style.width = "700px"),
      );
      await expect
        .poll(async () => (await state(page)).view.x)
        .toEqual(initial.view.x);
    }
    await page.mouse.up({ button: "right" });
    expect((await state(page)).view).toEqual(initial.view);
    expect((await state(page)).back).toBe(false);
    expect((await state(page)).pins).toEqual(initial.pins);
    expect((await state(page)).hover).toBeNull();
    expect(
      await page
        .locator(".u-cursor-x")
        .evaluate((el) => getComputedStyle(el).visibility),
    ).toBe("hidden");
  });

test("both horizontal pins drag in ordinary zoom and right-pan overrides pin proximity", async ({
  page,
}) => {
  await directFixture(page);
  await page.evaluate(() => {
    const s = (window as any).__nav;
    s.pins = { ...s.pins, yA: 25, yB: 75 };
    s.panel.setPins(s.pins);
  });
  const initial = await state(page);
  await drag(page, [0.5, 0.75], [0.6, 0.65]);
  expect((await state(page)).pins.yA).toBeCloseTo(35, 0);
  await drag(page, [0.5, 0.25], [0.6, 0.35]);
  expect((await state(page)).pins.yB).toBeCloseTo(65, 0);
  expect((await state(page)).pins.a).toEqual(initial.pins.a);
  expect((await state(page)).pins.b).toEqual(initial.pins.b);
  expect((await state(page)).view).toEqual(initial.view);
  expect((await state(page)).back).toBe(false);
  const pins = (await state(page)).pins,
    box = (await page.locator(".u-over").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.65);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5, {
    steps: 5,
  });
  await page.mouse.up({ button: "right" });
  expect((await state(page)).pins).toEqual(pins);
  expect((await state(page)).view.x[0]).toBeCloseTo(-20, 0);
});

test("selection border is absent at rest and clears after release cancel and pan", async ({
  page,
}, info) => {
  await directFixture(page);
  const selection = page.locator(".u-select");
  await expect(selection).toHaveCSS("visibility", "hidden");
  await page
    .locator(".u-over")
    .screenshot({ path: info.outputPath("idle-no-blue-box.png") });
  const box = (await page.locator(".u-over").boundingBox())!;
  const start = async () => {
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3);
    await page.mouse.down();
    await expect(selection).toHaveCSS("visibility", "hidden");
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
      steps: 5,
    });
    await expect(selection).toHaveCSS("visibility", "visible");
  };
  await start();
  await page.mouse.up();
  await expect(selection).toHaveCSS("visibility", "hidden");
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await start();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(selection).toHaveCSS("visibility", "hidden");
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, {
    steps: 5,
  });
  await expect(selection).toHaveCSS("visibility", "hidden");
  await page.mouse.up({ button: "right" });
  await expect(selection).toHaveCSS("visibility", "hidden");
});
