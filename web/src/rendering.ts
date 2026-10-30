import type { XY } from "./math";

export type RenderBounds = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};
export type TessellationOptions = {
  tolerance?: number;
  maxDepth?: number;
  maxExtraPoints?: number;
};
export type Tessellation = { segments: XY[][]; limited: boolean };

type Pixel = [number, number];
const EXTRA_LIMIT = 200_000;
const floatBits = new DataView(new ArrayBuffer(8));
const SIGN = 1n << 63n,
  MASK = (1n << 64n) - 1n;

/** Midpoint in ordered finite IEEE-754 values, not arithmetic distance.
 * Bisection reaches adjacent values in at most 64 steps, even across zero and
 * hundreds of decades. Used only for bounded display-boundary searches.
 */
export function floatMidpoint(a: number, b: number): number {
  const key = (x: number) => {
    floatBits.setFloat64(0, x);
    const bits = floatBits.getBigUint64(0);
    return bits & SIGN ? ~bits & MASK : bits | SIGN;
  };
  const middle = (key(a) + key(b)) >> 1n;
  floatBits.setBigUint64(0, middle & SIGN ? middle & ~SIGN : ~middle & MASK);
  return floatBits.getFloat64(0);
}

// Unlike (a + b) / 2 or a + (b - a) / 2, this also handles huge opposite signs.
function between(a: number, b: number, t: number): number {
  return Math.sign(a) === Math.sign(b) ? a + (b - a) * t : a * (1 - t) + b * t;
}

function distance(p: Pixel, a: Pixel, b: Pixel): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (!length) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  // Unit-vector form avoids squaring large pixel coordinates.
  const ux = dx / length,
    uy = dy / length;
  const along = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy;
  if (along < 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  if (along > length) return Math.hypot(p[0] - b[0], p[1] - b[1]);
  return Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux);
}

/** Display-only approximation; never changes the original-domain interpolator.
 *
 * Contract: finite knots, strictly increasing x; at agrees with the knots and
 * is continuous and monotone on EACH consecutive pair (linear or PCHIP).
 * project is a continuous axis-wise monotone pixel mapping, possibly reversed,
 * finite throughout the finite, strictly ascending viewport. Callers enforce
 * positive log bounds, split known null gaps into separate calls, and rerun on
 * every range/size change. No transform or interpolation is inferred here.
 *
 * Returned coordinates use data-domain units, but clip edges are DISPLAY
 * geometry, not observations: their x may differ from an exact root by a
 * bracket of at most 0.1*tolerance in screen x. Monotonicity bounds the entire
 * connecting arc inside that strip; overlapping brackets use at most twice
 * that width. Never feed these edges back into at or numerical calculations.
 * Only viewport-valid coordinates are projected (including on log axes).
 * Visible knots and clip edges do not consume maxExtraPoints. At most
 * 200,000 adaptive points and 52 subdivision levels may be requested. Null or
 * nonfinite evaluations conservatively break a path and set limited; arbitrary
 * hidden discontinuities cannot be discovered by finite probing.
 *
 * Quarter/mid/three-quarter probes (with 20% headroom) estimate pixel error;
 * this is not a mathematical supremum guarantee for arbitrary callbacks. The
 * tolerance is in project units (e.g. canvas/device pixels, not necessarily CSS
 * pixels). limited signals exhausted depth/budget/precision or invalid samples.
 */
export function tessellate(
  points: XY[],
  at: (x: number) => number | null,
  project: (x: number, y: number) => Pixel,
  bounds: RenderBounds,
  options: TessellationOptions = {},
): Tessellation {
  const { xMin, xMax, yMin, yMax } = bounds;
  const {
    tolerance = 0.35,
    maxDepth = 20,
    maxExtraPoints = EXTRA_LIMIT,
  } = options;
  if (
    ![xMin, xMax, yMin, yMax].every(Number.isFinite) ||
    !(xMin < xMax) ||
    !(yMin < yMax)
  )
    throw new RangeError(
      "Viewport bounds must be finite and strictly ascending",
    );
  if (
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > 52 ||
    !Number.isInteger(maxExtraPoints) ||
    maxExtraPoints < 0 ||
    maxExtraPoints > EXTRA_LIMIT
  )
    throw new RangeError(
      "Invalid tessellation tolerance, depth (0..52), or extra-point budget (0..200000)",
    );
  if (typeof at !== "function" || typeof project !== "function")
    throw new TypeError("at and project must be functions");
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (
      !p ||
      p.length !== 2 ||
      !p.every(Number.isFinite) ||
      (i > 0 && p[0] <= points[i - 1][0])
    )
      throw new RangeError(
        "Knots must be finite XY pairs with strictly increasing x",
      );
  }

  const result: Tessellation = { segments: [], limited: false };
  let current: XY[] | undefined;
  let extra = 0;
  const visible = (p: XY) =>
    p[0] >= xMin && p[0] <= xMax && p[1] >= yMin && p[1] <= yMax;
  const same = (a: XY, b: XY) => a[0] === b[0] && a[1] === b[1];
  function append(p: XY): void {
    if (!current) result.segments.push((current = []));
    if (!current.length || !same(current[current.length - 1], p))
      current.push([p[0], p[1]]);
  }
  function start(p: XY): void {
    if (current?.length && !same(current[current.length - 1], p))
      current = undefined;
    append(p);
  }
  function sample(x: number): XY | null {
    const y = at(x);
    if (y === null || !Number.isFinite(y)) {
      result.limited = true;
      return null;
    }
    return [x, y];
  }
  function pixel(p: XY): Pixel {
    const q = project(p[0], p[1]);
    if (!q || q.length !== 2 || !q.every(Number.isFinite))
      throw new RangeError(
        "project must return finite pixel coordinates inside the viewport",
      );
    return q;
  }

  // A bracketed root needs no derivative and works on either monotone direction.
  // Keep real samples separate from the geometric boundary: at(edge.x) need
  // not equal edge.y when the root falls between representable x values.
  type Clip = { edge: XY; inner: XY; lo: XY; hi: XY };
  const exact = (p: XY): Clip => ({ edge: p, inner: p, lo: p, hi: p });
  function crossing(a: XY, b: XY, y: number, keepAbove: boolean): Clip | null {
    if (a[1] === y) return exact(a);
    if (b[1] === y) return exact(b);
    let lo = a,
      hi = b;
    const increasing = b[1] > a[1];
    // One secant trial makes affine clipping cheap and exact when representable.
    // Normalize only if huge opposite-sign y values overflow subtraction.
    const delta = b[1] - a[1];
    const scale = Math.max(Math.abs(a[1]), Math.abs(b[1]), Math.abs(y));
    const fraction = Number.isFinite(delta)
      ? (y - a[1]) / delta
      : (y / scale - a[1] / scale) / (b[1] / scale - a[1] / scale);
    for (let i = 0; i <= 64; i++) {
      const x =
        i === 0 ? between(a[0], b[0], fraction) : floatMidpoint(lo[0], hi[0]);
      const interior = Number.isFinite(x) && x > lo[0] && x < hi[0];
      if (interior) {
        const p = sample(x);
        if (!p) return null;
        if (p[1] < Math.min(lo[1], hi[1]) || p[1] > Math.max(lo[1], hi[1])) {
          result.limited = true;
          return null;
        }
        if (p[1] === y) return exact(p);
        if (p[1] < y === increasing) lo = p;
        else hi = p;
      }
      // Probe only valid viewport coordinates. Axis-wise projection means the
      // x width does not depend on the synthetic y used to measure the bracket.
      const width = Math.abs(pixel([hi[0], y])[0] - pixel([lo[0], y])[0]);
      if (width <= tolerance * 0.1) {
        const inner = lo[1] > y === keepAbove ? lo : hi;
        return { edge: [inner[0], y], inner, lo, hi };
      }
      if (!interior && i > 0) break;
    }
    result.limited = true;
    return null;
  }

  function subdivide(a: XY, b: XY, pa: Pixel, pb: Pixel, depth: number): void {
    if (a[0] === b[0]) {
      append(b);
      return;
    }
    const q = sample(between(a[0], b[0], 0.25));
    const m = sample(between(a[0], b[0], 0.5));
    const r = sample(between(a[0], b[0], 0.75));
    // Unexpected null/nonfinite/out-of-viewport values violate the continuous
    // monotone-span contract. Keep endpoints but never draw across such a gap.
    if (!q || !m || !r || !visible(q) || !visible(m) || !visible(r)) {
      result.limited = true;
      current = undefined;
      append(b);
      return;
    }
    const pm = pixel(m);
    const error = Math.max(
      distance(pixel(q), pa, pb),
      distance(pm, pa, pb),
      distance(pixel(r), pa, pb),
    );
    if (Number.isFinite(error) && error <= tolerance * 0.8) {
      append(b);
      return;
    }
    if (
      depth >= maxDepth ||
      extra >= maxExtraPoints ||
      m[0] === a[0] ||
      m[0] === b[0]
    ) {
      result.limited = true;
      append(b);
      return;
    }
    extra++;
    subdivide(a, m, pa, pm, depth + 1);
    subdivide(m, b, pm, pb, depth + 1);
  }

  if (!points.length) return result;
  if (points.length === 1) {
    if (visible(points[0])) {
      pixel(points[0]);
      append(points[0]);
    }
    return result;
  }
  // Locate the first potentially visible span without copying/slicing input.
  let lo = 0,
    hi = points.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid][0] < xMin) lo = mid + 1;
    else hi = mid;
  }
  const first = Math.max(0, lo - 1);
  if (first < points.length && visible(points[first])) {
    pixel(points[first]);
    start(points[first]);
  }
  for (let i = first; i + 1 < points.length && points[i][0] <= xMax; i++) {
    const left = points[i],
      right = points[i + 1];
    const a: XY | null = left[0] < xMin ? sample(xMin) : left;
    const b: XY | null = right[0] > xMax ? sample(xMax) : right;
    if (
      a &&
      b &&
      a[0] <= b[0] &&
      Math.max(a[1], b[1]) >= yMin &&
      Math.min(a[1], b[1]) <= yMax
    ) {
      // Clip BOTH ends against the original bracket, not against a modified one.
      const ca =
        a[1] < yMin
          ? crossing(a, b, yMin, true)
          : a[1] > yMax
            ? crossing(a, b, yMax, false)
            : exact(a);
      const cb =
        b[1] < yMin
          ? crossing(a, b, yMin, true)
          : b[1] > yMax
            ? crossing(a, b, yMax, false)
            : exact(b);
      if (ca && cb) {
        if (ca.inner[0] <= cb.inner[0]) {
          start(ca.edge);
          append(ca.inner);
          // Only genuine, in-viewport samples reach the adaptive evaluator.
          subdivide(ca.inner, cb.inner, pixel(ca.inner), pixel(cb.inner), 0);
          append(cb.edge);
        } else {
          // Both roots lie in overlapping narrow brackets; there may be NO
          // representable in-viewport sample. Their union is <=0.2*tolerance
          // wide, so a vertical display edge approximates the entire monotone
          // visible arc without fabricating a numerical observation.
          const x = between(
            Math.max(ca.lo[0], cb.lo[0]),
            Math.min(ca.hi[0], cb.hi[0]),
            0.5,
          );
          start([x, ca.edge[1]]);
          append([x, cb.edge[1]]);
        }
      } else current = undefined;
    } else current = undefined;
    // Preserve every visible source knot even if a neighboring span was invalid
    // or the adaptive budget was exhausted. start only joins identical endpoints.
    if (visible(right)) {
      pixel(right);
      start(right);
    } else current = undefined;
  }
  return result;
}
