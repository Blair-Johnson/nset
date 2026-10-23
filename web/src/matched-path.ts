import uPlot from "uplot";
import type { XY } from "./math";
import { tessellate, type TessellationOptions } from "./rendering";

export type MatchedPathOptions = TessellationOptions & {
  fillTo?: number;
  onLimited?: (limited: boolean) => void;
};

/** Original-domain interpolation rendered in the CURRENT x/y viewport.
 *
 * Shares tessellate's finite, increasing-knot, continuous monotone-span contract;
 * callers split known null gaps and supply singleton markers separately. uPlot's
 * aligned data and idx0/idx1 are deliberately not used as interpolation knots.
 * Fill clamping changes geometry only, never points or the numerical evaluator.
 * Budgets apply independently to stroke and each contiguous fill-domain run.
 * Like tessellate, finite probes cannot discover arbitrary hidden discontinuities.
 */
export function matchedPath(
  points: XY[],
  at: (x: number) => number | null,
  options: MatchedPathOptions = {},
): uPlot.Series.PathBuilder {
  return (u, seriesIdx) => {
    const x = u.scales.x,
      y = u.scales.y;
    const bounds = { xMin: x.min!, xMax: x.max!, yMin: y.min!, yMax: y.max! };
    if (
      !Object.values(bounds).every(Number.isFinite) ||
      !(bounds.xMin < bounds.xMax) ||
      !(bounds.yMin < bounds.yMax) ||
      (x.distr === 3 && bounds.xMin <= 0) ||
      (y.distr === 3 && bounds.yMin <= 0)
    )
      throw new RangeError(
        "Matched paths require finite ascending bounds and positive log bounds",
      );
    if (options.fillTo !== undefined && !Number.isFinite(options.fillTo))
      throw new RangeError("Matched path fillTo must be finite");

    // 1.6.32 exposes pxRatio on the public constructor, NOT on plot instances.
    const deviceRatio =
      typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    const ratio =
      Number.isFinite(uPlot.pxRatio) && uPlot.pxRatio > 0
        ? uPlot.pxRatio
        : Number.isFinite(deviceRatio) && deviceRatio > 0
          ? deviceRatio
          : 1;
    const settings = {
      tolerance: options.tolerance ?? 0.35 * ratio,
      maxDepth: options.maxDepth,
      maxExtraPoints: options.maxExtraPoints,
    };
    const project = (vx: number, vy: number): XY => [
      u.valToPos(vx, "x", true),
      u.valToPos(vy, "y", true),
    ];
    // Adaptive error is measured before optional cosmetic pixel snapping, just
    // as native builders round their projected coordinates. PlotPanel defaults
    // adaptive curves to pxAlign:false; an explicit global/run value opts in.
    const alignment = Number(u.series[seriesIdx]?.pxAlign ?? 0);
    const drawProject = (vx: number, vy: number): XY => {
      const p = project(vx, vy);
      return alignment > 0
        ? [
            Math.round(p[0] / alignment) * alignment,
            Math.round(p[1] / alignment) * alignment,
          ]
        : p;
    };
    const result = tessellate(points, at, project, bounds, settings);
    let limited = result.limited;
    const stroke = new Path2D();
    for (const segment of result.segments) {
      if (segment.length < 2) continue;
      stroke.moveTo(...drawProject(...segment[0]));
      for (let i = 1; i < segment.length; i++)
        stroke.lineTo(...drawProject(...segment[i]));
    }

    const fill = new Path2D();
    const fillOption = u.series[seriesIdx]?.fill;
    const fillStyle =
      typeof fillOption === "function" ? fillOption(u, seriesIdx) : fillOption;
    if (fillStyle != null && points.length > 1) {
      const clamp = (value: number) =>
        Math.max(bounds.yMin, Math.min(bounds.yMax, value));
      const baseline = options.fillTo ?? (y.distr === 3 ? bounds.yMin : 0);
      const baselinePx = u.valToPos(clamp(baseline), "y", true);
      // Saturating the curve, not just the baseline, retains the visible area
      // beneath curves entirely above the viewport (where stroke is empty).
      const fillAt = (vx: number): number | null => {
        const value = at(vx);
        return value === null ||
          !Number.isFinite(value) ||
          (y.distr === 3 && value <= 0)
          ? null
          : clamp(value);
      };
      const runs =
        y.distr === 3
          ? positiveRuns(points, at, () => {
              limited = true;
            })
          : [points];
      for (const run of runs) {
        const filled = tessellate(
          run.map(([vx, vy]): XY => [vx, clamp(vy)]),
          fillAt,
          project,
          bounds,
          settings,
        );
        limited ||= filled.limited;
        for (const segment of filled.segments) {
          if (segment.length < 2) continue;
          const first = drawProject(...segment[0]);
          const last = drawProject(...segment[segment.length - 1]);
          fill.moveTo(...first);
          for (let i = 1; i < segment.length; i++)
            fill.lineTo(...drawProject(...segment[i]));
          fill.lineTo(last[0], baselinePx);
          fill.lineTo(first[0], baselinePx);
          fill.closePath();
        }
      }
    }
    const clip = new Path2D();
    clip.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
    options.onLimited?.(limited);
    return { stroke, fill, clip };
  };
}

/** Split BEFORE clamping: otherwise negative/zero log values become a spurious
 * horizontal edge, filling across invalid domains when the baseline is above it.
 * A boundary is the nearest representable x on its positive side. No zero or
 * negative value is ever projected. Null/nonfinite boundary probes are gaps.
 */
function positiveRuns(
  points: XY[],
  at: (x: number) => number | null,
  limited: () => void,
): XY[][] {
  const runs: XY[][] = [];
  let run: XY[] | undefined;
  const append = (p: XY) => {
    if (!run) runs.push((run = []));
    if (!run.length || run[run.length - 1][0] !== p[0]) run.push(p);
  };
  const boundary = (positive: XY, nonpositive: XY): XY | null => {
    let good = positive,
      bad = nonpositive;
    for (let i = 0; i < 2200; i++) {
      const vx =
        Math.sign(good[0]) === Math.sign(bad[0])
          ? good[0] + (bad[0] - good[0]) / 2
          : good[0] / 2 + bad[0] / 2;
      if (vx === good[0] || vx === bad[0]) return good;
      const vy = at(vx);
      if (vy === null || !Number.isFinite(vy)) {
        limited();
        return null;
      }
      if (vy > 0) good = [vx, vy];
      else bad = [vx, vy];
    }
    limited();
    return null;
  };
  if (points[0]?.[1] > 0) append(points[0]);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (a[1] > 0 && b[1] > 0) append(b);
    else if (a[1] > 0) {
      const end = boundary(a, b);
      if (end) append(end);
      run = undefined;
    } else if (b[1] > 0) {
      const start = boundary(b, a);
      run = undefined;
      if (start) append(start);
      append(b);
    } else run = undefined;
  }
  return runs;
}
