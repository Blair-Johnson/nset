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
  validateConfig,
  formatValue,
  styleFor,
  type ViewConfig,
} from "./config";
import { extent, unionSorted } from "./utils";
import {
  resolveOptions,
  cosmeticPath,
  fillColor,
  rawMarkerOptions,
  pairedVisibility,
} from "./options";
import { matchedPath } from "./matched-path";
import type { Run } from "./api";
import { PlotNavigation, readViewport } from "./navigation";
import type { NavigationAxis, PlotInteraction } from "./workspace-types";
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
  yA?: number | null;
  yB?: number | null;
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
export class PlotPanel {
  private chart?: uPlot;
  private generation = 0;
  private interaction?: PlotInteraction;
  private navigation?: PlotNavigation;
  private resize: ResizeObserver;
  private config?: ViewConfig;
  private analyzed: Analyzed[] = [];
  private pinLabels: PinLabel[] = [];
  private pins: Pins = { a: null, b: null, threshold: null };
  constructor(
    private host: HTMLElement,
    private onPick: (x: number) => void,
    private onWarnings: (warnings: string[]) => void,
    private fillHost = false,
  ) {
    this.resize = new ResizeObserver(() => this.syncSize());
    this.resize.observe(host);
  }
  private syncSize() {
    if (!this.chart || !this.config || this.host.clientWidth <= 0) return;
    const width = this.fillHost
      ? this.host.clientWidth
      : (this.config.width ?? Math.max(320, this.host.clientWidth));
    const height = this.fillHost
      ? Math.max(100, this.host.clientHeight)
      : this.config.height;
    if (this.chart.width === width && this.chart.height === height) return;
    this.navigation?.cancelGesture();
    this.chart.setSize({ width, height });
  }

  /** Only replace display colors; retain uPlot, data arrays, scales and navigation history. */
  refreshColors(config: ViewConfig): void {
    if (!this.chart || !this.config) return;
    this.analyzed.forEach((data, index) => {
      const style = styleFor(config, data.run.id, index);
      const markers = rawMarkerOptions(style);
      for (const seriesIndex of [index * 2 + 1, index * 2 + 2]) {
        const series = this.chart!.series[seriesIndex];
        series.stroke = () => style.color;
        if (seriesIndex % 2 === 1)
          series.fill = () => fillColor(style) ?? "transparent";
        if (series.points) {
          series.points.stroke =
            typeof markers.stroke === "function"
              ? markers.stroke
              : () => markers.stroke as string;
          series.points.fill =
            typeof markers.fill === "function"
              ? markers.fill
              : () => markers.fill as string;
        }
      }
    });
    this.config = {
      ...this.config,
      runs: config.runs,
      palette: config.palette,
      style: config.style,
    };
    this.chart.redraw(true);
  }

  clear() {
    this.generation++;
    this.navigation?.destroy();
    this.navigation = undefined;
    this.chart?.destroy();
    this.chart = undefined;
    this.host.replaceChildren();
  }
  destroy() {
    this.clear();
    this.resize.disconnect();
  }
  setPins(pins: Pins) {
    this.pins = { ...pins };
    this.chart?.redraw(false);
  }
  configureInteraction(options: PlotInteraction): void {
    this.interaction = { ...options };
    if (this.navigation) this.navigation.configure(this.interaction);
    else this.attachNavigation();
  }
  private attachNavigation() {
    if (!this.chart || !this.interaction || !readViewport(this.chart)) return;
    this.navigation = new PlotNavigation(
      this.chart,
      this.interaction,
      () => this.pins,
      (pin, value) => this.setPins({ ...this.pins, [pin]: value }),
    );
  }
  zoom(factor: number, axis?: NavigationAxis): void {
    this.navigation?.zoom(factor, axis);
  }
  pan(dx: number, dy: number): void {
    this.navigation?.pan(dx, dy);
  }
  back(): void {
    this.navigation?.back();
  }
  canGoBack(): boolean {
    return this.navigation?.canGoBack() ?? false;
  }
  viewport(): { x: [number, number]; y: [number, number] } | null {
    return this.chart ? readViewport(this.chart) : null;
  }
  reset() {
    if (this.navigation) {
      this.navigation.reset();
      return;
    }
    if (this.config) this.render(this.analyzed, this.config, this.pins);
  }
  render(data: Analyzed[], config: ViewConfig, pins: Pins) {
    config = validateConfig(config);
    if (!data.some((d) => d.points.length)) {
      this.clear();
      this.config = config;
      this.analyzed = data;
      this.pins = pins;
      this.onWarnings([]);
      return;
    }
    const generation = this.generation + 1;
    // Only observation coordinates enter aligned data. Display subdivisions belong
    // to each run's path builder, never to its numeric engine or another run's grid.
    const xs = unionSorted(data.map((d) => d.points.map((p) => p[0]))).filter(
      (x) => config.xScale !== "log" || x > 0,
    );
    const aligned: uPlot.AlignedData = [xs];
    const series: uPlot.Series[] = [
      { label: config.axis === "step" ? "Step" : "Timestamp (ms)" },
    ];
    const warnings: string[] = [];
    const limited = new Map<string, string>();
    let warningQueued = false;
    const publishWarnings = () =>
      this.onWarnings([
        ...warnings,
        ...Array.from(
          limited.values(),
          (name) =>
            `${name}: matched display reached its adaptive approximation limit (target 0.35 CSS px). Numerical inspector values are unchanged.`,
        ),
      ]);
    const reportLimit = (id: string, name: string, hit: boolean) => {
      if (hit) limited.set(id, name);
      else limited.delete(id);
      if (!warningQueued) {
        warningQueued = true;
        queueMicrotask(() => {
          warningQueued = false;
          if (this.generation === generation) publishWarnings();
        });
      }
    };
    const rawEnabled: boolean[] = [];
    if ((config.advanced.legend as { live?: boolean } | undefined)?.live)
      warnings.push(
        "Live hover legend reports the nearest aligned observation-grid point, not an exact interpolated cursor value. The pinned inspector remains authoritative.",
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
      rawEnabled.push(
        s.markers?.show !== undefined ? s.markers.show !== false : s.points,
      );
      const excluded = d.points.filter(
        ([x, y]) =>
          (config.xScale === "log" && x <= 0) ||
          (config.yScale === "log" && y <= 0),
      ).length;
      if (excluded)
        warnings.push(
          `${d.run.name}: ${excluded} transformed samples are excluded from log display only. Analysis still includes every sample.`,
        );
      const rawExcluded = rawEnabled[i]
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
          `${d.run.name}: ${s.path} is a cosmetic display path; readouts use ${config.interpolation}. Choose “matched” for adaptive numerical-curve approximation.`,
        );
      const adaptive =
        s.path === "matched" &&
        (config.interpolation === "pchip" ||
          config.xScale !== "linear" ||
          config.yScale !== "linear");
      const alignment =
        s.pxAlign ??
        (adaptive
          ? ((config.advanced.pxAlign as boolean | number | undefined) ?? false)
          : undefined);
      aligned.push(xs.map((x) => valid(x, d.fn.at(x))));
      series.push({
        label: `${d.run.name}${config.smoothing ? " · smoothed" : ""}`,
        show: s.visible,
        stroke: s.color,
        width: s.width,
        dash: s.dash,
        cap: s.cap ?? "butt",
        alpha: s.alpha ?? 1,
        pxAlign: alignment,
        auto: s.auto ?? true,
        fill: fillColor(s),
        fillTo:
          s.fillTo ?? ((u) => (config.yScale === "log" ? u.scales.y.min! : 0)),
        paths:
          s.width === 0 && s.fill === 0 && rawEnabled[i]
            ? () => null
            : adaptive
              ? matchedPath(d.points, (x) => d.fn.at(x), {
                  fillTo: s.fillTo,
                  onLimited: (hit) => reportLimit(d.run.id, d.run.name, hit),
                })
              : cosmeticPath(s),
        spanGaps: false,
        points: { ...rawMarkerOptions(s), show: d.points.length === 1 },
        value: (_u, v) => (v == null ? "—" : formatValue(v, config.yFormat)),
      });
      const raw = new Map(d.observations);
      aligned.push(xs.map((x) => valid(x, raw.get(x) ?? null)));
      series.push({
        label: `${d.run.name} · observations`,
        show: s.visible && rawEnabled[i],
        auto: s.auto ?? true,
        alpha: s.alpha ?? 1,
        pxAlign: s.pxAlign,
        stroke: s.color,
        width: 0,
        paths: () => null,
        points: rawMarkerOptions(s),
        value: (_u, v) => (v == null ? "—" : formatValue(v, config.yFormat)),
      });
    });
    if (!xs.length) {
      warnings.push(
        "No positive x values are drawable on the logarithmic axis. Choose linear or asinh.",
      );
      this.clear();
      this.config = config;
      this.analyzed = data;
      this.pins = pins;
      this.onWarnings(warnings);
      return;
    }
    let visibilityChanges = 0;
    const opts = resolveOptions(config, this.host.clientWidth, series, {
      draw: [
        (u) => this.drawPins(u, this.chart === u ? this.pins : pins, config),
      ],
      setSeries: [
        (_u, _idx, patch) => {
          if (patch.show !== undefined) visibilityChanges++;
        },
      ],
      ready: [
        (u) => {
          u.root
            .querySelectorAll<HTMLElement>(".u-legend tbody .u-series")
            .forEach((row, i) => {
              row.dataset.seriesIndex = String(i + (u.legend.live ? 0 : 1));
            });
          let down: { x: number; y: number; distance: number } | undefined;
          const moved = (e: PointerEvent) => {
            if (down)
              down.distance = Math.max(
                down.distance,
                Math.hypot(e.clientX - down.x, e.clientY - down.y),
              );
          };
          u.over.addEventListener("pointerdown", (e) => {
            if (!this.interaction && e.button === 0 && e.isPrimary)
              down = { x: e.clientX, y: e.clientY, distance: 0 };
          });
          u.over.addEventListener("pointermove", moved);
          u.over.addEventListener("pointercancel", () => {
            down = undefined;
          });
          u.over.addEventListener("pointerleave", () => {
            down = undefined;
          });
          u.over.addEventListener("pointerup", (e) => {
            if (this.interaction) {
              down = undefined;
              return;
            }
            moved(e);
            const drag = opts.cursor?.drag;
            const threshold =
              opts.cursor?.show && (drag?.x || drag?.y)
                ? Math.min(5, drag.dist ?? 0)
                : 5;
            if (down && (down.distance === 0 || down.distance < threshold)) {
              const rect = u.over.getBoundingClientRect();
              const x = u.posToVal(e.clientX - rect.left, "x");
              if (Number.isFinite(x)) this.onPick(x);
            }
            down = undefined;
          });
        },
      ],
    });
    if (this.fillHost) {
      opts.width = Math.max(1, this.host.clientWidth);
      opts.height = Math.max(100, this.host.clientHeight);
    }
    opts.cursor!.bind = {
      mousedown: (_u, _target, native) => (event) => {
        if (!this.interaction) native(event);
        return null;
      },
      dblclick: (_u, _target, native) => (event) => {
        if (!this.interaction) native(event);
        return null;
      },
      click: (u, target, native) => (event) => {
        const selected = Number(
          target.closest<HTMLElement>(".u-series")?.dataset.seriesIndex,
        );
        const before = u.series.map((s) => s.show !== false),
          changes = visibilityChanges;
        if (!this.interaction || target !== u.over) native(event); // Legacy cursor lock and legends retain native behavior.
        if (selected > 0 && visibilityChanges !== changes) {
          const isolated =
            Boolean(event.ctrlKey || event.metaKey) !==
            Boolean(u.legend.isolate);
          const next = pairedVisibility(before, selected, isolated, rawEnabled);
          u.batch(() =>
            next.forEach((show, i) => {
              if (i > 0 && show !== u.series[i].show) u.setSeries(i, { show });
            }),
          );
        }
        return null;
      },
    };
    // Check range callbacks before construction. Stage/flush native init so a
    // rejected view leaves the existing chart and its configuration untouched.
    for (const axis of ["x", "y"] as const) {
      const values =
        axis === "x"
          ? xs
          : (aligned.slice(1) as (number | null)[][]).flatMap((v) =>
              v.filter((x): x is number => x != null),
            );
      const limits = extent(values) ?? [null, null];
      (opts.scales![axis].range as uPlot.Range.Function)(
        {} as uPlot,
        limits[0] as number,
        limits[1] as number,
        axis,
      );
    }
    const staging = document.createElement("div");
    let candidate: uPlot | undefined;
    try {
      candidate = new uPlot(opts, aligned, staging);
      candidate.batch(() => {});
    } catch (error) {
      candidate?.destroy();
      throw error;
    }
    this.navigation?.destroy();
    this.navigation = undefined;
    this.chart?.destroy();
    this.host.replaceChildren(...staging.childNodes);
    this.chart = candidate;
    this.config = config;
    this.analyzed = data;
    this.pins = pins;
    this.generation = generation;
    this.attachNavigation();
    this.interaction?.onViewChange?.();
    publishWarnings();
  }
  private drawPins(
    u: uPlot,
    pins: Pins = this.pins,
    config: ViewConfig | undefined = this.config,
  ) {
    const ctx = u.ctx;
    const { left, top, width, height } = u.bbox;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, width, height);
    ctx.clip();
    const ratio = window.devicePixelRatio || 1;
    ctx.lineWidth = 1.5 * ratio;
    ctx.font = `${12 * ratio}px ui-monospace`;
    const labels: PinLabel[] = [];
    for (const [label, value, color, axis] of [
      ["A x", pins.a, "#7dd3fc", "x"],
      ["B x", pins.b, "#d8b4fe", "x"],
      ["A y", pins.yA, "#7dd3fc", "y"],
      ["B y", pins.yB, "#d8b4fe", "y"],
      ["threshold", pins.threshold, "#fbbf24", "y"],
    ] as const) {
      if (
        value == null ||
        !Number.isFinite(value) ||
        ((axis === "x" ? config?.xScale : config?.yScale) === "log" &&
          value <= 0)
      )
        continue;
      const position = u.valToPos(value, axis, true);
      if (
        position < (axis === "x" ? left : top) ||
        position > (axis === "x" ? left + width : top + height)
      )
        continue;
      ctx.strokeStyle = color;
      ctx.setLineDash([5 * ratio, 4 * ratio]);
      ctx.beginPath();
      ctx.moveTo(axis === "x" ? position : left, axis === "x" ? top : position);
      ctx.lineTo(
        axis === "x" ? position : left + width,
        axis === "x" ? top + height : position,
      );
      ctx.stroke();
      labels.push({
        text: label,
        color,
        x: axis === "x" ? position + 7 * ratio : left + 7 * ratio,
        y: axis === "x" ? top + 5 * ratio : position - 23 * ratio,
        width: ctx.measureText(label).width + 10 * ratio,
        height: 20 * ratio,
      });
    }
    this.pinLabels = placePinLabels(
      labels,
      { x: left, y: top, width, height },
      3 * ratio,
    );
    ctx.setLineDash([]);
    for (const label of this.pinLabels) {
      ctx.fillStyle = "#202429";
      ctx.fillRect(label.x, label.y, label.width, label.height);
      ctx.fillStyle = label.color;
      ctx.fillText(label.text, label.x + 5 * ratio, label.y + 14 * ratio);
    }
    ctx.restore();
  }
}
export interface PinLabel {
  text: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Deterministic label packing in canvas pixels; never move the data-coordinate lines. */
export function placePinLabels(
  labels: PinLabel[],
  bounds: { x: number; y: number; width: number; height: number },
  gap = 3,
): PinLabel[] {
  const placed: PinLabel[] = [];
  for (const original of labels) {
    const label = {
      ...original,
      width: Math.min(original.width, bounds.width),
      height: Math.min(original.height, bounds.height),
    };
    const clamp = (x: number, y: number) => ({
      ...label,
      x: Math.max(bounds.x, Math.min(bounds.x + bounds.width - label.width, x)),
      y: Math.max(
        bounds.y,
        Math.min(bounds.y + bounds.height - label.height, y),
      ),
    });
    const overlaps = (candidate: PinLabel) =>
      placed.some(
        (other) =>
          candidate.x < other.x + other.width + gap &&
          candidate.x + candidate.width + gap > other.x &&
          candidate.y < other.y + other.height + gap &&
          candidate.y + candidate.height + gap > other.y,
      );
    let candidate = clamp(label.x, label.y);
    if (overlaps(candidate)) {
      const options: PinLabel[] = [];
      for (
        let y = bounds.y;
        y <= bounds.y + bounds.height - label.height;
        y += label.height + gap
      )
        for (const x of [
          label.x,
          bounds.x,
          bounds.x + bounds.width - label.width,
        ])
          options.push(clamp(x, y));
      options.sort(
        (a, b) =>
          Math.hypot(a.x - label.x, a.y - label.y) -
          Math.hypot(b.x - label.x, b.y - label.y),
      );
      const free = options.find((option) => !overlaps(option));
      if (!free) continue; // No collision is preferable to unreadable overlapping labels in a tiny plot.
      candidate = free;
    }
    placed.push(candidate);
  }
  return placed;
}

export function initialPins(data: Analyzed[]): Pins {
  const range = extent(data.flatMap((d) => d.points.map((p) => p[0])));
  return { a: range?.[0] ?? null, b: range?.[1] ?? null, threshold: null };
}
