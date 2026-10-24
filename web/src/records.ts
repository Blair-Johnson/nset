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
    b.runUids.length > 32 ||
    b.runUids.some((v) => typeof v !== "string" || !v || v.length > 128) ||
    new Set(b.runUids).size !== b.runUids.length
  )
    throw new Error("Choose at most 32 distinct rx runs.");
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
  return binding.runUids.length
    ? binding.runUids
    : catalog.runs
        .filter(
          (r) => selected.includes(r.id) && r.rx?.sourceId === binding.sourceId,
        )
        .map((r) => r.rx!.uid);
}
export function recordRequest(
  binding: RecordBinding,
  catalog: Catalog,
  selected: string[],
) {
  return {
    source_id: binding.sourceId,
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
): Promise<{ data: PlotRun[]; sources: ResolvedSeries[]; notes: string }> {
  validateRecordBinding(b);
  const response = await api.post<RecordResult>(
    "/rx/plot",
    recordRequest(b, catalog, selected),
    signal,
  );
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const sources: ResolvedSeries[] = [];
  const data = response.traces.map((t) => {
    const source = catalog.runs.find(
      (r) => r.rx?.sourceId === b.sourceId && r.rx.uid === t.run_uid,
    );
    if (!source)
      throw new Error(
        "The saved rx run is unavailable; refresh the source catalog.",
      );
    const run = {
      ...source,
      id: t.id ?? JSON.stringify([b.sourceId, t.run_uid, t.y, t.group]),
      name: `${source.name} · ${t.y}${b.group ? ` · ${b.group}=${t.group_label ?? JSON.stringify(t.group)}` : ""}`,
    };
    sources.push({
      id: run.id,
      runId: source.id,
      key: t.y,
      kind: "metric",
      run: source,
      label: run.name,
    });
    return {
      run,
      raw: [],
      paired: {
        key: b.x,
        points: t.points.map(([x, y]) => [x, y] as [number, number]),
      },
    };
  });
  const restarted = response.traces.some((t) =>
    t.points.some((p, i) => i > 0 && p[0] <= t.points[i - 1][0]),
  );
  return {
    data,
    sources,
    notes: `${recordNotes(response)}${restarted ? " · Repeated/restarted X retained in event order; grouping uses only each record’s own scalar field." : ""}`,
  };
}
interface RxCatalog {
  source: { id: string; name: string; readonly: true } | null;
  error?: string;
  next_after: string | null;
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
  // Bounded initial metadata loading. No event data is downloaded here.
  let after: string | null = startAfter ?? null;
  for (let page = 0; page < (startAfter === undefined ? 5 : 1); page++) {
    const value: RxCatalog = await api.json(
      `/rx/catalog${after === null ? "" : `?after=${after}`}`,
      signal,
    );
    if (!value.source) return catalog;
    const s = value.source;
    catalog.rx = { ...s, error: value.error, nextAfter: value.next_after };
    if (!catalog.experiments.some((e) => e.id === s.id))
      catalog.experiments.push({
        id: s.id,
        name: `rx · ${s.name}${value.error ? " (unavailable)" : ""}`,
        created_at: 0,
      });
    for (const r of value.runs) {
      const created = Date.parse(r.created_at) || 0;
      catalog.runs.push({
        id: `${s.id}:${r.run_uid}`,
        experiment_id: s.id,
        name: `r${r.id}${r.alias ? ` · ${r.alias}` : ""}`,
        rx: { sourceId: s.id, uid: r.run_uid, state: r.state },
        status:
          r.state === "succeeded"
            ? "finished"
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
        updated_at:
          Date.parse(r.finished_at ?? r.started_at ?? r.created_at) || created,
      });
    }
    after = value.next_after;
    if (after === null || value.error) break;
  }
  return catalog;
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
