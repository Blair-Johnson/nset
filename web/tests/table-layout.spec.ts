import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

for (const width of [1440, 390])
  test(`${width}px wide-table context and selection`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route("**/__table_layout", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body><main style="padding:16px"><div style="height:64px">Experiment / Runs</div></main></body></html>',
      }),
    );
    await page.goto("/__table_layout");
    await page.evaluate(async () => {
      const { runTable, tableState } = await import("/src/browser-tables.ts");
      const experiment = { id: "sweep", name: "Sweep", created_at: 0 };
      const runs = Array.from({ length: 120 }, (_, i) => ({
        id: `run-${i}`,
        experiment_id: "sweep",
        name: `Candidate ${String(i).padStart(3, "0")} — deliberately long identity that must truncate`,
        status: "finished",
        created_at: i,
        updated_at: i,
        params: {},
        tags: {},
      }));
      const keys = Array.from(
        { length: 100 },
        (_, i) => `validation/metric_${String(i).padStart(3, "0")}`,
      );
      const series = runs.flatMap((run, i) =>
        keys.map((key) => ({
          kind: "metric",
          run_id: run.id,
          key,
          last_value: i,
          last_step: 99,
          count: 100,
        })),
      );
      const state = tableState();
      state.metrics = keys.slice(0, 10);
      state.descending = false;
      const selections: string[][] = [];
      (window as any).__layout = { selections };
      document.querySelector("main")!.append(
        runTable(
          { experiments: [experiment], runs, series } as any,
          experiment,
          [],
          (ids) => {
            selections.push(ids);
          },
          () => {},
          () => {},
          state,
        ),
      );
    });
    const measure = () =>
      page.evaluate(() => {
        const rect = (node: Element) => {
          const r = node.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        };
        const wrap = document.querySelector(".table-scroll")!;
        const last = document.querySelector("tbody tr:last-child")!;
        return {
          wrap: rect(wrap),
          header: rect(document.querySelector("thead th:last-child")!),
          identity: rect(last.children[1]),
          checkbox: rect(last.querySelector("input")!),
          lastMetric: rect(last.lastElementChild!),
          row: rect(last),
          footer: rect(document.querySelector(".table-footer")!),
          scrollTop: wrap.scrollTop,
          scrollLeft: wrap.scrollLeft,
          globalWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
          documentHeight: document.documentElement.scrollHeight,
        };
      });
    const before = await measure();
    await page.screenshot({ path: info.outputPath("initial.png") });
    if (width === 390 && !process.env.TABLE_BASELINE) {
      await page.locator(".table-scroll").evaluate((wrap) => {
        wrap.scrollLeft = 60;
      });
      const all = page.getByRole("checkbox", {
        name: "Select all matching runs",
        exact: true,
      });
      await expect
        .poll(() =>
          all.evaluate((node) => {
            const bounds = node.getBoundingClientRect();
            return (
              document.elementFromPoint(
                bounds.x + bounds.width / 2,
                bounds.y + bounds.height / 2,
              ) === node
            );
          }),
        )
        .toBe(true);
      await page.screenshot({
        path: info.outputPath("partial-scroll-checkbox.png"),
      });
      await all.click();
      await expect(all).toBeChecked();
      expect(
        await page.evaluate(
          () => (window as any).__layout.selections.at(-1).length,
        ),
      ).toBe(120);
      await page.keyboard.press("Space");
      await expect(all).toBeFocused();
      await expect(all).not.toBeChecked();
      expect(
        await page.evaluate(() => (window as any).__layout.selections.at(-1)),
      ).toEqual([]);
    }
    await page.locator(".table-scroll").evaluate((wrap) => {
      wrap.scrollTop = wrap.scrollHeight;
      wrap.scrollLeft = wrap.scrollWidth;
    });
    if (process.env.TABLE_BASELINE)
      await page.locator("tbody tr:last-child").scrollIntoViewIfNeeded();
    const after = await measure();
    await writeFile(
      info.outputPath("geometry.json"),
      JSON.stringify({ width, before, after }, null, 2),
    );
    console.log(
      JSON.stringify({
        kind: "table-context",
        width,
        baseline: !!process.env.TABLE_BASELINE,
        before,
        after,
      }),
    );
    await page.screenshot({ path: info.outputPath("scrolled.png") });
    expect(after.globalWidth).toBeLessThanOrEqual(width);
    if (process.env.TABLE_BASELINE) return;
    expect(after.row.height).toBeGreaterThanOrEqual(28);
    expect(after.row.height).toBeLessThanOrEqual(34);
    expect(after.scrollTop).toBeGreaterThan(0);
    expect(after.header.bottom).toBeLessThanOrEqual(after.wrap.y + 1);
    expect(after.header.bottom).toBeLessThan(after.wrap.bottom);
    expect(after.footer.y).toBeGreaterThanOrEqual(after.wrap.bottom);
    expect(after.footer.bottom).toBeLessThanOrEqual(1000);
    if (width > 760) {
      expect(after.checkbox.x).toBeGreaterThanOrEqual(after.wrap.x);
      expect(after.identity.x).toBeGreaterThanOrEqual(after.checkbox.right);
      expect(after.identity.right).toBeLessThanOrEqual(after.lastMetric.x);
      expect(after.identity.width).toBeLessThanOrEqual(240);
      const last = page.locator("tbody tr:last-child");
      const name = last.locator("td").nth(1);
      await name.hover();
      expect(
        await name.evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toBe(
        await last.evaluate((node) => getComputedStyle(node).backgroundColor),
      );
      await page.screenshot({ path: info.outputPath("scrolled-hover.png") });
      await last.getByRole("checkbox").focus();
      await page.keyboard.press("Space");
      await expect(last.getByRole("checkbox")).toBeFocused();
      await expect(last.getByRole("checkbox")).toBeChecked();
      expect((await measure()).scrollTop).toBe(after.scrollTop);
      expect(
        await name.evaluate((node) => getComputedStyle(node).boxShadow),
      ).not.toBe("none");
      await page.screenshot({ path: info.outputPath("scrolled-focus.png") });
      await page.mouse.move(0, 0);
      await page.locator(".run-table-scroll").focus();
      const backgrounds = await last
        .locator("td")
        .evaluateAll((cells) =>
          cells.map((cell) => getComputedStyle(cell).backgroundColor),
        );
      expect(backgrounds.slice(0, 2)).toEqual(
        await page
          .locator("tbody tr:first-child td")
          .evaluateAll((cells) =>
            cells
              .slice(0, 2)
              .map((cell) => getComputedStyle(cell).backgroundColor),
          ),
      );
      const all = page.getByRole("checkbox", {
        name: "Select all matching runs",
        exact: true,
      });
      await all.focus();
      await page.keyboard.press("Space");
      await expect(all).toBeFocused();
      await expect(all).toBeChecked();
      expect(
        await page.evaluate(
          () => (window as any).__layout.selections.at(-1).length,
        ),
      ).toBe(120);
      expect((await measure()).scrollTop).toBe(after.scrollTop);
      const sort = page.locator("thead th:last-child button");
      await sort.focus();
      await page.keyboard.press("Enter");
      await expect(sort).toBeFocused();
      expect((await measure()).scrollTop).toBe(after.scrollTop);
      await expect(
        page.getByRole("button", { name: /^(Next|Previous)$/ }),
      ).toHaveCount(0);
      await expect(
        page.locator("tbody input[type=checkbox]:checked"),
      ).toHaveCount(120);
    } else {
      expect(after.checkbox.x).toBeGreaterThanOrEqual(after.wrap.x);
      expect(after.identity.right).toBeLessThan(after.wrap.x);
      expect(after.wrap.width - 36).toBeGreaterThanOrEqual(300);
      expect(after.lastMetric.width).toBeLessThanOrEqual(after.wrap.width);
      expect(after.lastMetric.right).toBeLessThanOrEqual(after.wrap.right + 1);
    }
    // Wait through scroll-event delivery before and after each rebuild. Merely
    // checking synchronously misses an emptied header copying zero to the body.
    const settleScroll = () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    const sort = page.locator("thead th:last-child button");
    await sort.focus();
    await settleScroll();
    const beforeSort = await measure();
    expect(beforeSort.scrollLeft).toBeGreaterThan(0);
    for (const activation of ["click", "Enter", "Space"]) {
      if (activation === "click") await sort.click();
      else await page.keyboard.press(activation);
      await settleScroll();
      await expect(sort).toBeFocused();
      await expect(sort).toBeInViewport();
      expect((await measure()).scrollLeft).toBe(beforeSort.scrollLeft);
      expect((await measure()).scrollTop).toBe(beforeSort.scrollTop);
      expect(
        await page.locator("thead").evaluate((node) => node.scrollLeft),
      ).toBe(beforeSort.scrollLeft);
    }
  });
