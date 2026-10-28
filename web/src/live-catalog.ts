import type { Catalog } from "./workspace-types";
import type { LiveChange } from "./live";

/** Feed batches are replayable. The catalog's transaction watermark prevents
 * double counting writes already included in bootstrap or metadata repair. */
export function applyMetricHints(
  catalog: Catalog,
  changes: LiveChange[],
): Catalog {
  const baseline = catalog.metric_seq ?? 0;
  let high = baseline;
  const series = [...catalog.series];
  const indices = new Map(
    series.map((s, i) => [JSON.stringify([s.run_id, s.key, s.kind]), i]),
  );
  const runs = [...catalog.runs];
  const runIndices = new Map(runs.map((run, i) => [run.id, i]));
  let changed = false;
  for (const change of changes) {
    if (change.kind !== "metric" || change.high <= baseline) continue;
    high = Math.max(high, change.high);
    const runIndex = runIndices.get(change.runId);
    if (runIndex !== undefined && change.runUpdatedAt !== undefined) {
      const run = runs[runIndex];
      if (change.runUpdatedAt > run.updated_at)
        runs[runIndex] = { ...run, updated_at: change.runUpdatedAt };
    }
    const key = JSON.stringify([change.runId, change.key, "metric"]);
    const index = indices.get(key);
    const count =
      (index === undefined ? 0 : series[index].count) + change.count;
    if (!Number.isSafeInteger(count))
      throw new Error("Metric count exceeds supported precision");
    const summary = {
      run_id: change.runId,
      key: change.key,
      kind: "metric" as const,
      count,
      last_step: change.last.step,
      last_timestamp: change.last.timestamp,
      last_value: change.last.value,
    };
    if (index === undefined) {
      indices.set(key, series.length);
      series.push(summary);
    } else series[index] = summary;
    changed = true;
  }
  return changed ? { ...catalog, metric_seq: high, series, runs } : catalog;
}
