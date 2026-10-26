import { palette, type ViewConfig } from "./config";
import type { Catalog, ResolvedSeries } from "./workspace-types";
export const RUN_COLORS_KEY = "nset:run-colors:v1";
export const RUN_COLORS_EVENT = "nset:run-colors-changed";
const defaultsCache = new WeakMap<Catalog, Map<string, string>>();
const preferencesCache = new WeakMap<Storage, Map<string, string>>();
const validColor = (color: unknown): color is string =>
  typeof color === "string" && /^#[\da-f]{6}$/i.test(color);
function localStore(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
function preferences(storage = localStore()): Map<string, string> {
  if (!storage) return new Map();
  const cached = preferencesCache.get(storage);
  if (cached) return cached;
  const colors = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RUN_COLORS_KEY) ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [id, value] of Object.entries(parsed))
        if (id.length > 0 && validColor(value))
          colors.set(id, value.toLowerCase());
    }
  } catch {
    /* Invalid or inaccessible preferences must not block plots. */
  }
  preferencesCache.set(storage, colors);
  return colors;
}
export function runColor(
  catalog: Catalog,
  runId: string,
  storage = localStore(),
): string {
  const override = preferences(storage).get(runId);
  if (override) return override;
  let colors = defaultsCache.get(catalog);
  if (!colors) {
    colors = new Map(
      [...catalog.runs]
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
        .map((run, index) => [run.id, palette[index % palette.length]]),
    );
    defaultsCache.set(catalog, colors);
  }
  return colors.get(runId) ?? palette[0];
}
function announce(runId?: string): void {
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent(RUN_COLORS_EVENT, { detail: { runId } }),
    );
}
/** Transactional browser-local preference; a failed write never changes displayed state. */
export function setRunColor(
  runId: string,
  color: string | null,
  storage = localStore(),
): boolean {
  if (!storage || !runId || (color !== null && !validColor(color)))
    return false;
  const next = new Map(preferences(storage));
  if (color === null) next.delete(runId);
  else next.set(runId, color.toLowerCase());
  try {
    storage.setItem(RUN_COLORS_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    return false;
  }
  preferencesCache.set(storage, next);
  announce(runId);
  return true;
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key !== RUN_COLORS_KEY && event.key !== null) return;
    const storage = localStore();
    if (storage) preferencesCache.delete(storage);
    announce();
  });
/** Derived display colors are never persisted as chart-specific overrides. */
export function withRunColors(
  config: ViewConfig,
  sources: ResolvedSeries[],
  catalog: Catalog,
): ViewConfig {
  if (!config.palette) return config;
  const runs = { ...config.runs };
  for (const source of sources) {
    const current = Object.hasOwn(runs, source.id) ? runs[source.id] : {};
    Object.defineProperty(runs, source.id, {
      value: {
        ...current,
        color: current.color ?? runColor(catalog, source.runId),
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { ...config, runs };
}
