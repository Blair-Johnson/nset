import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const section = (page: Page, id: string) =>
  page.locator(`[data-section-id="${id}"]`);
const card = (page: Page, id: string) => page.locator(`[data-card-id="${id}"]`);
const order = (page: Page, id = "first") =>
  section(page, id)
    .locator(".dashboard-cell")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.cardId),
    );
const saved = (page: Page) =>
  page.evaluate(() => localStorage.getItem("nset.workspaces.v2"));

async function fixture(page: Page, empty = false, extraSection = false) {
  let histories = 0;
  await page.setViewportSize({ width: 1440, height: 1300 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/catalog")
      return route.fulfill({
        json: {
          experiments: [
            { id: "layout", name: "Layout experiment", created_at: 0 },
          ],
          runs: [
            {
              id: "run",
              experiment_id: "layout",
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
  await page.evaluate(
    async ({ empty, extraSection }) => {
      const { newChart, saveLibrary } = await import("/src/workspace.ts");
      const make = (id: string) => ({
        ...newChart("timeseries", ["loss"], `Plot ${id}`),
        id,
        layout: { width: 500, height: 280 },
      });
      saveLibrary({
        version: 2,
        activeByExperiment: { layout: "layout-view" },
        views: [
          {
            version: 2,
            id: "layout-view",
            experimentId: "layout",
            name: "Layout view",
            selectedRunIds: ["run"],
            updatedAt: 0,
            sections: [
              {
                id: "first",
                title: "Training",
                collapsed: false,
                cards: ["a", "b", "c", "d"].map(make),
              },
              {
                id: "second",
                title: "Validation",
                collapsed: false,
                cards: empty ? [] : ["e", "f"].map(make),
              },
              ...(extraSection
                ? [
                    {
                      id: "third",
                      title: "Training archive",
                      collapsed: true,
                      cards: ["g"].map(make),
                    },
                  ]
                : []),
            ],
          },
        ],
      });
    },
    { empty, extraSection },
  );
  await page.reload();
  await page.evaluate(async () => {
    const { ChartCard } = await import("/src/cards.ts");
    const state = ((window as any).reorderTest = { cards: {}, writes: 0 });
    const proto = ChartCard.prototype as any;
    const buildShell = proto.buildShell;
    proto.buildShell = function (...args: any[]) {
      const result = buildShell.apply(this, args);
      state.cards[this.spec.id] = this;
      return result;
    };
    state.dragEvents = [];
    for (const type of [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "gotpointercapture",
      "lostpointercapture",
      "dragstart",
      "dragover",
      "drop",
      "dragend",
      "blur",
    ]) {
      document.addEventListener(
        type,
        (event) => {
          const e = event as PointerEvent;
          state.dragEvents.push({
            type,
            pointerId: e.pointerId,
            pointerType: e.pointerType,
            buttons: e.buttons,
            trusted: e.isTrusted,
            x: e.clientX,
            y: e.clientY,
            target: (e.target as Element)
              ?.closest?.("[data-card-id]")
              ?.getAttribute("data-card-id"),
            indicator: document
              .querySelector(".card-drop-indicator")
              ?.getBoundingClientRect()
              .toJSON(),
          });
        },
        true,
      );
    }
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "nset.workspaces.v2") {
        state.writes++;
        if (state.failSave) throw new Error("fixture storage failure");
      }
      return setItem.call(this, key, value);
    };
  });
  await page.getByLabel("Access token", { exact: true }).fill("fixture");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Layout experiment", exact: true })
    .click();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await expect(card(page, "d").locator("canvas")).toBeVisible();
  await page.evaluate(() => {
    const state = (window as any).reorderTest;
    const c = state.cards.a;
    c.setPin("a", 30);
    c.setPin("yB", 60);
    c.plot.zoom(1.5);
    state.before = {
      card: c,
      canvas: c.host.querySelector("canvas"),
      plot: c.plot.chart,
      data: c.data,
      navigation: c.plot.navigation,
      viewport: c.plot.viewport(),
      pins: { ...c.pins },
      spec: JSON.stringify(c.spec),
    };
    state.writes = 0;
  });
  return () => histories;
}

async function beginDrag(
  page: Page,
  id: string,
  origin: "title" | "header padding" = "title",
) {
  const header = card(page, id).locator(".card-header");
  const handle = origin === "title" ? header.locator(".card-title") : header;
  await handle.scrollIntoViewIfNeeded();
  const r = (await handle.boundingBox())!;
  const x = r.x + (origin === "title" ? Math.min(30, r.width / 2) : 2);
  const y = r.y + (origin === "title" ? r.height / 2 : 2);
  if (origin === "header padding")
    expect(
      await handle.evaluate(
        (node, point) => document.elementFromPoint(point.x, point.y) === node,
        { x, y },
      ),
    ).toBe(true);
  await header.evaluate((node) =>
    node.addEventListener(
      "pointerdown",
      (event) => {
        (window as any).reorderTest.chartPointer = (
          event as PointerEvent
        ).pointerId;
      },
      { once: true },
    ),
  );
  await expect(header).toHaveJSProperty("draggable", false);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 2, y + 1);
  await expect(
    page.locator(".card-reordering, .card-drop-indicator"),
  ).toHaveCount(0);
  expect(
    await header.evaluate((node) =>
      node.hasPointerCapture((window as any).reorderTest.chartPointer),
    ),
  ).toBe(false);
  await page.mouse.move(x + 20, y + 5, { steps: 5 });
  await expect(header).toHaveClass(/card-reordering/);
  await expect(header).toHaveJSProperty("draggable", false);
  expect(
    await header.evaluate((node) =>
      node.hasPointerCapture((window as any).reorderTest.chartPointer),
    ),
  ).toBe(true);
  await expect(page.locator("#dashboard")).not.toHaveClass(/section-dragging/);
  await expect(card(page, id).locator("canvas")).toBeVisible();
}
async function hoverSlot(
  page: Page,
  id: string,
  after: boolean,
  single = false,
) {
  const r = (await card(page, id).boundingBox())!;
  const x = r.x + r.width * (single ? 0.5 : after ? 0.8 : 0.2);
  const y = r.y + r.height * (single ? (after ? 0.8 : 0.2) : 0.35);
  await page.mouse.move(x, y, { steps: 12 });
  await expect(page.locator(".card-drop-indicator")).toBeVisible();
}
async function move(
  page: Page,
  id: string,
  target: string,
  after: boolean,
  single = false,
) {
  await beginDrag(page, id);
  await hoverSlot(page, target, after, single);
  await page.mouse.up();
  await expect(page.locator(".card-drop-indicator")).toHaveCount(0);
}
async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}
async function identities(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).reorderTest,
      c = s.cards.a,
      b = s.before;
    return {
      card: c === b.card,
      canvas: c.host.querySelector("canvas") === b.canvas,
      plot: c.plot.chart === b.plot,
      data: c.data === b.data,
      navigation: c.plot.navigation === b.navigation,
      viewport:
        JSON.stringify(c.plot.viewport()) === JSON.stringify(b.viewport),
      pins: JSON.stringify(c.pins) === JSON.stringify(b.pins),
      spec: JSON.stringify(c.spec) === b.spec,
    };
  });
}

test("pointer title drag inserts first, middle and last across wrapped rows without reloads", async ({
  page,
}, info) => {
  const histories = await fixture(page);
  const loads = histories();
  const a = (await card(page, "a").boundingBox())!,
    b = (await card(page, "b").boundingBox())!,
    c = (await card(page, "c").boundingBox())!;
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  expect(c.y).toBeGreaterThan(a.y + 200);
  await beginDrag(page, "d");
  await hoverSlot(page, "a", false);
  const marker = (await page.locator(".card-drop-indicator").boundingBox())!;
  expect(Math.abs(marker.x - a.x)).toBeLessThan(4);
  expect(marker.width).toBe(3);
  await capture(page, info, "wrapped-row-before-first");
  await page.mouse.up();
  expect(await order(page)).toEqual(["d", "a", "b", "c"]);
  await move(page, "d", "b", true);
  expect(await order(page)).toEqual(["a", "b", "d", "c"]);
  await move(page, "a", "c", true);
  expect(await order(page)).toEqual(["b", "d", "c", "a"]);
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
  expect(histories()).toBe(loads);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(3);
  const source = JSON.parse((await saved(page))!);
  expect(source.views[0].sections[0].cards.map((c: any) => c.id)).toEqual([
    "b",
    "d",
    "c",
    "a",
  ]);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(["b", "d", "c", "a"]);
  await capture(page, info, "persisted-order");
});

test("cross-section insertion preserves source identity and supports an empty destination", async ({
  page,
}, info) => {
  const histories = await fixture(page, true);
  const loads = histories();
  await beginDrag(page, "a");
  const grid = section(page, "second").locator(".chart-grid");
  const r = (await grid.boundingBox())!;
  await page.mouse.move(r.x + 100, r.y + 20, { steps: 12 });
  await expect(page.locator(".card-drop-indicator")).toBeVisible();
  await capture(page, info, "empty-section-drop");
  await page.mouse.up();
  expect(await order(page)).toEqual(["b", "c", "d"]);
  expect(await order(page, "second")).toEqual(["a"]);
  await move(page, "b", "a", false, true);
  expect(await order(page, "second")).toEqual(["b", "a"]);
  await move(page, "a", "c", false);
  expect(await order(page)).toEqual(["a", "c", "d"]);
  expect(await order(page, "second")).toEqual(["b"]);
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
  expect(histories()).toBe(loads);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(["a", "c", "d"]);
  expect(await order(page, "second")).toEqual(["b"]);
});

for (const origin of ["header padding", "title"] as const) {
  test(`pointer ${origin} drag reorders with native dragstart and drop blocked`, async ({
    page,
  }) => {
    const histories = await fixture(page, true);
    const loads = histories();
    await page.evaluate(() => {
      // A browser/host that cancels native DnD must not disable chart reordering.
      const state = (window as any).reorderTest;
      state.blockedNativeEvents = [];
      for (const type of ["dragstart", "drop"])
        document.addEventListener(
          type,
          (event) => {
            state.blockedNativeEvents.push(type);
            event.preventDefault();
            event.stopImmediatePropagation();
          },
          { capture: true },
        );
    });
    await beginDrag(page, "a", origin);
    await hoverSlot(page, "d", true);
    await page.mouse.up();
    expect(await order(page)).toEqual(["b", "c", "d", "a"]);
    expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
    await beginDrag(page, "a", origin);
    const grid = section(page, "second").locator(".chart-grid");
    const r = (await grid.boundingBox())!;
    await page.mouse.move(r.x + 100, r.y + 20, { steps: 12 });
    await expect(page.locator(".card-drop-indicator")).toBeVisible();
    await page.mouse.up();
    await expect(
      page.locator(".card-reordering, .card-drop-indicator"),
    ).toHaveCount(0);
    await expect(card(page, "a").locator(".card-header")).toHaveJSProperty(
      "draggable",
      false,
    );
    expect(await order(page)).toEqual(["b", "c", "d"]);
    expect(await order(page, "second")).toEqual(["a"]);
    expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
    expect(histories()).toBe(loads);
    expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(
      2,
    );
    expect(
      await page.evaluate(
        () => (window as any).reorderTest.blockedNativeEvents,
      ),
    ).toEqual([]);
    const persisted = JSON.parse((await saved(page))!);
    expect(
      persisted.views[0].sections.map((s: any) =>
        s.cards.map((c: any) => c.id),
      ),
    ).toEqual([["b", "c", "d"], ["a"]]);
    await page.reload();
    await expect.poll(() => order(page)).toEqual(["b", "c", "d"]);
    await expect.poll(() => order(page, "second")).toEqual(["a"]);
  });
}

test("chart headers and titles advertise drag without tooltips while section titles advertise folding", async ({
  page,
}) => {
  await fixture(page);
  const header = card(page, "a").locator(".card-header");
  const title = card(page, "a").locator(".card-title");
  await expect(header).toHaveClass(/card-reorder-handle/);
  await expect(header).toHaveJSProperty("draggable", false);
  for (const handle of [header, title]) {
    await expect(handle).toHaveCSS("cursor", "grab");
    await expect(handle).toHaveCSS("user-select", "none");
    expect(await handle.getAttribute("title")).toBeNull();
  }
  await expect(section(page, "first").locator(".section-heading")).toHaveCSS(
    "cursor",
    "grab",
  );
  await expect(section(page, "first").locator(".section-toggle")).toHaveCSS(
    "cursor",
    "pointer",
  );
  const before = await saved(page);
  await beginDrag(page, "a", "header padding");
  await hoverSlot(page, "d", true);
  await expect(page.locator(".card-reordering")).toHaveCount(1);
  await expect(header).toHaveCSS("cursor", "grabbing");
  await expect(title).toHaveCSS("cursor", "grabbing");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".card-reordering")).toHaveCount(0);
  await expect(header).toHaveCSS("cursor", "grab");
  expect(await saved(page)).toBe(before);
});

test("real mouse drags on chart toolbar controls, nested SVG and menu summary never reorder", async ({
  page,
}) => {
  await fixture(page);
  const source = card(page, "a");
  const header = source.locator(".card-header");
  const before = await saved(page);
  const controls = await header
    .locator("button:visible:not(:disabled), .card-menu > summary")
    .all();
  expect(controls.length).toBeGreaterThan(4);
  const icon = header
    .getByRole("button", { name: "Zoom out", exact: true })
    .locator("svg");
  // Normally icons use pointer-events:none. Exercise actual SVG event targeting
  // as well, rather than relying solely on events retargeted to the button.
  await icon.evaluate((svg) => {
    (svg as SVGElement).style.pointerEvents = "auto";
  });
  for (const target of [...controls, icon]) {
    await target.scrollIntoViewIfNeeded();
    const r = (await target.boundingBox())!;
    const x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    if (target === icon)
      expect(
        await page.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y) instanceof SVGElement,
          { x, y },
        ),
      ).toBe(true);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await expect(header).toHaveJSProperty("draggable", false);
    await page.mouse.move(x + 20, y + 8, { steps: 5 });
    const destination = (await card(page, "b").boundingBox())!;
    await page.mouse.move(
      destination.x + destination.width * 0.8,
      destination.y + destination.height * 0.35,
      { steps: 12 },
    );
    await expect(
      page.locator(".card-reordering, .card-drop-indicator"),
    ).toHaveCount(0);
    await expect(page.locator("#dashboard")).not.toHaveClass(
      /section-dragging/,
    );
    await page.mouse.up();
    expect(
      await page.evaluate(() =>
        (window as any).reorderTest.dragEvents.filter(
          (event: any) => event.type === "dragstart",
        ),
      ),
    ).toEqual([]);
    expect(await order(page)).toEqual(["a", "b", "c", "d"]);
    expect(await saved(page)).toBe(before);
    expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(
      0,
    );
  }
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
  // Excluding a control gesture must not disable the next header gesture.
  await beginDrag(page, "a", "header padding");
  await hoverSlot(page, "b", true);
  await page.mouse.up();
  expect(await order(page)).toEqual(["b", "a", "c", "d"]);
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
});

test("chart Escape, pointercancel, lost capture, blur, outside and no-op drops never save", async ({
  page,
}) => {
  await fixture(page, false, true);
  const before = await saved(page);
  for (const reason of [
    "Escape",
    "pointercancel",
    "lostcapture",
    "blur",
    "outside",
    "noop",
  ]) {
    await test.step(reason, async () => {
      await beginDrag(page, "a");
      await hoverSlot(page, reason === "noop" ? "a" : "d", reason !== "noop");
      await expectMixedSections(page); // Chart drags never temporarily fold sections.
      expect(await saved(page)).toBe(before);
      expect(
        await page.evaluate(() => (window as any).reorderTest.writes),
      ).toBe(0);
      if (reason === "Escape") await page.keyboard.press("Escape");
      else if (reason === "outside") {
        await page.mouse.move(10, 10, { steps: 4 });
        await expect(page.locator(".card-drop-indicator")).toHaveCount(0);
      } else if (reason !== "noop") {
        await card(page, "a")
          .locator(".card-header")
          .evaluate((header, reason) => {
            const pointerId = (window as any).reorderTest.chartPointer;
            // Only the terminal cancellation signal is injected; activation and movement are real mouse input.
            if (reason === "blur") window.dispatchEvent(new Event("blur"));
            else if (reason === "pointercancel")
              header.dispatchEvent(
                new PointerEvent("pointercancel", {
                  pointerId,
                  pointerType: "mouse",
                  isPrimary: true,
                  bubbles: true,
                }),
              );
            else header.releasePointerCapture(pointerId);
          }, reason);
      }
      if (reason !== "outside" && reason !== "noop") {
        // Deliver pending lostpointercapture and prove held-pointer motion cannot revive a cancelled drag.
        const r = (await card(page, "d").boundingBox())!;
        await page.mouse.move(r.x + r.width * 0.8 + 2, r.y + r.height * 0.35);
        await expect(
          page.locator(".card-reordering, .card-drop-indicator"),
        ).toHaveCount(0);
      }
      await page.mouse.up();
      await expect(
        page.locator(".card-reordering, .card-drop-indicator"),
      ).toHaveCount(0);
      expect(
        await card(page, "a")
          .locator(".card-header")
          .evaluate((header) =>
            header.hasPointerCapture((window as any).reorderTest.chartPointer),
          ),
      ).toBe(false);
      await expectMixedSections(page);
      expect(await order(page)).toEqual(["a", "b", "c", "d"]);
      expect(await order(page, "second")).toEqual(["e", "f"]);
      expect(await sectionOrder(page)).toEqual(["first", "second", "third"]);
      expect(await saved(page)).toBe(before);
      expect(
        await page.evaluate(() => (window as any).reorderTest.writes),
      ).toBe(0);
      expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
    });
  }
  await move(page, "a", "d", true);
  expect(await order(page)).toEqual(["b", "c", "d", "a"]);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(1);
});

test("chart edge scrolling stays in the dashboard and stops outside valid drops", async ({
  page,
}) => {
  await fixture(page);
  const dashboard = page.locator("#dashboard");
  // Both panel edges are well inside the viewport, not at y=0/innerHeight.
  await dashboard.evaluate((node) => {
    node.style.height = "400px";
    node.style.alignSelf = "start";
  });
  const before = await saved(page);
  const windowBefore = await page.evaluate(() => window.scrollY);
  await beginDrag(page, "a");
  const panel = (await dashboard.boundingBox())!;
  const r = (await card(page, "a").boundingBox())!;
  const x = r.x + r.width / 2;
  const scroll = () => dashboard.evaluate((node) => node.scrollTop);
  const scrollBefore = await scroll();
  await page.mouse.move(x, panel.y + panel.height - 8, { steps: 8 });
  await expect.poll(scroll).toBeGreaterThan(scrollBefore + 24);
  await expect(card(page, "a").locator(".card-header")).toHaveClass(
    /card-reordering/,
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(windowBefore);
  expect(await saved(page)).toBe(before);
  for (const point of [
    { x: panel.x - 4, y: panel.y + panel.height - 8 },
    { x, y: panel.y - 4 },
    { x, y: panel.y + panel.height + 4 },
  ]) {
    await page.mouse.move(point.x, point.y);
    await expect(page.locator(".card-drop-indicator")).toHaveCount(0);
    const stopped = await scroll();
    await page.evaluate(async () => {
      for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    });
    expect(await scroll()).toBe(stopped);
  }
  // An in-panel top edge scrolls up even though it is below the toolbar.
  await dashboard.evaluate((node) => {
    node.scrollTop = 140;
  });
  await page.mouse.move(x, panel.y + 8);
  await expect.poll(scroll).toBeLessThan(116);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(
    page.locator(".card-reordering, .card-drop-indicator"),
  ).toHaveCount(0);
  const scrollAfter = await scroll();
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
  });
  expect(await scroll()).toBe(scrollAfter);
  expect(await page.evaluate(() => window.scrollY)).toBe(windowBefore);
  expect(await order(page)).toEqual(["a", "b", "c", "d"]);
  expect(await saved(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(0);
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
});

test("failed storage rolls order back transactionally and next drag still works", async ({
  page,
}) => {
  await fixture(page);
  const before = await saved(page);
  await page.evaluate(() => {
    (window as any).reorderTest.failSave = true;
  });
  await move(page, "a", "d", true);
  await expect(page.locator("#global-error")).toContainText(
    "fixture storage failure",
  );
  expect(await order(page)).toEqual(["a", "b", "c", "d"]);
  expect(await saved(page)).toBe(before);
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
  await page.evaluate(() => {
    (window as any).reorderTest.failSave = false;
  });
  await move(page, "a", "d", true);
  expect(await order(page)).toEqual(["b", "c", "d", "a"]);
  await expect(page.locator("#global-error")).toBeHidden();
});

test("single-column insertion uses top/bottom edges", async ({
  page,
}, info) => {
  await fixture(page);
  await page.setViewportSize({ width: 900, height: 1800 });
  const a = (await card(page, "a").boundingBox())!,
    b = (await card(page, "b").boundingBox())!;
  expect(b.y).toBeGreaterThan(a.y + 200);
  await beginDrag(page, "d");
  await hoverSlot(page, "b", false, true);
  const marker = (await page.locator(".card-drop-indicator").boundingBox())!;
  expect(marker.height).toBe(3);
  expect(Math.abs(marker.y - b.y)).toBeLessThan(4);
  await capture(page, info, "single-column-insertion");
  await page.mouse.up();
  expect(await order(page)).toEqual(["a", "d", "b", "c"]);
  await move(page, "a", "c", true, true);
  expect(await order(page)).toEqual(["d", "b", "c", "a"]);
});

test("section bands group controls near names, bound menus at 390px, and isolate actions", async ({
  page,
}, info) => {
  await fixture(page);
  const measure = () =>
    page.locator(".section-heading").evaluateAll((headers) =>
      headers.map((header) => {
        const rect = header.getBoundingClientRect(),
          title = header
            .querySelector(".section-toggle")!
            .getBoundingClientRect(),
          menu = header.querySelector("summary")!.getBoundingClientRect();
        const css = getComputedStyle(header);
        return {
          height: rect.height,
          width: rect.width,
          titleRight: title.right,
          menuLeft: menu.left,
          menuRight: menu.right,
          right: rect.right,
          divider: css.borderBottomStyle,
          border: css.borderBottomWidth,
          background: css.backgroundColor,
        };
      }),
    );
  const desktop = await measure();
  for (const m of desktop) {
    expect(m.height).toBeGreaterThanOrEqual(32);
    expect(m.height).toBeLessThanOrEqual(34);
    expect(m.menuLeft - m.titleRight).toBeLessThan(60);
    expect(m.divider).toBe("solid");
    expect(m.border).toBe("1px");
    expect(m.background).not.toBe("rgba(0, 0, 0, 0)");
  }
  await section(page, "second")
    .getByLabel("Validation section actions")
    .click();
  await section(page, "second")
    .getByRole("button", { name: "Rename section", exact: true })
    .click();
  const long =
    "Validation — a deliberately long section title for narrow windows";
  await page.getByLabel("Section name", { exact: true }).fill(long);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    section(page, "second").locator(".section-toggle"),
  ).toContainText(long);
  await expect(section(page, "first").locator(".section-toggle")).toContainText(
    "Training",
  );
  await move(page, "d", "a", false);
  expect(await order(page)).toEqual(["d", "a", "b", "c"]);
  expect(await order(page, "second")).toEqual(["e", "f"]);
  await section(page, "second").locator(".section-toggle").click();
  await expect(section(page, "second").locator(".chart-grid")).toBeHidden();
  await expect(section(page, "first").locator(".chart-grid")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 1000 });
  await section(page, "second").locator(".section-menu > summary").click();
  const menu = section(page, "second").locator(".menu-popover");
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(382);
  const mobile = await measure();
  for (const m of mobile) expect(m.menuRight).toBeLessThanOrEqual(m.right - 4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const measurements = { desktop, mobile, menu: box };
  const path = info.outputPath("header-measurements.json");
  await writeFile(path, JSON.stringify(measurements, null, 2));
  await info.attach("header-measurements", {
    path,
    contentType: "application/json",
  });
  console.log(
    JSON.stringify({ kind: "section-header-measurements", ...measurements }),
  );
  await capture(page, info, "narrow-section-actions");
  await section(page, "second")
    .getByRole("button", { name: "Move to top", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  expect(
    await page
      .locator(".chart-section")
      .evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLElement).dataset.sectionId),
      ),
  ).toEqual(["second", "first"]);
  expect(await order(page)).toEqual(["d", "a", "b", "c"]);
  await expect(
    section(page, "second").locator(".section-menu > summary"),
  ).toBeFocused();
});

test.afterEach(async ({ page }, info) => {
  const events = await page
    .evaluate(() => (window as any).reorderTest?.dragEvents)
    .catch(() => undefined);
  if (events) {
    const path = info.outputPath("drag-events.json");
    await writeFile(path, JSON.stringify(events, null, 2));
    await info.attach("drag-events", { path, contentType: "application/json" });
  }
});

test("real plot gestures never reorder and keyboard Move up/down remains available", async ({
  page,
}) => {
  await fixture(page);
  const before = await saved(page);
  const plot = card(page, "a").locator("canvas").first();
  await plot.scrollIntoViewIfNeeded();
  const r = (await plot.boundingBox())!;
  const destination = (await card(page, "b").boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.25, r.y + r.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(
    destination.x + destination.width * 0.8,
    destination.y + destination.height * 0.35,
    { steps: 12 },
  );
  await expect(
    page.locator(".card-reordering, .card-drop-indicator"),
  ).toHaveCount(0);
  await page.mouse.up();
  expect(await order(page)).toEqual(["a", "b", "c", "d"]);
  expect(await saved(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(0);
  await card(page, "a").getByLabel("Chart actions", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await card(page, "a")
    .getByRole("button", { name: "Move down", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  expect(await order(page)).toEqual(["b", "a", "c", "d"]);
  await card(page, "a").getByLabel("Chart actions", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await card(page, "a")
    .getByRole("button", { name: "Move up", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  expect(await order(page)).toEqual(["a", "b", "c", "d"]);
});

const sectionOrder = (page: Page) =>
  page
    .locator("#dashboard > .chart-section")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.sectionId),
    );
const sectionState = async (page: Page) =>
  JSON.parse((await saved(page))!).views[0].sections.map((s: any) => ({
    id: s.id,
    collapsed: s.collapsed,
  }));
async function beginSectionDrag(
  page: Page,
  id: string,
  part = ".section-heading",
) {
  const handle = section(page, id).locator(part);
  await handle.scrollIntoViewIfNeeded();
  const r = (await handle.boundingBox())!;
  const x = r.x + r.width * (part === ".section-heading" ? 0.85 : 0.5);
  const y = r.y + r.height / 2;
  await handle.evaluate((node) =>
    node.addEventListener(
      "pointerdown",
      (event) => {
        (window as any).reorderTest.sectionPointer = (
          event as PointerEvent
        ).pointerId;
      },
      { once: true },
    ),
  );
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 2, y + 1);
  await expect(page.locator("#dashboard")).not.toHaveClass(/section-dragging/);
  await page.mouse.move(x + 12, y + 1, { steps: 4 });
  await expect(page.locator("#dashboard")).toHaveClass(/section-dragging/);
  for (const grid of await page.locator("#dashboard .chart-grid").all())
    await expect(grid).toBeHidden();
}
async function hoverSection(page: Page, id: string, after: boolean) {
  const r = (await section(page, id)
    .locator(".section-heading")
    .boundingBox())!;
  await page.mouse.move(
    r.x + r.width / 2,
    r.y + r.height * (after ? 0.75 : 0.25),
    { steps: 8 },
  );
  await expect(page.locator(".section-drop-indicator")).toBeVisible();
}
async function moveSectionByPointer(
  page: Page,
  id: string,
  target: string,
  after: boolean,
  part?: string,
) {
  await beginSectionDrag(page, id, part);
  await hoverSection(page, target, after);
  await page.mouse.up();
  await expect(page.locator("#dashboard")).not.toHaveClass(/section-dragging/);
  await expect(page.locator(".section-drop-indicator")).toHaveCount(0);
}
async function expectMixedSections(page: Page) {
  await expect(section(page, "first").locator(".chart-grid")).toBeVisible();
  await expect(section(page, "second").locator(".chart-grid")).toBeVisible();
  await expect(section(page, "third").locator(".chart-grid")).toBeHidden();
  await expect(
    section(page, "first").locator(".section-toggle"),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    section(page, "third").locator(".section-toggle"),
  ).toHaveAttribute("aria-expanded", "false");
}

test("section heading drag folds only the preview and restores mixed collapse states and chart state", async ({
  page,
}) => {
  const histories = await fixture(page, false, true);
  const loads = histories();
  const before = await saved(page);
  await beginSectionDrag(page, "first");
  expect(await saved(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(0);
  await hoverSection(page, "third", true);
  await page.mouse.up();
  await expect(page.locator(".section-drop-indicator")).toHaveCount(0);
  expect(await sectionOrder(page)).toEqual(["second", "third", "first"]);
  await expectMixedSections(page);
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
  expect(histories()).toBe(loads);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(1);
  expect(await sectionState(page)).toEqual([
    { id: "second", collapsed: false },
    { id: "third", collapsed: true },
    { id: "first", collapsed: false },
  ]);
  // The non-control heading area and count are handles, even when collapsed.
  await moveSectionByPointer(
    page,
    "third",
    "second",
    false,
    ".section-heading",
  );
  await moveSectionByPointer(page, "first", "third", false, ".section-count");
  expect(await sectionOrder(page)).toEqual(["first", "third", "second"]);
  await expectMixedSections(page);
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
  await page.reload();
  await expect
    .poll(() => sectionOrder(page))
    .toEqual(["first", "third", "second"]);
  await expectMixedSections(page);
});

test("section Escape, pointercancel, lost capture, blur, outside and no-op drops restore without writes", async ({
  page,
}) => {
  await fixture(page, false, true);
  const before = await saved(page);
  for (const reason of [
    "Escape",
    "pointercancel",
    "lostcapture",
    "blur",
    "outside",
    "noop",
  ]) {
    await beginSectionDrag(page, "first");
    await hoverSection(
      page,
      reason === "noop" ? "first" : "third",
      reason !== "noop",
    );
    if (reason === "Escape") await page.keyboard.press("Escape");
    else if (reason === "outside") await page.mouse.move(10, 10, { steps: 4 });
    else if (reason !== "noop")
      await page.evaluate((reason) => {
        const pointerId = (window as any).reorderTest.sectionPointer;
        if (reason === "blur") window.dispatchEvent(new Event("blur"));
        else if (reason === "pointercancel")
          window.dispatchEvent(
            new PointerEvent("pointercancel", { pointerId }),
          );
        else
          document
            .querySelector<HTMLElement>(
              '[data-section-id="first"] .section-heading',
            )!
            .releasePointerCapture(pointerId);
      }, reason);
    await page.mouse.up();
    await expect(page.locator("#dashboard")).not.toHaveClass(
      /section-dragging/,
    );
    await expect(page.locator(".section-drop-indicator")).toHaveCount(0);
    await expectMixedSections(page);
    expect(await sectionOrder(page)).toEqual(["first", "second", "third"]);
    expect(await saved(page)).toBe(before);
  }
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(0);
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
  await moveSectionByPointer(page, "first", "third", true);
  expect(await sectionOrder(page)).toEqual(["second", "third", "first"]);
});

test("section save failure restores order and fold state, then a fresh drag succeeds", async ({
  page,
}) => {
  await fixture(page, false, true);
  const before = await saved(page);
  await page.evaluate(() => {
    (window as any).reorderTest.failSave = true;
  });
  await moveSectionByPointer(page, "first", "third", true);
  await expect(page.locator("#global-error")).toContainText(
    "fixture storage failure",
  );
  expect(await sectionOrder(page)).toEqual(["first", "second", "third"]);
  expect(await saved(page)).toBe(before);
  await expectMixedSections(page);
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
  await page.evaluate(() => {
    (window as any).reorderTest.failSave = false;
  });
  await moveSectionByPointer(page, "first", "third", true);
  expect(await sectionOrder(page)).toEqual(["second", "third", "first"]);
  await expectMixedSections(page);
  await expect(page.locator("#global-error")).toBeHidden();
});

test("section dragging respects chart filters and retains filtered-out sections", async ({
  page,
}) => {
  await fixture(page, false, true);
  await page.getByRole("searchbox", { name: "Search charts" }).fill("Training");
  await expect(section(page, "second")).toBeHidden();
  await moveSectionByPointer(page, "first", "third", true);
  expect(await sectionOrder(page)).toEqual(["second", "third", "first"]);
  await expect(section(page, "second")).toBeHidden();
  await page.getByRole("searchbox", { name: "Search charts" }).fill("");
  await expectMixedSections(page);
  expect((await sectionState(page)).map((s: any) => s.id)).toEqual([
    "second",
    "third",
    "first",
  ]);
});

test("section title movement beyond the drag threshold never starts section dragging", async ({
  page,
}) => {
  const histories = await fixture(page, false, true);
  const loads = histories();
  const first = section(page, "first");
  const toggle = first.locator(".section-toggle");
  const before = await saved(page);
  await expect(toggle).toHaveCSS("cursor", "pointer");
  await toggle.scrollIntoViewIfNeeded();
  const r = (await toggle.boundingBox())!;
  const heading = (await first.locator(".section-heading").boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  for (const point of [
    { x: r.x + r.width / 2 + 20, y: r.y + r.height / 2 },
    { x: heading.x + heading.width * 0.85, y: heading.y + heading.height / 2 },
  ]) {
    await page.mouse.move(point.x, point.y, { steps: 5 });
    await expect(page.locator("#dashboard")).not.toHaveClass(
      /section-dragging/,
    );
    await expect(page.locator(".section-drop-indicator")).toHaveCount(0);
    await expectMixedSections(page);
    expect(await saved(page)).toBe(before);
  }
  // Release outside the fold button so this gesture cannot click it.
  await page.mouse.up();
  expect(await sectionOrder(page)).toEqual(["first", "second", "third"]);
  expect(await saved(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(0);
  expect(
    await page.evaluate(() =>
      (window as any).reorderTest.dragEvents.filter(
        (event: any) => event.type === "dragstart",
      ),
    ),
  ).toEqual([]);
  await toggle.click();
  await expect(first.locator(".chart-grid")).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expectMixedSections(page);
  expect(Object.values(await identities(page)).every(Boolean)).toBe(true);
  expect(histories()).toBe(loads);
});

test("section action controls do not initiate drags, and ordinary title clicks still toggle", async ({
  page,
}) => {
  await fixture(page, false, true);
  const first = section(page, "first");
  // A sub-threshold movement must remain an ordinary toggle click.
  const title = (await first.locator(".section-toggle").boundingBox())!;
  await page.mouse.move(title.x + 25, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(title.x + 27, title.y + title.height / 2 + 1);
  await page.mouse.up();
  await expect(first.locator(".chart-grid")).toBeHidden();
  await first.locator(".section-toggle").click();
  await expectMixedSections(page);
  const before = await saved(page);
  const summary = first.locator(".section-menu > summary");
  const menuHandle = (await summary.boundingBox())!;
  await page.mouse.move(menuHandle.x + 6, menuHandle.y + menuHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    menuHandle.x + 18,
    menuHandle.y + menuHandle.height / 2,
    { steps: 4 },
  );
  await expect(page.locator("#dashboard")).not.toHaveClass(/section-dragging/);
  await page.mouse.up();
  await expect(first.locator(".section-menu")).toHaveAttribute("open", "");
  expect(await saved(page)).toBe(before);
  const action = first.getByRole("button", {
    name: "Move to bottom",
    exact: true,
  });
  const r = (await action.boundingBox())!;
  await page.mouse.move(r.x + 30, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 42, r.y + r.height / 2, { steps: 4 });
  await expect(page.locator("#dashboard")).not.toHaveClass(/section-dragging/);
  await expect(section(page, "second").locator(".chart-grid")).toBeVisible();
  await page.mouse.up();
  expect(await sectionOrder(page)).toEqual(["second", "third", "first"]);
  await expectMixedSections(page);
});

test("keyboard section Move to top/bottom controls persist full order without changing folds", async ({
  page,
}) => {
  await fixture(page, false, true);
  for (const [label, expected] of [
    ["Move to top", ["third", "first", "second"]],
    ["Move to bottom", ["first", "second", "third"]],
  ] as const) {
    const source = section(page, "third");
    await source.locator(".section-menu > summary").focus();
    await page.keyboard.press("Enter");
    await expect(
      source.getByRole("button", { name: "Move section up", exact: true }),
    ).toHaveCount(0);
    await source.getByRole("button", { name: label, exact: true }).focus();
    await page.keyboard.press("Enter");
    expect(await sectionOrder(page)).toEqual(expected);
    await expectMixedSections(page);
    await expect(source.locator(".section-menu > summary")).toBeFocused();
    await page.reload();
    await expect.poll(() => sectionOrder(page)).toEqual(expected);
    await expectMixedSections(page);
  }
});

test("filter updates and navigation cancel an active section drag without saving temporary folds", async ({
  page,
}) => {
  await fixture(page, false, true);
  const before = await saved(page);
  await beginSectionDrag(page, "first");
  await page.locator("#chart-search").evaluate((input) => {
    (input as HTMLInputElement).value = "Training";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#dashboard")).not.toHaveClass(/section-dragging/);
  await page.mouse.up();
  await page.getByRole("searchbox", { name: "Search charts" }).fill("");
  await expectMixedSections(page);
  const hash = await page.evaluate(() => location.hash);
  await beginSectionDrag(page, "first");
  await page.evaluate(() => {
    location.hash = "#/experiments";
  });
  await expect(page.locator("#dashboard")).toHaveCount(0);
  await expect(page.locator(".section-drop-indicator")).toHaveCount(0);
  await page.mouse.up();
  await page.evaluate((hash) => {
    location.hash = hash;
  }, hash);
  await expectMixedSections(page);
  expect(await sectionOrder(page)).toEqual(["first", "second", "third"]);
  expect(await saved(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(0);
});

test("unchanged refresh finishing during a chart drag preserves the drop", async ({
  page,
}) => {
  await fixture(page);
  let release!: () => void;
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestSeen = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/api/catalog", async (route) => {
    requested();
    await pending;
    await route.fallback();
  });
  await page.locator("#refresh").click();
  await requestSeen;
  try {
    await beginDrag(page, "a", "header padding");
    await hoverSlot(page, "d", true);
  } finally {
    release();
  }
  await expect(page.locator("#refresh")).toBeEnabled();
  await expect(card(page, "a").locator(".card-header")).toHaveClass(
    /card-reordering/,
  );
  await hoverSlot(page, "d", true);
  await page.mouse.up();
  expect(await order(page)).toEqual(["b", "c", "d", "a"]);
  await expect(
    page.locator(".card-reordering,.card-drop-indicator"),
  ).toHaveCount(0);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(["b", "c", "d", "a"]);
});

test("a changed view cancels an in-flight chart drag instead of applying a stale drop", async ({
  page,
}) => {
  await fixture(page);
  await beginDrag(page, "a");
  await hoverSlot(page, "d", true);
  await section(page, "second")
    .locator(".section-toggle")
    .evaluate((node) => (node as HTMLElement).click());
  await expect(
    page.locator(".card-reordering,.card-drop-indicator"),
  ).toHaveCount(0);
  const target = (await card(page, "d").boundingBox())!;
  await page.mouse.move(
    target.x + target.width * 0.8,
    target.y + target.height * 0.35,
  );
  await page.mouse.up();
  expect(await order(page)).toEqual(["a", "b", "c", "d"]);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(1);
  await move(page, "a", "d", true);
  expect(await order(page)).toEqual(["b", "c", "d", "a"]);
});

test("refresh cannot turn a held toolbar button into a chart drag", async ({
  page,
}) => {
  await fixture(page);
  let release!: () => void;
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestSeen = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/api/catalog", async (route) => {
    requested();
    await pending;
    await route.fallback();
  });
  await page.locator("#refresh").click();
  await requestSeen;
  const header = card(page, "a").locator(".card-header");
  try {
    const button = card(page, "a").getByRole("button", {
      name: "Zoom out",
      exact: true,
    });
    const r = (await button.boundingBox())!;
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await expect(header).toHaveJSProperty("draggable", false);
  } finally {
    release();
  }
  await expect(page.locator("#refresh")).toBeEnabled();
  await expect(header).toHaveJSProperty("draggable", false);
  const r = (await card(page, "b").boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.8, r.y + r.height * 0.35, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(
    page.locator(".card-reordering,.card-drop-indicator"),
  ).toHaveCount(0);
  expect(await order(page)).toEqual(["a", "b", "c", "d"]);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(0);
  await move(page, "a", "d", true);
  expect(await order(page)).toEqual(["b", "c", "d", "a"]);
});

for (const finish of ["Escape", "pointercancel", "drop"] as const) {
  test(`section ${finish} restores the nested dashboard scroll position`, async ({
    page,
  }) => {
    await fixture(page, false, true);
    const dashboard = page.locator("#dashboard");
    await dashboard.evaluate((node) => {
      node.style.height = "360px";
      node.style.alignSelf = "start";
    });
    const heading = section(page, "second").locator(".section-heading");
    await heading.scrollIntoViewIfNeeded();
    const before = await dashboard.evaluate((node) => node.scrollTop);
    const windowBefore = await page.evaluate(() => window.scrollY);
    const stored = await saved(page);
    expect(before).toBeGreaterThan(100);
    await beginSectionDrag(page, "second");
    await expect
      .poll(() => dashboard.evaluate((node) => node.scrollTop))
      .toBe(0);
    if (finish === "drop") await hoverSection(page, "second", true);
    else if (finish === "Escape") await page.keyboard.press("Escape");
    else
      await page.evaluate(() =>
        window.dispatchEvent(
          new PointerEvent("pointercancel", {
            pointerId: (window as any).reorderTest.sectionPointer,
          }),
        ),
      );
    await page.mouse.up();
    await expect(dashboard).not.toHaveClass(/section-dragging/);
    await expect
      .poll(() => dashboard.evaluate((node) => node.scrollTop))
      .toBe(before);
    expect(await page.evaluate(() => window.scrollY)).toBe(windowBefore);
    expect(await saved(page)).toBe(stored);
    await expectMixedSections(page);
  });
}
