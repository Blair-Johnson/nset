import type { XY } from "./math";

/** How a trace connects consecutive samples. */
export type TraceKind = "linear" | "spline" | "stepped-after" | "stepped-before";

export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void;
}

/**
 * Natural cubic spline second derivatives for values `v` at strictly
 * increasing knots `t` (zero curvature at both ends). Thomas algorithm, O(n).
 */
export function naturalSecondDerivatives(t: number[], v: number[]): number[] {
  const n = t.length;
  const m = new Array<number>(n).fill(0);
  if (n < 3) return m;
  const c = new Array<number>(n).fill(0);
  const d = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const h0 = t[i] - t[i - 1],
      h1 = t[i + 1] - t[i];
    const a = h0,
      b = 2 * (h0 + h1),
      cc = h1;
    const r = 6 * ((v[i + 1] - v[i]) / h1 - (v[i] - v[i - 1]) / h0);
    const denom = b - a * c[i - 1];
    c[i] = cc / denom;
    d[i] = (r - a * d[i - 1]) / denom;
  }
  for (let i = n - 2; i >= 1; i--) m[i] = d[i] - c[i] * m[i + 1];
  return m;
}

/**
 * Cubic Bézier control points for an interpolating C² spline through `pts`.
 * `param: "x"` treats y as a function of x (time-series charts); `"chord"`
 * parameterizes by cumulative chord length so XY traces may double back.
 * Returns one [c1x, c1y, c2x, c2y] per segment.
 */
export function splineControls(
  pts: XY[],
  param: "x" | "chord",
): [number, number, number, number][] {
  const n = pts.length;
  if (n < 2) return [];
  const t = new Array<number>(n);
  t[0] = 0;
  // "chord": centripetal knots (√distance) — no loops or cusps at spikes,
  // well-conditioned when consecutive samples are close or vertical.
  for (let i = 1; i < n; i++)
    t[i] =
      param === "x"
        ? pts[i][0]
        : t[i - 1] +
          Math.sqrt(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const my = naturalSecondDerivatives(t, ys);
  const mx = param === "x" ? null : naturalSecondDerivatives(t, xs);
  const slope = (v: number[], m: number[], i: number, end: 0 | 1) => {
    const h = t[i + 1] - t[i];
    const secant = (v[i + 1] - v[i]) / h;
    return end === 0
      ? secant - (h * (2 * m[i] + m[i + 1])) / 6
      : secant + (h * (m[i] + 2 * m[i + 1])) / 6;
  };
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = t[i + 1] - t[i];
    const dx0 = mx ? slope(xs, mx, i, 0) : 1,
      dx1 = mx ? slope(xs, mx, i, 1) : 1;
    const dy0 = slope(ys, my, i, 0),
      dy1 = slope(ys, my, i, 1);
    out.push([
      xs[i] + (dx0 * h) / 3,
      ys[i] + (dy0 * h) / 3,
      xs[i + 1] - (dx1 * h) / 3,
      ys[i + 1] - (dy1 * h) / 3,
    ]);
  }
  return out;
}

/**
 * Thin samples closer than `minGap` pixels (along x for time-series, along the
 * trace for XY) before splining. Sub-pixel knots are invisible but make the
 * spline wildly over/undershoot; the first and last samples always remain.
 */
function distinct(pts: XY[], param: "x" | "chord", minGap = 2): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = out[out.length - 1];
    const last = i === pts.length - 1;
    const gap = !q
      ? Infinity
      : param === "x"
        ? p[0] - q[0]
        : Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (q && gap < minGap) {
      if (last && gap > 1e-6) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/**
 * Draw one contiguous run of projected (pixel) points. Steps are built along
 * the trace: "after" holds y while x moves; "before" moves y first. Splines
 * are natural cubic (C²: continuous slope and curvature at every sample).
 */
export function traceRun(
  sink: PathSink,
  input: XY[],
  kind: TraceKind,
  param: "x" | "chord",
): void {
  const pts = kind === "spline" ? distinct(input, param) : input;
  if (!pts.length) return;
  sink.moveTo(pts[0][0], pts[0][1]);
  if (kind === "spline" && pts.length > 2) {
    const controls = splineControls(pts, param);
    controls.forEach(([c1x, c1y, c2x, c2y], i) =>
      sink.bezierCurveTo(c1x, c1y, c2x, c2y, pts[i + 1][0], pts[i + 1][1]),
    );
    return;
  }
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1],
      [x1, y1] = pts[i];
    if (kind === "stepped-after") sink.lineTo(x1, y0);
    else if (kind === "stepped-before") sink.lineTo(x0, y1);
    sink.lineTo(x1, y1);
  }
}

/** Split samples into drawable runs; an invalid sample breaks the line. */
export function traceRuns(
  points: XY[],
  valid: (x: number, y: number) => boolean,
): XY[][] {
  const runs: XY[][] = [];
  let current: XY[] = [];
  for (const point of points) {
    if (valid(point[0], point[1])) current.push(point);
    else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}
