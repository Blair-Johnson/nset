import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const candidates = `
[data-design=outlined] .card-header button:not([aria-pressed=true]):not(:hover) { background:var(--surface);border-color:var(--control-border);color:var(--text) }
[data-design=quiet] .card-header .card-chart-toolbar button,
[data-design=quiet] .card-header > button,
[data-design=grouped] .card-header .card-chart-toolbar button,
[data-design=grouped] .card-header > button { background:transparent;border-color:transparent;color:var(--muted) }
[data-design=quiet] .card-header button:hover:not(:disabled),
[data-design=grouped] .card-header button:hover:not(:disabled) { background:var(--surface-hover);border-color:transparent;color:var(--text) }
[data-design=quiet] .card-header button[aria-pressed=true],
[data-design=grouped] .card-header button[aria-pressed=true] { background:var(--selected);border-color:var(--accent);color:var(--accent) }
[data-design=grouped] .card-chart-toolbar { background:var(--surface-raised);box-shadow:0 0 0 1px var(--border);border-radius:5px }
`;

async function fixture(page: Page, width: number, compare = true) {
  await page.setViewportSize({ width, height: 1120 });
  await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    await import("/src/style.css");
    const { ChartCard } = await import("/src/cards.ts");
    const { newChart } = await import("/src/workspace.ts");
    document.body.style.cssText = "margin:0;padding:16px;display:block";
    const runs = ["Baseline", "Cosine schedule", "Warmup"].map((name, i) => ({
      id: `r${i}`,
      name,
      experiment_id: "e",
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
    }));
    const context = {
      api: {},
      selectedRunIds: runs.map((run) => run.id),
      catalog: {
        experiments: [],
        runs,
        series: runs.map((run) => ({
          run_id: run.id,
          key: "validation/loss",
          kind: "metric",
          count: 301,
          last_step: 300,
          last_timestamp: 300,
          last_value: 0.1,
        })),
      },
      store: {
        clear() {},
        async load({ runId }: { runId: string }) {
          return Array.from({ length: 301 }, (_, step) => ({
            seq: step + 1,
            step,
            timestamp: step,
            value:
              Math.exp(-step / 70) +
              0.1 +
              0.01 * Math.sin(step / 8 + Number(runId.slice(1))),
          }));
        },
      },
    };
    (window as any).designCards = [];
    for (const [variant, label] of [
      ["outlined", "A · Current outlined controls"],
      ["quiet", "B · Quiet icons"],
      ["grouped", "C · Grouped controls"],
    ]) {
      const section = document.createElement("section");
      section.style.cssText = "max-width:1000px;margin:0 auto 18px";
      section.dataset.design = variant;
      const heading = document.createElement("h2");
      heading.textContent = label;
      heading.style.cssText =
        "font-size:12px;font-weight:500;color:var(--muted);margin:0 0 6px";
      const host = document.createElement("div");
      section.append(heading, host);
      document.body.append(section);
      const spec = newChart(
        "timeseries",
        ["validation/loss"],
        "Validation loss",
      );
      spec.id = variant;
      spec.layout = { width: 1000, height: 290 };
      const card = new ChartCard(host, spec, context, {
        onEdit() {},
        onDuplicate() {},
        onRemove() {},
        onMove() {},
        onResize() {},
      });
      (window as any).designCards.push(card);
    }
  });
  if (compare) await page.addStyleTag({ content: candidates });
  await expect(page.locator(".u-over")).toHaveCount(3);
}

function contrast(a: string, b: string) {
  const luminance = (value: string) => {
    const rgb = (value.match(/[\d.]+/g) ?? [])
      .slice(0, 3)
      .map(Number)
      .map((x) => x / 255);
    const linear = rgb.map((x) =>
      x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4,
    );
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

for (const width of [1440, 390]) {
  test(`plot toolbar alternatives keep geometry and controls at ${width}px`, async ({
    page,
  }, info) => {
    await fixture(page, width);
    await page.mouse.move(0, 0);
    const measures = await page
      .locator("section[data-design]")
      .evaluateAll((sections) =>
        sections.map((section) => {
          const box = (selector: string) => {
            const r = section.querySelector(selector)!.getBoundingClientRect();
            return { width: r.width, height: r.height };
          };
          const style = getComputedStyle(section.querySelector(".chart-card")!);
          return {
            variant: (section as HTMLElement).dataset.design,
            card: box(".chart-card"),
            plot: box(".u-over"),
            header: box(".card-header"),
            background: style.backgroundColor,
            buttons: [
              ...section.querySelectorAll<HTMLButtonElement>(
                ".card-chart-toolbar button, .card-header > .card-button",
              ),
            ].filter((button) => !button.hidden).map((button) => {
              const s = getComputedStyle(button),
                r = button.getBoundingClientRect();
              return {
                name: button.getAttribute("aria-label"),
                width: r.width,
                height: r.height,
                border: s.borderColor,
                color: s.color,
                disabled: button.disabled,
              };
            }),
          };
        }),
      );
    for (const measure of measures) {
      expect(measure.plot).toEqual(measures[0].plot);
      expect(measure.header).toEqual(measures[0].header);
      expect(measure.buttons.map((b) => b.name)).toEqual(
        measures[0].buttons.map((b) => b.name),
      );
      for (const button of measure.buttons) {
        expect(button.width).toBeGreaterThanOrEqual(26);
        expect(button.height).toBeGreaterThanOrEqual(26);
        if (!button.disabled)
          expect(
            contrast(button.color, measure.background),
          ).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: info.outputPath("toolbar-alternatives.png"),
      fullPage: true,
    });
    await writeFile(
      info.outputPath("toolbar-measurements.json"),
      JSON.stringify(measures, null, 2),
    );
    console.log(
      JSON.stringify({ kind: "toolbar-alternatives", width, measures }),
    );
    for (const variant of ["outlined", "quiet", "grouped"]) {
      const section = page.locator(`[data-design=${variant}]`);
      const zoom = section.getByRole("button", {
        name: "Zoom in",
        exact: true,
      });
      await zoom.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(zoom).toBeFocused();
      const focus = await zoom.evaluate((node) => ({
        outline: getComputedStyle(node).outlineStyle,
        width: getComputedStyle(node).outlineWidth,
      }));
      expect(focus.outline).toBe("solid");
      expect(parseFloat(focus.width)).toBeGreaterThanOrEqual(2);
      await page.keyboard.press("Enter");
      await expect(
        section.getByRole("button", { name: "Previous view", exact: true }),
      ).toBeEnabled();
      await section
        .getByRole("button", { name: "Add vertical cursor", exact: true })
        .click();
      await expect(
        section.getByRole("button", {
          name: "Add vertical cursor",
          exact: true,
        }),
      ).toHaveAttribute("aria-pressed", "true");
      await section.screenshot({
        path: info.outputPath(`${variant}-active.png`),
      });
    }
  });
}

for (const width of [1440, 390]) {
  test(`production toolbar uses quiet distinct icons and retained focus at ${width}px`, async ({
    page,
  }, info) => {
    await fixture(page, width, false);
    const card = page.locator("[data-design=outlined] .chart-card");
    const icons = card.locator(".card-header svg:visible");
    await expect(icons).toHaveCount(7);
    const data = await icons.evaluateAll((nodes) =>
      nodes.map((node) => ({
        icon: (node as SVGElement).dataset.icon,
        hidden: node.getAttribute("aria-hidden"),
        path: node.querySelector("path")?.getAttribute("d"),
        width: node.getBoundingClientRect().width,
        height: node.getBoundingClientRect().height,
      })),
    );
    expect(new Set(data.map((item) => item.path)).size).toBe(7);
    for (const icon of data) {
      expect(icon.hidden).toBe("true");
      expect(icon.width).toBe(16);
      expect(icon.height).toBe(16);
    }
    const navigate = card.getByRole("button", { name: "Touch navigation: drag to inspect, two fingers to pan and pinch to zoom", exact: true });
    await expect(navigate).toBeHidden();
    const zoom = card.getByRole("button", { name: "Zoom in", exact: true });
    await page.mouse.move(0, 0);
    expect(
      await zoom.evaluate((node) => getComputedStyle(node).borderColor),
    ).toBe("rgba(0, 0, 0, 0)");
    await zoom.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(zoom).toBeFocused();
    expect(
      await zoom.evaluate((node) => getComputedStyle(node).outlineWidth),
    ).toBe("2px");
    await page.keyboard.press("Enter");
    await expect(
      card.getByRole("button", { name: "Previous view", exact: true }),
    ).toBeEnabled();
    const cursor = card.getByRole("button", {
      name: "Add vertical cursor",
      exact: true,
    });
    await cursor.click();
    await expect(cursor).toHaveAttribute("aria-pressed", "true");
    expect(
      await cursor.evaluate((node) => getComputedStyle(node).borderColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
    await card.screenshot({
      path: info.outputPath("production-toolbar-active.png"),
    });
    const fit = card.getByRole("button", {
      name: "Fit configured range",
      exact: true,
    });
    await expect(fit.locator("svg")).toHaveAttribute("data-icon", "fit");
    await card
      .getByRole("button", { name: "Maximize chart", exact: true })
      .click();
    const restore = card.getByRole("button", {
      name: "Restore chart",
      exact: true,
    });
    await expect(restore.locator("svg")).toHaveAttribute(
      "data-icon",
      "restore",
    );
    await expect(restore).toBeFocused();
    await card.screenshot({
      path: info.outputPath("production-toolbar-maximized.png"),
    });
    await restore.click();
    await expect(
      card
        .getByRole("button", { name: "Maximize chart", exact: true })
        .locator("svg"),
    ).toHaveAttribute("data-icon", "maximize");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}
