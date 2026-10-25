import type { Run } from "./api";
import type { CatalogSeries } from "./workspace-types";
import { scalarParameters, compareParameters } from "./run-table-fields";

export interface RunSortState {
  sort: string;
  descending: boolean;
}
export const runSortState = (): RunSortState => ({
  sort: "created_at",
  descending: true,
});

/** Shared table/drawer ordering. Stable ties retain catalog order; missing values
 * remain last in either direction, including typed parameter nulls. */
export function createRunOrder(runs: Run[], catalogSeries: CatalogSeries[]) {
  const runIds = new Set(runs.map((r) => r.id));
  const summaries = new Map<string, Map<string, CatalogSeries>>();
  for (const series of catalogSeries) {
    if (series.kind !== "metric" || !runIds.has(series.run_id)) continue;
    let map = summaries.get(series.run_id);
    if (!map) {
      map = new Map();
      summaries.set(series.run_id, map);
    }
    map.set(series.key, series);
  }
  const parameters = new Map(
    runs.map((run) => [
      run.id,
      new Map(
        scalarParameters(run.params).map((field) => [field.sourcePath, field]),
      ),
    ]),
  );
  return {
    summaries,
    parameters,
    sort(rows: Run[], state: RunSortState): Run[] {
      return [...rows].sort((a, b) => {
        let result = 0;
        if (state.sort === "name") result = a.name.localeCompare(b.name);
        else if (state.sort === "status")
          result = a.status.localeCompare(b.status);
        else if (state.sort.startsWith("metric:")) {
          const key = state.sort.slice(7),
            av = summaries.get(a.id)?.get(key)?.last_value,
            bv = summaries.get(b.id)?.get(key)?.last_value;
          if (av == null) return bv == null ? 0 : 1;
          if (bv == null) return -1;
          result = av - bv;
        } else if (state.sort.startsWith("parameter:")) {
          const key = state.sort.slice(10);
          return compareParameters(
            parameters.get(a.id)?.get(key)?.value,
            parameters.get(b.id)?.get(key)?.value,
            state.descending,
          );
        } else result = a.created_at - b.created_at;
        return (state.descending ? -1 : 1) * result;
      });
    },
  };
}
