import {
  emptyFilter,
  OPS,
  type FilterCondition,
  type RunFilter,
} from "./run-filter";
import { TIME_OPS, TIME_UNITS, type TimeUnit } from "./run-time-filter";

/** Restore only known rule shapes. Invalid time values remain editable
 * and match nothing; never resolve relative windows while saving/restoring. */
export function restoreRunFilter(value: unknown): RunFilter {
  if (!value || typeof value !== "object") return emptyFilter();
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.conditions) ||
    (raw.combine !== "all" && raw.combine !== "any")
  )
    return emptyFilter();
  const conditions: FilterCondition[] = [];
  for (const item of raw.conditions) {
    if (!item || typeof item !== "object") return emptyFilter();
    const c = item as Record<string, unknown>;
    if (
      !["params", "tags", "event", "time"].includes(String(c.scope)) ||
      typeof c.path !== "string" ||
      typeof c.value !== "string" ||
      !["exclude", "include", "default"].includes(String(c.missing))
    )
      return emptyFilter();
    const time = c.scope === "time";
    if (!(time ? TIME_OPS : OPS).some(({ op }) => op === c.op))
      return emptyFilter();
    const condition: FilterCondition = {
      scope: c.scope as FilterCondition["scope"],
      path: c.path,
      op: c.op as FilterCondition["op"],
      value: c.value,
      missing: time ? "exclude" : (c.missing as FilterCondition["missing"]),
    };
    if (!time && typeof c.fallback === "string")
      condition.fallback = c.fallback;
    if (time) {
      if (c.precision === "date" || c.precision === "datetime")
        condition.precision = c.precision;
      if (typeof c.unit === "string" && Object.hasOwn(TIME_UNITS, c.unit))
        condition.unit = c.unit as TimeUnit;
      if (typeof c.valueTo === "string") condition.valueTo = c.valueTo;
    }
    conditions.push(condition);
  }
  return { combine: raw.combine, conditions };
}

export function loadRunSearch(id: string): { query: string; status: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey(id)) ?? "{}");
    return {
      query: typeof saved?.query === "string" ? saved.query : "",
      status: ["all", "running", "finished", "failed", "canceled"].includes(
        saved?.status,
      )
        ? saved.status
        : "all",
    };
  } catch {
    return { query: "", status: "all" };
  }
}
export function saveRunSearch(
  id: string,
  search: { query: string; status: string },
) {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey(id)) ?? "{}");
    localStorage.setItem(
      preferenceKey(id),
      JSON.stringify({ ...saved, ...search }),
    );
  } catch {
    /* Preferences are optional. */
  }
}

const preferenceKey = (id: string) => `nset.run-pane.${id}`;
export function loadRunFilter(id: string): RunFilter {
  try {
    return restoreRunFilter(
      JSON.parse(localStorage.getItem(preferenceKey(id)) ?? "null")?.filter,
    );
  } catch {
    return emptyFilter();
  }
}
export function saveRunFilter(id: string, filter: RunFilter): void {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey(id)) ?? "{}");
    localStorage.setItem(
      preferenceKey(id),
      JSON.stringify({ ...saved, filter }),
    );
  } catch {
    /* Storage is optional (blocked, full or malformed). */
  }
}
