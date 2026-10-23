import type { ViewConfig } from "./config";
import type { ChartSource } from "./workspace-types";

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
): ViewConfig {
  return config.yLabel
    ? config
    : { ...config, yLabel: metricAxisLabel(source) };
}
