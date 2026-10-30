import uPlot from "uplot";
import { logAxisSplits } from "./log-ticks";
import {
  defaultLabelLayout,
  formatNumberTicks,
  formatTimestampTick,
  timestampTickIncrements,
} from "./axis-labels";
import {
  deepMerge,
  formatValue,
  validateConfig,
  type ViewConfig,
  type RunStyle,
  type Formatter,
  type Scale,
} from "./config";

export interface ScalePatch {
  dir?: 1 | -1;
  log?: 2 | 10;
  asinh?: number;
  auto?: boolean;
  range?: uPlot.Range.MinMax | uPlot.Range.Config;
}

/** Trusted adapter for BOTH aligned x and y. Native aligned x does not wrap range objects. */
export function resolveScale(
  kind: Scale,
  axis: "x" | "y",
  min: number | null,
  max: number | null,
  patch: ScalePatch = {},
): uPlot.Scale {
  const base = patch.log ?? 10;
  const literal =
    patch.range ??
    (min !== null || max !== null
      ? ([min, max] as uPlot.Range.MinMax)
      : undefined);
  const tuple = Array.isArray(literal) ? literal : undefined;
  const cfg = literal && !Array.isArray(literal) ? literal : undefined;
  const fixedMin =
    tuple?.[0] ?? (patch.auto === false ? cfg?.min?.hard : undefined);
  const fixedMax =
    tuple?.[1] ?? (patch.auto === false ? cfg?.max?.hard : undefined);
  const range: uPlot.Range.Function = (_u, dataMin, dataMax) => {
    let lo =
      Number.isFinite(dataMin) && (kind !== "log" || dataMin > 0)
        ? dataMin
        : kind === "log"
          ? 1
          : 0;
    let hi =
      Number.isFinite(dataMax) && (kind !== "log" || dataMax > 0)
        ? dataMax
        : kind === "log"
          ? base
          : 1;
    const sourceMin = lo,
      sourceMax = hi;
    if (cfg && patch.auto !== false) {
      [lo, hi] = uPlot.rangeNum(lo, hi, {
        min: cfg.min ?? {},
        max: cfg.max ?? {},
      }) as [number, number];
      // Linear padding can cross zero. Only the automatic padded edge is repaired;
      // configured hard/soft log bounds have already been validated as positive.
      if (kind === "log" && !(lo > 0))
        lo = Math.max(Number.MIN_VALUE, sourceMin / base, cfg.min?.hard ?? 0);
    } else if (!tuple && patch.auto !== false) {
      if (kind === "log")
        [lo, hi] = uPlot.rangeLog(lo, hi, base, false) as [number, number];
      else if (axis === "y")
        [lo, hi] = uPlot.rangeNum(lo, hi, 0.1, true) as [number, number];
    }
    lo = fixedMin ?? lo;
    hi = fixedMax ?? hi;
    if (!(lo < hi)) {
      if (fixedMin != null && fixedMax != null)
        throw new Error(`${axis} range: minimum must be less than maximum.`);
      const hardMin = cfg?.min?.hard,
        hardMax = cfg?.max?.hard;
      if (fixedMax != null || (hardMax != null && fixedMin == null)) {
        hi = fixedMax ?? hardMax!;
        lo = kind === "log" ? hi / base : hi - Math.max(1, Math.abs(hi) * 0.1);
        if (hardMin != null) lo = Math.max(lo, hardMin);
      } else {
        lo = fixedMin ?? hardMin ?? lo;
        hi = kind === "log" ? lo * base : lo + Math.max(1, Math.abs(lo) * 0.1);
        if (hardMax != null) hi = Math.min(hi, hardMax);
      }
    }
    if (
      ![lo, hi].every(Number.isFinite) ||
      !(lo < hi) ||
      (kind === "log" && lo <= 0)
    )
      throw new Error(
        `${axis} ${kind} range cannot produce finite ascending${kind === "log" ? " positive" : ""} bounds from [${sourceMin}, ${sourceMax}]. Reduce extreme bounds or padding.`,
      );
    return [lo, hi];
  };
  return {
    time: false,
    distr: kind === "log" ? 3 : kind === "asinh" ? 4 : 1,
    asinh: patch.asinh ?? 1,
    log: base,
    dir: patch.dir ?? 1,
    auto: patch.auto ?? !(tuple && tuple[0] !== null && tuple[1] !== null),
    range,
  };
}

export const formatter =
  (name: Formatter): uPlot.Axis.Values =>
  (_u, values) =>
    values.map((v) => (v == null ? "" : formatValue(v, name)));

/** Elapsed backend milliseconds, never a calendar date. Preserve sub-ms values,
 * carry rounded milliseconds across unit boundaries, and do not wrap at 24h.
 * Beyond exact integer milliseconds, use compact days instead of false precision.
 */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "—";
  const sign = milliseconds < 0 ? "-" : "";
  const absolute = Math.abs(milliseconds);
  if (absolute < 1000) return `${sign}${Number(absolute.toPrecision(6))} ms`;
  if (absolute > Number.MAX_SAFE_INTEGER)
    return `${sign}${Number((absolute / 86_400_000).toPrecision(6))}d`;
  let remaining = Math.round(absolute);
  const parts: string[] = [];
  for (const [unit, size] of [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
  ] as const) {
    const amount = Math.floor(remaining / size);
    if (amount) parts.push(`${amount}${unit}`);
    remaining %= size;
  }
  if (remaining || !parts.length) parts.push(`${remaining / 1000}s`);
  return sign + parts.join(" ");
}

/** What the horizontal axis shows: the join parameter itself, or a metric
 * (XY charts, where `config.axis` is only the hidden join parameter). */
export type XQuantity = ViewConfig["axis"] | "metric";

/** Relative axes interpret default/legacy ISO formatting as elapsed duration.
 * Explicit numeric formats and static advanced labels remain user-controlled.
 */
function xFormatter(axis: XQuantity, name: Formatter): uPlot.Axis.Values {
  return (_u, values) =>
    values.map((value) =>
      value == null ? "" : formatXValue(value, axis, name),
    );
}

/** Coordinate readouts and ticks share axis semantics, including legacy ISO on elapsed axes. */
export function formatXValue(
  value: number,
  axis: XQuantity,
  name: Formatter,
): string {
  if (axis === "relative" && (name === "number" || name === "iso-time"))
    return formatDuration(value);
  return formatValue(
    value,
    axis === "timestamp" && name === "number" ? "iso-time" : name,
  );
}

/** Moving coordinates use the effective axis notation. Static label arrays
 * describe only their explicit splits, so arbitrary coordinates use base format. */
export function coordinateFormatter(
  config: ViewConfig,
  quantity: XQuantity,
  index: number,
): (value: number) => string {
  const axes = config.advanced?.axes as { values?: unknown }[] | undefined;
  const override = axes?.[index]?.values;
  if (typeof override === "string") {
    return index === 0 && quantity === "relative"
      ? (value) => formatXValue(value, quantity, override as Formatter)
      : (value) => formatValue(value, override as Formatter);
  }
  return index === 0
    ? (value) => formatXValue(value, quantity, config.xFormat)
    : (value) => formatValue(value, config.yFormat);
}

/** All user literals pass validation; internal callbacks/series/hooks are never patched. */
export function resolveOptions(
  config: ViewConfig,
  width: number,
  series: uPlot.Series[],
  hooks: uPlot.Hooks.Arrays = {},
  quantity: XQuantity = config.axis,
): uPlot.Options {
  config = validateConfig(config);
  const labelLayout =
    quantity === "metric"
      ? { ...defaultLabelLayout(config), multilineTime: false }
      : defaultLabelLayout(config);
  const { scales: scalePatches, ...presentation } = config.advanced;
  const patches = (scalePatches ?? {}) as { x?: ScalePatch; y?: ScalePatch };
  const opts: uPlot.Options = {
    width: config.width ?? Math.max(320, width),
    height: config.height,
    padding: [20, 22, 8, 8],
    scales: {
      x: resolveScale(config.xScale, "x", config.xMin, config.xMax, patches.x),
      y: resolveScale(config.yScale, "y", config.yMin, config.yMax, patches.y),
    },
    series,
    axes: [
      {
        label:
          config.xLabel ||
          (quantity === "metric"
            ? "Metric value"
            : quantity === "step"
              ? "Step"
              : quantity === "relative"
                ? "Relative time · from run start"
                : "Timestamp · UTC epoch milliseconds"),
        stroke: "#abb3bc",
        font: "11px ui-monospace, monospace",
        values: labelLayout.multilineTime
          ? (_u, values) =>
              values.map((v) => (v == null ? "" : formatTimestampTick(v)))
          : quantity === "metric" && config.xFormat === "number"
            ? (_u, values) => formatNumberTicks(values)
            : xFormatter(quantity, config.xFormat),
        // End native multiline UTC labels at the tick; no moving gutters,
        // hidden endpoint ticks, or shorter coordinate readouts.
        ...(labelLayout.multilineTime
          ? { align: 2 as const, incrs: timestampTickIncrements }
          : {}),
        space:
          quantity === "timestamp"
            ? labelLayout.multilineTime
              ? 100
              : 170
            : quantity === "relative"
              ? 100
              : quantity === "metric"
                ? 70
                : 50,
        size: labelLayout.multilineTime ? 44 : 32,
        labelSize: 20,
        grid: { show: config.grid, stroke: "#363b40", width: 1 },
        ticks: { show: config.ticks, stroke: "#737b84" },
      },
      {
        label: config.yLabel || "Metric value",
        stroke: "#abb3bc",
        font: "11px ui-monospace, monospace",
        values: labelLayout.compactY
          ? (_u, values) => formatNumberTicks(values)
          : formatter(config.yFormat),
        // Tall (maximized) plots get breathing room rather than a tick every 50px.
        space: 40,
        size: 76,
        labelSize: 22,
        grid: { show: config.grid, stroke: "#363b40", width: 1 },
        ticks: { show: config.ticks, stroke: "#737b84" },
      },
    ],
    legend: { show: config.legend, live: false },
    cursor: {
      show: config.cursor,
      drag: { x: config.zoom, y: false, dist: 8 },
      points: { show: false },
    },
    hooks,
  };
  const resolved = deepMerge(opts, presentation);
  // Native cursor markers need the built-in HTMLElement factory. A literal true
  // is otherwise wrapped into a function returning true, which creates no DOM.
  if (resolved.cursor?.points?.show === true)
    delete resolved.cursor.points.show;
  if (resolved.cursor?.drag?.uni === null) delete resolved.cursor.drag.uni;
  if (resolved.cursor?.hover?.skip)
    resolved.cursor.hover.skip = [undefined, ...resolved.cursor.hover.skip];
  resolved.axes?.forEach((axis, index) => {
    const scale = resolved.scales?.[axis.scale ?? (index === 0 ? "x" : "y")];
    if (scale?.distr === 3 && axis.splits === undefined) {
      // Native log splits can stop advancing after a fractional pan. Our
      // bounded generator already spaces labels, including on reversed axes.
      axis.splits = logAxisSplits;
      axis.filter ??= (_u, values) => values;
    }
    if (typeof axis.values === "string") {
      const format = coordinateFormatter(config, quantity, index);
      axis.values = (_u, values) =>
        values.map((value) => (value == null ? "" : format(value)));
    } else if (Array.isArray(axis.values)) {
      // Static labels must stay attached to their split value when zoomed or
      // when uPlot filters log ticks. Resolve to trusted callbacks, not index labels.
      const labels = axis.values as (string | number | null)[];
      const splits = axis.splits as number[];
      const byValue = new Map(splits.map((x, i) => [x, labels[i]]));
      axis.values = (_u, values) => values.map((x) => byValue.get(x) ?? "");
      axis.filter = (_u, values) => values;
    }
  });
  return resolved;
}

/** Hex fast path; browser canvas normalizes other validated literal CSS colors. */
export function fillColor(style: RunStyle): string | undefined {
  if (!style.fill) return undefined;
  const color = style.fillColor ?? style.color;
  if (/^#[0-9a-f]{6}$/i.test(color))
    return `${color}${Math.round(style.fill * 255)
      .toString(16)
      .padStart(2, "0")}`;
  if (typeof document === "undefined") return color; // tests inspect literals; browser supplies alpha normalization.
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.globalAlpha = style.fill;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r},${g},${b},${a / 255})`;
}

export function cosmeticPath(style: RunStyle): uPlot.Series.PathBuilder {
  const options = style.pathOptions ?? {};
  if (style.path === "stepped-before" || style.path === "stepped-after")
    return uPlot.paths.stepped!({
      align: style.path === "stepped-before" ? -1 : 1,
      ...options,
    });
  if (style.path === "spline")
    return uPlot.paths.spline!({ alignGaps: options.alignGaps });
  return uPlot.paths.linear!({ alignGaps: options.alignGaps });
}

export function rawMarkerOptions(style: RunStyle): uPlot.Series.Points {
  const { show, ...markers } = style.markers ?? {};
  return {
    ...(show === "auto" ? {} : { show: show ?? true }),
    size: style.pointSize,
    width: 1,
    stroke: style.color,
    fill: "#1e2022",
    ...markers,
  };
}

/** One run has two protected series slots. Raw visibility can never outlive its derived run. */
export function pairedVisibility(
  current: readonly boolean[],
  selected: number,
  isolate: boolean,
  rawEnabled: readonly boolean[],
): boolean[] {
  const run = Math.floor((selected - 1) / 2);
  if (run < 0 || run >= rawEnabled.length) return [...current];
  const othersShown = rawEnabled.some(
    (_v, i) => i !== run && current[1 + i * 2],
  );
  return current.map((show, index) => {
    if (index === 0) return show;
    const i = Math.floor((index - 1) / 2);
    const derived = isolate
      ? !othersShown || i === run
      : i === run
        ? !current[1 + run * 2]
        : current[1 + i * 2];
    return derived && (index % 2 === 1 || rawEnabled[i]);
  });
}
