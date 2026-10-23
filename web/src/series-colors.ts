import { palette, type ViewConfig } from "./config";
import type { Catalog, ResolvedSeries } from "./workspace-types";
const cache = new WeakMap<Catalog, Map<string, string>>();
export function runColor(catalog: Catalog, runId: string): string {
  let colors = cache.get(catalog);
  if (!colors) {
    colors = new Map([...catalog.runs]
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      .map((run, index) => [run.id, palette[index % palette.length]]));
    cache.set(catalog, colors);
  }
  return colors.get(runId) ?? palette[0];
}
/** Display-only palette assignment shared by drawer, cards and editor preview. */
export function withRunColors(config: ViewConfig, sources: ResolvedSeries[], catalog: Catalog): ViewConfig {
  if (!config.palette) return config;
  const runs = { ...config.runs };
  for (const source of sources) {
    const current = Object.hasOwn(runs, source.id) ? runs[source.id] : {};
    runs[source.id] = { ...current, color: current.color ?? runColor(catalog, source.runId) };
  }
  return { ...config, runs };
}
