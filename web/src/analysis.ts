/** Pure, DOM-free analysis: canonical curves, smoothing, XY joins and readouts.
 * PlotPanel renders these; cards and the editor share them. */
import {
  canonicalize,
  joinXY,
  makeInterpolator,
  makeXYInterpolator,
  type Interpolator,
  type Point,
  type XY,
} from "./math";
import type { ViewConfig } from "./config";
import { gaussianLocalLinear } from "./gaussian";
import { smoothingCoordinate } from "./smoothing-coordinate";
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
type Channel = { canonical: XY[]; smoothed: XY[] };
type AnalysisProjection = {
  identity: string;
  signature: string;
  transform: (x: number) => number;
  y: Channel;
  x?: Channel;
};
// Weak ownership: discarding Analyzed releases its channel snapshots. No cache
// chain refers to earlier Analyzed objects or projections.
const projections = new WeakMap<Analyzed, AnalysisProjection>();
export function analyze(
  data: PlotRun[],
  config: ViewConfig,
  previous?: readonly Analyzed[],
): Analyzed[] {
  const signature = JSON.stringify(config);
  const candidates = new Map<string, AnalysisProjection>();
  for (const trace of previous ?? []) {
    const cached = projections.get(trace);
    if (cached?.signature === signature)
      candidates.set(cached.identity, cached);
  }
  return data.map(({ run, raw, x, paired }) => {
    if (paired) {
      const observations = paired.points;
      // Paired records have no independent step/time coordinate. Never infer
      // one from their X values or event order; smoothing is unsupported here.
      const points = observations;
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
    const identity = JSON.stringify([run.id, x?.run.id, x?.key]);
    const prior = candidates.get(identity);
    const coordinate = config.smoothing
      ? smoothingCoordinate(config, !!x)
      : null;
    // The helper creates fresh closures. Reuse the old pure transform only
    // when ALL settings match, so Gaussian can verify transform identity.
    const transform = prior?.transform ?? coordinate?.transform;
    const smooth = (channel: XY[], old?: Channel): XY[] =>
      transform
        ? gaussianLocalLinear(
            channel,
            config.smoothingSigma,
            transform,
            old?.smoothed,
          )
        : channel;
    const points = smooth(observations, prior?.y);
    const remember = (trace: Analyzed, xChannel?: Channel): Analyzed => {
      if (transform)
        projections.set(trace, {
          identity,
          signature,
          transform,
          y: { canonical: observations, smoothed: points },
          x: xChannel,
        });
      return trace;
    };
    if (x) {
      // Both scalar channels are independently smoothed on the common axis,
      // before joining. Observation markers still join the untouched channels.
      const channel = canonicalize(x.raw, config.axis, runStartTime(x.run));
      const smoothed = smooth(channel, prior?.x);
      const joined = joinXY(points, smoothed, config.interpolation);
      return remember(
        {
          run,
          observations: joinXY(
            observations,
            channel,
            config.interpolation,
            "y",
          ),
          points: joined,
          fn: makeXYInterpolator(joined),
          count: raw.length,
          x: { key: x.key },
        },
        { canonical: channel, smoothed },
      );
    }
    return remember({
      run,
      observations,
      points,
      fn: makeInterpolator(points, config.interpolation),
      count: raw.length,
    });
  });
}
/** The quantity on the horizontal axis of rendered data. */
export function xQuantity(data: Analyzed[], config: ViewConfig): XQuantity {
  return data.some((d) => d.x) ? "metric" : config.axis;
}
