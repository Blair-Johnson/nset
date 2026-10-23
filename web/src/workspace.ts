import { assertSafe, defaults, parseSafeJson, validateConfig } from "./config";
import type {
  Catalog,
  ChartSpec,
  ResolvedSeries,
  Section,
  SeriesRef,
  Workspace,
  WorkspaceLibrary,
} from "./workspace-types";

const STORAGE_KEY = "nset.workspaces.v2";
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const uniqueId = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
function object(value: unknown, fields?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  const result = value as Record<string, unknown>;
  if (fields && Object.keys(result).some((key) => !fields.includes(key)))
    throw new Error("Unknown field in saved view.");
  return result;
}
function text(value: unknown, label: string, max = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label}.`);
  return value;
}
function id(value: unknown): string {
  const result = text(value, "identity", 8192);
  if (forbidden.has(result)) throw new Error("Unsafe identity.");
  return result;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`Expected an array of at most ${max} entries.`);
  return value;
}
function distinct(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`Duplicate ${label}.`);
}
function strings(value: unknown, max: number): string[] {
  const result = array(value, max).map((v) => text(v, "key"));
  distinct(result, "key");
  return result;
}
function enumValue<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T))
    throw new Error(`Expected ${choices.join(" or ")}.`);
  return value as T;
}

/** JSON tuple escaping is injective even for slashes, quotes and separators. */
export function seriesId(ref: SeriesRef): string {
  return JSON.stringify([ref.kind, ref.runId, ref.key]);
}
export function resolveSources(
  card: ChartSpec,
  selectedRunIds: string[],
  catalog: Catalog,
): ResolvedSeries[] {
  const kind = card.kind === "image" ? "image" : "metric";
  const runs = new Map(catalog.runs.map((run) => [run.id, run]));
  const available = new Set(
    catalog.series.map((s) =>
      seriesId({ runId: s.run_id, key: s.key, kind: s.kind }),
    ),
  );
  const refs: SeriesRef[] =
    card.source.mode === "explicit"
      ? card.source.series
      : selectedRunIds.flatMap((runId) =>
          card.source.mode === "selected"
            ? card.source.keys.map((key) => ({ runId, key, kind }))
            : [],
        );
  const result: ResolvedSeries[] = [];
  const seen = new Set<string>();
  const names = new Map<string, number>();
  for (const run of catalog.runs)
    names.set(run.name, (names.get(run.name) ?? 0) + 1);
  for (const ref of refs) {
    const identity = seriesId(ref),
      run = runs.get(ref.runId);
    if (
      ref.kind !== kind ||
      !run ||
      !available.has(identity) ||
      seen.has(identity)
    )
      continue;
    seen.add(identity);
    const runLabel =
      names.get(run.name)! > 1 ? `${run.name} (${run.id})` : run.name;
    result.push({
      ...ref,
      id: identity,
      run,
      label: `${runLabel} \u00b7 ${ref.key}`,
    });
  }
  return result;
}
export function newChart(
  kind: ChartSpec["kind"],
  keys: string[],
  title?: string,
): ChartSpec {
  const config = defaults();
  config.height = 280;
  config.advanced = {
    axes: [
      {
        stroke: "#abb3bc",
        grid: { stroke: "#363b40" },
        ticks: { stroke: "#737b84" },
      },
      {
        stroke: "#abb3bc",
        grid: { stroke: "#363b40" },
        ticks: { stroke: "#737b84" },
      },
    ],
  };
  return validateChart({
    id: uniqueId("card"),
    title:
      title ??
      (keys.length === 1
        ? keys[0].split("/").at(-1) || keys[0]
        : kind === "image"
          ? "Images"
          : "Metrics"),
    kind,
    source: { mode: "selected", keys: [...new Set(keys)] },
    config,
    outliers: "all",
    size: "normal",
  });
}
export function defaultSections(catalog: Catalog, runIds: string[]): Section[] {
  const selected = new Set(runIds);
  const keys = new Map<string, { key: string; kind: "metric" | "image" }>();
  for (const s of catalog.series)
    if (selected.has(s.run_id)) keys.set(JSON.stringify([s.kind, s.key]), s);
  const sections = new Map<string, Section>();
  for (const { key, kind } of [...keys.values()].sort(
    (a, b) => compare(a.key, b.key) || compare(a.kind, b.kind),
  )) {
    const slash = key.lastIndexOf("/");
    const namespace = slash < 0 ? "" : key.slice(0, slash);
    const sectionId = `namespace:${JSON.stringify(namespace)}`;
    let section = sections.get(sectionId);
    if (!section) {
      section = {
        id: sectionId,
        title: namespace || "Overview",
        collapsed: false,
        cards: [],
      };
      sections.set(sectionId, section);
    }
    const card = newChart(
      kind === "metric" ? "timeseries" : "image",
      [key],
      key.slice(slash + 1) || key,
    );
    card.id = `default:${JSON.stringify([kind, key])}`;
    section.cards.push(card);
  }
  return [...sections.values()].sort((a, b) =>
    a.id === 'namespace:""'
      ? -1
      : b.id === 'namespace:""'
        ? 1
        : compare(a.title, b.title),
  );
}
export function newWorkspace(
  experimentId: string,
  name: string,
  selectedRunIds: string[],
  catalog: Catalog,
): Workspace {
  return validateWorkspace({
    version: 2,
    id: uniqueId("view"),
    experimentId,
    name,
    selectedRunIds: [...new Set(selectedRunIds)],
    sections: defaultSections(catalog, selectedRunIds),
    updatedAt: Date.now(),
  });
}
export function validateChart(value: unknown): ChartSpec {
  assertSafe(value);
  const v = object(value, [
    "id",
    "title",
    "kind",
    "source",
    "config",
    "outliers",
    "size",
    "layout",
  ]);
  const kind = enumValue(v.kind, ["timeseries", "image"]);
  const source = object(v.source);
  let binding: ChartSpec["source"];
  if (source.mode === "selected") {
    object(source, ["mode", "keys"]);
    binding = { mode: "selected", keys: strings(source.keys, 512) };
  } else if (source.mode === "explicit") {
    object(source, ["mode", "series"]);
    const series = array(source.series, 4096).map((value) => {
      const s = object(value, ["runId", "key", "kind"]);
      const ref: SeriesRef = {
        runId: id(s.runId),
        key: text(s.key, "metric key"),
        kind: enumValue(s.kind, ["metric", "image"]),
      };
      if (ref.kind !== (kind === "image" ? "image" : "metric"))
        throw new Error("Source kind does not match chart kind.");
      return ref;
    });
    distinct(series.map(seriesId), "series identity");
    binding = { mode: "explicit", series };
  } else throw new Error("Unknown source mode.");
  let layout: ChartSpec["layout"];
  if (v.layout !== undefined) {
    const dimensions = object(v.layout, ["width", "height"]);
    const width = dimensions.width,
      height = dimensions.height;
    if (
      typeof width !== "number" ||
      !Number.isInteger(width) ||
      width < 300 ||
      width > 4096 ||
      typeof height !== "number" ||
      !Number.isInteger(height) ||
      height < 240 ||
      height > 2160
    )
      throw new Error(
        "Card dimensions must be whole CSS pixels: width 300–4096, height 240–2160.",
      );
    layout = { width, height };
  }
  return {
    id: id(v.id),
    title: text(v.title, "chart title", 256),
    kind,
    source: binding,
    config: validateConfig(v.config),
    outliers: enumValue(v.outliers, ["all", "robust"]),
    size: enumValue(v.size, ["normal", "wide"]),
    ...(layout ? { layout } : {}),
  };
}
export function validateWorkspace(value: unknown): Workspace {
  assertSafe(value);
  const v = object(value, [
    "version",
    "id",
    "name",
    "experimentId",
    "selectedRunIds",
    "sections",
    "updatedAt",
  ]);
  if (v.version !== 2) throw new Error("Unsupported workspace version.");
  if (
    typeof v.updatedAt !== "number" ||
    !Number.isSafeInteger(v.updatedAt) ||
    v.updatedAt < 0
  )
    throw new Error("Invalid updatedAt.");
  const sections = array(v.sections, 128).map((value) => {
    const s = object(value, ["id", "title", "collapsed", "cards"]);
    if (typeof s.collapsed !== "boolean")
      throw new Error("Invalid section collapse state.");
    return {
      id: id(s.id),
      title: text(s.title, "section title", 256),
      collapsed: s.collapsed,
      cards: array(s.cards, 256).map(validateChart),
    };
  });
  distinct(
    sections.map((s) => s.id),
    "section identity",
  );
  const cards = sections.flatMap((s) => s.cards);
  if (cards.length > 512) throw new Error("Too many charts.");
  distinct(
    cards.map((c) => c.id),
    "chart identity",
  );
  const selectedRunIds = array(v.selectedRunIds, 4096).map(id);
  distinct(selectedRunIds, "selected run");
  return {
    version: 2,
    id: id(v.id),
    name: text(v.name, "view name", 256),
    experimentId: id(v.experimentId),
    selectedRunIds,
    sections,
    updatedAt: v.updatedAt,
  };
}
function emptyLibrary(): WorkspaceLibrary {
  return { version: 2, views: [], activeByExperiment: {} };
}
function validateLibrary(value: unknown): WorkspaceLibrary {
  assertSafe(value);
  const v = object(value, ["version", "views", "activeByExperiment"]);
  if (v.version !== 2) throw new Error("Unsupported library version.");
  const views = array(v.views, 128).map(validateWorkspace);
  distinct(
    views.map((view) => view.id),
    "view identity",
  );
  const active = object(v.activeByExperiment);
  const entries = Object.entries(active).map(([experimentId, viewId]) => {
    id(experimentId);
    id(viewId);
    if (
      !views.some(
        (view) => view.id === viewId && view.experimentId === experimentId,
      )
    )
      throw new Error("Invalid active view reference.");
    return [experimentId, viewId as string] as const;
  });
  return { version: 2, views, activeByExperiment: Object.fromEntries(entries) };
}
export function loadLibrary(storage?: Storage): WorkspaceLibrary {
  try {
    const saved = (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY);
    return saved === null || saved === undefined
      ? emptyLibrary()
      : validateLibrary(parseSafeJson(saved));
  } catch {
    return emptyLibrary();
  }
}
/** Validation and quota/security errors propagate so the shell can report an unsaved view. */
export function saveLibrary(
  library: WorkspaceLibrary,
  storage?: Storage,
): void {
  const clean = validateLibrary(library);
  const target = storage ?? globalThis.localStorage;
  if (!target)
    throw new Error("Saved views are unavailable in this environment.");
  target.setItem(STORAGE_KEY, JSON.stringify(clean));
}
export function exportWorkspace(workspace: Workspace): string {
  return JSON.stringify(validateWorkspace(workspace));
}
export function importWorkspace(text: string): Workspace {
  return validateWorkspace(parseSafeJson(text));
}
