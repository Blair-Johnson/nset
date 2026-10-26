import type { Run } from "./api";
import type { FilterCondition } from "./run-filter";

export type TimeOp =
  | "last"
  | "older"
  | "before"
  | "after"
  | "between"
  | "on"
  | "today"
  | "yesterday";
export type TimeUnit = "minutes" | "hours" | "days" | "weeks";
export const TIME_UNITS: Record<TimeUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};
export const TIME_OPS: { op: TimeOp; label: string }[] = [
  { op: "last", label: "in the last" },
  { op: "older", label: "more than … ago" },
  { op: "before", label: "before date" },
  { op: "after", label: "after date" },
  { op: "between", label: "between dates" },
  { op: "on", label: "on date" },
  { op: "today", label: "today" },
  { op: "yesterday", label: "yesterday" },
];

/** Strict local calendar date, never UTC parsing or JavaScript's rollover dates. */
export function localDate(text: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return;
  const [year, month, day] = text.split("-").map(Number);
  if (year < 1) return;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  )
    return;
  return date;
}

/** Parse a local wall-clock time strictly, including rejecting DST gaps. */
export function localDateTime(text: string): Date | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) return;
  const date = localDate(match[1]);
  if (!date) return;
  const [hours, minutes, seconds] = [
    Number(match[2]),
    Number(match[3]),
    Number(match[4] ?? 0),
  ];
  if (hours > 23 || minutes > 59 || seconds > 59) return;
  date.setHours(hours, minutes, seconds, 0);
  if (
    date.getHours() !== hours ||
    date.getMinutes() !== minutes ||
    date.getSeconds() !== seconds
  )
    return;
  return date;
}
function absoluteDate(c: FilterCondition, text: string): Date | undefined {
  return c.precision === "datetime" ? localDateTime(text) : localDate(text);
}
function nextDay(date: Date): number {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime();
}
function duration(c: FilterCondition): number {
  if (
    !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(c.value) ||
    !Object.hasOwn(TIME_UNITS, c.unit ?? "")
  )
    return NaN;
  return Number(c.value) * TIME_UNITS[c.unit!];
}
export function timeConditionError(c: FilterCondition): string {
  if (c.path !== "created_at" && c.path !== "updated_at")
    return "Choose Created or Updated.";
  if (!TIME_OPS.some(({ op }) => op === c.op)) return "Choose a time operator.";
  if (c.op === "last" || c.op === "older") {
    const ms = duration(c);
    return Number.isFinite(ms) && ms >= 1 && ms <= 8.64e15
      ? ""
      : "Enter a positive duration and a unit.";
  }
  if (c.op === "today" || c.op === "yesterday") return "";
  if (c.op === "on" && c.precision === "datetime")
    return "Choose a calendar date.";
  const start = absoluteDate(c, c.value);
  if (!start)
    return c.precision === "datetime"
      ? "Enter a valid local date and time."
      : "Enter a valid calendar date.";
  if (c.op === "between") {
    const end = absoluteDate(c, c.valueTo ?? "");
    if (!end) return "Enter a valid end date and time.";
    if (end < start) return "End must be on or after the start.";
  }
  return "";
}

export function timeConditionMatches(
  run: Run,
  c: FilterCondition,
  now: number,
): boolean {
  if (timeConditionError(c) || !Number.isFinite(now)) return false;
  const time = run[c.path as "created_at" | "updated_at"];
  if (
    typeof time !== "number" ||
    !Number.isFinite(time) ||
    Math.abs(time) > 8.64e15
  )
    return false;
  if (c.op === "last") return time >= now - duration(c) && time <= now;
  if (c.op === "older") return time < now - duration(c);
  let start: Date;
  if (c.op === "today" || c.op === "yesterday") {
    start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (c.op === "yesterday") {
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
    }
  } else start = absoluteDate(c, c.value)!;
  if (c.op === "before") return time < start.getTime();
  if (c.op === "after")
    return c.precision === "datetime"
      ? time > start.getTime()
      : time >= nextDay(start);
  const end = c.op === "between" ? absoluteDate(c, c.valueTo!)! : start;
  return (
    time >= start.getTime() &&
    (c.precision === "datetime" && c.op === "between"
      ? time <= end.getTime()
      : time < nextDay(end)) &&
    (c.op !== "today" || time <= now)
  );
}

export function describeTimeCondition(c: FilterCondition): string {
  const name = c.path === "created_at" ? "Created" : "Updated";
  const op = TIME_OPS.find((o) => o.op === c.op)?.label ?? c.op;
  if (c.op === "last") return `${name} in the last ${c.value} ${c.unit}`;
  if (c.op === "older") return `${name} more than ${c.value} ${c.unit} ago`;
  if (c.op === "today" || c.op === "yesterday")
    return `${name} ${op} (local time)`;
  return `${name} ${op} ${c.value}${c.op === "between" ? ` – ${c.valueTo}` : ""} (local time)`;
}
