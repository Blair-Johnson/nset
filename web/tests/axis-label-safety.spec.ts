import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";

// Real ChartCard → PlotPanel → installed uPlot. Test-only alternatives are route transforms.
// Pixel evidence is retained; no claim of human screenshot inspection.
for (const dpr of [1, 2])
  for (const viewport of [390, 1440])
    for (const variant of ["baseline", "compact", "reserve", "production"]) {
      test(`${viewport} dpr${dpr} ${variant}: label safety`, async ({
        browser,
      }, info) => {
        test.setTimeout(120000);
        const context = await browser.newContext({
          viewport: { width: viewport, height: 1000 },
          deviceScaleFactor: dpr,
        });
        const page = await context.newPage();
        await page.route(/^http:\/\/127\.0\.0\.1:[0-9]+\/$/, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><html><body></body></html>",
          }),
        );
        await page.route("**/src/options.ts*", async (route) => {
          const response = await route.fetch();
          let original = await response.text();
          if (variant === "production") {
            await route.fulfill({ response, body: original });
            return;
          }
          // The baseline disables automatic label layout. Anchor on the whole
          // assignment, which branches for XY (metric) X axes.
          const layoutLine = /const labelLayout = quantity === "metric"[\s\S]*?: defaultLabelLayout\(config\);/;
          expect(original).toMatch(layoutLine);
          original = original.replace(
            layoutLine,
            "const labelLayout = { compactY: false, multilineTime: false };",
          );
          expect(original).toContain("return resolved;");
          const patch = `
        const variant = window.__axisReview.variant;
        const controlled = a => Object.keys(a ?? {}).some(k => !['stroke', 'grid', 'ticks'].includes(k)) || a?.ticks?.size !== undefined;
        const customY = controlled(config.advanced.axes?.[1]);
        const customLayout = config.advanced.padding !== undefined || (config.advanced.axes ?? []).some(controlled);
        if (variant !== 'baseline' && !customY && config.yFormat === 'number') {
          if (variant === 'compact') resolved.axes[1].values = (_u, values) => values.map(v => {
            if (v == null) return '';
            const plain = formatValue(v, 'number');
            const exp = Number(plain).toExponential().replace('e+', 'e');
            return exp.length < plain.length ? exp : plain;
          });
          else resolved.axes[1].size = 104;
        }
        if (variant !== 'baseline' && !customLayout && config.axis === 'timestamp' && config.xFormat === 'number') {
          if (variant === 'compact') {
            const original = resolved.axes[0].values;
            resolved.axes[0].values = (...args) => original(...args).map(s => s.replace(' ', '\\n'));
            resolved.axes[0].size = 48;
            resolved.axes[0].align = 2;
          } else resolved.padding = [20, 84, 8, 8];
        }
        return resolved;`;
          await route.fulfill({
            response,
            body: original.replace("return resolved;", patch),
          });
        });
        const cases: any[] = [
          { name: "small", values: [0, 1, 2, 3, 2, 1, 0] },
          { name: "large", values: [1e9, 2e9, 3e9, 4e9, 3e9, 2e9, 1e9] },
          {
            name: "fractional",
            values: [
              0.00011, 0.00012, 0.00013, 0.00014, 0.00013, 0.00012, 0.00011,
            ],
          },
          {
            name: "scientific",
            values: [1e15, 2e15, 3e15, 4e15, 3e15, 2e15, 1e15],
            yFormat: "scientific",
          },
          {
            name: "negative",
            values: [-12345, -10000, -5000, 0, -5000, -10000, -12345],
          },
          {
            name: "learning-rate-log",
            values: [1e-6, 1e-5, 1e-4, 1e-3, 1e-4, 1e-5, 1e-6],
            yScale: "log",
          },
          {
            name: "timestamp",
            values: [0, 1, 2, 3, 2, 1, 0],
            axis: "timestamp",
          },
          { name: "relative", values: [0, 1, 2, 3, 2, 1, 0], axis: "relative" },
          { name: "mixed", values: [0, 1, 2, 3, 2, 1, 0], mixed: true },
          {
            name: "nonredundant",
            values: [0, 1, 2, 3, 2, 1, 0],
            explicitLabel: true,
          },
          { name: "custom", values: [0, 1, 2, 3, 2, 1, 0], custom: true },
          {
            name: "custom-sides",
            values: [0, 1, 2, 3, 2, 1, 0],
            custom: true,
            sides: true,
          },
          {
            name: "negative-large",
            values: [-4e9, -3e9, -2e9, -1e9, -2e9, -3e9, -4e9],
          },
          {
            name: "timestamp-midnight",
            values: [0, 1, 2, 3, 2, 1, 0],
            axis: "timestamp",
            start: 1735689598000,
          },
          {
            name: "timestamp-ms",
            values: [0, 1, 2, 3, 2, 1, 0],
            axis: "timestamp",
            increment: 1,
          },
          {
            name: "timestamp-reversed",
            values: [0, 1, 2, 3, 2, 1, 0],
            axis: "timestamp",
            reversed: true,
          },
          {
            name: "large-reversed",
            values: [1e9, 2e9, 3e9, 4e9, 3e9, 2e9, 1e9],
            reversed: true,
          },
        ];
        const results: any[] = [];
        for (const scenario of cases) {
          await page.goto(info.project.use.baseURL as string);
          await page.evaluate(
            async ({ viewport, variant, scenario }: any) => {
              const w = window as any;
              w.__axisReview = {
                variant,
                redundant: !scenario.mixed,
                explicitLabel: scenario.explicitLabel,
              };
              const proto = CanvasRenderingContext2D.prototype;
              const original = proto.fillText;
              w.__text = [];
              proto.fillText = function (text, x, y, ...rest) {
                const m = this.measureText(text),
                  t = this.getTransform();
                const left = x - m.actualBoundingBoxLeft,
                  right = x + m.actualBoundingBoxRight;
                const top = y - m.actualBoundingBoxAscent,
                  bottom = y + m.actualBoundingBoxDescent;
                const points = [
                  [left, top],
                  [right, top],
                  [left, bottom],
                  [right, bottom],
                ].map(([a, b]) => new DOMPoint(a, b).matrixTransform(t));
                w.__text.push({
                  text,
                  canvas: this.canvas,
                  x: Math.min(...points.map((p) => p.x)),
                  y: Math.min(...points.map((p) => p.y)),
                  right: Math.max(...points.map((p) => p.x)),
                  bottom: Math.max(...points.map((p) => p.y)),
                  font: this.font,
                });
                return original.call(this, text, x, y, ...rest);
              };
              const { ChartCard } = await import("/src/cards.ts");
              const { newChart } = await import("/src/workspace.ts");
              document.body.style.cssText =
                "margin:16px;background:#191c20;color:#ddd;font:13px system-ui;--surface:#202429;--surface-raised:#252a30;--border:#42474e;--text:#ddd;--muted:#aaa;--control-border:#555;--accent:#7dd3fc";
              const host = document.createElement("div");
              host.style.cssText = `width:${viewport === 390 ? 358 : 1000}px;max-width:100%`;
              document.body.append(host);
              const runs = ["a", "b"].map((id) => ({
                id,
                name: `Run ${id}`,
                experiment_id: "e",
                status: "finished",
                params: {},
                tags: {},
                created_at: scenario.start ?? 1700000000000,
                updated_at: 0,
              }));
              const keys = scenario.mixed
                ? ["train/loss", "eval/accuracy"]
                : [
                    scenario.name === "learning-rate-log"
                      ? "learning_rate"
                      : "train/loss",
                  ];
              const spec = newChart(
                "timeseries",
                keys,
                scenario.mixed ? "Comparison" : keys[0],
              );
              spec.id = "axis-review";
              spec.layout = {
                width: viewport === 390 ? 358 : 1000,
                height: 290,
              };
              Object.assign(spec.config, {
                axis: scenario.axis ?? "step",
                yScale: scenario.yScale ?? "linear",
                ...(scenario.yFormat ? { yFormat: scenario.yFormat } : {}),
                ...(scenario.explicitLabel ? { yLabel: "Loss (nats)" } : {}),
              });
              if (scenario.reversed)
                spec.config.advanced = {
                  scales: { x: { dir: -1 }, y: { dir: -1 } },
                };
              if (scenario.custom)
                spec.config.advanced = {
                  padding: [24, 30, 10, 12],
                  axes: [
                    { size: 38, labelSize: 24 },
                    { size: 88, labelSize: 28 },
                  ],
                };
              if (scenario.sides) {
                spec.config.advanced.padding = [24, 30, 10, 24];
                spec.config.advanced.axes[0] = {
                  size: 38,
                  labelSize: 24,
                  side: 0,
                  label: "Step override",
                  values: "fixed-2",
                  font: "12px monospace",
                };
                spec.config.advanced.axes[1] = {
                  size: 88,
                  labelSize: 28,
                  side: 1,
                  label: "Loss (nats)",
                  values: "fixed-2",
                  font: "12px monospace",
                };
              }
              const context = {
                api: {},
                catalog: {
                  experiments: [],
                  runs,
                  series: runs.flatMap((run) =>
                    keys.map((key) => ({
                      run_id: run.id,
                      key,
                      kind: "metric",
                      count: 7,
                      last_step: 6,
                      last_timestamp: 1700000006000,
                      last_value: 0,
                    })),
                  ),
                },
                selectedRunIds: ["a", "b"],
                store: {
                  clear() {},
                  async load() {
                    return scenario.values.map(
                      (value: number, step: number) => ({
                        seq: step + 1,
                        step,
                        timestamp:
                          (scenario.start ?? 1700000000000) +
                          step * (scenario.increment ?? 1000),
                        value,
                      }),
                    );
                  },
                },
              };
              w.card = new ChartCard(host, spec, context, {
                onEdit() {},
                onRemove() {},
                onMove() {},
                onDuplicate() {},
                onResize() {},
                onDimensions() {},
              });
            },
            { viewport, variant, scenario },
          );
          await expect(page.locator(".u-over")).toBeVisible();
          await page.waitForTimeout(50);
          const measure = async (mode: string) => {
            const result = await page.evaluate(
              async ({ mode, scenario, variant, viewport }: any) => {
                const w = window as any,
                  c = w.card,
                  p = c.plot,
                  u = p.chart,
                  ratio = u.ctx.canvas.width / u.width;
                const xs = u.scales.x,
                  ys = u.scales.y;
                // All four badges deliberately meet near the top/right corner.
                p.pins = {
                  a: xs.max - (xs.max - xs.min) * 0.01,
                  b: xs.max - (xs.max - xs.min) * 0.02,
                  yA: ys.max - (ys.max - ys.min) * 0.01,
                  yB: ys.max - (ys.max - ys.min) * 0.02,
                  threshold: null,
                };
                w.__text = [];
                u.redraw(true, true);
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
                const labels = p.pinLabels.map((v: any) => ({ ...v }));
                const texts = w.__text
                  .filter((t: any) => t.canvas === u.ctx.canvas)
                  .map(({ canvas, ...v }: any) => v);
                const textCollisions = [];
                for (let i = 0; i < texts.length; i++)
                  for (let j = i + 1; j < texts.length; j++) {
                    const a = texts[i],
                      b = texts[j];
                    if (
                      Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 &&
                      Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0.5
                    )
                      textCollisions.push([a.text, b.text]);
                  }
                const clipped = texts.filter(
                  (t: any) =>
                    t.x < -0.5 ||
                    t.y < -0.5 ||
                    t.right > u.ctx.canvas.width + 0.5 ||
                    t.bottom > u.ctx.canvas.height + 0.5,
                );
                const collisions = [];
                for (let i = 0; i < labels.length; i++)
                  for (let j = i + 1; j < labels.length; j++) {
                    const a = labels[i],
                      b = labels[j];
                    if (
                      a.x < b.x + b.width &&
                      a.x + a.width > b.x &&
                      a.y < b.y + b.height &&
                      a.y + a.height > b.y
                    )
                      collisions.push([a.text, b.text]);
                  }
                const escaped = labels.filter(
                  (a: any) =>
                    a.x < u.bbox.left ||
                    a.y < u.bbox.top ||
                    a.x + a.width > u.bbox.left + u.bbox.width ||
                    a.y + a.height > u.bbox.top + u.bbox.height,
                );
                const axis = u.axes[1];
                const ctx = u.ctx;
                let pixelNonBackground = 0;
                const pixels = ctx.getImageData(
                  0,
                  0,
                  ctx.canvas.width,
                  ctx.canvas.height,
                ).data;
                for (let i = 3; i < pixels.length; i += 4)
                  if (pixels[i]) pixelNonBackground++;
                ctx.save();
                ctx.font = "11px ui-monospace, monospace";
                const maxTick = Math.max(
                  0,
                  ...axis._values
                    .filter((v: any) => v != null)
                    .map((v: any) => ctx.measureText(String(v)).width),
                );
                ctx.restore();
                const rect =
                  c.el?.getBoundingClientRect?.() ??
                  document
                    .querySelector(".chart-card")!
                    .getBoundingClientRect();
                return {
                  viewport,
                  variant,
                  scenario: scenario.name,
                  mode,
                  card: { width: rect.width, height: rect.height },
                  canvas: { width: u.width, height: u.height },
                  drawable: {
                    width: u.bbox.width / ratio,
                    height: u.bbox.height / ratio,
                    area: (u.bbox.width * u.bbox.height) / ratio ** 2,
                  },
                  ySize: axis._size,
                  yLabel: axis.label,
                  yLabelSize: axis.labelSize,
                  xSize: u.axes[0]._size,
                  xLabelSize: u.axes[0].labelSize,
                  padding: u._padding,
                  ticks: axis._values,
                  xTicks: u.axes[0]._values,
                  xSplits: u.axes[0]._splits,
                  scaleX: { min: xs.min, max: xs.max },
                  scaleY: { min: ys.min, max: ys.max },
                  pixelNonBackground,
                  xLabel: u.axes[0].label,
                  xAlign: u.axes[0].align,
                  sides: u.axes.map((a: any) => a.side),
                  sourcePoints: p.analyzed.map((d: any) => d.points),
                  alignedData: u.data,
                  maxTick,
                  gutterClearance: axis._size - maxTick - 15,
                  labels,
                  collisions,
                  textCollisions,
                  escaped,
                  clipped,
                  texts,
                  ratio,
                  overflow: document.documentElement.scrollWidth > viewport,
                };
              },
              { mode, scenario, variant, viewport },
            );
            results.push(result);
            writeFileSync(
              info.outputPath("measurements.json"),
              JSON.stringify(results, null, 2),
            );
            if (
              process.env.NSET_AXIS_CAPTURE === "all" ||
              (mode === "card" &&
                ["large", "timestamp", "timestamp-ms"].includes(
                  scenario.name,
                )) ||
              (variant !== "baseline" &&
                (result.clipped.length ||
                  result.textCollisions.length ||
                  result.collisions.length ||
                  result.escaped.length))
            ) {
              await page.screenshot({
                path: info.outputPath(`${scenario.name}-${mode}.png`),
                fullPage: true,
              });
            }
            expect(result.labels.length).toBe(4);
            expect(result.collisions).toEqual([]);
            expect(result.escaped).toEqual([]);
            // Baseline failures are evidence, not exceptions silently waived in the fixed variants.
            if (variant !== "baseline") {
              expect(result.clipped, `${scenario.name} ${mode}`).toEqual([]);
              expect(result.textCollisions, `${scenario.name} ${mode}`).toEqual(
                [],
              );
            } else if (mode === "card") {
              if (scenario.name === "large")
                expect(result.textCollisions.length).toBeGreaterThan(0);
              if (scenario.name === "timestamp")
                expect(result.clipped.length).toBeGreaterThan(0);
            }
            expect(result.pixelNonBackground).toBeGreaterThan(100);
            expect(result.yLabel).not.toBeNull();
            if (variant === "production" && scenario.axis === "timestamp") {
              expect(result.xSplits.every(Number.isInteger)).toBe(true);
              expect(new Set(result.xTicks.filter(Boolean)).size).toBe(
                result.xTicks.filter(Boolean).length,
              );
            }
            expect(
              result.ticks.filter((s: string) => s !== "").length,
            ).toBeGreaterThan(0);
            expect(
              result.xTicks.filter((s: string) => s !== "").length,
            ).toBeGreaterThan(0);
            if (mode === "card")
              expect(result.card.width).toBe(viewport === 390 ? 358 : 1000);
            if (scenario.sides) {
              expect(result.sides).toEqual([0, 1]);
              expect(result.xLabel).toBe("Step override");
              expect(result.yLabel).toBe("Loss (nats)");
              expect(
                result.ticks
                  .filter(Boolean)
                  .every((t: string) => /\.\d{2}$/.test(t)),
              ).toBe(true);
            }
            if (scenario.custom) {
              expect(result.ySize).toBe(88);
              expect(result.yLabelSize).toBe(28);
              expect(result.xSize).toBe(38);
              expect(result.xLabelSize).toBe(24);
              expect(result.padding).toEqual([
                24,
                30,
                10,
                scenario.sides ? 24 : 12,
              ]);
            }
          };
          await measure("card");
          if (variant === "production") {
            const initial = results[results.length - 1];
            for (let cycle = 0; cycle < 2; cycle++) {
              const box = (await page.locator(".u-over").boundingBox())!;
              const x = box.x + box.width * 0.6,
                y = box.y + box.height * 0.5;
              await page.mouse.move(x, y);
              await page.keyboard.down("Alt");
              await page.mouse.wheel(0, -90);
              await page.keyboard.up("Alt");
              await page.waitForTimeout(80);
              await measure(`zoom-${cycle}`);
              const zoomed = results[results.length - 1];
              expect(zoomed.drawable).toEqual(initial.drawable);
              expect(zoomed.scaleX).not.toEqual(initial.scaleX);
              await page.mouse.down({ button: "right" });
              await page.mouse.move(x - 14, y + 5, { steps: 4 });
              await page.mouse.up({ button: "right" });
              await page.waitForTimeout(60);
              await measure(`pan-${cycle}`);
              const panned = results[results.length - 1];
              expect(panned.drawable).toEqual(initial.drawable);
              expect(panned.scaleX).not.toEqual(zoomed.scaleX);
              expect(panned.sourcePoints).toEqual(initial.sourcePoints);
              expect(panned.alignedData).toEqual(initial.alignedData);
            }
            await page.evaluate(() => (window as any).card.plot.reset());
            await page.waitForTimeout(60);
            await measure("reset");
            expect(results[results.length - 1].drawable).toEqual(
              initial.drawable,
            );
            // Native renderer resizing, twice in each direction; no dynamic gutters.
            for (let cycle = 0; cycle < 2; cycle++) {
              await page.evaluate(() => {
                const u = (window as any).card.plot.chart;
                u.setSize({ width: u.width - 18, height: u.height + 25 });
              });
              await measure(`resize-${cycle}`);
              await page.evaluate(
                ({ width, height }) =>
                  (window as any).card.plot.chart.setSize({ width, height }),
                initial.canvas,
              );
              await measure(`resize-restored-${cycle}`);
              expect(results[results.length - 1].drawable).toEqual(
                initial.drawable,
              );
            }
          }
          if (["small", "large", "timestamp"].includes(scenario.name)) {
            await page.getByRole("button", { name: /Maximize chart/i }).click();
            await page.waitForTimeout(100);
            await measure("maximized");
            await page.getByRole("button", { name: /Restore chart/i }).click();
            await page.waitForTimeout(80);
            await measure("restored");
            if (variant === "production") {
              await page
                .getByRole("button", { name: /Maximize chart/i })
                .click();
              await page.waitForTimeout(80);
              await measure("maximized-again");
              await page
                .getByRole("button", { name: /Restore chart/i })
                .click();
              await page.waitForTimeout(80);
              await measure("restored-again");
            }
          }
        }
        writeFileSync(
          info.outputPath("measurements.json"),
          JSON.stringify(results, null, 2),
        );
        await context.close();
        console.log(
          JSON.stringify({
            kind: "final",
            viewport,
            dpr,
            variant,
            metrics: { cases: results.length },
            artifacts: { measurements: info.outputPath("measurements.json") },
          }),
        );
      });
    }
