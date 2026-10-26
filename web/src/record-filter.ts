import {
  formatFilterValue,
  parseFilterValue,
  type FilterOp,
  type RunFilter,
} from "./run-filter";
import {
  recordPath,
  validateRecordScalar,
  type RecordFilters,
  type RecordCondition,
} from "./records";

export const RECORD_FILTER_OPERATORS: readonly FilterOp[] = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "exists",
  "missing",
];

/** Presentation only: do not use run matching (AND may span events there). */
export function recordFilterToMenu(filters: RecordFilters): RunFilter {
  return {
    combine: filters.any ? "any" : "all",
    conditions: filters.conditions.map((c) => ({
      scope: "event",
      path: c.path,
      op: c.op === "ne" ? "neq" : c.op,
      value: formatFilterValue(c.value),
      missing: "exclude",
    })),
  };
}

/** Keep the persisted/API record predicate: every AND condition shares one event.
 * Empty rows are inactive. Hints omit the edited condition, never its siblings. */
export function menuToRecordFilters(
  filter: RunFilter,
  omit?: number,
): RecordFilters {
  if (filter.conditions.length > 16)
    throw new Error("Choose at most 16 conditions.");
  return {
    any: filter.combine === "any",
    conditions: filter.conditions.flatMap((c, index) => {
      if (index === omit || !c.path.trim()) return [];
      if (c.scope !== "event" || !RECORD_FILTER_OPERATORS.includes(c.op))
        throw new Error("Choose an Event record condition.");
      recordPath(c.path);
      const value =
        c.op === "exists" || c.op === "missing"
          ? null
          : validateRecordScalar(parseFilterValue(c.value));
      if (JSON.stringify(value).length > 1024)
        throw new Error("Filter values must be at most 1024 characters.");
      return [
        {
          path: c.path,
          op:
            c.op === "neq" ? ("ne" as const) : (c.op as RecordCondition["op"]),
          value,
        },
      ];
    }),
  };
}
