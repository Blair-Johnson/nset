import test from "node:test";
import assert from "node:assert/strict";
import type { Run } from "./api";
import {
  conditionMatches,
  describeCondition,
  runFilterResult,
  type FilterCondition,
} from "./run-filter";
import { localDate, timeConditionError, TIME_UNITS } from "./run-time-filter";
import { RunFilterSession } from "./run-filter-session";
import {
  restoreRunFilter,
  loadRunFilter,
  saveRunFilter,
} from "./run-filter-state";
import { menuToRecordFilters, RECORD_FILTER_OPERATORS } from "./record-filter";

const now = Date.UTC(2026, 9, 26, 12);
const day = TIME_UNITS.days;
const rule = (patch: Partial<FilterCondition> = {}): FilterCondition => ({
  scope: "time",
  path: "created_at",
  op: "last",
  value: "7",
  unit: "days",
  missing: "exclude",
  ...patch,
});
const run = (timestamp: number, rx = false): Run => ({
  id: "run",
  experiment_id: "experiment",
  name: "run",
  status: "finished",
  params: { seed: 1 },
  tags: { owner: "team" },
  created_at: timestamp,
  updated_at: timestamp,
  ...(rx ? { rx: { sourceId: "rx:one", uid: "uid", state: "succeeded" } } : {}),
});

test("created/updated rolling windows on native and rx runs: inclusive lower/now, future excluded", () => {
  for (const rx of [false, true])
    for (const path of ["created_at", "updated_at"]) {
      const c = rule({ path });
      for (const [time, expected] of [
        [now - 7 * day - 1, false],
        [now - 7 * day, true],
        [now, true],
        [now + 1, false],
      ] as const)
        assert.equal(
          conditionMatches(run(time, rx), c, now),
          expected,
          `${rx}/${path}/${time}`,
        );
      const distinct = { ...run(now, rx), created_at: now - 10 * day };
      assert.equal(conditionMatches(distinct, c, now), path === "updated_at");
    }
  for (const [unit, value] of [
    ["minutes", "10080"],
    ["hours", "168"],
    ["days", "7"],
    ["weeks", "1"],
  ] as const)
    assert.equal(
      conditionMatches(run(now - 7 * day), rule({ unit, value }), now),
      true,
    );
});

test("strict stale boundary and missing/invalid timestamps never match, including include/default policy", () => {
  const c = rule({ op: "older" });
  assert.equal(conditionMatches(run(now - 7 * day), c, now), false);
  assert.equal(conditionMatches(run(now - 7 * day - 1), c, now), true);
  for (const invalid of [
    NaN,
    Infinity,
    undefined,
    null,
    "2026-10-20",
    now + 1,
    9e15,
  ])
    for (const missing of ["exclude", "include", "default"] as const)
      assert.equal(
        conditionMatches(
          run(invalid as number),
          { ...c, missing, fallback: "1" },
          now,
        ),
        false,
      );
});

test("typed duration and calendar parsing rejects impossible, ambiguous and reversed input", () => {
  for (const value of [
    "",
    "0",
    "-2",
    "NaN",
    "Infinity",
    "1e3",
    "7 days",
    " 7",
    "0.00000001",
    "999999999999999999999",
  ])
    assert.ok(timeConditionError(rule({ value })), value);
  assert.equal(timeConditionError(rule({ value: "0.5", unit: "hours" })), "");
  assert.ok(timeConditionError(rule({ unit: "months" as never })));
  for (const value of [
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-01",
    "2026-01-00",
    "2026-1-1",
    "10/26/2026",
    "2026-10-26T00:00Z",
    "0000-01-01",
  ])
    assert.equal(localDate(value), undefined, value);
  assert.ok(localDate("2024-02-29"));
  assert.equal(localDate("0099-01-01")?.getFullYear(), 99);
  assert.ok(
    timeConditionError(
      rule({ op: "between", value: "2026-10-27", valueTo: "2026-10-26" }),
    ),
  );
  assert.ok(timeConditionError(rule({ op: "between", value: "2026-10-27" })));
  assert.equal(
    conditionMatches(run(now), rule({ value: "broken" }), now),
    false,
  );
});

function inNewYork(body: () => void) {
  const old = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    body();
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
}

test("calendar boundaries use local next midnight across 23h spring and 25h fall days", () =>
  inNewYork(() => {
    for (const [date, nextDate, hours] of [
      ["2026-03-08", "2026-03-09", 23],
      ["2026-11-01", "2026-11-02", 25],
    ] as const) {
      const start = localDate(date)!.getTime(),
        end = localDate(nextDate)!.getTime();
      assert.equal((end - start) / TIME_UNITS.hours, hours);
      for (const op of ["on", "between"] as const) {
        const c = rule({ op, value: date, valueTo: date });
        assert.equal(conditionMatches(run(start - 1), c, now), false);
        assert.equal(conditionMatches(run(start), c, now), true);
        assert.equal(conditionMatches(run(end - 1), c, now), true);
        assert.equal(conditionMatches(run(end), c, now), false);
      }
      assert.equal(
        conditionMatches(
          run(start - 1),
          rule({ op: "before", value: date }),
          now,
        ),
        true,
      );
      assert.equal(
        conditionMatches(run(start), rule({ op: "before", value: date }), now),
        false,
      );
      assert.equal(
        conditionMatches(run(end - 1), rule({ op: "after", value: date }), now),
        false,
      );
      assert.equal(
        conditionMatches(run(end), rule({ op: "after", value: date }), now),
        true,
      );
      assert.equal(
        conditionMatches(
          run(start),
          rule({ op: "yesterday" }),
          end + 12 * TIME_UNITS.hours,
        ),
        true,
      );
      assert.equal(
        conditionMatches(
          run(end),
          rule({ op: "yesterday" }),
          end + 12 * TIME_UNITS.hours,
        ),
        false,
      );
    }
    const morning = new Date(2026, 9, 26, 12).getTime();
    assert.equal(
      conditionMatches(run(morning), rule({ op: "today" }), morning),
      true,
    );
    assert.equal(
      conditionMatches(run(morning + 1), rule({ op: "today" }), morning),
      false,
    );
    assert.equal(
      conditionMatches(
        run(localDate("2026-10-26")!.getTime() - 1),
        rule({ op: "today" }),
        morning,
      ),
      false,
    );
  }));

test("rolling seven days stays 168 hours even over DST", () =>
  inNewYork(() => {
    const end = new Date(2026, 2, 10, 12).getTime();
    assert.equal(
      conditionMatches(run(end - 168 * TIME_UNITS.hours), rule(), end),
      true,
    );
    assert.equal(
      conditionMatches(run(end - 168 * TIME_UNITS.hours - 1), rule(), end),
      false,
    );
  }));

test("time, config, tags and Event clauses retain AND/OR and unknown evidence semantics", () => {
  const event: FilterCondition = {
    scope: "event",
    path: "loss",
    op: "lt",
    value: "1",
    missing: "exclude",
  };
  const config: FilterCondition = {
    scope: "params",
    path: '$["seed"]',
    op: "eq",
    value: "1",
    missing: "exclude",
  };
  const tag: FilterCondition = {
    scope: "tags",
    path: '$["owner"]',
    op: "eq",
    value: "team",
    missing: "exclude",
  };
  for (const combine of ["all", "any"] as const) {
    const filter = { combine, conditions: [rule(), event] };
    assert.equal(
      runFilterResult(run(now, true), filter, () => null, now),
      combine === "all" ? null : true,
    );
    assert.equal(
      runFilterResult(run(now - 8 * day, true), filter, () => null, now),
      combine === "all" ? false : null,
    );
    assert.equal(
      runFilterResult(run(now, true), filter, () => false, now),
      combine === "any",
    );
    assert.equal(
      runFilterResult(run(now - 8 * day, true), filter, () => true, now),
      combine === "any",
    );
  }
  assert.equal(
    runFilterResult(
      run(now),
      { combine: "all", conditions: [rule(), config, tag] },
      undefined,
      now,
    ),
    true,
  );
});

test("session uses one clock across a pass, refreshes same catalog and active UI, keeps saved windows relative", (t) => {
  let time = now;
  t.mock.method(Date, "now", () => time);
  const filter = { combine: "all" as const, conditions: [rule()] };
  const session = new RunFilterSession(filter);
  const runs = [run(now - 7 * day), { ...run(now - 7 * day), id: "two" }];
  session.setRuns(runs, "revision");
  time++;
  assert.equal(session.matches(runs[0]), true);
  assert.equal(session.matches(runs[1]), true);
  assert.equal(session.count(), 2);
  session.setRuns(runs, "revision");
  assert.equal(session.count(), 0);
  session.setActive(false);
  time = now;
  session.refreshTime();
  assert.equal(session.count(), 0);
  session.setActive(true);
  assert.equal(session.count(), 2);
  assert.deepEqual(session.filter, filter);
  session.destroy();
});

test("relative clock runs only while subscribed and active; unsubscribing disposes timer", (t) => {
  let time = now;
  t.mock.method(Date, "now", () => time);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const session = new RunFilterSession({
    combine: "all",
    conditions: [rule()],
  });
  session.setRuns([run(now - 7 * day)]);
  let changes = 0;
  const unsubscribe = session.subscribe(() => changes++);
  time++;
  t.mock.timers.tick(30_000);
  assert.equal(session.count(), 0);
  assert.equal(changes, 1);
  session.setActive(false);
  t.mock.timers.tick(30_000);
  assert.equal(changes, 1);
  unsubscribe();
  t.mock.timers.tick(30_000);
  assert.equal(changes, 1);
  session.destroy();
});

test("persisted time/config/Event rules restore without freezing dates and preserve pane preferences", (t) => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  t.after(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });
  values.set("nset.run-pane.exp", JSON.stringify({ open: false, width: 400 }));
  const filter = {
    combine: "any" as const,
    conditions: [
      rule(),
      rule({
        path: "updated_at",
        op: "between",
        value: "2026-10-01",
        valueTo: "2026-10-26",
      }),
    ],
  };
  saveRunFilter("exp", filter);
  const restored = loadRunFilter("exp");
  assert.deepEqual(restored, filter);
  assert.equal(JSON.parse(values.get("nset.run-pane.exp")!).width, 400);
  assert.equal(
    runFilterResult(
      run(now - 7 * day),
      { ...restored, conditions: [restored.conditions[0]] },
      undefined,
      now,
    ),
    true,
  );
  assert.equal(
    runFilterResult(
      run(now - 7 * day),
      { ...restored, conditions: [restored.conditions[0]] },
      undefined,
      now + 1,
    ),
    false,
  );
  const invalid = restoreRunFilter({
    combine: "all",
    conditions: [rule({ value: "bad" })],
  });
  assert.equal(invalid.conditions.length, 1);
  assert.equal(runFilterResult(run(now), invalid, undefined, now), false);
  for (const bad of [
    null,
    { combine: "xor", conditions: [] },
    { combine: "all", conditions: [{ ...rule(), scope: "unknown" }] },
  ])
    assert.deepEqual(restoreRunFilter(bad), { combine: "all", conditions: [] });
  assert.match(describeCondition(rule()), /Created in the last 7 days/);
});

test("record-only adapter rejects time scope/operators and keeps supported record filters", () => {
  assert.ok(!RECORD_FILTER_OPERATORS.includes("last"));
  assert.throws(() =>
    menuToRecordFilters({ combine: "all", conditions: [rule()] }),
  );
  assert.throws(() =>
    menuToRecordFilters({
      combine: "all",
      conditions: [rule({ scope: "event", path: "created_at" })],
    }),
  );
  assert.equal(
    menuToRecordFilters({
      combine: "all",
      conditions: [
        {
          scope: "event",
          path: "created_at",
          op: "gte",
          value: "1",
          missing: "exclude",
        },
      ],
    }).conditions[0].path,
    "created_at",
  );
});
