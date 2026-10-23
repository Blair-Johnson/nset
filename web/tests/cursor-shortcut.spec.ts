import { writeFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";

// Isolated composition contract: use real PlotPanels, and reconfigure in the
// callback exactly as ChartCard does (no production cards.ts changes here).
async function fixture(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const { PlotPanel } = await import("/src/plot.ts");
    const { validateConfig } = await import("/src/config.ts");
    const { makeInterpolator } = await import("/src/math.ts");
    const { nextCursorPlacement } = await import("/src/cursor-placement.ts");
    document.body.replaceChildren();
    document.body.style.cssText =
      "margin:0;padding:24px;min-height:1500px;overflow:auto";
    const fields = document.createElement("div");
    fields.innerHTML = `<input aria-label="Input"><textarea aria-label="Textarea"></textarea><select aria-label="Select"><option>Choice</option></select><div contenteditable="true" aria-label="Editable"><span>Text</span></div><button>Outside</button>`;
    document.body.append(fields);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:24px;margin-top:24px";
    document.body.append(row);
    const panels: any[] = [];
    for (let index = 0; index < 2; index++) {
      const host = document.createElement("div");
      host.id = `plot-${index}`;
      host.style.cssText = "width:650px;background:var(--canvas)";
      row.append(host);
      const points = [
        [0, 10],
        [40, 90],
        [100, 30],
      ];
      const s: any = {
        host,
        cycles: 0,
        hover: null,
        picks: [],
        events: [],
        pins: { a: 20, b: 80, yA: 20, yB: 80, threshold: null },
        config: validateConfig({
          xMin: 0,
          xMax: 100,
          yMin: 0,
          yMax: 100,
          height: 360,
        }),
        data: [
          {
            run: { id: `r${index}`, name: `Series ${index}` },
            points,
            observations: points,
            count: points.length,
            fn: makeInterpolator(points, "linear"),
          },
        ],
      };
      s.options = {
        mode: "zoom",
        axis: "both",
        directGestures: true,
        inferZoomAxes: true,
        cursorAxis: "x",
        activePin: "a",
        onCursorModeCycle: () => {
          s.cycles++;
          s.configure(nextCursorPlacement(s.options));
        },
        onPin: (pin: string, value: number) => {
          s.pins[pin] = value;
          s.events.push([pin, value]);
        },
        onHorizontalPin: (pin: string, value: number) => {
          const name = pin === "a" ? "yA" : "yB";
          s.pins[name] = value;
          s.events.push([name, value]);
        },
        onPlacementComplete: (pin: string) => {
          const first = pin === "a" || pin === "yA";
          s.configure({
            mode: first ? "inspect" : "zoom",
            activePin: first ? "b" : s.options.activePin,
          });
        },
        onHover: (x: number | null) => (s.hover = x),
      };
      s.configure = (patch: any) => {
        Object.assign(s.options, patch);
        s.panel.configureInteraction(s.options);
      };
      s.mount = () => {
        s.panel = new PlotPanel(
          host,
          (x: number) => s.picks.push(x),
          () => {},
        );
        s.configure({});
        s.panel.render(s.data, s.config, s.pins);
      };
      s.mount();
      panels.push(s);
    }
    (window as any).__cursor = panels;
  });
  await expect(page.locator(".u-over")).toHaveCount(2);
  await expect(page.locator("#plot-0 .uplot")).toHaveAttribute(
    "data-cursor-placement",
    "off",
  );
}
const root = (page: Page, index = 0) => page.locator(`#plot-${index} .uplot`);
const state = (page: Page, index = 0) =>
  page.evaluate((index) => {
    const s = (window as any).__cursor[index];
    return {
      cycles: s.cycles,
      mode: s.options.mode,
      axis: s.options.cursorAxis,
      activePin: s.options.activePin,
      pins: s.pins,
      events: s.events,
      picks: s.picks,
      view: s.panel.viewport(),
      hover: s.hover,
    };
  }, index);
async function pointer(page: Page, x = 0.45, y = 0.55, index = 0) {
  const box = (await page.locator(`#plot-${index} .u-over`).boundingBox())!;
  await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
}
async function click(page: Page, x: number, y: number) {
  await pointer(page, x, y);
  await page.mouse.down();
  await page.mouse.up();
}
async function configure(
  page: Page,
  patch: Record<string, unknown>,
  index = 0,
) {
  await page.evaluate(
    ({ patch, index }) => (window as any).__cursor[index].configure(patch),
    { patch, index },
  );
}
async function styles(page: Page) {
  return page.locator("#plot-0 .uplot").evaluate((el) => {
    const read = (
      selector: string,
      border: "borderRightColor" | "borderBottomColor",
    ) => {
      const line = el.querySelector(selector)!;
      const css = getComputedStyle(line),
        box = line.getBoundingClientRect();
      return {
        color: css[border],
        opacity: Number(css.opacity),
        visibility: css.visibility,
        width: box.width,
        height: box.height,
        weight:
          border === "borderRightColor"
            ? css.borderRightWidth
            : css.borderBottomWidth,
      };
    };
    return {
      vertical: read(".u-cursor-x", "borderRightColor"),
      horizontal: read(".u-cursor-y", "borderBottomColor"),
    };
  });
}
async function pinPixels(page: Page) {
  return page
    .locator("#plot-0 canvas")
    .evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      const counts = { a: 0, b: 0 };
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] === 125 && pixels[i + 1] === 211 && pixels[i + 2] === 252)
          counts.a++;
        if (pixels[i] === 216 && pixels[i + 1] === 180 && pixels[i + 2] === 254)
          counts.b++;
      }
      return counts;
    });
}

test("C follows pointer over one plot, never focus, axes, or stale cursor axis", async ({
  page,
}) => {
  await fixture(page);
  const initial = await state(page);
  await root(page).focus();
  await page.mouse.move(1490, 1000);
  await page.keyboard.press("c");
  expect((await state(page)).cycles).toBe(0);
  // Focus remains on plot 0 while only plot 1 receives the shortcut.
  await pointer(page, 0.45, 0.55, 1);
  await page.keyboard.press("c");
  await expect(root(page, 1)).toHaveAttribute(
    "data-cursor-placement",
    "vertical",
  );
  await expect(root(page)).toBeFocused();
  expect((await state(page)).cycles).toBe(0);
  expect((await state(page, 1)).cycles).toBe(1);
  await pointer(page);
  await page.keyboard.press("c");
  await expect(root(page)).toHaveAttribute("data-cursor-placement", "vertical");
  await page.keyboard.press("c");
  await expect(root(page)).toHaveAttribute(
    "data-cursor-placement",
    "horizontal",
  );
  await page.keyboard.press("c");
  await expect(root(page)).toHaveAttribute("data-cursor-placement", "off");
  expect(await state(page)).toMatchObject({
    cycles: 3,
    pins: initial.pins,
    view: initial.view,
    activePin: "a",
  });
  // OFF retains y, but the next C must start vertical rather than horizontal.
  await page.keyboard.press("c");
  expect(await state(page)).toMatchObject({
    cycles: 4,
    axis: "x",
    mode: "inspect",
  });
  // An axis is part of the plot root, not the scalar plotting area.
  await page.locator("#plot-0 .u-axis").first().hover();
  await page.keyboard.press("c");
  expect((await state(page)).cycles).toBe(4);
  // No plot focus is necessary and the shortcut must not steal it.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await pointer(page, 0.5, 0.5, 1);
  await page.keyboard.press("c");
  expect((await state(page, 1)).cycles).toBe(2);
  await expect(root(page, 1)).not.toBeFocused();
});

test("typing, modifiers, IME, repeat, and prevented events are not intercepted", async ({
  page,
}) => {
  await fixture(page);
  for (const selector of ["input", "textarea", "select", "[contenteditable]"]) {
    await page.locator(selector).first().focus();
    await pointer(page);
    await page.keyboard.press("c");
    expect((await state(page)).cycles).toBe(0);
    await expect(page.locator(selector).first()).toBeFocused();
  }
  await expect(page.locator("input")).toHaveValue("c");
  await expect(page.locator("textarea")).toHaveValue("c");
  await expect(page.locator("[contenteditable]")).toContainText("c");
  await root(page).focus();
  for (const key of ["Control+c", "Meta+c", "Alt+c"])
    await page.keyboard.press(key);
  expect((await state(page)).cycles).toBe(0);
  for (const extra of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
  ]) {
    const prevented = await root(page).evaluate((el, extra) => {
      const e = new KeyboardEvent("keydown", {
        key: "c",
        bubbles: true,
        cancelable: true,
        ...extra,
      });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    }, extra);
    expect(prevented).toBe(false);
  }
  await root(page).evaluate((el) => {
    const e = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    e.preventDefault();
    el.dispatchEvent(e);
  });
  expect((await state(page)).cycles).toBe(0);
  await page.keyboard.down("c");
  await page.keyboard.down("c"); // Real browser repeat while held.
  await page.keyboard.up("c");
  expect((await state(page)).cycles).toBe(1);
  await page.keyboard.press("Shift+c");
  expect((await state(page)).cycles).toBe(2);
});

test("actual A/B placement completes to OFF; mode cycling preserves both pairs", async ({
  page,
}) => {
  await fixture(page);
  const initial = await state(page);
  await pointer(page);
  await page.keyboard.press("c");
  await click(page, 0.35, 0.5);
  expect(await state(page)).toMatchObject({ mode: "inspect", activePin: "b" });
  await page.keyboard.press("c"); // Switching orientation restarts at A.
  expect(await state(page)).toMatchObject({ axis: "y", activePin: "a" });
  await click(page, 0.5, 0.35);
  expect(await state(page)).toMatchObject({ mode: "inspect", activePin: "b" });
  await click(page, 0.55, 0.65);
  await expect(root(page)).toHaveAttribute("data-cursor-placement", "off");
  const completed = await state(page);
  expect(completed.axis).toBe("y");
  expect(completed.pins.a).not.toEqual(initial.pins.a);
  expect(completed.pins.b).toEqual(initial.pins.b);
  expect(completed.pins.yA).not.toEqual(initial.pins.yA);
  expect(completed.pins.yB).not.toEqual(initial.pins.yB);
  expect(completed.events.map((e: any[]) => e[0])).toEqual(["a", "yA", "yB"]);
  expect(completed.picks).toEqual([]);
  await click(page, 0.65, 0.5); // Ordinary click while OFF cannot place anything.
  expect((await state(page)).pins).toEqual(completed.pins);
  await page.keyboard.press("c");
  expect(await state(page)).toMatchObject({
    mode: "inspect",
    axis: "x",
    activePin: "a",
    pins: completed.pins,
  });
  await click(page, 0.4, 0.5);
  await click(page, 0.7, 0.5);
  await expect(root(page)).toHaveAttribute("data-cursor-placement", "off");
  expect((await state(page)).events.map((e: any[]) => e[0])).toEqual([
    "a",
    "yA",
    "yB",
    "a",
    "b",
  ]);
});

test("zoom and right/Space pan stay available in all modes; held gestures reject C", async ({
  page,
}) => {
  await fixture(page);
  const initial = await state(page);
  for (const patch of [
    { mode: "inspect", cursorAxis: "x" },
    { mode: "inspect", cursorAxis: "y" },
    { mode: "zoom" },
  ]) {
    await configure(page, patch);
    await pointer(page, 0.35, 0.35);
    await page.mouse.down();
    await page.keyboard.press("c");
    await pointer(page, 0.65, 0.65);
    await page.mouse.up();
    expect((await state(page)).view).not.toEqual(initial.view);
    expect((await state(page)).cycles).toBe(0);
    expect((await state(page)).pins).toEqual(initial.pins);
    await page.evaluate(() => (window as any).__cursor[0].panel.reset());
    for (const space of [false, true]) {
      await pointer(page, 0.45, 0.45);
      if (space) {
        await page.keyboard.down("Space");
        await page.keyboard.press("c"); // Holding the pan modifier also blocks cycling.
      }
      await page.mouse.down({ button: space ? "left" : "right" });
      await pointer(page, 0.5, 0.5);
      await page.keyboard.press("c");
      expect((await styles(page)).vertical.visibility).toBe("hidden");
      expect((await styles(page)).horizontal.visibility).toBe("hidden");
      expect((await state(page)).hover).toBeNull();
      await page.mouse.up({ button: space ? "left" : "right" });
      if (space) await page.keyboard.up("Space");
      expect((await styles(page)).vertical.visibility).toBe("hidden");
      expect((await state(page)).view).not.toEqual(initial.view);
      expect((await state(page)).pins).toEqual(initial.pins);
      expect((await state(page)).cycles).toBe(0);
      await pointer(page, 0.52, 0.52);
      expect((await styles(page)).vertical.visibility).toBe("visible");
      await page.evaluate(() => (window as any).__cursor[0].panel.reset());
    }
  }
  // A gesture begun outside the plot must not arm placement on entering it.
  await page.mouse.move(1450, 600);
  await page.mouse.down();
  await pointer(page);
  await page.keyboard.press("c");
  expect((await state(page)).cycles).toBe(0);
  await page.mouse.up();
  await page.keyboard.press("c");
  expect((await state(page)).cycles).toBe(1);
  // OFF still lets users adjust an existing pin; C cannot interrupt its drag.
  await configure(page, { mode: "zoom" });
  await pointer(page, 0.2, 0.5);
  await page.mouse.down();
  await pointer(page, 0.25, 0.5);
  await page.keyboard.press("c");
  await page.mouse.up();
  expect((await state(page)).cycles).toBe(1);
  expect((await state(page)).pins.a).toBeCloseTo(25, 0);
  expect((await state(page)).pins.b).toBe(initial.pins.b);
  await expect(root(page)).toHaveAttribute("data-cursor-placement", "off");
});

test("preview orientation, contrast, pin pixels, and neutral OFF", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await pointer(page);
  const pins = await pinPixels(page);
  expect(pins.a).toBeGreaterThan(50);
  expect(pins.b).toBeGreaterThan(50);
  const snapshots: Record<string, unknown> = {};
  for (const mode of ["vertical", "horizontal", "off"]) {
    await page.keyboard.press("c");
    await expect(root(page)).toHaveAttribute("data-cursor-placement", mode);
    const lines = await styles(page);
    expect(lines.vertical.height).toBeGreaterThan(200);
    expect(lines.vertical.width).toBeLessThanOrEqual(2);
    expect(lines.horizontal.width).toBeGreaterThan(400);
    expect(lines.horizontal.height).toBeLessThanOrEqual(2);
    if (mode === "vertical") {
      expect(lines.vertical).toMatchObject({
        color: "rgb(89, 216, 255)",
        opacity: 1,
        weight: "2px",
      });
      expect(lines.horizontal.opacity).toBe(0.28);
    } else if (mode === "horizontal") {
      expect(lines.horizontal).toMatchObject({
        color: "rgb(255, 198, 107)",
        opacity: 1,
        weight: "2px",
      });
      expect(lines.vertical.opacity).toBe(0.28);
    } else {
      expect(lines.vertical).toMatchObject({
        color: "rgb(145, 164, 183)",
        opacity: 0.7,
        weight: "1px",
      });
      expect(lines.horizontal).toMatchObject({
        color: "rgb(145, 164, 183)",
        opacity: 0.7,
        weight: "1px",
      });
    }
    expect(await pinPixels(page)).toEqual(pins);
    const contrast = await page.locator("#plot-0").evaluate((host, lines) => {
      const rgb = (s: string) =>
        s
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number);
      const luminance = (rgb: number[]) =>
        rgb
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const background = rgb(getComputedStyle(host).backgroundColor);
      const ratio = (line: typeof lines.vertical) => {
        const color = rgb(line.color).map(
          (v, i) => v * line.opacity + background[i] * (1 - line.opacity),
        );
        const a = luminance(color),
          b = luminance(background);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      return {
        background,
        vertical: ratio(lines.vertical),
        horizontal: ratio(lines.horizontal),
      };
    }, lines);
    expect(
      mode === "horizontal" ? contrast.horizontal : contrast.vertical,
    ).toBeGreaterThan(3);
    snapshots[mode] = { lines, contrast, pinPixels: pins };
    const path = testInfo.outputPath(`cursor-${mode}.png`);
    await page.screenshot({ path });
    await testInfo.attach(`cursor-${mode}`, { path, contentType: "image/png" });
  }
  const evidencePath = testInfo.outputPath("decoded-preview-evidence.json");
  await writeFile(evidencePath, JSON.stringify(snapshots, null, 2));
  await testInfo.attach("decoded-preview-evidence", {
    path: evidencePath,
    contentType: "application/json",
  });
});

test("disposed and remounted plots have exactly one live shortcut listener", async ({
  page,
}) => {
  await fixture(page);
  await pointer(page);
  await page.keyboard.press("c");
  expect((await state(page)).cycles).toBe(1);
  await page.evaluate(() => {
    const s = (window as any).__cursor[0];
    s.oldRoot = s.host.querySelector(".uplot");
    s.panel.destroy();
    // Reinsert the old DOM so :hover cannot mask a leaked window listener.
    s.host.append(s.oldRoot);
  });
  await pointer(page);
  await page.keyboard.press("c");
  expect((await state(page)).cycles).toBe(1);
  expect(
    await page.evaluate(() =>
      (window as any).__cursor[0].oldRoot.hasAttribute("data-cursor-placement"),
    ),
  ).toBe(false);
  await page.evaluate(() => (window as any).__cursor[0].mount());
  await pointer(page);
  await root(page).focus();
  await page.keyboard.press("c");
  expect((await state(page)).cycles).toBe(2);
  await expect(root(page)).toHaveAttribute(
    "data-cursor-placement",
    "horizontal",
  );
  // Replacement render destroys/recreates navigation as real card updates do.
  await page.evaluate(() => {
    const s = (window as any).__cursor[0];
    s.panel.render(s.data, s.config, s.pins);
  });
  await pointer(page);
  await page.keyboard.press("c");
  expect((await state(page)).cycles).toBe(3);
  await expect(root(page)).toHaveAttribute("data-cursor-placement", "off");
  // Opt-out: no callback means no C interception at all.
  await configure(page, { onCursorModeCycle: undefined });
  const prevented = await root(page).evaluate((el) => {
    const e = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(false);
  expect((await state(page)).cycles).toBe(3);
});
