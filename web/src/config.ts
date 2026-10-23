export type Scale = "linear" | "log" | "asinh";
export type PathName =
  "matched" | "linear" | "stepped-before" | "stepped-after" | "spline";
export type Formatter = "number" | "fixed-2" | "scientific" | "iso-time";
export interface RunStyle {
  color: string;
  width: number;
  dash: number[];
  points: boolean;
  pointSize: number;
  fill: number;
  visible: boolean;
  path: PathName;
}
export interface ViewConfig {
  version: 1;
  axis: "step" | "timestamp";
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
  "#76d5ff",
  "#b5a1ff",
  "#ffc77a",
  "#7ee3ba",
  "#fa97b1",
  "#d9df86",
  "#76a6ff",
  "#e7a4ff",
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
export function assertSafe(value: unknown, path = "$", depth = 0): void {
  if (depth > 32) throw new Error(`${path}: nesting is limited to 32 levels.`);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object")
    throw new Error(
      `${path}: only finite JSON values are supported; executable callbacks are not accepted.`,
    );
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error(`${path}: plain JSON objects required.`);
  for (const [key, item] of Object.entries(value)) {
    if (badKeys.has(key)) throw new Error(`${path}.${key}: protected key.`);
    assertSafe(item, `${path}.${key}`, depth + 1);
  }
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
function choice(v: unknown, p: string, values: readonly string[]) {
  if (typeof v !== "string" || !values.includes(v))
    throw new Error(
      `${p}: choose ${values.join(", ")}; executable callbacks are unsupported.`,
    );
}
function color(v: unknown, p: string) {
  str(v, p);
  if (!/^#[0-9a-f]{6}$/i.test(v as string))
    throw new Error(`${p}: use a six-digit hex color.`);
}
function arrayNumbers(v: unknown, p: string, min: number, max: number) {
  if (!Array.isArray(v)) throw new Error(`${p}: expected numeric array.`);
  v.forEach((n, i) => num(n, `${p}[${i}]`, min, max));
}
const paths = [
  "matched",
  "linear",
  "stepped-before",
  "stepped-after",
  "spline",
];
const formats = ["number", "fixed-2", "scientific", "iso-time"];
function styleCheck(v: unknown, p: string) {
  object(v, p);
  for (const [k, x] of Object.entries(v)) {
    const q = `${p}.${k}`;
    if (k === "color") color(x, q);
    else if (k === "width") num(x, q, 0, 20);
    else if (k === "pointSize") num(x, q, 1, 40);
    else if (k === "fill") num(x, q, 0, 1);
    else if (k === "dash") arrayNumbers(x, q, 0, 100);
    else if (["points", "visible"].includes(k)) bool(x, q);
    else if (k === "path") choice(x, q, paths);
    else throw new Error(`${q}: unsupported per-run option.`);
  }
}
/** Merge plain objects recursively and arrays by index; never overwrite missing defaults. */
export function deepMerge<T>(base: T, patch: unknown): T {
  assertSafe(patch);
  function merge(a: unknown, b: unknown): unknown {
    if (Array.isArray(b)) {
      const out = Array.isArray(a) ? a.slice() : [];
      b.forEach((v, i) => {
        out[i] = merge(out[i], v);
      });
      return out;
    }
    if (b !== null && typeof b === "object") {
      const out: Record<string, unknown> = {
        ...(a !== null && typeof a === "object" && !Array.isArray(a) ? a : {}),
      };
      for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
      return out;
    }
    return b;
  }
  return merge(base, patch) as T;
}
/** The subset is intentionally closed: no option is silently dropped. */
export function validateAdvanced(v: unknown): Record<string, unknown> {
  assertSafe(v);
  object(v, "advanced");
  const protectedRoots = new Set([
    "data",
    "hooks",
    "scales",
    "plugins",
    "mode",
    "series",
    "bands",
    "select",
    "width",
    "height",
    "pxAlign",
    "tzDate",
    "ms",
  ]);
  const line = (x: unknown, p: string, ticks = false) => {
    object(x, p);
    for (const [k, n] of Object.entries(x)) {
      if (k === "show") bool(n, `${p}.${k}`);
      else if (k === "stroke") color(n, `${p}.${k}`);
      else if (k === "width") num(n, `${p}.${k}`, 0, 10);
      else if (k === "dash") arrayNumbers(n, `${p}.${k}`, 0, 100);
      else if (k === "size" && ticks) num(n, `${p}.${k}`, 0, 40);
      else throw new Error(`${p}.${k}: unsupported line option.`);
    }
  };
  for (const [k, x] of Object.entries(v)) {
    const p = `advanced.${k}`;
    if (protectedRoots.has(k))
      throw new Error(
        `${p}: protected inspector option; use the built-in scale, size, or per-run controls. Data, hooks and analysis invariants cannot be overridden.`,
      );
    if (k === "title") str(x, p);
    else if (k === "padding") {
      arrayNumbers(x, p, 0, 160);
      if ((x as unknown[]).length !== 4)
        throw new Error(`${p}: expected [top,right,bottom,left].`);
    } else if (k === "legend") {
      object(x, p);
      for (const [n, y] of Object.entries(x)) {
        if (["show", "live"].includes(n)) bool(y, `${p}.${n}`);
        else
          throw new Error(
            `${p}.${n}: unsupported or callback-valued legend option.`,
          );
      }
    } else if (k === "cursor") {
      object(x, p);
      for (const [n, y] of Object.entries(x)) {
        const q = `${p}.${n}`;
        if (["show", "x", "y"].includes(n)) bool(y, q);
        else if (n === "drag") {
          object(y, q);
          for (const [a, b] of Object.entries(y)) {
            if (["x", "y"].includes(a)) bool(b, `${q}.${a}`);
            else if (a === "dist") num(b, `${q}.${a}`, 0, 100);
            else
              throw new Error(
                `${q}.${a}: protected or unsupported drag option.`,
              );
          }
        } else
          throw new Error(
            `${q}: protected or unsupported cursor callback; pinned A/B hooks are required.`,
          );
      }
    } else if (k === "axes") {
      if (!Array.isArray(x) || x.length > 2)
        throw new Error(`${p}: expected up to two axis patches [x,y].`);
      x.forEach((axis, i) => {
        const q = `${p}[${i}]`;
        object(axis, q);
        for (const [n, y] of Object.entries(axis)) {
          const r = `${q}.${n}`;
          if (["show"].includes(n)) bool(y, r);
          else if (["label", "font", "labelFont"].includes(n)) str(y, r);
          else if (n === "stroke") color(y, r);
          else if (["size", "gap", "labelSize", "labelGap"].includes(n))
            num(y, r, 0, 200);
          else if (n === "rotate") num(y, r, -90, 90);
          else if (["grid", "ticks", "border"].includes(n))
            line(y, r, n === "ticks");
          else if (n === "values") choice(y, r, formats);
          else
            throw new Error(
              `${r}: protected or unsupported axis option/callback. Use a named values formatter.`,
            );
        }
      });
    } else
      throw new Error(
        `${p}: unsupported uPlot option or executable callback. See the documented JSON subset.`,
      );
  }
  return v;
}
export function parseAdvanced(text: string): Record<string, unknown> {
  return validateAdvanced(JSON.parse(text));
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
    } else if (k === "axis") choice(v, p, ["step", "timestamp"]);
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
    } else if (k === "style") styleCheck(v, p);
    else if (k === "runs") {
      object(v, p);
      for (const [id, s] of Object.entries(v)) styleCheck(s, `${p}.${id}`);
    } else if (k === "advanced") validateAdvanced(v);
  }
  const result = deepMerge(d, value);
  for (const axis of ["x", "y"] as const) {
    const lo = result[`${axis}Min`],
      hi = result[`${axis}Max`];
    if (lo !== null && hi !== null && lo >= hi)
      throw new Error(`${axis} range: minimum must be less than maximum.`);
    if (
      result[`${axis}Scale`] === "log" &&
      ((lo !== null && lo <= 0) || (hi !== null && hi <= 0))
    )
      throw new Error(`${axis} log range must be positive.`);
  }
  return result;
}
export function styleFor(
  config: ViewConfig,
  id: string,
  index: number,
): RunStyle {
  return {
    ...config.style,
    color: config.palette
      ? palette[index % palette.length]
      : config.style.color,
    ...config.runs[id],
  };
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
export const CONFIG_HELP = `Advanced JSON is an explicit, safe uPlot subset, deep-merged into defaults (arrays merge by index). Supported roots: title, padding [top,right,bottom,left], legend {show,live}, cursor {show,x,y,drag:{x,y,dist}}, axes [x,y]. Axis keys: show, label, font, labelFont, stroke, size, gap, labelSize, labelGap, rotate, grid/ticks/border {show,stroke,width,dash}; ticks also supports size, values: number|fixed-2|scientific|iso-time. Colors use #rrggbb. Unlisted options are rejected, not ignored. Function-valued options are available only through named paths/formatters; no JavaScript, eval, callbacks or plugins. Data, hooks, scales, series identity and sizing are protected; use built-in controls. Per-run styles use the fields below. 'Matched' draws the numerical interpolant; PCHIP is tessellated at 16 subdivisions per segment, independent of viewport. Other display paths are explicitly cosmetic and do not change numerical readouts.`;
