export type Point = { seq: number; step: number; timestamp: number; value: number };
export type XY = [number, number];
export type Interpolation = 'linear' | 'pchip';
export type Crossings = { points: number[]; plateaus: [number, number][] };
export type Interpolator = { at(x: number): number | null; crossings(y: number): Crossings };

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

/** Ascending x; largest seq wins duplicate x, with last input winning tied seq.
 * Does not mutate inputs. Numeric fields must be finite (even discarded rows).
 * Relative x is timestamp - runStart, in backend milliseconds. The explicit
 * finite run origin is required even for empty data; first logging is not start.
 */
export function canonicalize(points: Point[], axis: 'step' | 'timestamp' | 'relative', runStart?: number): XY[] {
  if (axis !== 'step' && axis !== 'timestamp' && axis !== 'relative') throw new RangeError('Unknown axis');
  if (axis === 'relative') finite(runStart!, 'runStart');
  const latest = new Map<number, Point>();
  for (const p of points) {
    for (const key of ['seq', 'step', 'timestamp', 'value'] as const) finite(p[key], key);
    const x = axis === 'relative' ? finite(p.timestamp - runStart!, 'Relative timestamp') : p[axis];
    const prior = latest.get(x);
    if (!prior || p.seq >= prior.seq) latest.set(x, p);
  }
  return Array.from(latest, ([x, p]): XY => [x, p.value]).sort((a, b) => a[0] - b[0]);
}

function copyOrdered(points: XY[]): XY[] {
  return points.map(([x, y], i) => {
    finite(x, 'x');
    finite(y, 'y');
    if (i > 0 && !(x > points[i - 1][0])) {
      throw new RangeError('XY coordinates must be strictly increasing; canonicalize first');
    }
    return [x, y];
  });
}

// Convex interpolation without overflowing b-a for opposite-sign extremes.
function mix(a: number, b: number, t: number): number {
  if (t === 0) return a;
  if (t === 1) return b;
  const delta = b - a;
  const value = Number.isFinite(delta) ? a + t * delta : (1 - t) * a + t * b;
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), value));
}

/** Per-observation EMA over the entire ordered series, seeded with its first y.
 * alpha is in (0, 1]; no viewport dependence, input mutation, or point removal.
 */
export function ema(points: XY[], alpha: number): XY[] {
  if (!(finite(alpha, 'alpha') > 0 && alpha <= 1)) throw new RangeError('alpha must be in (0, 1]');
  const result = copyOrdered(points);
  for (let i = 1; i < result.length; i++) result[i][1] = mix(result[i - 1][1], result[i][1], alpha);
  return result;
}

/** EMA over paired event order. X is a recorded coordinate, not a sort key. */
export function emaInOrder(points: XY[], alpha: number): XY[] {
  if (!(finite(alpha, 'alpha') > 0 && alpha <= 1)) throw new RangeError('alpha must be in (0, 1]');
  const result = points.map(([x, y]): XY => [finite(x, 'x'), finite(y, 'y')]);
  for (let i = 1; i < result.length; i++) result[i][1] = mix(result[i - 1][1], result[i][1], alpha);
  return result;
}

function sameSign(a: number, b: number): boolean {
  return a !== 0 && b !== 0 && Math.sign(a) === Math.sign(b);
}

/** PCHIP derivatives: Fritsch & Butland (1984), DOI 10.1137/0905021.
 * Weighted harmonic interior means and one-sided shape-limited endpoints,
 * as documented by scipy.interpolate.PchipInterpolator (SciPy _cubic.py).
 * Rescaling avoids unnecessary overflow in weights and reciprocal slopes.
 */
function derivatives(h: number[], d: number[]): number[] {
  if (d.length === 1) return [d[0], d[0]];
  function endpoint(h0: number, h1: number, d0: number, d1: number): number {
    if (d0 === 0) return 0;
    const hs = Math.max(h0, h1);
    const q = (h0 / hs) / (h0 / hs + h1 / hs);
    const ds = Math.max(Math.abs(d0), Math.abs(d1));
    let scaled = (1 + q) * (d0 / ds) - q * (d1 / ds);
    if (!sameSign(scaled, d0)) return 0;
    if (!sameSign(d0, d1) && Math.abs(scaled) > 3 * Math.abs(d0 / ds)) {
      scaled = 3 * (d0 / ds);
    }
    return finite(scaled * ds, 'PCHIP endpoint derivative');
  }
  const m = [endpoint(h[0], h[1], d[0], d[1])];
  for (let i = 1; i < d.length; i++) {
    const left = d[i - 1], right = d[i];
    if (!sameSign(left, right)) {
      m.push(0);
    } else {
      const hs = Math.max(h[i - 1], h[i]);
      const hp = h[i - 1] / hs, hn = h[i] / hs;
      const w = (2 * hn + hp) / (3 * (hp + hn));
      const small = Math.min(Math.abs(left), Math.abs(right));
      m.push(Math.sign(left) * finite(small / (w * (small / Math.abs(left)) +
        (1 - w) * (small / Math.abs(right))), 'PCHIP derivative'));
    }
  }
  const last = d.length - 1;
  m.push(endpoint(h[last], h[last - 1], d[last], d[last - 1]));
  return m;
}

/** Finite, strictly increasing XY input is copied. Queries must be finite.
 * Empty/out-of-domain queries return null. Knots return the exact stored y.
 * Unrepresentable widths/secants/derivatives or underflowing normalized queries
 * throw RangeError, never NaN/Infinity. Roots are accurate to floating-point
 * resolution; distinct mathematical roots may share one representable x.
 * Threshold results are sorted; points are isolated roots only (plateau endpoints
 * belong to the closed plateau intervals, not redundantly to points).
 */
export function makeInterpolator(points: XY[], kind: Interpolation): Interpolator {
  if (kind !== 'linear' && kind !== 'pchip') throw new RangeError('Unknown interpolation');
  const data = copyOrdered(points);
  const n = data.length;
  const h: number[] = [], d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(finite(data[i + 1][0] - data[i][0], 'Segment width'));
    if (kind === 'pchip') {
      const delta = finite(data[i + 1][1] - data[i][1], 'PCHIP value difference');
      const slope = finite(delta / h[i], 'PCHIP secant');
      if (delta !== 0 && slope === 0) throw new RangeError('PCHIP secant underflow');
      d.push(slope);
    }
  }
  const m = kind === 'pchip' && n > 1 ? derivatives(h, d) : [];
  // Normalized Bezier controls: derivatives/secant are bounded by [0,3].
  // Evaluating by de Casteljau avoids large cubic coefficients and overshoot.
  const controls = d.map((slope, i): [number, number] => slope === 0 ? [0, 1] : [
    Math.max(0, Math.min(1, finite(m[i] / slope, 'PCHIP slope ratio') / 3)),
    1 - Math.max(0, Math.min(1, finite(m[i + 1] / slope, 'PCHIP slope ratio') / 3)),
  ]);
  function fraction(i: number, t: number): number {
    if (kind === 'linear' || d[i] === 0 || (m[i] === d[i] && m[i + 1] === d[i])) return t;
    const [c1, c2] = controls[i];
    const a = mix(0, c1, t), b = mix(c1, c2, t), c = mix(c2, 1, t);
    return mix(mix(a, b, t), mix(b, c, t), t);
  }
  function at(x: number): number | null {
    finite(x, 'Query x');
    if (!n || x < data[0][0] || x > data[n - 1][0]) return null;
    // Lower bound: O(log n), including exact knots and the final endpoint.
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (data[mid][0] < x) lo = mid + 1;
      else hi = mid;
    }
    if (data[lo][0] === x) return data[lo][1];
    const i = lo - 1;
    if (data[i][1] === data[i + 1][1]) return data[i][1];
    const t = (x - data[i][0]) / h[i];
    if (t === 0) throw new RangeError('Normalized query underflow');
    return mix(data[i][1], data[i + 1][1], fraction(i, t));
  }
  function crossings(y: number): Crossings {
    finite(y, 'Threshold');
    const roots: number[] = [], plateaus: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const [x0, y0] = data[i];
      if (y0 === y && (i === 0 || data[i - 1][1] !== y) &&
          (i === n - 1 || data[i + 1][1] !== y)) roots.push(x0);
      if (i === n - 1) continue;
      const [x1, y1] = data[i + 1];
      if (y0 === y && y1 === y) {
        const previous = plateaus[plateaus.length - 1];
        if (previous && previous[1] === x0) previous[1] = x1;
        else plateaus.push([x0, x1]);
      } else if ((y0 < y && y < y1) || (y1 < y && y < y0)) {
        const delta = y1 - y0;
        const scale = Math.max(Math.abs(y0), Math.abs(y1));
        const target = Number.isFinite(delta) ? (y - y0) / delta :
          (y / scale - y0 / scale) / (y1 / scale - y0 / scale);
        if (target === 0) throw new RangeError('Normalized threshold underflow');
        let t = target;
        if (kind === 'pchip') {
          let lo = 0, hi = 1;
          // Bracketed solve on each monotonic segment. Unlike an absolute x
          // tolerance, representable-neighbor termination works on tiny grids.
          // 1076 bisections also cover roots down into the subnormal t range.
          for (let k = 0; k < 1076; k++) {
            t = lo + (hi - lo) / 2;
            if (t === lo || t === hi) break;
            const value = fraction(i, t);
            if (value === target) break;
            if (value < target) lo = t;
            else hi = t;
          }
        }
        const root = mix(x0, x1, t);
        if (roots[roots.length - 1] !== root) roots.push(root);
      }
    }
    // Distinct mathematical roots can round to the same representable x.
    return { points: roots.filter((x, i) => i === 0 || x !== roots[i - 1]), plateaus };
  }
  return { at, crossings };
}

/** Oscilloscope XY join of two canonical [parameter, value] channels that share
 * one parameter (step, wall time, or relative time). Output is [x, y] in
 * parameter order over the overlap of both domains; at every knot of either
 * channel the other is interpolated, never extrapolated. With linear channels the
 * returned polyline is exactly the parametric curve. Inputs are not mutated.
 * `knots: 'y'` samples only at Y knots (raw observation markers).
 */
export function joinXY(y: XY[], x: XY[], kind: Interpolation, knots: 'union' | 'y' = 'union'): XY[] {
  if (!y.length || !x.length) return [];
  const fy = makeInterpolator(y, kind), fx = makeInterpolator(x, kind);
  const params: number[] = [];
  if (knots === 'y') for (const p of y) params.push(p[0]);
  else {
    let i = 0, j = 0;
    while (i < y.length || j < x.length) {
      const a = i < y.length ? y[i][0] : Infinity, b = j < x.length ? x[j][0] : Infinity;
      const t = Math.min(a, b);
      if (a === t) i++;
      if (b === t) j++;
      params.push(t);
    }
  }
  const result: XY[] = [];
  for (const t of params) {
    const xv = fx.at(t), yv = fy.at(t);
    if (xv !== null && yv !== null) result.push([xv, yv]);
  }
  return result;
}

export type XYInterpolator = Interpolator & { monotonic: boolean };

/** Readouts for a parametric polyline (points in parameter order, any x order).
 * at(x) is defined only when x is monotonic after merging consecutive repeated x
 * (the later sample wins, matching duplicate-coordinate semantics elsewhere);
 * otherwise one x can map to several y and at() returns null. crossings(level)
 * reports every x where the polyline meets the level, sorted, with plateaus as
 * closed x intervals. Straight segments between joined samples are exact for
 * linear channels.
 */
export function makeXYInterpolator(points: XY[]): XYInterpolator {
  const data = points.map(([x, y]): XY => [finite(x, 'x'), finite(y, 'y')]);
  const merged: XY[] = [];
  for (const p of data) {
    if (merged.length && merged[merged.length - 1][0] === p[0]) merged[merged.length - 1] = p;
    else merged.push(p);
  }
  const increasing = merged.every((p, i) => i === 0 || p[0] > merged[i - 1][0]);
  const decreasing = !increasing && merged.every((p, i) => i === 0 || p[0] < merged[i - 1][0]);
  const ordered = increasing ? merged : decreasing ? [...merged].reverse() : null;
  const fn = ordered ? makeInterpolator(ordered, 'linear') : null;
  function at(x: number): number | null {
    finite(x, 'Query x');
    return fn ? fn.at(x) : null;
  }
  function crossings(level: number): Crossings {
    finite(level, 'Threshold');
    const roots: number[] = [], plateaus: [number, number][] = [];
    const n = data.length;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = data[i];
      if (y0 === level && (i === 0 || data[i - 1][1] !== level) &&
          (i === n - 1 || data[i + 1][1] !== level)) roots.push(x0);
      if (i === n - 1) continue;
      const [x1, y1] = data[i + 1];
      if (y0 === level && y1 === level) {
        const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
        const previous = plateaus[plateaus.length - 1];
        if (previous && lo <= previous[1] && hi >= previous[0]) {
          previous[0] = Math.min(previous[0], lo);
          previous[1] = Math.max(previous[1], hi);
        } else plateaus.push([lo, hi]);
      } else if ((y0 < level && level < y1) || (y1 < level && level < y0)) {
        const delta = y1 - y0;
        const scale = Math.max(Math.abs(y0), Math.abs(y1));
        const t = Number.isFinite(delta) ? (level - y0) / delta :
          (level / scale - y0 / scale) / (y1 / scale - y0 / scale);
        roots.push(mix(x0, x1, t));
      }
    }
    roots.sort((a, b) => a - b);
    plateaus.sort((a, b) => a[0] - b[0]);
    return { points: roots.filter((x, i) => i === 0 || x !== roots[i - 1]), plateaus };
  }
  return { at, crossings, monotonic: !!ordered };
}
