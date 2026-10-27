import type { CardContext, ResolvedSeries } from "./workspace-types";

export interface ChartIdentity {
  id: string;
  runId: string;
  name: string;
  metric: string;
  label: string;
}

/** Presentation only. Duplicate labels never change the internal series/run IDs. */
export function chartIdentities(
  sources: ResolvedSeries[],
  context: Pick<CardContext, "catalog" | "runLabels" | "labelMode">,
): Map<string, ChartIdentity> {
  const mixed = new Set(sources.map((source) => source.key)).size > 1;
  return new Map(
    sources.map((source) => {
      const alias =
        context.labelMode !== "original" &&
        context.runLabels &&
        Object.hasOwn(context.runLabels, source.runId)
          ? context.runLabels[source.runId]
          : undefined;
      const name = alias?.trim() ? alias : source.run.name;
      const metric = mixed ? source.key : "";
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
