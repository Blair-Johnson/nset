import type { ViewConfig } from "./config";
import type { PlotRun } from "./analysis";
import type {
  ChartSource,
  MetricLoader,
  ResolvedSeries,
  XBinding,
} from "./workspace-types";

/** Display defaults never replace explicit user labels or mutate saved config. */
export function metricAxisLabel(source: ChartSource): string {
  const keys = [
    ...new Set(
      source.mode === "selected"
        ? source.keys
        : source.series
            .filter((series) => series.kind === "metric")
            .map((series) => series.key),
    ),
  ];
  return keys.length === 1 ? keys[0] : "Metric values";
}

export function withMetricLabel(
  config: ViewConfig,
  source: ChartSource,
  x?: XBinding,
): ViewConfig {
  const labelled = config.yLabel
    ? config
    : { ...config, yLabel: metricAxisLabel(source) };
  return x && !labelled.xLabel
    ? { ...labelled, xLabel: xMetricLabel(x) }
    : labelled;
}

/** Automatic X title for XY charts: the X metric key. */
export function xMetricLabel(x: XBinding): string {
  return x.mode === "key" ? x.key : x.series.key;
}

/** Load each trace's Y history and, for XY charts, its X history. Shared X
 * series are fetched once (the store deduplicates and caches by series). */
export async function loadPlotRuns(
  sources: ResolvedSeries[],
  store: MetricLoader,
  signal?: AbortSignal,
): Promise<PlotRun[]> {
  return Promise.all(
    sources.map(async (source) => {
      const [raw, x] = await Promise.all([
        store.load(source, signal),
        source.x ? store.load(source.x.ref, signal) : undefined,
      ]);
      return {
        run: { ...source.run, id: source.id, name: source.label },
        raw,
        ...(source.x && x
          ? { x: { run: source.x.run, raw: x, key: source.x.ref.key } }
          : {}),
      };
    }),
  );
}
