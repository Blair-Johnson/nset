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

async function fixture(page: Page, empty = false) {
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
  await page.evaluate(async (empty) => {
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
          ],
        },
      ],
    });
  }, empty);
  await page.reload();
  await page.evaluate(async () => {
    const { ChartCard } = await import("/src/cards.ts");
    const state = ((window as any).reorderTest = { cards: {}, writes: 0 });
    const proto = ChartCard.prototype as any;
    const build = proto.build;
    proto.build = function (...args: any[]) {
      const result = build.apply(this, args);
      state.cards[this.spec.id] = this;
      return result;
    };
    state.dragEvents = [];
    for (const type of ["dragstart", "dragover", "drop", "dragend", "blur"]) {
      document.addEventListener(
        type,
        (event) => {
          const e = event as DragEvent;
          state.dragEvents.push({
            type,
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

async function beginDrag(page: Page, id: string) {
  const title = card(page, id).locator(".card-title");
  await title.scrollIntoViewIfNeeded();
  const r = (await title.boundingBox())!;
  await page.mouse.move(r.x + Math.min(30, r.width / 2), r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + 45, r.y + r.height / 2 + 5, { steps: 5 });
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
  await page.mouse.move(x, y); // HTML5 dragover follows dragenter.
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

test("native title drag inserts first, middle and last across wrapped rows without reloads", async ({
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
  await page.mouse.move(r.x + 100, r.y + 20);
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

test("Escape, invalid targets, no-op and foreign drags clear feedback without saving", async ({
  page,
}) => {
  await fixture(page);
  const before = await saved(page);
  await beginDrag(page, "d");
  await hoverSlot(page, "a", false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".card-drop-indicator")).toHaveCount(0);
  await beginDrag(page, "d");
  await hoverSlot(page, "a", false);
  await page.mouse.move(10, 10, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".card-drop-indicator")).toHaveCount(0);
  await move(page, "a", "a", false);
  await section(page, "first")
    .locator(".chart-grid")
    .evaluate((grid) => {
      const transfer = new DataTransfer();
      transfer.setData("application/x-nset-card", "does-not-exist");
      grid.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
      grid.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    });
  await expect(page.locator(".card-drop-indicator")).toHaveCount(0);
  expect(await order(page)).toEqual(["a", "b", "c", "d"]);
  expect(await saved(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).reorderTest.writes)).toBe(0);
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
    .getByRole("button", { name: "Move section up", exact: true })
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

test("only titles initiate reorder and keyboard Move up/down remains available", async ({
  page,
}) => {
  await fixture(page);
  const before = await saved(page);
  const types = await card(page, "a").evaluate((host) => {
    const result: string[][] = [];
    for (const target of host.querySelectorAll(
      "canvas,button,input,select,.u-over",
    )) {
      const dataTransfer = new DataTransfer();
      target.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
      result.push([...dataTransfer.types]);
      target.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    }
    return result;
  });
  expect(types.length).toBeGreaterThan(4);
  expect(types.every((list) => !list.includes("application/x-nset-card"))).toBe(
    true,
  );
  expect(await saved(page)).toBe(before);
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
