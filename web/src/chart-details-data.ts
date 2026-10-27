import { styleFor } from "./config";
import { chartIdentities } from "./chart-identities";
import { withRunColors } from "./series-colors";
import { resolveSources } from "./workspace";
import type { CardContext, ChartSpec } from "./workspace-types";

const unsafe = new Set(["__proto__", "prototype", "constructor"]);

/** Literal segments only: never follow inherited properties or dotted paths. */
function rawConfigValue(params: unknown, path: string[]): unknown {
  if (!path.length) return undefined;
  let value = params;
  for (const segment of path) {
    if (
      unsafe.has(segment) ||
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, segment)
    )
      return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function serializedValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function displayValue(value: unknown): string {
  const text =
    typeof value === "string" ? value : (serializedValue(value) ?? "—");
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

export function chartConfigValue(params: unknown, path: string[]): string {
  return displayValue(rawConfigValue(params, path));
}

export function chartDetailsData(chart: ChartSpec, context: CardContext) {
  const sources = resolveSources(
    chart,
    context.selectedRunIds,
    context.catalog,
  );
  const config = withRunColors(chart.config, sources, context.catalog);
  const identities = chartIdentities(sources, context);
  const fields = chart.details?.configFields ?? [];
  const labels = chart.details?.configRunLabels;
  const rawValues: unknown[][] = [];
  const seen = new Set<string>();
  const columns = sources.flatMap((source, index) => {
    if (seen.has(source.runId)) return [];
    seen.add(source.runId);
    const name =
      labels && Object.hasOwn(labels, source.runId)
        ? labels[source.runId]
        : identities.get(source.id)!.name;
    const values = fields.map((field) =>
      rawConfigValue(source.run.params, field.path),
    );
    rawValues.push(values);
    const style = styleFor(config, source.id, index);
    return [
      {
        id: source.runId,
        name,
        original: source.run.name,
        color: style.color,
        dash: style.dash,
        values: values.map(displayValue),
      },
    ];
  });
  return {
    // Counts and timestamps deliberately excluded: polling must not invalidate UI.
    sources: sources.map((source) => [source.id, source.x?.ref ?? null]),
    columns,
    fields: fields.map((field, index) => ({
      label: field.label ?? field.path.join(" · "),
      path: field.path,
      differs:
        new Set(rawValues.map((values) => serializedValue(values[index])))
          .size > 1,
    })),
  };
}
