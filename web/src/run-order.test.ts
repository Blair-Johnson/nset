import test from "node:test";
import assert from "node:assert/strict";
import type { Run } from "./api";
import type { CatalogSeries } from "./workspace-types";
import { createRunOrder, runSortState } from "./run-order";
import { compareParameters, type ScalarParameter } from "./run-table-fields";

const run = (id: string, params: Record<string, unknown> = {}): Run => ({
  id,
  experiment_id: "e",
  name: id,
  status: "finished",
  params,
  tags: {},
  created_at: 1,
  updated_at: 1,
});
const ids = (rows: Run[]) => rows.map((row) => row.id);

test("default, names and statuses keep stable ties without mutating catalog order", () => {
  const runs = [run("b"), run("a"), run("c")];
  runs[0].status = "running";
  runs[2].created_at = 2;
  const order = createRunOrder(runs, []);
  assert.deepEqual(ids(order.sort(runs, runSortState())), ["c", "b", "a"]);
  assert.deepEqual(ids(order.sort(runs, { sort: "name", descending: false })), [
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual(
    ids(order.sort(runs, { sort: "status", descending: true })),
    ["b", "a", "c"],
  );
  assert.deepEqual(ids(runs), ["b", "a", "c"]);
});

test("metric sorting keeps null and absent summaries last in both directions", () => {
  const runs = [
    run("two"),
    run("missing"),
    run("ten"),
    run("tie"),
    run("null"),
  ];
  const series = [
    { run_id: "two", last_value: 2 },
    { run_id: "ten", last_value: 10 },
    { run_id: "tie", last_value: 2 },
    { run_id: "null", last_value: null },
  ].map((value) => ({
    ...value,
    key: "loss",
    kind: "metric",
    count: 1,
    last_step: 0,
    last_timestamp: 0,
  })) as CatalogSeries[];
  const order = createRunOrder(runs, series);
  assert.deepEqual(
    ids(order.sort(runs, { sort: "metric:loss", descending: false })),
    ["two", "tie", "ten", "missing", "null"],
  );
  assert.deepEqual(
    ids(order.sort(runs, { sort: "metric:loss", descending: true })),
    ["ten", "two", "tie", "missing", "null"],
  );
  // Sorting another column first cannot change the tie order on the next pass.
  order.sort(runs, { sort: "name", descending: true });
  assert.deepEqual(
    ids(order.sort(runs, { sort: "metric:loss", descending: false })),
    ["two", "tie", "ten", "missing", "null"],
  );
});

test("parameter ordering uses exact paths, numeric values, null then missing", () => {
  const runs = [
    run("two", { value: 2, "a.b": 10, a: { b: 0 } }),
    run("missing"),
    run("ten", { value: 10, "a.b": 2, a: { b: 1 } }),
    run("null", { value: null }),
    run("tie", { value: 2 }),
  ];
  const order = createRunOrder(runs, []);
  const sort = 'parameter:$["value"]';
  assert.deepEqual(ids(order.sort(runs, { sort, descending: false })), [
    "two",
    "tie",
    "ten",
    "null",
    "missing",
  ]);
  assert.deepEqual(ids(order.sort(runs, { sort, descending: true })), [
    "ten",
    "two",
    "tie",
    "null",
    "missing",
  ]);
  assert.deepEqual(
    ids(
      order.sort(runs, { sort: 'parameter:$["a.b"]', descending: false }),
    ).slice(0, 2),
    ["ten", "two"],
  );
  assert.deepEqual(
    ids(
      order.sort(runs, { sort: 'parameter:$["a"]["b"]', descending: false }),
    ).slice(0, 2),
    ["two", "ten"],
  );
});

test("mixed parameter types reuse the table comparator and subsets preserve order", () => {
  const values: (ScalarParameter | undefined)[] = [
    undefined,
    null,
    false,
    true,
    0,
    10,
    2,
    "2",
    "",
    "false",
  ];
  const runs = values.map((value, index) =>
    run(String(index), value === undefined ? {} : { value }),
  );
  const order = createRunOrder(runs, []);
  for (const descending of [false, true]) {
    const state = { sort: 'parameter:$["value"]', descending };
    const expected = [...runs].sort((a, b) =>
      compareParameters(values[+a.id], values[+b.id], descending),
    );
    assert.deepEqual(ids(order.sort(runs, state)), ids(expected));
    const selected = new Set(["0", "1", "3", "6"]);
    assert.deepEqual(
      ids(
        order.sort(
          runs.filter((r) => selected.has(r.id)),
          state,
        ),
      ),
      ids(expected.filter((r) => selected.has(r.id))),
    );
  }
});
