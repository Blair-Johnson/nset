import type { XY } from "./math";
import type { PathSink } from "./trace-path";
import type { Analyzed } from "./analysis";
import { styleFor, type ViewConfig } from "./config";

const EPS = 1e-7; // Device pixels, not data units.
type Segment = XY[];
const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
function at(v: number[], t: number): number {
  const a = v.slice();
  for (let n = a.length - 1; n > 0; n--)
    for (let i = 0; i < n; i++) a[i] = mix(a[i], a[i + 1], t);
  return a[0];
}
function extrema(v: number[]): number[] {
  if (v.length !== 4) return [];
  const a = -v[0] + 3 * v[1] - 3 * v[2] + v[3];
  const b = 2 * (v[0] - 2 * v[1] + v[2]);
  const c = v[1] - v[0];
  if (Math.abs(a) < Number.EPSILON * Math.max(1, Math.abs(b), Math.abs(c)))
    return b ? [-c / b].filter((t) => t > 0 && t < 1) : [];
  const d = b * b - 4 * a * c;
  if (d < 0) return [];
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(d));
  return (q ? [q / a, c / q] : [-b / (2 * a)])
    .filter((t) => t > 0 && t < 1).sort((a, b) => a - b);
}

/** The very same device-pixel commands sent to Canvas, including cosmetic
 * splines/steps. No reordering, resampling or alternate smoothing contract. */
export class CrossingPath implements PathSink {
  private current: XY = [0, 0];
  private segments: Segment[] = [];
  constructor(private sink?: PathSink) {}
  moveTo(x: number, y: number) {
    this.current = [x, y];
    this.sink?.moveTo(x, y);
  }
  lineTo(x: number, y: number) {
    this.segments.push([this.current, [x, y]]);
    this.current = [x, y];
    this.sink?.lineTo(x, y);
  }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number) {
    this.segments.push([this.current, [a, b], [c, d], [x, y]]);
    this.current = [x, y];
    this.sink?.bezierCurveTo(a, b, c, d, x, y);
  }
  /** Intersect the stroke centerline, clipped on the free axis. A coincident
   * segment contributes its closest visible point, not an unbounded root list. */
  crossings(axis: "x" | "y", fixed: number, mouse: number, bounds: XY): number[] {
    const fixedIndex = axis === "x" ? 0 : 1, freeIndex = 1 - fixedIndex;
    const out: number[] = [];
    const add = (p: number) => {
      if (Number.isFinite(p) && p >= bounds[0] - EPS && p <= bounds[1] + EPS)
        out.push(Math.max(bounds[0], Math.min(bounds[1], p)));
    };
    for (const segment of this.segments) {
      if (!segment.flat().every(Number.isFinite)) continue;
      const v = segment.map((p) => p[fixedIndex]);
      const w = segment.map((p) => p[freeIndex]);
      if (fixed < Math.min(...v) - EPS || fixed > Math.max(...v) + EPS) continue;
      if (v.every((p) => Math.abs(p - fixed) <= EPS)) {
        const values = [w[0], w[w.length - 1], ...extrema(w).map((t) => at(w, t))];
        const lo = Math.max(bounds[0], Math.min(...values));
        const hi = Math.min(bounds[1], Math.max(...values));
        if (lo <= hi) add(Math.max(lo, Math.min(hi, mouse)));
        continue;
      }
      if (v.length === 2) {
        if (v[0] !== v[1]) add(at(w, Math.max(0, Math.min(1, (fixed - v[0]) / (v[1] - v[0])))));
        continue;
      }
      const knots = [0, ...extrema(v), 1];
      for (const t of knots) if (Math.abs(at(v, t) - fixed) <= EPS) add(at(w, t));
      for (let i = 1; i < knots.length; i++) {
        let lo = knots[i - 1], hi = knots[i];
        const a = at(v, lo) - fixed, b = at(v, hi) - fixed;
        if (a === 0 || b === 0 || Math.sign(a) === Math.sign(b)) continue;
        for (let n = 0; n < 64; n++) {
          const mid = (lo + hi) / 2;
          if (mid === lo || mid === hi) break;
          if (Math.sign(at(v, mid) - fixed) === Math.sign(a)) lo = mid;
          else hi = mid;
        }
        add(at(w, (lo + hi) / 2));
      }
    }
    return out;
  }
}

/** At most one neighbor on each side; identical shared vertices and an exact
 * hit collapse. Distances are pixels so log/asinh/reversed axes behave alike. */
export function crossingNeighbors(points: number[], mouse: number): number[] {
  let lower: number | undefined, upper: number | undefined;
  for (const p of points) {
    if (!Number.isFinite(p)) continue;
    if (Math.abs(p - mouse) <= EPS) return [p];
    if (p < mouse && (lower === undefined || p > lower)) lower = p;
    if (p > mouse && (upper === undefined || p < upper)) upper = p;
  }
  return [lower, upper].filter((p): p is number => p !== undefined);
}
export interface HoverCrossing { index: number; positions: number[] }
export function nearestCrossingRuns(
  crossings: HoverCrossing[],
  identity: (index: number) => string,
  mouse: number,
): HoverCrossing[] {
  const runs = new Map<string, HoverCrossing>();
  for (const row of crossings) {
    const id = identity(row.index), previous = runs.get(id);
    if (previous) previous.positions.push(...row.positions);
    else runs.set(id, { index: row.index, positions: row.positions.slice() });
  }
  return [...runs].map(([id, row]) => ({
    id, index: row.index, positions: crossingNeighbors(row.positions, mouse),
  })).filter((row) => row.positions.length).sort((a, b) => {
    const distance = (row: HoverCrossing) => Math.min(...row.positions.map((p) => Math.abs(p - mouse)));
    const delta = distance(a) - distance(b);
    return Math.abs(delta) > EPS ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }).slice(0, 4);
}

export function drawablePoint([x, y]: XY, config: ViewConfig): boolean {
  return Number.isFinite(x) && Number.isFinite(y) &&
    (config.xScale !== "log" || x > 0) && (config.yScale !== "log" || y > 0);
}
export function markerEnabled(config: ViewConfig, id: string, index: number): boolean {
  const s = styleFor(config, id, index);
  return (s.markers?.size ?? s.pointSize) > 0 &&
    (s.markers?.show !== undefined ? s.markers.show !== false : s.points);
}
/** Global legend eligibility, deliberately independent of zoom. A singleton's
 * automatic marker is part of PlotPanel's existing rendering contract. */
export function plottedSeries(d: Analyzed, config: ViewConfig, index: number): boolean {
  const s = styleFor(config, d.run.id, index);
  if (!s.visible || s.alpha === 0) return false;
  if ((markerEnabled(config, d.run.id, index) && d.observations.some((p) => drawablePoint(p, config))) ||
      (d.points.length === 1 && (s.markers?.size ?? s.pointSize) > 0 && drawablePoint(d.points[0], config))) return true;
  if (s.width <= 0 && s.fill <= 0) return false;
  return d.points.some((p, i) => {
    if (!i) return false;
    const a = d.points[i - 1];
    if (drawablePoint(a, config) && drawablePoint(p, config) && (a[0] !== p[0] || a[1] !== p[1])) return true;
    // Matched native paths clip the original interpolant, rather than breaking
    // at log-excluded endpoints. Its monotone spans can enter the valid domain.
    if (!d.x && s.path === "matched" && [...a, ...p].every(Number.isFinite) && p[0] > a[0]) {
      const left = config.xScale === "log" ? Math.max(0, a[0]) : a[0];
      if (p[0] <= left) return false;
      if (config.yScale !== "log") return true;
      const y = d.fn.at(left);
      return y !== null && Number.isFinite(y) && Math.max(y, p[1]) > 0;
    }
    return false;
  });
}
