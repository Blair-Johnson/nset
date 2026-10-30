import { uuid } from "./uuid";
import { validateRecordBinding, type RecordBinding } from "./records";
import { assertSafe, defaults, parseSafeJson, validateConfig } from "./config";
import type {
  Catalog,
  ChartDetails,
  ChartMeasurement,
  ChartSpec,
  ResolvedSeries,
  Section,
  SeriesRef,
  Workspace,
  WorkspaceLibrary,
  XBinding,
} from "./workspace-types";
import type { Run } from "./api";

const STORAGE_KEY = "nset.workspaces.v2";
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const uniqueId = (prefix: string) => `${prefix}:${uuid()}`;
function object(value: unknown, fields?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  const result = value as Record<string, unknown>;
  if (fields && Object.keys(result).some((key) => !fields.includes(key)))
    throw new Error("Unknown field in saved view.");
  return result;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid ${label}.`);
  return value;
}
function id(value: unknown): string {
  const result = text(value, "identity");
  if (forbidden.has(result)) throw new Error("Unsafe identity.");
  return result;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array.");
  return value;
}
function distinct(values: string[], label: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`Duplicate ${label}.`);
}
function strings(value: unknown): string[] {
  const result = array(value).map((v) => text(v, "key"));
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
/** Identity of what a chart's X coordinate means. Cameras, cursors and zoom
 * history are only meaningful while this is unchanged. */
export function cameraAxis(card: ChartSpec): string {
  if (card.records)
    return JSON.stringify(["records", card.records.sourceId, card.records.x]);
  const x = card.kind === "timeseries" ? card.x : undefined;
  if (!x) return card.config.axis;
  return JSON.stringify([
    card.config.axis,
    x.mode === "key" ? ["key", x.key] : ["series", seriesId(x.series)],
  ]);
}
interface RunIndex {
  byId: Map<string, Run>;
  names: Map<string, number>;
  rxBySource: Map<string, Run[]>;
}
// Catalog snapshots are immutable: live-catalog replaces both arrays on metric
// updates, and metadata refreshes replace them too. Key each index by its own
// array so wrapper/selection changes reuse it and replacing either array (even
// on the same Catalog object) invalidates it. Do not mutate indexed fields or
// array contents in place. Weak keys allow obsolete snapshots to be collected.
const runIndexes = new WeakMap<Catalog["runs"], RunIndex>();
const seriesIndexes = new WeakMap<Catalog["series"], Set<string>>();
function indexRuns(catalog: Catalog): RunIndex {
  let index = runIndexes.get(catalog.runs);
  if (!index) {
    index = { byId: new Map(), names: new Map(), rxBySource: new Map() };
    for (const run of catalog.runs) {
      index.byId.set(run.id, run);
      index.names.set(run.name, (index.names.get(run.name) ?? 0) + 1);
      if (run.rx) {
        let runs = index.rxBySource.get(run.rx.sourceId);
        if (!runs) index.rxBySource.set(run.rx.sourceId, (runs = []));
        runs.push(run);
      }
    }
    runIndexes.set(catalog.runs, index);
  }
  return index;
}
function indexSeries(catalog: Catalog): Set<string> {
  let available = seriesIndexes.get(catalog.series);
  if (!available) {
    available = new Set(
      catalog.series.map((s) =>
        seriesId({ runId: s.run_id, key: s.key, kind: s.kind }),
      ),
    );
    seriesIndexes.set(catalog.series, available);
  }
  return available;
}
function runLabel(run: Run, index: RunIndex): string {
  return index.names.get(run.name)! > 1 ? `${run.name} (${run.id})` : run.name;
}
function* sourceRefs(
  card: ChartSpec,
  selectedRunIds: string[],
): Generator<SeriesRef> {
  if (card.source.mode === "explicit") {
    const selected = new Set(selectedRunIds);
    for (const ref of card.source.series)
      if (selected.has(ref.runId)) yield ref;
  } else {
    const kind = card.kind === "image" ? "image" : "metric";
    for (const runId of selectedRunIds)
      for (const key of card.source.keys) yield { runId, key, kind };
  }
}
/** Shared availability rules, without constructing labels or resolved traces. */
function* nativeSources(
  card: ChartSpec,
  selectedRunIds: string[],
  catalog: Catalog,
) {
  const { byId } = indexRuns(catalog);
  const available = indexSeries(catalog);
  const kind = card.kind === "image" ? "image" : "metric";
  const binding = kind === "metric" ? card.x : undefined;
  for (const ref of sourceRefs(card, selectedRunIds)) {
    const run = byId.get(ref.runId);
    if (ref.kind !== kind || !run || !available.has(seriesId(ref))) continue;
    // Keyed X follows Y's run; fixed X may belong to any unselected run.
    const xRef = !binding
      ? undefined
      : binding.mode === "series"
        ? binding.series
        : { runId: ref.runId, key: binding.key, kind: "metric" as const };
    const xRun = xRef ? byId.get(xRef.runId) : undefined;
    if (
      xRef &&
      (xRef.kind !== "metric" || !xRun || !available.has(seriesId(xRef)))
    )
      continue;
    yield { ref, run, xRef, xRun };
  }
}
function* recordSourceRuns(
  binding: RecordBinding,
  selectedRunIds: string[],
  index: RunIndex,
) {
  // Explicit portable UIDs narrow the global selection, never replace it.
  const selected = new Set(selectedRunIds);
  const uids = new Set(binding.runUids);
  for (const run of index.rxBySource.get(binding.sourceId) ?? [])
    if (selected.has(run.id) && (!uids.size || uids.has(run.rx!.uid)))
      yield run;
}
/** Whether a chart can have a trace, before constructing a ChartCard.
 * Native charts require a matching Y (and metric X for XY). Explicit bindings
 * narrow selection. Record fields/filters are not known from the scalar catalog:
 * keep record charts visible when any eligible rx run exists. */
export function chartHasSources(
  spec: ChartSpec,
  catalog: Catalog,
  selectedRunIds: string[],
): boolean {
  if (spec.records) {
    if (!spec.records.ys.length) return false;
    return !recordSourceRuns(
      spec.records,
      selectedRunIds,
      indexRuns(catalog),
    ).next().done;
  }
  return !nativeSources(spec, selectedRunIds, catalog).next().done;
}
export function resolveSources(
  card: ChartSpec,
  selectedRunIds: string[],
  catalog: Catalog,
): ResolvedSeries[] {
  const index = indexRuns(catalog);
  if (card.records) {
    const b = card.records;
    return [...recordSourceRuns(b, selectedRunIds, index)].flatMap((run) =>
      b.ys.map((key) => ({
        id: JSON.stringify([b.sourceId, run.rx!.uid, key, null]),
        runId: run.id,
        key,
        kind: "metric" as const,
        run,
        label: `${run.name} · ${key}`,
      })),
    );
  }
  const result: ResolvedSeries[] = [];
  const seen = new Set<string>();
  for (const { ref, run, xRef, xRun } of nativeSources(
    card,
    selectedRunIds,
    catalog,
  )) {
    const identity = seriesId(ref);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({
      ...ref,
      id: identity,
      run,
      label: `${runLabel(run, index)} · ${ref.key}`,
      ...(xRef && xRun
        ? {
            x: {
              ref: { ...xRef },
              run: xRun,
              label: `${runLabel(xRun, index)} · ${xRef.key}`,
            },
          }
        : {}),
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
/**
 * "Reset chart": every display setting returns to what a new chart gets
 * (axes, scales, bounds, smoothing, style, legend, advanced options). What
 * the chart plots — its sources and X binding — and its title, id, size and
 * place on the dashboard stay, including authored details. XY charts keep
 * their join parameter.
 */
export function resetChart(card: ChartSpec): ChartSpec {
  const fresh = newChart(card.kind, [], card.title);
  const config = fresh.config;
  // Size belongs to the dashboard layout, not to the chart's look.
  config.width = card.config.width;
  config.height = card.config.height;
  if (card.kind === "timeseries" && card.x) config.axis = card.config.axis;
  return validateChart({
    ...structuredClone(card),
    config,
    outliers: fresh.outliers,
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
/** Move one section relative to another without cloning cards or losing hidden sections. */
export function reorderSections(
  sections: Section[],
  id: string,
  targetId: string,
  after = false,
): Section[] {
  const source = sections.find((section) => section.id === id);
  if (!source || id === targetId || !sections.some((s) => s.id === targetId))
    return sections;
  const next = sections.filter((section) => section !== source);
  const index = next.findIndex((section) => section.id === targetId);
  next.splice(index + Number(after), 0, source);
  return next.every((section, i) => section === sections[i]) ? sections : next;
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
/** Shared by semantic run names and chart-local configuration-table headings. */
function validateRunLabels(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(value)).map(([runId, label]) => [
      id(runId),
      text(label, "run label"),
    ]),
  );
}

/** Called only after the enclosing chart passes safe-JSON validation. */
function validateDetails(
  value: unknown,
  kind: ChartSpec["kind"],
): ChartDetails {
  const v = object(value, [
    "markdown",
    "configFields",
    "configRunLabels",
    "measurements",
  ]);
  const details: ChartDetails = {};
  if (v.markdown !== undefined) {
    if (typeof v.markdown !== "string")
      throw new Error("Invalid details markdown.");
    details.markdown = v.markdown;
  }
  if (v.configFields !== undefined) {
    details.configFields = array(v.configFields).map((value) => {
      const field = object(value, ["path", "label"]);
      const path = array(field.path).map(id);
      if (!path.length)
        throw new Error("Configuration field paths cannot be empty.");
      return {
        path,
        ...(field.label !== undefined
          ? { label: text(field.label, "field label") }
          : {}),
      };
    });
    distinct(
      details.configFields.map((field) => JSON.stringify(field.path)),
      "configuration path",
    );
  }
  if (v.configRunLabels !== undefined)
    details.configRunLabels = validateRunLabels(v.configRunLabels);
  if (v.measurements !== undefined) {
    const entries = Object.entries(object(v.measurements));
    if (kind === "image" && entries.length)
      throw new Error("Image charts do not support measurements.");
    details.measurements = Object.fromEntries(
      entries.map(([name, value]) => {
        // JS `$` also matches before a final newline; require the entire match.
        if (
          name.match(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)?.[0] !== name ||
          forbidden.has(name)
        )
          throw new Error("Invalid measurement identity.");
        const m = object(value, ["axis", "a", "b"]);
        if (
          typeof m.a !== "number" ||
          !Number.isFinite(m.a) ||
          (m.b !== undefined &&
            m.b !== null &&
            (typeof m.b !== "number" || !Number.isFinite(m.b)))
        )
          throw new Error("Measurement coordinates must be finite numbers.");
        const measurement: ChartMeasurement = {
          axis: enumValue(m.axis, ["x", "y"]),
          a: m.a,
          ...(m.b !== undefined ? { b: m.b as number | null } : {}),
        };
        return [name, measurement];
      }),
    );
  }
  return details;
}

export function validateChart(value: unknown): ChartSpec {
  assertSafe(value);
  const v = object(value, [
    "id",
    "title",
    "kind",
    "source",
    "x",
    "config",
    "outliers",
    "size",
    "layout",
    "records",
    "details",
  ]);
  const kind = enumValue(v.kind, ["timeseries", "image"]);
  const source = object(v.source);
  let binding: ChartSpec["source"];
  if (source.mode === "selected") {
    object(source, ["mode", "keys"]);
    binding = { mode: "selected", keys: strings(source.keys) };
  } else if (source.mode === "explicit") {
    object(source, ["mode", "series"]);
    const series = array(source.series).map((value) => {
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
  const records =
    v.records === undefined ? undefined : validateRecordBinding(v.records);
  if (records && (kind !== "timeseries" || v.x !== undefined))
    throw new Error("Record charts use their own paired X field.");
  let x: XBinding | undefined;
  if (v.x !== undefined) {
    if (kind !== "timeseries")
      throw new Error("Only scalar charts can use a metric X axis.");
    const raw = object(v.x);
    if (raw.mode === "key") {
      object(raw, ["mode", "key"]);
      x = { mode: "key", key: text(raw.key, "X metric key") };
    } else if (raw.mode === "series") {
      object(raw, ["mode", "series"]);
      const s = object(raw.series, ["runId", "key", "kind"]);
      if (s.kind !== "metric") throw new Error("X series must be a metric.");
      x = {
        mode: "series",
        series: {
          runId: id(s.runId),
          key: text(s.key, "X metric key"),
          kind: "metric",
        },
      };
    } else throw new Error("Unknown X binding mode.");
  }
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
    title: text(v.title, "chart title"),
    kind,
    source: binding,
    ...(records ? { records } : {}),
    ...(x ? { x } : {}),
    config: validateConfig(v.config),
    outliers: enumValue(v.outliers, ["all", "robust"]),
    size: enumValue(v.size, ["normal", "wide"]),
    ...(layout ? { layout } : {}),
    ...(v.details !== undefined
      ? { details: validateDetails(v.details, kind) }
      : {}),
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
    "pendingSelectedRunIds",
    "runLabels",
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
  const sections = array(v.sections).map((value) => {
    const s = object(value, ["id", "title", "collapsed", "cards"]);
    if (typeof s.collapsed !== "boolean")
      throw new Error("Invalid section collapse state.");
    return {
      id: id(s.id),
      title: text(s.title, "section title"),
      collapsed: s.collapsed,
      cards: array(s.cards).map(validateChart),
    };
  });
  distinct(
    sections.map((s) => s.id),
    "section identity",
  );
  const cards = sections.flatMap((s) => s.cards);
  distinct(
    cards.map((c) => c.id),
    "chart identity",
  );
  const selectedRunIds = array(v.selectedRunIds).map(id);
  const pendingSelectedRunIds =
    v.pendingSelectedRunIds === undefined
      ? []
      : array(v.pendingSelectedRunIds).map(id);
  distinct([...selectedRunIds, ...pendingSelectedRunIds], "selected run");
  const runLabels =
    v.runLabels === undefined ? undefined : validateRunLabels(v.runLabels);
  return {
    version: 2,
    id: id(v.id),
    name: text(v.name, "view name"),
    experimentId: id(v.experimentId),
    selectedRunIds,
    ...(pendingSelectedRunIds.length ? { pendingSelectedRunIds } : {}),
    ...(runLabels !== undefined ? { runLabels } : {}),
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
  const views = array(v.views).map(validateWorkspace);
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
