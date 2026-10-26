import { createRunOrder } from "./run-order";
import test from "node:test";
import assert from "node:assert/strict";
import { conditionMatches, type FilterCondition } from "./run-filter";
import { localDateTime, timeConditionError } from "./run-time-filter";
import { restoreRunFilter } from "./run-filter-state";
import { rxTimestamp } from "./records";
import type { Run } from "./api";

const condition = (patch: Partial<FilterCondition> = {}): FilterCondition => ({
  scope: "time",
  path: "created_at",
  op: "between",
  value: "2026-10-26T14:30",
  valueTo: "2026-10-26T15:30",
  precision: "datetime",
  missing: "exclude",
  ...patch,
});
const run = (created_at: number): Run => ({
  id: "a",
  name: "a",
  experiment_id: "e",
  status: "finished",
  params: {},
  tags: {},
  created_at,
  updated_at: created_at,
});

test("local exact-time bounds are strict before/after and inclusive between", () => {
  const start = new Date(2026, 9, 26, 14, 30).getTime();
  const end = new Date(2026, 9, 26, 15, 30).getTime();
  const matches = (time: number, c = condition()) =>
    conditionMatches(run(time), c, end);
  assert.equal(localDateTime("2026-10-26T14:30")!.getTime(), start);
  assert.equal(matches(start - 1), false);
  assert.equal(matches(start), true);
  assert.equal(matches(end), true);
  assert.equal(matches(end + 1), false);
  assert.equal(matches(start, condition({ op: "before" })), false);
  assert.equal(matches(start - 1, condition({ op: "before" })), true);
  assert.equal(matches(start, condition({ op: "after" })), false);
  assert.equal(matches(start + 1, condition({ op: "after" })), true);
  assert.ok(timeConditionError(condition({ valueTo: "2026-10-26T14:29" })));
  const filter = { combine: "all" as const, conditions: [condition()] };
  assert.deepEqual(restoreRunFilter(filter), filter);
});

test("local date-times reject invalid dates, clock values and DST gaps", () => {
  for (const value of [
    "2026-02-30T12:00",
    "2026-10-26T24:00",
    "2026-10-26T12:60",
    "2026-10-26T12:00:60",
    "2026-10-26",
    "2026-10-26T14:30Z",
  ])
    assert.equal(localDateTime(value), undefined);
  const old = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(localDateTime("2026-03-08T02:30"), undefined);
    assert.equal(localDateTime("2026-03-08T03:30")?.getHours(), 3);
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
});

test("rx dates preserve unknown versus epoch zero and valid lifecycle fallbacks", () => {
  assert.ok(Number.isNaN(rxTimestamp("broken", null, "")));
  assert.equal(rxTimestamp("1970-01-01T00:00:00Z", "2026-10-26T00:00:00Z"), 0);
  assert.equal(
    rxTimestamp("bad", "2026-10-25T00:00:00Z", "2026-10-01T00:00:00Z"),
    Date.UTC(2026, 9, 25),
  );
  const c = condition({ op: "older", value: "7", unit: "days" });
  assert.equal(conditionMatches(run(rxTimestamp("broken")), c), false);
  assert.equal(conditionMatches(run(0), c), true);
  assert.equal(conditionMatches(run(-1), c), true);
});

test("unknown Created dates sort last without disturbing valid chronology", () => {
  const rows = [1, NaN, 3, 0, NaN].map((time, index) => ({
    ...run(time),
    id: String(index),
  }));
  const order = createRunOrder(rows, []);
  assert.deepEqual(
    order.sort(rows, { sort: "created_at", descending: true }).map((r) => r.id),
    ["2", "0", "3", "1", "4"],
  );
  assert.deepEqual(
    order
      .sort(rows, { sort: "created_at", descending: false })
      .map((r) => r.id),
    ["3", "0", "2", "1", "4"],
  );
});
