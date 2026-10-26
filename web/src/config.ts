export type Scale = "linear" | "log" | "asinh";
export type PathName =
  "matched" | "linear" | "stepped-before" | "stepped-after" | "spline";
export type Formatter = "number" | "fixed-2" | "scientific" | "iso-time";
export type LineCap = "butt" | "round" | "square";
export interface MarkerStyle {
  show?: boolean | "auto";
  size?: number;
  space?: number;
  width?: number;
  stroke?: string;
  fill?: string;
  dash?: number[];
  cap?: LineCap;
}
export interface PathOptions {
  alignGaps?: -1 | 0 | 1;
  align?: -1 | 1;
  ascDesc?: boolean;
  extend?: boolean;
}
export interface RangeLimit {
  pad?: number;
  soft?: number;
  mode?: 0 | 1 | 2 | 3;
  hard?: number;
}
export type LiteralRange =
  [number | null, number | null] | { min: RangeLimit; max: RangeLimit };
export interface ScaleOptions {
  dir?: 1 | -1;
  log?: 2 | 10;
  asinh?: number;
  auto?: boolean;
  range?: LiteralRange;
}
export interface RunStyle {
  color: string;
  width: number;
  dash: number[];
  points: boolean;
  pointSize: number;
  fill: number;
  visible: boolean;
  path: PathName;
  cap?: LineCap;
  alpha?: number;
  pxAlign?: boolean | number;
  fillColor?: string;
  fillTo?: number;
  auto?: boolean;
  markers?: MarkerStyle;
  pathOptions?: PathOptions;
}
export interface ViewConfig {
  version: 1;
  axis: "step" | "timestamp" | "relative";
  interpolation: "linear" | "pchip";
  smoothing: boolean;
  alpha: number;
  xScale: Scale;
  yScale: Scale;
  xMin: number | null;
  xMax: number | null;
  yMin: number | null;
  yMax: number | null;
  xLabel: string;
  yLabel: string;
  xFormat: Formatter;
  yFormat: Formatter;
  height: number;
  width: number | null;
  grid: boolean;
  ticks: boolean;
  legend: boolean;
  cursor: boolean;
  zoom: boolean;
  palette: boolean;
  style: RunStyle;
  runs: Record<string, Partial<RunStyle>>;
  advanced: Record<string, unknown>;
}
export const palette = [
  "#60a5fa",
  "#c084fc",
  "#fbbf24",
  "#34d399",
  "#fb7185",
  "#22d3ee",
  "#f97316",
  "#e879f9",
];
export function defaults(): ViewConfig {
  return {
    version: 1,
    axis: "step",
    interpolation: "linear",
    smoothing: false,
    alpha: 0.2,
    xScale: "linear",
    yScale: "linear",
    xMin: null,
    xMax: null,
    yMin: null,
    yMax: null,
    xLabel: "",
    yLabel: "",
    xFormat: "number",
    yFormat: "number",
    height: 440,
    width: null,
    grid: true,
    ticks: true,
    legend: true,
    cursor: true,
    zoom: true,
    palette: true,
    style: {
      color: palette[0],
      width: 2,
      dash: [],
      points: false,
      pointSize: 5,
      fill: 0,
      visible: true,
      path: "matched",
    },
    runs: {},
    advanced: {},
  };
}
const badKeys = new Set(["__proto__", "constructor", "prototype"]);
/** Validate JSON shape without imposing local size/count/depth budgets. */
export function assertSafe(value: unknown, path = "$"): void {
  type Frame = { value: unknown; path: string; exit?: boolean };
  const stack: Frame[] = [{ value, path }];
  // Only ancestors count as cycles: repeated references in separate branches are JSON-safe.
  const ancestors = new WeakSet<object>();
  while (stack.length) {
    const { value: v, path: p, exit } = stack.pop()!;
    if (exit) {
      ancestors.delete(v as object);
      continue;
    }
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v))
    )
      continue;
    if (typeof v !== "object")
      throw new Error(
        `${p}: only finite JSON values are supported; executable callbacks are not accepted.`,
      );
    if (ancestors.has(v))
      throw new Error(`${p}: cyclic JSON values are unsupported.`);
    const array = Array.isArray(v);
    const prototype = Object.getPrototypeOf(v);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new Error(`${p}: plain JSON objects and arrays required.`);
    if (Object.getOwnPropertySymbols(v).length)
      throw new Error(`${p}: symbol keys are not JSON.`);
    const entries = Object.entries(Object.getOwnPropertyDescriptors(v));
    if (array && entries.length !== v.length + 1)
      throw new Error(`${p}: dense JSON arrays required.`);
    ancestors.add(v);
    stack.push({ value: v, path: p, exit: true });
    for (const [key, descriptor] of entries) {
      if (array && key === "length") continue;
      if (badKeys.has(key)) throw new Error(`${p}.${key}: protected key.`);
      if (!descriptor.enumerable || !("value" in descriptor))
        throw new Error(
          `${p}.${key}: plain JSON properties required; accessors are unsupported.`,
        );
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length))
        throw new Error(`${p}: dense JSON arrays required.`);
      stack.push({ value: descriptor.value, path: `${p}.${key}` });
    }
  }
}
export function parseSafeJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  assertSafe(value);
  return value;
}
function object(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path}: expected object.`);
}
function bool(v: unknown, p: string) {
  if (typeof v !== "boolean") throw new Error(`${p}: expected boolean.`);
}
function str(v: unknown, p: string) {
  if (typeof v !== "string") throw new Error(`${p}: expected string.`);
}
function num(v: unknown, p: string, min = -Infinity, max = Infinity) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new Error(`${p}: expected finite number in [${min}, ${max}].`);
}
function choice(v: unknown, p: string, values: readonly (string | number)[]) {
  if ((typeof v !== "string" && typeof v !== "number") || !values.includes(v))
    throw new Error(
      `${p}: choose ${values.join(", ")}; executable callbacks are unsupported.`,
    );
}
const namedColors = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  ),
);
/** Literal colors only: never URLs, variables, relative colors, CSS-wide keywords or executable CSS. */
export function isSafeColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  if (
    !v ||
    /[;{}<>\\'"\x00-\x1f]/.test(v) ||
    /(?:url|var|env|calc|expression)\s*\(|\/\*|\bfrom\b/.test(v)
  )
    return false;
  const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v);
  const named = namedColors.has(v);
  const fn =
    /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(([^()]*)\)$/.exec(v);
  if (!hex && !named && !fn) return false;
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function")
    return CSS.supports("color", v);
  if (hex || named) return true;
  // Node/test fallback deliberately supports only numeric rgb/hsl forms.
  if (!fn || !["rgb", "rgba", "hsl", "hsla"].includes(fn[1])) return false;
  const body = fn[2].trim();
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i;
  let parts: string[];
  if (body.includes(",")) {
    if (body.includes("/")) return false;
    parts = body.split(",").map((x) => x.trim());
  } else {
    if ((body.match(/\//g) ?? []).length > 1) return false;
    const [channels, alpha] = body.split("/");
    parts = channels.trim().split(/\s+/);
    if (parts.length !== 3) return false;
    if (alpha !== undefined) parts.push(alpha.trim());
  }
  if (parts.length !== 3 && parts.length !== 4) return false;
  if (fn[1].startsWith("hsl")) {
    if (parts[0].endsWith("%")) return false;
    parts[0] = parts[0].replace(/(?:deg|grad|rad|turn)$/, "");
    if (!parts[1].endsWith("%") || !parts[2].endsWith("%")) return false;
  }
  return parts.every(
    (x) => numeric.test(x) && Number.isFinite(Number(x.replace(/%$/, ""))),
  );
}
function color(v: unknown, p: string) {
  if (!isSafeColor(v))
    throw new Error(
      `${p}: expected a safe CSS literal color (hex, named, rgb or hsl); URLs and variables are unsupported.`,
    );
}
function arrayNumbers(v: unknown, p: string, min = -Infinity, max = Infinity) {
  if (!Array.isArray(v)) throw new Error(`${p}: expected numeric array.`);
  v.forEach((n, i) => num(n, `${p}[${i}]`, min, max));
}
function increasing(v: unknown, p: string, positive = false, empty = false) {
  arrayNumbers(v, p, positive ? Number.MIN_VALUE : -Infinity);
  const a = v as number[];
  if ((!empty && !a.length) || a.some((n, i) => i > 0 && n <= a[i - 1]))
    throw new Error(
      `${p}: expected ${positive ? "positive " : ""}strictly increasing values.`,
    );
}
function pxAlign(v: unknown, p: string) {
  if (typeof v !== "boolean") num(v, p, 0, 10);
}
const caps = ["butt", "round", "square"];
const paths = [
  "matched",
  "linear",
  "stepped-before",
  "stepped-after",
  "spline",
];
const formats = ["number", "fixed-2", "scientific", "iso-time"];
type Check = (v: unknown, p: string) => void;
function fields(v: unknown, p: string, schema: Record<string, Check>) {
  object(v, p);
  for (const [k, x] of Object.entries(v)) {
    if (!Object.hasOwn(schema, k))
      throw new Error(`${p}.${k}: protected or unsupported option/callback.`);
    schema[k](x, `${p}.${k}`);
  }
}
const bounded =
  (min: number, max = Infinity): Check =>
  (v, p) =>
    num(v, p, min, max);
const enumOf =
  (values: readonly (number | string)[]): Check =>
  (v, p) =>
    choice(v, p, values);
const dash: Check = (v, p) => arrayNumbers(v, p, 0, 100);
const markerSchema: Record<string, Check> = {
  show: (v, p) => {
    if (v !== "auto") bool(v, p);
  },
  size: bounded(0, 100),
  space: bounded(0, 1000),
  width: bounded(0, 20),
  stroke: color,
  fill: color,
  dash,
  cap: enumOf(caps),
};
export function validateStyle(v: unknown, p = "style"): void {
  assertSafe(v);
  fields(v, p, {
    color,
    width: bounded(0, 20),
    pointSize: bounded(1, 100),
    fill: bounded(0, 1),
    dash,
    points: bool,
    visible: bool,
    path: enumOf(paths),
    cap: enumOf(caps),
    alpha: bounded(0, 1),
    pxAlign,
    fillColor: color,
    fillTo: num,
    auto: bool,
    markers: (x, q) => fields(x, q, markerSchema),
    pathOptions: (x, q) =>
      fields(x, q, {
        alignGaps: enumOf([-1, 0, 1]),
        align: enumOf([-1, 1]),
        ascDesc: bool,
        extend: bool,
      }),
  });
}
/** Arrays replace, except the two positional axis patches. Built-in callbacks survive untouched. */
export function deepMerge<T>(base: T, patch: unknown): T {
  assertSafe(patch);
  type Pending = { base: unknown; patch: object; out: object };
  const pending: Pending[] = [];
  function merge(a: unknown, b: unknown, key = ""): unknown {
    if (b === null || typeof b !== "object") return b;
    const out = Array.isArray(b)
      ? key === "axes" && Array.isArray(a)
        ? a.slice()
        : []
      : {
          ...(a !== null && typeof a === "object" && !Array.isArray(a)
            ? a
            : {}),
        };
    pending.push({
      base: Array.isArray(b)
        ? key === "axes" && Array.isArray(a)
          ? a
          : undefined
        : a !== null && typeof a === "object" && !Array.isArray(a)
          ? a
          : undefined,
      patch: b,
      out,
    });
    return out;
  }
  const result = merge(base, patch);
  while (pending.length) {
    const { base: a, patch: b, out } = pending.pop()!;
    for (const [key, value] of Object.entries(b)) {
      const previous =
        a !== null && typeof a === "object"
          ? (a as Record<string, unknown>)[key]
          : undefined;
      (out as Record<string, unknown>)[key] = merge(previous, value, key);
    }
  }
  return result as T;
}
function rangeCheck(v: unknown, p: string) {
  if (Array.isArray(v)) {
    if (v.length !== 2)
      throw new Error(
        `${p}: expected [min,max], with null for an automatic bound.`,
      );
    v.forEach((x, i) => {
      if (x !== null) num(x, `${p}[${i}]`);
    });
    if (v[0] !== null && v[1] !== null && v[0] >= v[1])
      throw new Error(`${p}: minimum must be less than maximum.`);
    return;
  }
  const limit = (x: unknown, q: string) =>
    fields(x, q, {
      pad: bounded(0, 10),
      soft: num,
      mode: enumOf([0, 1, 2, 3]),
      hard: num,
    });
  fields(v, p, { min: limit, max: limit });
  const r = v as { min?: RangeLimit; max?: RangeLimit };
  if (!r.min || !r.max)
    throw new Error(
      `${p}: range config requires min and max objects (empty objects are allowed).`,
    );
  if (
    r.min.hard !== undefined &&
    r.max.hard !== undefined &&
    r.min.hard >= r.max.hard
  )
    throw new Error(`${p}: hard minimum must be less than hard maximum.`);
  if (
    r.min.soft !== undefined &&
    r.max.soft !== undefined &&
    r.min.soft > r.max.soft
  )
    throw new Error(`${p}: soft minimum must not exceed soft maximum.`);
  if (
    (r.min.soft !== undefined &&
      r.max.hard !== undefined &&
      r.min.soft >= r.max.hard) ||
    (r.max.soft !== undefined &&
      r.min.hard !== undefined &&
      r.max.soft <= r.min.hard)
  )
    throw new Error(
      `${p}: soft limits must not cross the opposite hard bound.`,
    );
}
/** Advanced bounds supersede built-in bounds as a whole, including partial/null bounds. */
export function effectiveRange(
  config: ViewConfig,
  axis: "x" | "y",
): LiteralRange {
  const scales = config.advanced.scales as
    Record<string, ScaleOptions> | undefined;
  return scales?.[axis]?.range ?? [config[`${axis}Min`], config[`${axis}Max`]];
}
export function explicitRangeBounds(
  range: LiteralRange,
): [number | null, number | null] {
  return Array.isArray(range)
    ? [...range]
    : [range.min.hard ?? null, range.max.hard ?? null];
}
function line(x: unknown, p: string, ticks = false) {
  fields(x, p, {
    show: bool,
    stroke: color,
    width: bounded(0, 10),
    dash,
    cap: enumOf(caps),
    ...(ticks ? { size: bounded(0, 100) } : {}),
  });
}
/** Closed, literal-only uPlot subset. Data, callbacks, scale identity and analysis remain protected. */
export function validateAdvanced(v: unknown): Record<string, unknown> {
  assertSafe(v);
  object(v, "advanced");
  const protectedRoots = new Set([
    "data",
    "hooks",
    "plugins",
    "mode",
    "series",
    "bands",
    "width",
    "height",
    "tzDate",
    "ms",
  ]);
  for (const k of Object.keys(v))
    if (protectedRoots.has(k))
      throw new Error(
        `advanced.${k}: protected inspector option; use built-in size and per-run controls. Data, hooks and analysis invariants cannot be overridden.`,
      );
  fields(v, "advanced", {
    title: str,
    padding: (x, p) => {
      if (!Array.isArray(x) || x.length !== 4)
        throw new Error(`${p}: expected [top,right,bottom,left].`);
      x.forEach((y, i) => {
        if (y !== null) num(y, `${p}[${i}]`, 0, 160);
      });
    },
    pxAlign,
    drawOrder: (x, p) => {
      if (
        !Array.isArray(x) ||
        x.length !== 2 ||
        !x.includes("axes") ||
        !x.includes("series")
      )
        throw new Error(`${p}: expected each of axes and series exactly once.`);
    },
    select: (x, p) => fields(x, p, { show: bool, over: bool }),
    focus: (x, p) => fields(x, p, { alpha: bounded(0, 1) }),
    scales: (x, p) =>
      fields(
        x,
        p,
        Object.fromEntries(
          ["x", "y"].map((axis) => [
            axis,
            (y: unknown, q: string) => {
              fields(y, q, {
                dir: enumOf([-1, 1]),
                log: enumOf([2, 10]),
                asinh: bounded(Number.MIN_VALUE),
                auto: bool,
                range: rangeCheck,
              });
              const scale = y as ScaleOptions;
              if (
                scale.auto === false &&
                scale.range &&
                explicitRangeBounds(scale.range).some((n) => n === null)
              )
                throw new Error(
                  `${q}: auto:false requires a fully explicit tuple or both hard bounds.`,
                );
            },
          ]),
        ),
      ),
    legend: (x, p) =>
      fields(x, p, {
        show: bool,
        live: bool,
        isolate: bool,
        markers: (y, q) =>
          fields(y, q, {
            show: bool,
            width: bounded(0, 20),
            stroke: color,
            fill: color,
            dash: enumOf([
              "none",
              "hidden",
              "dotted",
              "dashed",
              "solid",
              "double",
              "groove",
              "ridge",
              "inset",
              "outset",
            ]),
          }),
      }),
    cursor: (x, p) =>
      fields(x, p, {
        show: bool,
        x: bool,
        y: bool,
        lock: bool,
        points: (y, q) =>
          fields(y, q, {
            show: bool,
            one: bool,
            size: bounded(0, 100),
            width: bounded(0, 20),
            stroke: color,
            fill: color,
          }),
        drag: (y, q) =>
          fields(y, q, {
            x: bool,
            y: bool,
            setScale: bool,
            dist: bounded(0, 1000),
            uni: (n, r) => {
              if (n !== null) num(n, r, 0, 1000);
            },
          }),
        focus: (y, q) =>
          fields(y, q, { prox: bounded(-1, 1e6), bias: enumOf([-1, 0, 1]) }),
        hover: (y, q) =>
          fields(y, q, {
            prox: (n, r) => {
              if (n !== null) num(n, r, 0, 1e6);
            },
            bias: enumOf([-1, 0, 1]),
            skip: (n, r) => {
              if (
                !Array.isArray(n) ||
                n.some((a) => a !== null && typeof a !== "number")
              )
                throw new Error(
                  `${r}: expected an array of null or finite numeric values.`,
                );
            },
          }),
      }),
    axes: (x, p) => {
      if (!Array.isArray(x) || x.length > 2)
        throw new Error(`${p}: expected up to two axis patches [x,y].`);
      x.forEach((axis, i) => {
        const q = `${p}[${i}]`;
        fields(axis, q, {
          show: bool,
          label: str,
          font: str,
          labelFont: str,
          stroke: color,
          size: bounded(0, 200),
          gap: bounded(0, 200),
          labelSize: bounded(0, 200),
          labelGap: bounded(0, 200),
          rotate: bounded(-90, 90),
          side: enumOf(i === 0 ? [0, 2] : [1, 3]),
          align: enumOf([1, 2]),
          alignTo: enumOf([1, 2]),
          lineGap: bounded(0, 10),
          space: bounded(Number.MIN_VALUE, 1000),
          incrs: (y, r) => increasing(y, r, true),
          splits: (y, r) => increasing(y, r, false, true),
          grid: line,
          border: line,
          ticks: (y, r) => line(y, r, true),
          values: (y, r) => {
            if (Array.isArray(y)) {
              for (const a of y)
                if (
                  a !== null &&
                  typeof a !== "string" &&
                  typeof a !== "number"
                )
                  throw new Error(
                    `${r}: expected static string/number/null labels.`,
                  );
            } else choice(y, r, formats);
          },
        });
        const a = axis as Record<string, unknown>;
        if (
          Array.isArray(a.values) &&
          (!Array.isArray(a.splits) || a.values.length !== a.splits.length)
        )
          throw new Error(
            `${q}: static values require static splits with matching lengths.`,
          );
        if (
          a.rotate !== undefined &&
          a.rotate !== 0 &&
          (i !== 0 || (a.side ?? 2) !== 2)
        )
          throw new Error(
            `${q}.rotate: nonzero rotation is supported only on the bottom x axis.`,
          );
      });
    },
  });
  return v;
}
export function parseAdvanced(text: string): Record<string, unknown> {
  return validateAdvanced(parseSafeJson(text));
}
export function validateConfig(value: unknown): ViewConfig {
  assertSafe(value);
  object(value, "view");
  const d = defaults();
  for (const [k, v] of Object.entries(value)) {
    const p = `view.${k}`;
    if (!Object.hasOwn(d, k)) throw new Error(`${p}: unknown setting.`);
    if (k === "version") {
      if (v !== 1) throw new Error("Unsupported view version.");
    } else if (k === "axis") choice(v, p, ["step", "timestamp", "relative"]);
    else if (k === "interpolation") choice(v, p, ["linear", "pchip"]);
    else if (["xScale", "yScale"].includes(k))
      choice(v, p, ["linear", "log", "asinh"]);
    else if (["xFormat", "yFormat"].includes(k)) choice(v, p, formats);
    else if (["xLabel", "yLabel"].includes(k)) str(v, p);
    else if (
      [
        "smoothing",
        "grid",
        "ticks",
        "legend",
        "cursor",
        "zoom",
        "palette",
      ].includes(k)
    )
      bool(v, p);
    else if (k === "alpha") {
      num(v, p, Number.MIN_VALUE, 1);
    } else if (k === "height") num(v, p, 240, 1800);
    else if (k === "width") {
      if (v !== null) num(v, p, 320, 8000);
    } else if (["xMin", "xMax", "yMin", "yMax"].includes(k)) {
      if (v !== null) num(v, p);
    } else if (k === "style") validateStyle(v, p);
    else if (k === "runs") {
      object(v, p);
      for (const [id, s] of Object.entries(v)) validateStyle(s, `${p}.${id}`);
    } else if (k === "advanced") validateAdvanced(v);
  }
  const result = deepMerge(d, value);
  for (const axis of ["x", "y"] as const) {
    const range = effectiveRange(result, axis);
    rangeCheck(range, `${axis} range`);
    const [lo, hi] = explicitRangeBounds(range);
    const scales = result.advanced.scales as
      Record<string, ScaleOptions> | undefined;
    if (scales?.[axis]?.auto === false && (lo === null || hi === null))
      throw new Error(
        `${axis} range: auto:false requires a fully explicit tuple or both hard bounds.`,
      );
    if (result[`${axis}Scale`] === "log") {
      const limits = Array.isArray(range)
        ? range
        : [range.min.hard, range.max.hard, range.min.soft, range.max.soft];
      if (limits.some((n) => n !== null && n !== undefined && n <= 0))
        throw new Error(`${axis} log range must be positive.`);
      const axes = result.advanced.axes as
        Record<string, unknown>[] | undefined;
      const splits = axes?.[axis === "x" ? 0 : 1]?.splits as
        number[] | undefined;
      if (splits?.some((n) => n <= 0))
        throw new Error(`${axis} log splits must be positive.`);
    }
  }
  if (result.yScale === "log") {
    for (const [id, style] of [
      ["defaults", result.style],
      ...Object.entries(result.runs).map(
        ([id, patch]) => [id, deepMerge(result.style, patch)] as const,
      ),
    ] as const) {
      if (style.fillTo !== undefined && style.fillTo <= 0)
        throw new Error(
          `${id}: log fillTo must be positive; omit it to use the visible lower bound.`,
        );
    }
  }
  return result;
}
export function styleFor(
  config: ViewConfig,
  id: string,
  index: number,
): RunStyle {
  return deepMerge(
    {
      ...config.style,
      color: config.palette
        ? palette[index % palette.length]
        : config.style.color,
    },
    Object.hasOwn(config.runs, id) ? config.runs[id] : {},
  );
}
export function formatValue(value: number, formatter: Formatter): string {
  if (!Number.isFinite(value)) return "—";
  if (formatter === "fixed-2") return value.toFixed(2);
  if (formatter === "scientific") return value.toExponential(3);
  if (formatter === "iso-time") {
    const d = new Date(value);
    return Number.isNaN(d.valueOf())
      ? "Invalid time"
      : d.toISOString().replace("T", " ").replace(".000Z", "Z");
  }
  return Number(value.toPrecision(6)).toString();
}
export const CONFIG_HELP = `Advanced JSON is a closed, literal-only uPlot subset. Objects merge recursively; arrays replace, except axes patches merge positionally as [x,y]. Supported roots: title; padding [top,right,bottom,left] (null = automatic); pxAlign (boolean or 0–10); drawOrder (axes and series, each once); focus {alpha}; select {show,over}; scales {x,y}; axes; cursor; legend.
Scales: dir (-1|1), log (2|10), asinh (>0), auto, range [min,max] (null = automatic) or {min:{pad,soft,mode,hard},max:{pad,soft,mode,hard}}. Range limits require min/max objects; pad 0–10, mode 0–3. Advanced range overrides built-in min/max as a whole. auto:false requires two explicit tuple values or two hard bounds (built-in fixed bounds also qualify when no advanced range is set). Log bounds and static splits must be positive. Distribution and orientation stay under built-in controls.
Axes: show, label, font, labelFont, stroke, size, gap, labelSize, labelGap, rotate (bottom x only), side (x:0|2, y:1|3), align/alignTo (1|2), lineGap, space, positive increasing incrs, increasing splits, values (number|fixed-2|scientific|iso-time or a static string/number/null array paired with equal-length splits). grid/ticks/border: show, stroke, width, dash, cap; ticks also size.
Cursor: show,x,y,lock; points {show,one,size,width,stroke,fill}; focus {prox,bias}; hover {prox,bias,skip} (skip: null or numbers); drag {x,y,dist,setScale,uni} (uni may be null). Legend: show,live,isolate,markers {show,width,stroke,fill,dash}; legend dash is a CSS border style such as dashed, not a numeric dash array.
Styles: existing color,width,dash,points,pointSize,fill,visible,path plus cap,alpha,pxAlign,fillColor,fillTo,auto; markers {show:boolean|"auto",size,space,width,stroke,fill,dash,cap}; pathOptions {alignGaps:-1|0|1,align:-1|1,ascDesc,extend}. Marker fields override legacy points/pointSize. auto excludes a series from auto-ranging only, not analysis. Colors are safe CSS literals, never URLs or variables. No JavaScript, callbacks, hooks, plugins, data replacement, scale identity, or series identity overrides. Unlisted options are rejected.
Matched PCHIP and matched linear interpolation on nonlinear axes are adaptively tessellated in screen space with a 0.35 CSS-pixel target tolerance before optional pixel snapping and bounded work. Explicit log fillTo must be positive; omitted log baselines use the visible lower bound. Other display paths and pathOptions are cosmetic and never change numerical interpolation, readouts, or exports.`;
