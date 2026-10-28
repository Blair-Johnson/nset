import type { Run } from "./api";
import type { CatalogSeries } from "./workspace-types";
import { createRunOrder, type RunSortState } from "./run-order";

/** Use the complete experiment, not its filtered/page/selected subset. */
export function sortedRunIds(
  runs: Run[],
  series: CatalogSeries[],
  state: RunSortState,
): string[] {
  return createRunOrder(runs, series)
    .sort(runs, state)
    .map((run) => run.id);
}

/** Bottom-to-top paint order. Reverse run groups, not each run's series.
 * Unmatched (e.g. cross-experiment explicit) sources stay in source order below
 * ranked runs. Source IDs are opaque: never infer a run ID by splitting them. */
export function traceDrawOrder(
  sources: readonly { id: string; runId: string }[],
  topFirstRunIds: readonly string[],
): string[] {
  const rank = new Map(topFirstRunIds.map((id, index) => [id, index]));
  const missing = topFirstRunIds.length;
  return [...sources]
    .sort(
      (a, b) => (rank.get(b.runId) ?? missing) - (rank.get(a.runId) ?? missing),
    )
    .map((source) => source.id);
}

/** Renderer slots only; the logical data/legend arrays are never reordered. */
export function traceDrawIndices(
  ids: readonly string[],
  bottomFirstIds: readonly string[],
): number[] {
  const rank = new Map(bottomFirstIds.map((id, index) => [id, index]));
  return ids
    .map((_id, index) => index)
    .sort((a, b) => (rank.get(ids[a]) ?? -1) - (rank.get(ids[b]) ?? -1));
}

/** A trace and its raw-observation markers always move as one unit. */
export function permuteTracePairs<T>(
  values: readonly T[],
  indices: readonly number[],
): T[] {
  return [
    values[0],
    ...indices.flatMap((index) => [
      values[2 * index + 1],
      values[2 * index + 2],
    ]),
  ];
}
