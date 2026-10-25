import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { menuToRecordFilters, recordFilterToMenu } from "./record-filter";
import {
  formatFilterValue,
  parseFilterValue,
  type RunFilter,
} from "./run-filter";
import type { RecordFilters } from "./records";

const filter = (value = "train", path = "phase"): RunFilter => ({
  combine: "all",
  conditions: [{ scope: "event", path, op: "eq", value, missing: "exclude" }],
});

test("record adapter preserves scalar types and persisted AND/OR operators", () => {
  const values = [
    "train",
    "1",
    "true",
    "null",
    "",
    " train ",
    1,
    0.1,
    true,
    false,
    null,
  ];
  for (const value of values) {
    assert.deepEqual(parseFilterValue(formatFilterValue(value)), value);
    for (const any of [false, true]) {
      const saved: RecordFilters = {
        any,
        conditions: [{ path: 'events[0]["phase.name"]', op: "ne", value }],
      };
      const menu = recordFilterToMenu(saved);
      assert.equal(menu.conditions[0].scope, "event");
      assert.equal(menu.conditions[0].op, "neq");
      assert.deepEqual(menuToRecordFilters(menu), saved);
    }
  }
  assert.equal(
    recordFilterToMenu({
      any: false,
      conditions: [{ path: "phase", op: "eq", value: "train" }],
    }).conditions[0].value,
    "train",
  );
});

test("record filters retain every same-event condition; own hint scope omits only self", () => {
  const draft = filter();
  draft.conditions.push({
    ...draft.conditions[0],
    path: "step",
    value: "2",
    op: "gte",
  });
  assert.deepEqual(menuToRecordFilters(draft), {
    any: false,
    conditions: [
      { path: "phase", op: "eq", value: "train" },
      { path: "step", op: "gte", value: 2 },
    ],
  });
  assert.deepEqual(menuToRecordFilters(draft, 0), {
    any: false,
    conditions: [{ path: "step", op: "gte", value: 2 }],
  });
  draft.combine = "any";
  assert.equal(menuToRecordFilters(draft).any, true);
  assert.equal(draft.conditions.length, 2);
});

test("exact literal, nested, and typed array-index path identities are not rewritten", () => {
  for (const path of [
    "metrics.loss",
    '$["metrics.loss"]',
    "items[0].loss",
    'items["0"].loss',
    "not_in_hints",
  ]) {
    assert.equal(
      menuToRecordFilters(filter("null", path)).conditions[0].path,
      path,
    );
  }
  assert.throws(
    () => menuToRecordFilters(filter("train", "items[")),
    /bracket|index/i,
  );
  assert.deepEqual(menuToRecordFilters(filter("train", "")), {
    any: false,
    conditions: [],
  });
});

test("unsafe numbers and non-scalar inputs are rejected, never silently rounded", () => {
  for (const text of [
    "9007199254740992",
    "9007199254740993",
    "-9007199254740993",
    "1e309",
    "[]",
    "{}",
  ])
    assert.throws(
      () => menuToRecordFilters(filter(text)),
      /safe integers|scalar/,
    );
  assert.equal(
    menuToRecordFilters(filter("9007199254740991")).conditions[0].value,
    9007199254740991,
  );
  assert.equal(
    menuToRecordFilters(filter('"9007199254740993"')).conditions[0].value,
    "9007199254740993",
  );
});

test("record-only scope/operators and existence semantics stay explicit", () => {
  const draft = filter();
  for (const scope of ["tags", "params"] as const) {
    draft.conditions[0].scope = scope;
    assert.throws(() => menuToRecordFilters(draft), /Event/);
  }
  draft.conditions[0].scope = "event";
  draft.conditions[0].op = "contains";
  assert.throws(() => menuToRecordFilters(draft), /Event/);
  for (const op of ["exists", "missing"] as const) {
    draft.conditions[0].op = op;
    draft.conditions[0].value = "9007199254740993";
    assert.deepEqual(menuToRecordFilters(draft).conditions[0], {
      path: "phase",
      op,
      value: null,
    });
  }
});

test("chart record controls instantiate the actual shared menu, not a run session or legacy form", () => {
  const source = readFileSync(
    new URL("./record-controls.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /new RunFilterMenu\(/);
  assert.doesNotMatch(
    source,
    /new RunFilterSession|Record filter.*JSON value|Apply record filters|Add record condition|maximum 32|record-filter-row/,
  );
});
