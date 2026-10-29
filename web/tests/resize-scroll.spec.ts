import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const target = '[data-card-id="resize-12"]';
const panelScroll = (page: Page) =>
  page.locator("#dashboard").evaluate((node) => node.scrollTop);

async function fixture(page: Page, bottom = false) {
  let histories = 0;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/views") return route.fulfill({ json: { views: [] } });
    if (path === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [
            { id: "resize", name: "Resize dashboard", created_at: 0 },
          ],
          runs: [
            {
              id: "run",
              experiment_id: "resize",
              name: "Training",
              status: "finished",
              params: {},
              tags: {},
              created_at: 0,
              updated_at: 0,
            },
          ],
          series: [
            {
              run_id: "run",
              key: "loss",
              kind: "metric",
              count: 101,
              last_step: 100,
              last_timestamp: 100,
              last_value: 100,
            },
          ],
        },
      });
    if (path.endsWith("/metrics")) {
      histories++;
      return route.fulfill({
        json: {
          points: Array.from({ length: 101 }, (_, step) => ({
            seq: step + 1,
            step,
            timestamp: step,
            value: step,
          })),
          total: 101,
          snapshot: 101,
          next_after: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/");
  await page.evaluate(async (bottom) => {
    const { newChart, saveLibrary } = await import("/src/workspace.ts");
    const cards = Array.from({ length: bottom ? 13 : 24 }, (_, i) => ({
      ...newChart("timeseries", ["loss"], `Chart ${i}`),
      id: `resize-${i}`,
      layout: { width: i === 11 ? 1000 : 580, height: 420 },
    }));
    saveLibrary({
      version: 2,
      activeByExperiment: { resize: "long-view" },
      views: [
        {
          version: 2,
          id: "long-view",
          experimentId: "resize",
          name: "Long view",
          selectedRunIds: ["run"],
          updatedAt: 0,
          sections: [
            {
              id: "first",
              title: "Training",
              collapsed: false,
              cards: cards.slice(0, 18),
            },
            {
              id: "second",
              title: "More charts",
              collapsed: false,
              cards: cards.slice(18),
            },
          ],
        },
      ],
    });
  }, bottom);
  await page.reload();
  await page.evaluate(async () => {
    const { ChartCard } = await import("/src/cards.ts");
    const state = ((window as any).resizeTest = { cards: {} });
    const proto = ChartCard.prototype as any;
    const buildShell = proto.buildShell;
    proto.buildShell = function (...args: any[]) {
      const result = buildShell.apply(this, args);
      state.cards[this.spec.id] = this;
      return result;
    };
  });
  await page.getByLabel("Access token", { exact: true }).fill("fixture");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Resize dashboard", exact: true })
    .click();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await page.locator(`${target} .card-resize-handle`).scrollIntoViewIfNeeded();
  await expect(page.locator(`${target} canvas`)).toBeVisible();
  await page.evaluate(() => {
    const s = (window as any).resizeTest;
    const c = s.cards["resize-12"];
    c.setPin("a", 30);
    c.setPin("yB", 60);
    c.plot.zoom(1.5);
    s.canvas = c.host.querySelector("canvas");
    s.plot = c.plot.chart;
    s.data = c.data;
    s.navigation = c.plot.navigation;
    s.viewport = c.plot.viewport();
    s.pins = { ...c.pins };
  });
  if (bottom)
    await page.locator("#dashboard").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
  await frames(page, 4);
  await expect(page.locator("#global-error")).toBeHidden();
  expect(await panelScroll(page)).toBeGreaterThan(1000);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  return () => histories;
}

async function frames(page: Page, count = 3) {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise(requestAnimationFrame);
  }, count);
}

async function startRecording(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).resizeTest;
    const c = s.cards["resize-12"];
    const panel = document.querySelector<HTMLElement>("#dashboard")!;
    s.frames = [];
    s.moves = [];
    s.recording = true;
    s.phase = "start";
    s.observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.removedNodes)
          if (
            node instanceof HTMLElement &&
            (node.matches(".dashboard-cell,.chart-section") ||
              node.contains(c.host))
          )
            s.moves.push({
              phase: s.phase,
              node: node.className,
              y: panel.scrollTop,
            });
    });
    s.observer.observe(document.querySelector("#dashboard"), {
      childList: true,
      subtree: true,
    });
    const sample = () => {
      const rect = c.root.getBoundingClientRect();
      s.frames.push({
        phase: s.phase,
        y: panel.scrollTop,
        windowY: scrollY,
        panelTop: panel.getBoundingClientRect().top,
        toolbarHeight: document
          .querySelector(".workspace-toolbar")!
          .getBoundingClientRect().height,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        max: panel.scrollHeight - panel.clientHeight,
        focus: document.activeElement?.getAttribute("aria-label"),
      });
      if (s.recording) requestAnimationFrame(sample);
    };
    sample();
    return panel.scrollTop;
  });
}

async function evidence(
  page: Page,
  info: TestInfo,
  name: string,
  y: number,
  policy: "page" | "anchor" | "clamp" | "alert" = "page",
) {
  await frames(page, 6);
  const result = await page.evaluate(() => {
    const s = (window as any).resizeTest;
    s.recording = false;
    s.observer.disconnect();
    const c = s.cards["resize-12"];
    return {
      frames: s.frames,
      moves: s.moves,
      sameCanvas: s.canvas === c.host.querySelector("canvas"),
      samePlot: s.plot === c.plot.chart,
      sameData: s.data === c.data,
      sameNavigation: s.navigation === c.plot.navigation,
      viewport: c.plot.viewport(),
      oldViewport: s.viewport,
      pins: c.pins,
      oldPins: s.pins,
    };
  });
  const path = info.outputPath(`${name}-frames.json`);
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach(`${name}-frames`, {
    path,
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  console.log(
    JSON.stringify({
      kind: "resize-scroll",
      name,
      start: y,
      min: Math.min(...result.frames.map((f: any) => f.y)),
      max: Math.max(...result.frames.map((f: any) => f.y)),
      moves: result.moves.length,
    }),
  );
  for (const frame of result.frames) {
    const reason = `${name}: ${JSON.stringify(frame)}; initial: ${JSON.stringify(result.frames[0])}`;
    expect(frame.windowY, reason).toBe(0);
    if (policy !== "anchor")
      expect(
        Math.abs(frame.y - (policy === "clamp" ? Math.min(y, frame.max) : y)),
        reason,
      ).toBeLessThanOrEqual(1);
    if (policy !== "clamp") {
      expect(
        Math.abs(
          frame.top -
            result.frames[0].top -
            (policy === "alert"
              ? frame.panelTop - result.frames[0].panelTop
              : 0),
        ),
        reason,
      ).toBeLessThanOrEqual(1);
      expect(frame.left, reason).toBe(result.frames[0].left);
    }
  }
  expect(result.moves).toEqual([]);
  expect(
    result.sameCanvas &&
      result.samePlot &&
      result.sameData &&
      result.sameNavigation,
  ).toBe(true);
  expect(result.viewport).toEqual(result.oldViewport);
  expect(result.pins).toEqual(result.oldPins);
  await expect(page.locator(`${target} .card-resize-handle`)).toBeFocused();
}

async function drag(page: Page, dx: number, dy: number, finish = "release") {
  const box = (await page
    .locator(`${target} .card-resize-handle`)
    .boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => ((window as any).resizeTest.phase = "move"));
  for (let step = 1; step <= 6; step++) {
    await page.mouse.move(
      box.x + box.width / 2 + (dx * step) / 6,
      box.y + box.height / 2 + (dy * step) / 6,
    );
    await frames(page, 1);
  }
  await page.evaluate(() => ((window as any).resizeTest.phase = "commit"));
  if (finish === "escape") await page.keyboard.press("Escape");
  if (finish === "cancel")
    await page
      .locator(`${target} .card-resize-handle`)
      .evaluate((node) =>
        node.dispatchEvent(
          new PointerEvent("pointercancel", { bubbles: true }),
        ),
      );
  await page.mouse.up();
}

async function layout(page: Page) {
  return page.evaluate(() => {
    const library = JSON.parse(localStorage.getItem("nset.workspaces.v2")!);
    return library.views[0].sections[0].cards[12].layout;
  });
}

test("full-shell far-below-fold pointer resize preserves every frame and commits without moving nodes", async ({
  page,
}, info) => {
  const histories = await fixture(page);
  const loads = histories();
  await page.screenshot({ path: info.outputPath("before-resize.png") });
  const y = await startRecording(page);
  await drag(page, 70, 60);
  await evidence(page, info, "pointer-grow", y);
  expect(await layout(page)).toEqual({ width: 650, height: 480 });
  // A wide preceding card keeps this card's anchor fixed while its next sibling
  // wraps into and out of the row as the desired width changes.
  const siblingTop = () =>
    page
      .locator('[data-card-id="resize-13"]')
      .evaluate((node) => node.getBoundingClientRect().top);
  const wrapped = await siblingTop();
  for (const [name, dx, dy, width, height] of [
    ["pointer-shrink-wrap", -190, -60, 460, 420],
    ["pointer-grow-wrap", 190, 60, 650, 480],
    ["pointer-width-shrink", -20, 0, 630, 480],
    ["pointer-height-shrink", 0, -30, 630, 450],
  ] as const) {
    const start = await startRecording(page);
    await drag(page, dx, dy);
    await evidence(page, info, name, start);
    expect(await layout(page)).toEqual({ width, height });
    if (name === "pointer-shrink-wrap")
      expect(await siblingTop()).toBeLessThan(wrapped - 300);
    if (name === "pointer-grow-wrap") expect(await siblingTop()).toBe(wrapped);
  }
  expect(histories()).toBe(loads);
});

test("keyboard resize retains focus, viewport and panel position for repeated commits", async ({
  page,
}, info) => {
  const histories = await fixture(page);
  const loads = histories();
  const handle = page.locator(`${target} .card-resize-handle`);
  await handle.evaluate((node: HTMLElement) =>
    node.focus({ preventScroll: true }),
  );
  const y = await startRecording(page);
  for (const key of [
    "ArrowRight",
    "ArrowDown",
    "Shift+ArrowRight",
    "Shift+ArrowDown",
    "ArrowLeft",
    "ArrowUp",
    "Shift+ArrowLeft",
    "Shift+ArrowUp",
  ]) {
    await page.keyboard.press(key);
    await frames(page);
    await expect(handle).toBeFocused();
  }
  await evidence(page, info, "keyboard-repeat", y);
  expect(await layout(page)).toEqual({ width: 580, height: 420 });
  expect(histories()).toBe(loads);
});

for (const finish of ["escape", "cancel"] as const)
  test(`pointer ${finish} restores dimensions without scrolling or reloading`, async ({
    page,
  }, info) => {
    const histories = await fixture(page);
    const loads = histories();
    const y = await startRecording(page);
    await drag(page, 70, 60, finish);
    await evidence(page, info, finish, y);
    expect(await layout(page)).toEqual({ width: 580, height: 420 });
    await expect(page.locator(`${target} [data-role=chart-card]`)).toHaveCSS(
      "height",
      "420px",
    );
    expect(histories()).toBe(loads);
  });

test("failed storage rolls back resize without losing scroll, focus or chart state", async ({
  page,
}, info) => {
  const histories = await fixture(page);
  const loads = histories();
  await page.evaluate(() => {
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "nset.workspaces.v2")
        throw new DOMException("Storage full", "QuotaExceededError");
      save.call(this, key, value);
    };
  });
  const y = await startRecording(page);
  await drag(page, 70, 60);
  // The error banner changes the panel's bounds. Preserve the panel's scroll
  // offset and the card's position within it; the document never scrolls.
  await evidence(page, info, "failed-storage", y, "alert");
  expect(await layout(page)).toEqual({ width: 580, height: 420 });
  await expect(page.locator(`${target} [data-role=chart-card]`)).toHaveCSS(
    "height",
    "420px",
  );
  await expect(page.locator("#global-error")).toContainText("Storage full");
  expect(histories()).toBe(loads);
});

test("dashboard shrink at the bottom allows only the browser's natural scroll clamp", async ({
  page,
}, info) => {
  const histories = await fixture(page, true);
  const loads = histories();
  const y = await startRecording(page);
  await drag(page, 0, -100);
  await evidence(page, info, "bottom-clamp", y, "clamp");
  expect(await panelScroll(page)).toBeLessThan(y - 50);
  expect(await layout(page)).toEqual({ width: 580, height: 320 });
  expect(histories()).toBe(loads);
});

for (const finish of ["release", "escape", "cancel"] as const) {
  test(`panel edge resize ${finish} accounts for scroll without moving the document`, async ({
    page,
  }) => {
    await fixture(page);
    const dashboard = page.locator("#dashboard");
    await dashboard.evaluate((node) => {
      node.style.height = "600px";
      node.style.alignSelf = "start";
    });
    const handle = page.locator(`${target} .card-resize-handle`);
    await handle.scrollIntoViewIfNeeded();
    const panel = (await dashboard.boundingBox())!;
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const before = await panelScroll(page);
    const stored = await layout(page);
    const windowBefore = await page.evaluate(() => scrollY);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, panel.y + panel.height - 8);
    await expect.poll(() => panelScroll(page)).toBeGreaterThan(before + 24);
    expect(await page.evaluate(() => scrollY)).toBe(windowBefore);
    // Leaving the visible panel stops auto-scroll, but pointer capture still
    // tracks the final resize position and supports all completion paths.
    const finalY = panel.y + panel.height + 8;
    await page.mouse.move(x, finalY);
    const stopped = await panelScroll(page);
    await frames(page, 4);
    expect(await panelScroll(page)).toBe(stopped);
    if (finish === "escape") await page.keyboard.press("Escape");
    if (finish === "cancel")
      await handle.evaluate((node) =>
        node.dispatchEvent(
          new PointerEvent("pointercancel", { bubbles: true }),
        ),
      );
    await page.mouse.up();
    expect(await layout(page)).toEqual(
      finish === "release"
        ? {
            width: stored.width,
            height: Math.round(
              Math.min(
                2160,
                Math.max(240, stored.height + finalY - y + stopped - before),
              ),
            ),
          }
        : stored,
    );
    await expect(page.locator(".card-resizing-slot")).toHaveCount(0);
    expect(await page.evaluate(() => scrollY)).toBe(windowBefore);
    const ended = await panelScroll(page);
    await frames(page, 4);
    expect(await panelScroll(page)).toBe(ended);
  });
}
