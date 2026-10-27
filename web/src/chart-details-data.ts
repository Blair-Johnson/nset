import { styleFor } from "./config";
import { chartIdentities } from "./chart-identities";
import { withRunColors } from "./series-colors";
import { resolveSources } from "./workspace";
import type { CardContext, ChartSpec } from "./workspace-types";

const unsafe = new Set(["__proto__", "prototype", "constructor"]);

/** Literal segments only: never follow inherited properties or dotted paths. */
export function chartConfigValue(params: unknown, path: string[]): string {
  if (!path.length) return "—";
  let value = params;
  for (const segment of path) {
    if (
      unsafe.has(segment) ||
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, segment)
    )
      return "—";
    value = (value as Record<string, unknown>)[segment];
  }
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "—";
  } catch {
    return "—";
  }
}

export function chartDetailsData(chart: ChartSpec, context: CardContext) {
  const sources = resolveSources(
    chart,
    context.selectedRunIds,
    context.catalog,
  );
  const config = withRunColors(chart.config, sources, context.catalog);
  const identities = chartIdentities(sources, context);
  const seen = new Set<string>();
  const columns = sources.flatMap((source, index) => {
    if (seen.has(source.runId)) return [];
    seen.add(source.runId);
    const name = identities.get(source.id)!.name;
    const style = styleFor(config, source.id, index);
    return [
      {
        id: source.runId,
        name,
        original: source.run.name,
        color: style.color,
        dash: style.dash,
        values: (chart.details?.configFields ?? []).map((field) =>
          chartConfigValue(source.run.params, field.path),
        ),
      },
    ];
  });
  return {
    // Counts and timestamps deliberately excluded: polling must not invalidate UI.
    sources: sources.map((source) => [source.id, source.x?.ref ?? null]),
    columns,
    fields: (chart.details?.configFields ?? []).map((field) => ({
      label: field.label ?? field.path.join(" · "),
      path: field.path,
    })),
  };
}
