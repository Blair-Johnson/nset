import type { Api, Run } from "./api";
import type { Catalog, ResolvedSeries } from "./workspace-types";
import type { PlotRun } from "./analysis";
import type { ViewConfig } from "./config";

export type Scalar = string | number | boolean | null;
export interface RecordCondition {
  path: string;
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "exists" | "missing";
  value: Scalar;
}
export interface RecordFilters {
  any: boolean;
  conditions: RecordCondition[];
}
export interface RecordBinding {
  sourceId: string;
  /** Empty means the workspace's selected rx runs; otherwise portable rx UIDs. */
  runUids: string[];
  x: string;
  ys: string[];
  filters: RecordFilters;
  group?: string;
}
export interface RecordDiagnostics {
  scanned: number;
  matched: number;
  bytes: number;
  invalid_json: number;
  oversized: number;
  skipped_axes: number;
  skipped_groups: number;
  omitted_traces: number;
  points: number;
  partial: boolean;
  reasons: string[];
}
export interface FieldHint {
  path: string;
  types: string[];
  present: number;
  values: Scalar[];
}
export interface RecordRow {
  /** Original stored JSON, including exact integer text and formatting. */
  raw?: string;
  run_uid: string;
  seq: string;
  received_at: string;
  data: unknown;
}
export interface RecordResult {
  source_generation?: string;
  diagnostics: RecordDiagnostics;
  coverage: string;
  fields: FieldHint[];
  records: RecordRow[];
  next_cursor: unknown | null;
  traces: {
    id?: string;
    group_label?: string | null;
    run_uid: string;
    y: string;
    group: Scalar | null;
    points: [number, number, string][];
  }[];
}
/** Exact, case-sensitive path parser. Dotted names are nested; JSON bracket names
 * preserve literal punctuation. Arrays require an explicit nonnegative index. */
export function recordPath(text: string): (string | number)[] {
  if (!text || text.length > 1024)
    throw new Error("Choose a record path (at most 1024 characters).");
  const parts: (string | number)[] = [];
  let i = text.startsWith("$") ? 1 : 0;
  while (i < text.length) {
    if (parts.length >= 32)
      throw new Error("Record paths support at most 32 components.");
    if (text[i] === ".") {
      i++;
      if (i === text.length) throw new Error("Finish the record path.");
    } else if (parts.length && text[i] !== "[")
      throw new Error("Invalid record path separator.");
    if (text[i] === "[") {
      i++;
      if (text[i] === '"') {
        const start = i++;
        let escaped = false;
        while (i < text.length) {
          const c = text[i++];
          if (c === '"' && !escaped) break;
          escaped = c === "\\" && !escaped;
        }
        try {
          parts.push(JSON.parse(text.slice(start, i)));
        } catch {
          throw new Error("Invalid JSON-quoted record key.");
        }
      } else {
        const m = /^\d+/.exec(text.slice(i));
        if (!m || !Number.isSafeInteger(Number(m[0])))
          throw new Error("Use a nonnegative array index.");
        parts.push(Number(m[0]));
        i += m[0].length;
      }
      if (text[i++] !== "]") throw new Error("Close the record path bracket.");
    } else {
      const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(text.slice(i));
      if (!m)
        throw new Error(
          'Use JSON brackets for special keys, e.g. $["metrics.loss"].',
        );
      parts.push(m[0]);
      i += m[0].length;
    }
  }
  if (!parts.length) throw new Error("Choose a field, not the record root.");
  return parts;
}
export function recordValue(value: unknown, path: string): unknown {
  for (const part of recordPath(path)) {
    if (
      !value ||
      typeof value !== "object" ||
      (typeof part === "number"
        ? !Array.isArray(value)
        : Array.isArray(value)) ||
      !Object.hasOwn(value, part)
    )
      return undefined;
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}
/** Filters use JS-safe scalar transport; never silently round large integers. */
export function validateRecordScalar(value: unknown): Scalar {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value))
    throw new Error("Use a JSON scalar, not an array/object.");
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new Error(
      "Numeric filters require finite numbers and safe integers (+/-9007199254740991). Large integers must not be rounded; inspect raw JSON instead.",
    );
  return value as Scalar;
}
export function parseRecordScalar(text: string): Scalar {
  return validateRecordScalar(JSON.parse(text));
}
export function validateRecordBinding(value: unknown): RecordBinding {
  const b = value as RecordBinding;
  if (
    !b ||
    typeof b !== "object" ||
    Object.keys(b).some(
      (k) =>
        !["sourceId", "runUids", "x", "ys", "filters", "group"].includes(k),
    )
  )
    throw new Error("Invalid record binding.");
  if (
    typeof b.sourceId !== "string" ||
    !b.sourceId.startsWith("rx:") ||
    b.sourceId.length > 128
  )
    throw new Error("Invalid rx source identity.");
  if (
    !Array.isArray(b.runUids) ||
    b.runUids.some((v) => typeof v !== "string" || !v || v.length > 128) ||
    new Set(b.runUids).size !== b.runUids.length
  )
    throw new Error("Choose distinct rx run identities.");
  recordPath(b.x);
  if (
    !Array.isArray(b.ys) ||
    !b.ys.length ||
    b.ys.length > 16 ||
    new Set(b.ys).size !== b.ys.length
  )
    throw new Error("Choose 1–16 distinct Y fields.");
  b.ys.forEach(recordPath);
  if (b.group) recordPath(b.group);
  if (b.group !== undefined && typeof b.group !== "string")
    throw new Error("Invalid grouping field.");
  if (
    !b.filters ||
    typeof b.filters.any !== "boolean" ||
    !Array.isArray(b.filters.conditions) ||
    b.filters.conditions.length > 16 ||
    Object.keys(b.filters).some((k) => !["any", "conditions"].includes(k))
  )
    throw new Error("Invalid record filter.");
  for (const c of b.filters.conditions) {
    validateRecordScalar(c.value);
    recordPath(c.path);
    if (
      Object.keys(c).some((k) => !["path", "op", "value"].includes(k)) ||
      !["eq", "ne", "lt", "lte", "gt", "gte", "exists", "missing"].includes(
        c.op,
      ) ||
      (!["string", "number", "boolean"].includes(typeof c.value) &&
        c.value !== null) ||
      (typeof c.value === "number" && !Number.isFinite(c.value)) ||
      JSON.stringify(c.value)?.length > 1024
    )
      throw new Error("Record filters require typed JSON scalar values.");
  }
  return structuredClone(b);
}
export function recordRuns(
  binding: RecordBinding,
  catalog: Catalog,
  selected: string[],
): string[] {
  const selection = new Set(selected);
  const eligible = new Set(
    catalog.runs
      .filter((r) => selection.has(r.id) && r.rx?.sourceId === binding.sourceId)
      .map((r) => r.rx!.uid),
  );
  return binding.runUids.length
    ? binding.runUids.filter((uid) => eligible.has(uid))
    : [...eligible];
}
export function recordRequest(
  binding: RecordBinding,
  catalog: Catalog,
  selected: string[],
) {
  return {
    source_id: binding.sourceId,
    source_generation: catalog.rx?.sourceGeneration,
    runs: recordRuns(binding, catalog, selected),
    x: binding.x,
    ys: binding.ys,
    filters: binding.filters,
    group: binding.group || null,
  };
}
export function recordNotes(result: RecordResult): string {
  const d = result.diagnostics;
  return [
    `${d.matched} matching / ${d.scanned} scanned records`,
    d.partial ? `Partial result: ${d.reasons.join(", ")}` : "",
    d.skipped_axes
      ? `${d.skipped_axes} missing/non-numeric X/Y pairs skipped`
      : "",
    d.skipped_groups
      ? `${d.skipped_groups} missing/non-scalar groups skipped`
      : "",
    d.oversized ? `${d.oversized} oversized records skipped` : "",
    d.invalid_json ? `${d.invalid_json} invalid JSON records skipped` : "",
    d.omitted_traces ? `${d.omitted_traces} points omitted by group limit` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export function recordConfig(config: ViewConfig, b: RecordBinding): ViewConfig {
  return {
    ...config,
    xLabel: config.xLabel || b.x,
    yLabel: config.yLabel || (b.ys.length === 1 ? b.ys[0] : "Record values"),
  };
}
export async function loadRecordPlot(
  api: Api,
  b: RecordBinding,
  catalog: Catalog,
  selected: string[],
  signal?: AbortSignal,
): Promise<{
  data: PlotRun[];
  sources: ResolvedSeries[];
  notes: string;
  warning: string;
}> {
  validateRecordBinding(b);
  const request = recordRequest(b, catalog, selected);
  if (!request.runs.length) throw new Error("Select rx runs to plot.");
  const sourceRuns = new Map(
    catalog.runs
      .filter((r) => r.rx?.sourceId === b.sourceId)
      .map((r) => [r.rx!.uid, r]),
  );
  const sources: ResolvedSeries[] = [];
  const data: PlotRun[] = [];
  const traces = new Map<string, PlotRun>();
  const diagnostics = emptyDiagnostics();
  let generation = request.source_generation;
  let restarted = false;
  // The run count is a transport budget, never a selection/trace limit.
  // Sequential bounded requests also release each SQLite snapshot promptly.
  for (
    let offset = 0;
    offset < request.runs.length;
    offset += RECORD_BATCH_SIZE
  ) {
    const runs = request.runs.slice(offset, offset + RECORD_BATCH_SIZE);
    let cursor: unknown = null;
    const seen = new Set<string>();
    do {
      checkAbort(signal);
      const response = await api.post<RecordResult>(
        "/rx/plot",
        {
          ...request,
          runs,
          cursor,
          source_generation: generation,
        },
        signal,
      );
      checkAbort(signal);
      generation = checkGeneration(generation, response);
      if (
        response.diagnostics.invalid_json ||
        response.diagnostics.oversized ||
        response.diagnostics.omitted_traces ||
        (response.diagnostics.partial && response.next_cursor == null)
      )
        throw new Error(
          `Record plot could not complete: ${response.diagnostics.reasons.join(", ")}`,
        );
      addDiagnostics(diagnostics, response.diagnostics);
      for (const t of response.traces) {
        const id =
          t.id ?? JSON.stringify([b.sourceId, t.run_uid, t.y, t.group]);
        let plot = traces.get(id);
        if (!plot) {
          const source = sourceRuns.get(t.run_uid);
          if (!source)
            throw new Error(
              "The saved rx run is unavailable; refresh the source catalog.",
            );
          const run = {
            ...source,
            id,
            name: `${source.name} · ${t.y}${b.group ? ` · ${b.group}=${t.group_label ?? JSON.stringify(t.group)}` : ""}`,
          };
          sources.push({
            id,
            runId: source.id,
            key: t.y,
            kind: "metric",
            run: source,
            label: run.name,
          });
          plot = { run, raw: [], paired: { key: b.x, points: [] } };
          traces.set(id, plot);
          data.push(plot);
        }
        const points = plot.paired!.points;
        for (const [x, y] of t.points) {
          if (points.length && x <= points[points.length - 1][0])
            restarted = true;
          points.push([x, y]);
        }
      }
      cursor = response.next_cursor ?? null;
      if (cursor !== null) {
        const key = JSON.stringify(cursor);
        if (seen.has(key))
          throw new Error("Record plot made no progress; retry the query.");
        seen.add(key);
      }
    } while (cursor !== null);
  }
  // Page-budget diagnostics describe transport, not an incomplete final plot.
  diagnostics.partial = false;
  diagnostics.reasons = [];
  return {
    data,
    sources,
    warning: "",
    notes: `${recordNotes({ diagnostics } as RecordResult)}${restarted ? " · Repeated/restarted X retained in event order; grouping uses only each record’s own scalar field." : ""}`,
  };
}
// Shared by complete plot loads and sampled field/record inspection controls.
const RECORD_BATCH_SIZE = 32;
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}
function checkGeneration(expected: string | undefined, response: RecordResult) {
  if (expected !== undefined && response.source_generation !== expected)
    throw new Error("rx source changed; refresh the catalog.");
  return response.source_generation ?? expected;
}
function emptyDiagnostics(): RecordDiagnostics {
  return {
    scanned: 0,
    matched: 0,
    bytes: 0,
    invalid_json: 0,
    oversized: 0,
    skipped_axes: 0,
    skipped_groups: 0,
    omitted_traces: 0,
    points: 0,
    partial: false,
    reasons: [],
  };
}
function addDiagnostics(target: RecordDiagnostics, value: RecordDiagnostics) {
  for (const key of [
    "scanned",
    "matched",
    "bytes",
    "invalid_json",
    "oversized",
    "skipped_axes",
    "skipped_groups",
    "omitted_traces",
    "points",
  ] as const)
    target[key] += value[key] ?? 0;
  target.partial ||= value.partial;
  target.reasons = [...new Set([...target.reasons, ...value.reasons])];
}
type RecordQuery = ReturnType<typeof recordRequest> & {
  cursor?: unknown;
  limit?: number;
  prefix?: string;
  search?: string;
};
interface RecordPageCursor {
  scope: string;
  source_generation?: string;
  batch: number;
  cursors: (string | null)[];
}
/** A sampled field page visits every run batch. Inspection keeps normal record
 * pages but moves across empty batches automatically. Composite cursors are
 * local transport state; the server signs each underlying continuation. */
export async function loadRecordPage(
  api: Api,
  route: "/rx/fields" | "/rx/records",
  request: RecordQuery,
  signal?: AbortSignal,
): Promise<RecordResult> {
  const { cursor: supplied, ...query } = request;
  if (!query.runs.length) throw new Error("Select rx runs to inspect.");
  const scope = JSON.stringify([route, query]);
  const cursor = supplied as RecordPageCursor | null | undefined;
  if (cursor && (cursor.scope !== scope || !Array.isArray(cursor.cursors)))
    throw new Error("Record selection changed; restart inspection.");
  const state: RecordPageCursor = cursor
    ? structuredClone(cursor)
    : {
        scope,
        source_generation: query.source_generation,
        batch: 0,
        cursors: [],
      };
  const result: RecordResult = {
    diagnostics: emptyDiagnostics(),
    fields: [],
    records: [],
    traces: [],
    next_cursor: null,
    coverage: "",
  };
  const hints = new Map<string, FieldHint>();
  const batches = Math.ceil(query.runs.length / RECORD_BATCH_SIZE);
  for (
    let batch = route === "/rx/fields" ? 0 : state.batch;
    batch < batches;
    batch++
  ) {
    if (cursor && state.cursors[batch] === null) continue;
    checkAbort(signal);
    const page = await api.post<RecordResult>(
      route,
      {
        ...query,
        runs: query.runs.slice(
          batch * RECORD_BATCH_SIZE,
          (batch + 1) * RECORD_BATCH_SIZE,
        ),
        cursor: state.cursors[batch] ?? null,
        source_generation: state.source_generation,
      },
      signal,
    );
    checkAbort(signal);
    state.source_generation = checkGeneration(state.source_generation, page);
    if (page.next_cursor != null && page.next_cursor === state.cursors[batch])
      throw new Error("Record query made no progress; restart inspection.");
    state.cursors[batch] = (page.next_cursor as string | null) ?? null;
    addDiagnostics(result.diagnostics, page.diagnostics);
    result.coverage = page.coverage;
    result.records.push(...(page.records ?? []));
    for (const hint of page.fields ?? []) {
      const old = hints.get(hint.path);
      if (!old) hints.set(hint.path, structuredClone(hint));
      else {
        old.present += hint.present;
        old.types = [...new Set([...old.types, ...hint.types])];
        old.values = [
          ...new Map(
            [...old.values, ...hint.values].map((value) => [
              JSON.stringify(value),
              value,
            ]),
          ).values(),
        ].slice(0, 8);
      }
    }
    state.batch = state.cursors[batch] === null ? batch + 1 : batch;
    if (
      route === "/rx/records" &&
      (result.records.length || page.next_cursor != null)
    )
      break;
  }
  // Preserve returned exact paths before capping cross-batch suggestions. The
  // completion menu cannot recover a late-batch exact hint discarded here.
  const prefix = (query.search || query.prefix || "").toLowerCase();
  const rank = (path: string) => {
    const value = path.toLowerCase();
    return value === prefix ? 0 : value.startsWith(prefix) ? 1 : 2;
  };
  result.fields = [...hints.values()]
    .sort((a, b) => rank(a.path) - rank(b.path))
    .slice(0, query.limit ?? 64);
  result.source_generation = state.source_generation;
  result.next_cursor =
    route === "/rx/fields"
      ? state.cursors.some((value) => value !== null)
        ? state
        : null
      : state.batch < batches
        ? state
        : null;
  return result;
}
interface RxCatalog {
  source: { id: string; name: string; readonly: true } | null;
  error?: string;
  next_after: string | null;
  high_water?: string;
  source_generation?: string;
  runs: {
    id: string;
    run_uid: string;
    state: string;
    alias: string | null;
    config: string | null;
    argv: string;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    exit_code: number | null;
  }[];
}
export async function appendRxCatalog(
  api: Api,
  catalog: Catalog,
  signal?: AbortSignal,
  startAfter?: string,
): Promise<Catalog> {
  // Complete metadata discovery, one bounded page at a time. Event payloads
  // remain server-side; rendering pagination does not scope a filter.
  let after: string | null = startAfter ?? null;
  let high = catalog.rx?.highWater;
  let generation = catalog.rx?.sourceGeneration;
  const seen = new Set<string>();
  for (;;) {
    const query = new URLSearchParams();
    if (after !== null) query.set("after", after);
    if (high !== undefined) query.set("high_water", high);
    if (generation !== undefined) query.set("source_generation", generation);
    const value: RxCatalog = await api.json(
      `/rx/catalog${query.size ? `?${query}` : ""}`,
      signal,
    );
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!value.source) {
      if (after !== null || generation !== undefined)
        throw new Error("rx source unavailable; refresh the catalog");
      return catalog;
    }
    if (value.error && after !== null) throw new Error(value.error);
    if (generation !== undefined && value.source_generation !== generation)
      throw new Error("rx source changed; refresh the catalog");
    if (high !== undefined && value.high_water !== high)
      throw new Error("rx catalog snapshot changed; refresh the catalog");
    high = value.high_water;
    generation = value.source_generation;
    const s = value.source;
    catalog.rx = {
      ...s,
      error: value.error,
      nextAfter: value.next_after,
      highWater: high,
      sourceGeneration: generation,
    };
    if (!catalog.experiments.some((e) => e.id === s.id))
      catalog.experiments.push({
        id: s.id,
        name: `rx · ${s.name}${value.error ? " (unavailable)" : ""}`,
        created_at: 0,
      });
    if (value.error) return catalog;
    for (const r of value.runs) {
      const created = rxTimestamp(r.created_at);
      catalog.runs.push({
        id: `${s.id}:${r.run_uid}`,
        experiment_id: s.id,
        name: `r${r.id}${r.alias ? ` · ${r.alias}` : ""}`,
        rx: { sourceId: s.id, uid: r.run_uid, state: r.state },
        status:
          r.state === "succeeded"
            ? "finished"
            : r.state === "canceled"
              ? "canceled"
              : ["active", "queued"].includes(r.state)
                ? "running"
                : "failed",
        params: {
          "rx recorded state": r.state,
          "rx config summary": r.config,
          "rx command": r.argv,
          "rx run UID": r.run_uid,
          "rx exit code": r.exit_code,
        },
        tags: {},
        created_at: created,
        updated_at: rxTimestamp(r.finished_at, r.started_at, r.created_at),
      });
    }
    after = value.next_after;
    if (after === null || startAfter !== undefined) break;
    if (seen.has(after))
      throw new Error("rx catalog made no progress; refresh");
    seen.add(after);
  }
  return catalog;
}
/** Preserve unknown rx dates as NaN; epoch zero is a valid timestamp. */
export function rxTimestamp(...values: (string | null | undefined)[]): number {
  for (const value of values) {
    const time = value == null ? NaN : Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return NaN;
}
export function newRecordBinding(catalog: Catalog): RecordBinding {
  return {
    sourceId: catalog.rx?.id ?? "rx:unavailable",
    runUids: [],
    x: "",
    ys: [],
    filters: { any: false, conditions: [] },
  };
}
