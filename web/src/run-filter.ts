import type { Run } from "./api";
import { scalarParameters, displayPath } from "./run-table-fields";

/**
 * Structured run filters over arbitrary nested config (params) and tags.
 * Paths are addressed by their exact JSONPath identity (see run-config), so
 * literal dots in keys never become nested lookups.
 */
export type FilterOp =
  | "eq"
  | "neq"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "exists"
  | "missing";
/** What to do with a run that does not have the condition's path. */
export type MissingPolicy = "exclude" | "include" | "default";
export interface FilterCondition {
  /** "params" (run config) or "tags". */
  scope: "params" | "tags" | "event";
  /** Exact JSONPath identity, e.g. `$["train"]["optim"]["lr"]`. */
  path: string;
  op: FilterOp;
  /** Raw user text; parsed as JSON when possible (numbers, booleans, null). */
  value: string;
  missing: MissingPolicy;
  /** Used when missing === "default": the value a missing path is treated as. */
  fallback?: string;
}
export interface RunFilter {
  combine: "all" | "any";
  conditions: FilterCondition[];
}
export const emptyFilter = (): RunFilter => ({
  combine: "all",
  conditions: [],
});

export const OPS: { op: FilterOp; label: string }[] = [
  { op: "eq", label: "=" },
  { op: "neq", label: "≠" },
  { op: "lt", label: "<" },
  { op: "lte", label: "≤" },
  { op: "gt", label: ">" },
  { op: "gte", label: "≥" },
  { op: "contains", label: "contains" },
  { op: "exists", label: "exists" },
  { op: "missing", label: "not exists" },
];

export function parseFilterValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

export interface FilterField {
  scope: "params" | "tags" | "event";
  path: string;
  label: string;
  /** Number of runs that have this path. */
  count: number;
  /** A few example values (as JSON text) for the value picker. */
  examples: string[];
  types?: string[];
}

/** Every scalar leaf path present in any of the runs, with coverage counts. */
export function filterFields(runs: Run[]): FilterField[] {
  const fields = new Map<string, FilterField & { seen: Set<string> }>();
  for (const run of runs)
    for (const scope of ["params", "tags"] as const)
      for (const field of scalarParameters(run[scope] ?? {})) {
        const id = `${scope}\n${field.sourcePath}`;
        let entry = fields.get(id);
        if (!entry) {
          entry = {
            scope,
            path: field.sourcePath,
            label: scope === "tags" ? `tag:${field.label}` : field.label,
            count: 0,
            examples: [],
            seen: new Set(),
          };
          fields.set(id, entry);
        }
        entry.count++;
        const text = JSON.stringify(field.value);
        if (!entry.seen.has(text) && entry.seen.size < 50) {
          entry.seen.add(text);
          entry.examples.push(text);
        }
      }
  return [...fields.values()]
    .map(({ seen: _seen, ...field }) => field)
    .sort((a, b) =>
      a.scope === b.scope
        ? a.label.localeCompare(b.label)
        : a.scope === "params"
          ? -1
          : 1,
    );
}

/** Read a JSONPath identity (`$["a"][0]`) from a value; undefined if absent. */
export function readPath(root: unknown, path: string): unknown {
  if (!path.startsWith("$")) return undefined;
  let current: unknown = root;
  const re = /\[("(?:[^"\\]|\\.)*"|\d+)\]/g;
  let consumed = 1;
  for (const match of path.matchAll(re)) {
    if (match.index !== consumed) return undefined;
    consumed += match[0].length;
    const key: string | number = match[1].startsWith('"')
      ? (JSON.parse(match[1]) as string)
      : Number(match[1]);
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (typeof key !== "number" || key >= current.length) return undefined;
      current = current[key];
    } else {
      if (
        typeof key !== "string" ||
        !Object.prototype.hasOwnProperty.call(current, key)
      )
        return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return consumed === path.length ? current : undefined;
}

function compare(actual: unknown, op: FilterOp, expected: unknown): boolean {
  switch (op) {
    case "exists":
      return true;
    case "missing":
      return false;
    case "eq":
      return JSON.stringify(actual) === JSON.stringify(expected);
    case "neq":
      return JSON.stringify(actual) !== JSON.stringify(expected);
    case "contains":
      return (typeof actual === "string" ? actual : JSON.stringify(actual))
        .toLowerCase()
        .includes(
          (typeof expected === "string"
            ? expected
            : JSON.stringify(expected)
          ).toLowerCase(),
        );
    default: {
      const a =
        typeof actual === "number"
          ? actual
          : typeof actual === "string" && actual.trim() !== ""
            ? Number(actual)
            : NaN;
      const b =
        typeof expected === "number"
          ? expected
          : typeof expected === "string" && expected.trim() !== ""
            ? Number(expected)
            : NaN;
      if (Number.isFinite(a) && Number.isFinite(b))
        return op === "lt"
          ? a < b
          : op === "lte"
            ? a <= b
            : op === "gt"
              ? a > b
              : a >= b;
      if (typeof actual === "string" && typeof expected === "string") {
        const c = actual.localeCompare(expected);
        return op === "lt"
          ? c < 0
          : op === "lte"
            ? c <= 0
            : op === "gt"
              ? c > 0
              : c >= 0;
      }
      return false;
    }
  }
}

export function conditionMatches(run: Run, c: FilterCondition): boolean {
  if (c.scope === "event") return c.op === "missing" && !run.rx;
  let actual = readPath(run[c.scope] ?? {}, c.path);
  if (c.op === "missing") return actual === undefined;
  if (actual === undefined) {
    if (c.op === "exists") return c.missing === "include";
    if (c.missing === "include") return true;
    if (c.missing === "exclude") return false;
    actual = parseFilterValue(c.fallback ?? "");
  }
  return compare(actual, c.op, parseFilterValue(c.value));
}

/** A condition with no path is incomplete and ignored. */
export function activeConditions(filter: RunFilter | undefined) {
  return (filter?.conditions ?? []).filter((c) => c.path);
}

/** Event evidence is three-valued; unrelated native clauses can still prove AND/OR. */
export function runFilterResult(
  run: Run,
  filter: RunFilter | undefined,
  event: (condition: FilterCondition) => boolean | null = () => null,
): boolean | null {
  const conditions = activeConditions(filter);
  if (!conditions.length) return true;
  const results = conditions.map((c) =>
    c.scope === "event"
      ? run.rx
        ? event(c)
        : c.op === "missing"
      : conditionMatches(run, c),
  );
  if (filter!.combine === "any")
    return results.includes(true)
      ? true
      : results.includes(null)
        ? null
        : false;
  return results.includes(false) ? false : results.includes(null) ? null : true;
}
export function runMatchesFilter(run: Run, filter: RunFilter | undefined) {
  return runFilterResult(run, filter) === true;
}

export function describeCondition(c: FilterCondition, label?: string) {
  const name = `${c.scope === "event" ? "Event: " : ""}${label ?? c.path}`;
  const op = OPS.find((o) => o.op === c.op)?.label ?? c.op;
  const missing =
    c.missing === "include"
      ? " (or missing)"
      : c.missing === "default"
        ? ` (missing = ${c.fallback ?? ""})`
        : "";
  return c.op === "exists" || c.op === "missing"
    ? `${name} ${op}${missing}`
    : `${name} ${op} ${c.value}${missing}`;
}

export { displayPath };
