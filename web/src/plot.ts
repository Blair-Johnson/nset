import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import {
  canonicalize,
  ema,
  makeInterpolator,
  type Point,
  type XY,
} from "./math";
import {
  deepMerge,
  formatValue,
  styleFor,
  type ViewConfig,
  type Formatter,
  type PathName,
} from "./config";
import { extent, unionSorted } from "./utils";
import type { Run } from "./api";
export interface PlotRun {
  run: Run;
  raw: Point[];
}
export interface Analyzed {
  run: Run;
  observations: XY[];
  points: XY[];
  fn: ReturnType<typeof makeInterpolator>;
  count: number;
}
export interface Pins {
  a: number | null;
  b: number | null;
  threshold: number | null;
}
export function analyze(data: PlotRun[], config: ViewConfig): Analyzed[] {
  return data.map(({ run, raw }) => {
    const observations = canonicalize(raw, config.axis);
    const points = config.smoothing
      ? ema(observations, config.alpha)
      : observations;
    return {
      run,
      observations,
      points,
      fn: makeInterpolator(points, config.interpolation),
      count: raw.length,
    };
  });
}
export function curveGrid(points: XY[], kind: "linear" | "pchip"): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const x = points[i][0];
    out.push(x);
    if (kind === "pchip" && i + 1 < points.length) {
      const end = points[i + 1][0];
      for (let j = 1; j < 16; j++) {
        const t = j / 16;
        const at = x * (1 - t) + end * t;
        if (Number.isFinite(at) && at > x && at < end) out.push(at);
      }
    }
  }
  return out;
}
function path(name: PathName): uPlot.Series.PathBuilder {
  if (name === "stepped-before") return uPlot.paths.stepped!({ align: -1 });
  if (name === "stepped-after") return uPlot.paths.stepped!({ align: 1 });
  if (name === "spline") return uPlot.paths.spline!();
  return uPlot.paths.linear!();
}
export class PlotPanel {
  private chart?: uPlot;
  private resize: ResizeObserver;
  private config?: ViewConfig;
  private analyzed: Analyzed[] = [];
  private pins: Pins = { a: null, b: null, threshold: null };
  constructor(
    private host: HTMLElement,
    private onPick: (x: number) => void,
    private onWarnings: (warnings: string[]) => void,
  ) {
    this.resize = new ResizeObserver(() => {
      if (this.chart && this.config && this.host.clientWidth > 0)
        this.chart.setSize({
          width: this.config.width ?? Math.max(320, this.host.clientWidth),
          height: this.config.height,
        });
    });
    this.resize.observe(host);
  }
  clear() {
    this.chart?.destroy();
    this.chart = undefined;
    this.host.replaceChildren();
  }
  destroy() {
    this.clear();
    this.resize.disconnect();
  }
  setPins(pins: Pins) {
    this.pins = pins;
    this.chart?.redraw(false);
  }
  reset() {
    if (this.config) this.render(this.analyzed, this.config, this.pins);
  }
  render(data: Analyzed[], config: ViewConfig, pins: Pins) {
    this.clear();
    this.config = config;
    this.analyzed = data;
    this.pins = pins;
    if (!data.some((d) => d.points.length)) return;
    const grids = data.map((d) => curveGrid(d.points, config.interpolation));
    const xs = unionSorted(grids).filter(
      (x) => config.xScale !== "log" || x > 0,
    );
    const aligned: uPlot.AlignedData = [xs];
    const series: uPlot.Series[] = [
      { label: config.axis === "step" ? "Step" : "Timestamp (ms)" },
    ];
    const warnings: string[] = [];
    if ((config.advanced.legend as { live?: boolean } | undefined)?.live)
      warnings.push(
        "Live hover legend reports the nearest drawing-grid point, not an exact interpolated cursor value. The pinned inspector remains authoritative.",
      );
    const valid = (x: number, y: number | null) =>
      y !== null &&
      Number.isFinite(y) &&
      (config.xScale !== "log" || x > 0) &&
      (config.yScale !== "log" || y > 0)
        ? y
        : null;
    data.forEach((d, i) => {
      const s = styleFor(config, d.run.id, i);
      const excluded = d.points.filter(
        ([x, y]) =>
          (config.xScale === "log" && x <= 0) ||
          (config.yScale === "log" && y <= 0),
      ).length;
      if (excluded)
        warnings.push(
          `${d.run.name}: ${excluded} transformed samples are excluded from log display only. Analysis still includes every sample.`,
        );
      const rawExcluded = s.points
        ? d.observations.filter(
            ([x, y]) =>
              (config.xScale === "log" && x <= 0) ||
              (config.yScale === "log" && y <= 0),
          ).length
        : 0;
      if (rawExcluded)
        warnings.push(
          `${d.run.name}: ${rawExcluded} raw point markers are excluded from log display only.`,
        );
      if (s.path !== "matched")
        warnings.push(
          `${d.run.name}: ${s.path} is a cosmetic display path; readouts use ${config.interpolation}. Choose “matched” for agreement.`,
        );
      aligned.push(xs.map((x) => valid(x, d.fn.at(x))));
      series.push({
        label: `${d.run.name} · ${config.smoothing ? "EMA" : "raw-derived"} ${config.interpolation}`,
        show: s.visible,
        stroke: s.color,
        width: s.width,
        dash: s.dash,
        fill: s.fill
          ? `${s.color}${Math.round(s.fill * 255)
              .toString(16)
              .padStart(2, "0")}`
          : undefined,
        paths: path(s.path),
        spanGaps: false,
        points: { show: false },
        value: (_u, v) => (v == null ? "—" : formatValue(v, config.yFormat)),
      });
      const raw = new Map(d.observations);
      aligned.push(xs.map((x) => valid(x, raw.get(x) ?? null)));
      series.push({
        label: `${d.run.name} · raw observations`,
        show: s.visible && s.points,
        stroke: s.color,
        width: 0,
        paths: () => null,
        points: {
          show: true,
          size: s.pointSize,
          width: 1,
          stroke: s.color,
          fill: "#121a28",
        },
        value: (_u, v) => (v == null ? "—" : formatValue(v, config.yFormat)),
      });
    });
    if (!xs.length) {
      warnings.push(
        "No positive x values are drawable on the logarithmic axis. Choose linear or asinh.",
      );
      this.onWarnings(warnings);
      return;
    }
    this.onWarnings(warnings);
    const scale = (
      kind: ViewConfig["xScale"],
      min: number | null,
      max: number | null,
    ): uPlot.Scale => ({
      time: false,
      distr: kind === "log" ? 3 : kind === "asinh" ? 4 : 1,
      asinh: 1,
      ...(min !== null || max !== null
        ? {
            range: (_u, lo, hi) => {
              let low = min ?? lo,
                high = max ?? hi;
              if (low >= high) {
                if (max === null)
                  high =
                    kind === "log"
                      ? low * 10
                      : low + Math.max(1, Math.abs(low) * 0.1);
                else
                  low =
                    kind === "log"
                      ? high / 10
                      : high - Math.max(1, Math.abs(high) * 0.1);
              }
              return [low, high] as [number, number];
            },
          }
        : {}),
    });
    const formatter =
      (name: Formatter): uPlot.Axis.Values =>
      (_u, values) =>
        values.map((v) => formatValue(v, name));
    const opts: uPlot.Options = {
      width: config.width ?? Math.max(320, this.host.clientWidth),
      height: config.height,
      padding: [20, 22, 8, 8],
      scales: {
        x: scale(config.xScale, config.xMin, config.xMax),
        y: scale(config.yScale, config.yMin, config.yMax),
      },
      series,
      axes: [
        {
          label:
            config.xLabel ||
            (config.axis === "step"
              ? "Step"
              : "Timestamp · UTC epoch milliseconds"),
          stroke: "#8f9db4",
          font: "11px ui-monospace, monospace",
          values: formatter(config.xFormat),
          size: 64,
          labelSize: 20,
          grid: { show: config.grid, stroke: "#263347", width: 1 },
          ticks: { show: config.ticks, stroke: "#455269" },
        },
        {
          label: config.yLabel || "Metric value",
          stroke: "#8f9db4",
          font: "11px ui-monospace, monospace",
          values: formatter(config.yFormat),
          size: 76,
          labelSize: 22,
          grid: { show: config.grid, stroke: "#263347", width: 1 },
          ticks: { show: config.ticks, stroke: "#455269" },
        },
      ],
      legend: { show: config.legend, live: false },
      cursor: {
        show: config.cursor,
        drag: { x: config.zoom, y: false, dist: 8 },
        points: { show: false },
      },
      hooks: {
        draw: [(u) => this.drawPins(u)],
        ready: [
          (u) => {
            let down: { x: number; y: number } | undefined;
            u.over.addEventListener("pointerdown", (e) => {
              down = { x: e.clientX, y: e.clientY };
            });
            u.over.addEventListener("pointerup", (e) => {
              if (
                down &&
                Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5
              ) {
                const rect = u.over.getBoundingClientRect();
                const x = u.posToVal(e.clientX - rect.left, "x");
                if (Number.isFinite(x)) this.onPick(x);
              }
              down = undefined;
            });
          },
        ],
      },
    };
    // User patches cannot target data, hooks, scales or series. Resolve named callbacks explicitly.
    const resolved = deepMerge(opts, config.advanced);
    resolved.axes?.forEach((axis) => {
      if (typeof axis.values === "string")
        axis.values = formatter(axis.values as Formatter);
    });
    this.chart = new uPlot(resolved, aligned, this.host);
  }
  private drawPins(u: uPlot) {
    const ctx = u.ctx;
    const { left, top, width, height } = u.bbox;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();
    const ratio = window.devicePixelRatio || 1;
    ctx.lineWidth = 1.5 * ratio;
    ctx.font = `${11 * ratio}px ui-monospace, monospace`;
    const vertical = (value: number | null, label: string, color: string) => {
      if (value === null) return;
      const x = u.valToPos(value, "x", true);
      if (!Number.isFinite(x)) return;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.setLineDash([5 * ratio, 4 * ratio]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, top + height);
      ctx.stroke();
      ctx.fillText(label, x + 5 * ratio, top + 15 * ratio);
    };
    vertical(this.pins.a, "A", "#76d5ff");
    vertical(this.pins.b, "B", "#b5a1ff");
    if (this.pins.threshold !== null) {
      const y = u.valToPos(this.pins.threshold, "y", true);
      if (Number.isFinite(y)) {
        ctx.strokeStyle = "#ffc77a";
        ctx.fillStyle = "#ffc77a";
        ctx.setLineDash([3 * ratio, 4 * ratio]);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();
        ctx.fillText("threshold", left + 8 * ratio, y - 6 * ratio);
      }
    }
    ctx.restore();
  }
}
export function initialPins(data: Analyzed[]): Pins {
  const range = extent(data.flatMap((d) => d.points.map((p) => p[0])));
  return { a: range?.[0] ?? null, b: range?.[1] ?? null, threshold: null };
}
