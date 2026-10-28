import type { XY } from "./math";

type Sample = {
  x: number;
  u: number;
  y: number;
  originalY: number;
  index: number;
  fit: number;
  reuse: boolean;
};
type Bin = {
  start: number;
  end: number;
  anchor: number;
  offset: number;
  moments?: Float64Array[];
  totals?: Float64Array;
};
type Projection = {
  sigma: number;
  transform: (x: number) => number;
  samples: Sample[];
};
// Keys are caller-owned outputs; snapshots do not reference their keys or prior projections.
const projections = new WeakMap<readonly XY[], Projection>();
const identity = (x: number): number => x;
const DEGREE = 10;
const POSITION_MOMENTS = DEGREE + 3;
const VALUE_MOMENTS = DEGREE + 2;
const BIN_WIDTH = 1 / 4; // sigma units; centered offsets are at most 1/8
const DIRECT_WINDOW = 64;
const DIRECT_BIN = 8;

/** Gaussian-weighted local linear regression, evaluated only at original Xs.
 * Fits a + b*(transform(x)-transform(x_i))/sigma with exp(-d*d/2) weights
 * and the CLOSED |d| <= 3 neighborhood. Returns [originalX, a]. Unsorted
 * inputs are supported, copied, and returned in their original order. Invalid
 * transformed coordinates are excluded and keep their original Y; singular or
 * numerically unsupported fits also keep their original Y. Raw X/Y and sigma
 * must be finite, sigma > 0. The transform must be pure (may return NaN).
 *
 * Small windows are exact. Dense windows use degree-10 Gaussian Taylor weights
 * in bins of width <= sigma/4, NOT resampled observations. Prefix moments
 * retain every sample's position/value and enforce exact cutoff membership.
 * For |d| <= 25/8 and |z| <= 1/8, the relative kernel remainder is < 1e-12:
 * Cauchy's coefficient bound on radius r=sqrt(11) gives
 * exp(r²/2+d²/4+|dz|+z²/2) * (|z|/r)^11 / (1-|z|/r) < 9.49e-13.
 * All five regression moments use the same weights, preserving affine functions
 * up to roundoff. Output error also depends on local conditioning.
 *
 * O(n log n) sorting, O(n) storage/preparation; at most 26 bins per fit.
 * Optional previous is an output of this function. With identical sigma and
 * transform identity, only targets whose CLOSED support changed are refitted.
 * Input/output snapshots protect reuse from caller mutation. Appends, removals,
 * moved points and changed values invalidate both old and new neighborhoods.
 * Unaffected cached results may differ from a fresh fit by floating-point and
 * Taylor roundoff (global normalization/bin partition can change), not semantics.
 */
export function gaussianLocalLinear(
  points: XY[],
  sigma: number,
  transform: (x: number) => number = identity,
  previous?: readonly XY[],
): XY[] {
  if (!Number.isFinite(sigma) || sigma <= 0)
    throw new RangeError("sigma must be finite and positive");
  const samples: Sample[] = [];
  let scale = 0;
  const result = points.map(([x, y], index): XY => {
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RangeError("XY must be finite");
    const u = transform(x);
    if (Number.isFinite(u)) {
      samples.push({ x, u, y, originalY: y, index, fit: y, reuse: false });
      scale = Math.max(scale, Math.abs(y));
    }
    return [x, y];
  });
  samples.sort((a, b) => a.u - b.u || a.x - b.x || a.index - b.index);
  const finish = (): XY[] => {
    for (const sample of samples) result[sample.index][1] = sample.fit;
    projections.set(result, { sigma, transform, samples });
    return result;
  };
  if (samples.length < 3 || scale === 0) return finish();
  const distance = (a: number, b: number): number => {
    const delta = a - b;
    return Number.isFinite(delta) ? delta / sigma : a / sigma - b / sigma;
  };
  const prior = previous && projections.get(previous);
  if (prior && prior.sigma === sigma && prior.transform === transform) {
    const old = prior.samples,
      changed: number[] = [];
    let i = 0,
      j = 0;
    // Sorted merge preserves multiplicity. Duplicate-coordinate groups are
    // reused only if all their original values/order agree; otherwise refit.
    while (i < samples.length || j < old.length) {
      const a = samples[i],
        b = old[j];
      const order = !a ? 1 : !b ? -1 : a.u - b.u || a.x - b.x;
      if (order < 0) {
        changed.push(a.u);
        i++;
      } else if (order > 0) {
        changed.push(b.u);
        j++;
      } else {
        let ie = i + 1,
          je = j + 1;
        while (
          ie < samples.length &&
          samples[ie].u === a.u &&
          samples[ie].x === a.x
        )
          ie++;
        while (je < old.length && old[je].u === b.u && old[je].x === b.x) je++;
        let same = ie - i === je - j;
        for (let k = 0; same && k < ie - i; k++)
          same = samples[i + k].originalY === old[j + k].originalY;
        if (same)
          for (let k = 0; k < ie - i; k++) {
            samples[i + k].reuse = true;
            samples[i + k].fit = old[j + k].fit;
          }
        else changed.push(a.u);
        i = ie;
        j = je;
      }
    }
    let change = 0,
      refits = 0;
    for (const sample of samples) {
      while (
        change < changed.length &&
        distance(changed[change], sample.u) < -3
      )
        change++;
      if (change < changed.length && distance(changed[change], sample.u) <= 3)
        sample.reuse = false;
      if (!sample.reuse) {
        sample.fit = sample.originalY;
        refits++;
      }
    }
    if (refits === 0) return finish();
  }
  const origin = samples[0].y / scale;
  // Normalized Y avoids overflow; removing a common offset preserves constants.
  for (const sample of samples) sample.y = sample.y / scale - origin;
  const bins: Bin[] = [];
  let binAt = new Int32Array(0);
  const prepareBins = (): void => {
    binAt = new Int32Array(samples.length);
    for (let start = 0; start < samples.length;) {
      let end = start + 1;
      while (
        end < samples.length &&
        distance(samples[end].u, samples[start].u) <= BIN_WIDTH
      )
        end++;
      // Do not round an absolute midpoint (e.g. between 1e16 and 1e16+2).
      // A normalized offset keeps every centered position within BIN_WIDTH/2.
      const anchor = samples[start].u,
        offset = distance(samples[end - 1].u, anchor) / 2;
      const bin: Bin = { start, end, anchor, offset };
      if (end - start > DIRECT_BIN) {
        const moments = Array.from(
          { length: POSITION_MOMENTS + VALUE_MOMENTS },
          () => new Float64Array(end - start + 1),
        );
        for (let j = start; j < end; j++) {
          const at = j - start,
            z = distance(samples[j].u, anchor) - offset;
          let power = 1;
          for (let k = 0; k < POSITION_MOMENTS; k++) {
            moments[k][at + 1] = moments[k][at] + power;
            if (k < VALUE_MOMENTS)
              moments[POSITION_MOMENTS + k][at + 1] =
                moments[POSITION_MOMENTS + k][at] + power * samples[j].y;
            power *= z;
          }
        }
        bin.moments = moments;
        bin.totals = Float64Array.from(moments, (row) => row[end - start]);
      }
      binAt.fill(bins.length, start, end);
      bins.push(bin);
      start = end;
    }
  };
  let left = 0,
    right = 0;
  const partial = new Float64Array(POSITION_MOMENTS + VALUE_MOMENTS);
  for (const target of samples) {
    if (target.reuse) continue;
    while (left < samples.length && distance(samples[left].u, target.u) < -3)
      left++;
    while (right < samples.length && distance(samples[right].u, target.u) <= 3)
      right++;
    if (right - left < 3) continue; // one/two distinct observations fit themselves
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      t0 = 0,
      t1 = 0;
    const direct = (start: number, end: number): void => {
      for (let j = start; j < end; j++) {
        const d = distance(samples[j].u, target.u),
          w = Math.exp(-0.5 * d * d);
        s0 += w;
        s1 += w * d;
        s2 += w * d * d;
        t0 += w * samples[j].y;
        t1 += w * d * samples[j].y;
      }
    };
    if (right - left <= DIRECT_WINDOW) direct(left, right);
    else {
      if (!bins.length) prepareBins();
      for (let b = binAt[left]; b <= binAt[right - 1]; b++) {
        const bin = bins[b],
          start = Math.max(left, bin.start),
          end = Math.min(right, bin.end);
        if (!bin.moments || end - start <= DIRECT_BIN) {
          direct(start, end);
          continue;
        }
        const d = distance(bin.anchor, target.u) + bin.offset,
          weight = Math.exp(-0.5 * d * d);
        const a = start - bin.start,
          z = end - bin.start;
        let m = bin.totals!;
        if (start !== bin.start || end !== bin.end) {
          m = partial;
          for (let k = 0; k < m.length; k++)
            m[k] = bin.moments[k][z] - bin.moments[k][a];
        }
        let m0 = 0,
          m1 = 0,
          m2 = 0,
          v0 = 0,
          v1 = 0,
          c = 1,
          previousCoefficient = 0;
        for (let k = 0; k <= DEGREE; k++) {
          m0 += c * m[k];
          m1 += c * m[k + 1];
          m2 += c * m[k + 2];
          v0 += c * m[POSITION_MOMENTS + k];
          v1 += c * m[POSITION_MOMENTS + 1 + k];
          const next = (-d * c - previousCoefficient) / (k + 1);
          previousCoefficient = c;
          c = next;
        }
        s0 += weight * m0;
        s1 += weight * (d * m0 + m1);
        s2 += weight * (d * d * m0 + 2 * d * m1 + m2);
        t0 += weight * v0;
        t1 += weight * (d * v0 + v1);
      }
    }
    const determinant = s0 * s2 - s1 * s1;
    if (!(s2 > 0 && determinant > 32 * Number.EPSILON * s0 * s2)) continue;
    const estimate = ((t0 * s2 - t1 * s1) / determinant + origin) * scale;
    if (Number.isFinite(estimate)) target.fit = estimate;
  }
  return finish();
}
