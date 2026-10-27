import type { CardContext, ResolvedSeries } from "./workspace-types";

export interface ChartIdentity {
  id: string;
  runId: string;
  name: string;
  metric: string;
  label: string;
}

/** Presentation only. Keys always remain the original resolved series/run IDs. */
export function chartIdentities(
  sources: ResolvedSeries[],
  context: Pick<CardContext, "catalog" | "runLabels" | "labelMode">,
): Map<string, ChartIdentity> {
  const runs = new Map(context.catalog.runs.map((run) => [run.id, run]));
  for (const source of sources) runs.set(source.runId, source.run);
  const names = new Map<string, string>();
  const rawCounts = new Map<string, number>();
  for (const run of runs.values())
    rawCounts.set(run.name, (rawCounts.get(run.name) ?? 0) + 1);
  for (const [id, run] of runs) {
    const alias =
      context.labelMode !== "original" &&
      context.runLabels &&
      Object.hasOwn(context.runLabels, id)
        ? context.runLabels[id]?.trim()
        : "";
    names.set(
      id,
      alias ||
        (rawCounts.get(run.name)! > 1 ? `${run.name} (${id})` : run.name),
    );
  }
  // An alias can also collide with a raw name or another run's ID-suffixed name.
  // Each pass splits a collision group, retaining full IDs (never ambiguous prefixes).
  for (;;) {
    const groups = new Map<string, string[]>();
    for (const [id, name] of names)
      groups.set(name, [...(groups.get(name) ?? []), id]);
    const collisions = [...groups.values()].filter((ids) => ids.length > 1);
    if (!collisions.length) break;
    for (const ids of collisions)
      for (const id of ids) names.set(id, `${names.get(id)} (${id})`);
  }
  const mixed = new Set(sources.map((source) => source.key)).size > 1;
  const traceCounts = new Map<string, number>();
  const traceKey = (s: ResolvedSeries) => JSON.stringify([s.runId, s.key]);
  for (const source of sources)
    traceCounts.set(
      traceKey(source),
      (traceCounts.get(traceKey(source)) ?? 0) + 1,
    );
  return new Map(
    sources.map((source) => {
      const name = names.get(source.runId) ?? source.run.name;
      const metric =
        traceCounts.get(traceKey(source))! > 1
          ? `${source.key} (${source.id})`
          : mixed
            ? source.key
            : "";
      return [
        source.id,
        {
          id: source.id,
          runId: source.runId,
          name,
          metric,
          label: metric ? `${name} · ${metric}` : name,
        },
      ];
    }),
  );
}
