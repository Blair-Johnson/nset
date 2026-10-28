/** Pure, DOM-free analysis: canonical curves, smoothing, XY joins and readouts.
 * PlotPanel renders these; cards and the editor share them. */
import {
  canonicalize,
  ema,
  emaInOrder,
  joinXY,
  makeInterpolator,
  makeXYInterpolator,
  type Interpolator,
  type Point,
  type XY,
} from "./math";
import type { ViewConfig } from "./config";
import type { XQuantity } from "./options";
import { runStartTime, type Run } from "./api";

export interface PlotRun {
  run: Run;
  raw: Point[];
  /** Record observations are already paired, in event order; never canonicalize/join. */
  paired?: { key: string; points: XY[] };
  /** XY charts: the X channel, joined to `raw` on the config's step/time axis.
   * `run` supplies the relative-time origin for that channel. */
  x?: { run: Run; raw: Point[]; key: string };
}
export interface Analyzed {
  run: Run;
  /** Raw observations as drawable [x, y] (XY: Y observations placed on X). */
  observations: XY[];
  /** Displayed curve knots, in parameter order (XY: any x order). */
  points: XY[];
  fn: Interpolator & { monotonic?: boolean };
  count: number;
  /** XY charts only: identity of the X channel. */
  x?: { key: string };
}
export function analyze(data: PlotRun[], config: ViewConfig): Analyzed[] {
  return data.map(({ run, raw, x, paired }) => {
    if (paired) {
      const observations = paired.points;
      const points = config.smoothing
        ? emaInOrder(observations, config.alpha)
        : observations;
      const fn = makeXYInterpolator(points);
      // Repeated coordinates can represent different values, not replacements.
      if (new Set(points.map((p) => p[0])).size !== points.length) {
        fn.at = () => null;
        fn.monotonic = false;
      }
      return {
        run,
        observations,
        points,
        fn,
        count: observations.length,
        x: { key: paired.key },
      };
    }
    const observations = canonicalize(raw, config.axis, runStartTime(run));
    const points = config.smoothing
      ? ema(observations, config.alpha)
      : observations;
    if (x) {
      // Smoothing applies to the Y channel only: the X channel (often a
      // cumulative counter) keeps its logged values.
      const channel = canonicalize(x.raw, config.axis, runStartTime(x.run));
      const joined = joinXY(points, channel, config.interpolation);
      return {
        run,
        observations: joinXY(observations, channel, config.interpolation, "y"),
        points: joined,
        fn: makeXYInterpolator(joined),
        count: raw.length,
        x: { key: x.key },
      };
    }
    return {
      run,
      observations,
      points,
      fn: makeInterpolator(points, config.interpolation),
      count: raw.length,
    };
  });
}
/** The quantity on the horizontal axis of rendered data. */
export function xQuantity(data: Analyzed[], config: ViewConfig): XQuantity {
  return data.some((d) => d.x) ? "metric" : config.axis;
}
