import test from "node:test";
import assert from "node:assert/strict";
import type { Run } from "./api";
import type { CatalogSeries } from "./workspace-types";
import {
  sortedRunIds,
  traceDrawOrder,
  traceDrawIndices,
  permuteTracePairs,
} from "./trace-order";

const run = (id: string, created_at = 1): Run => ({
  id,
  name: id,
  created_at,
  updated_at: created_at,
  experiment_id: "e",
  status: "finished",
  params: {},
  tags: {},
});
const metric = (run_id: string, last_value: number): CatalogSeries => ({
  run_id,
  key: "loss",
  kind: "metric",
  count: 1,
  last_step: 0,
  last_timestamp: 0,
  last_value,
});
const sources = [
  { id: "a/loss", runId: "a" },
  { id: "b/loss", runId: "b" },
  { id: "a/accuracy", runId: "a" },
  { id: "c/loss", runId: "c" },
];

test("ascending/descending sorts paint the top run last without reversing its series", () => {
  const runs = [run("c"), run("b"), run("a")];
  const before = structuredClone({ runs, sources });
  const order = (descending: boolean) =>
    traceDrawOrder(
      sources,
      sortedRunIds(runs, [], { sort: "name", descending }),
    );
  assert.deepEqual(order(false), ["c/loss", "b/loss", "a/loss", "a/accuracy"]);
  assert.deepEqual(order(true), ["a/loss", "a/accuracy", "b/loss", "c/loss"]);
  assert.deepEqual({ runs, sources }, before);
});

test("ties use catalog order rather than selection, source, or previous sort order", () => {
  const runs = [run("b"), run("a"), run("c")];
  for (const descending of [false, true]) {
    sortedRunIds(runs, [], { sort: "name", descending });
    const top = sortedRunIds(runs, [], { sort: "created_at", descending });
    assert.deepEqual(top, ["b", "a", "c"]);
    assert.deepEqual(traceDrawOrder(sources, top), [
      "c/loss",
      "a/loss",
      "a/accuracy",
      "b/loss",
    ]);
  }
});

test("live summary changes reorder metric sorts but not unrelated sorts", () => {
  const runs = [run("a"), run("b"), run("c")];
  const before = [metric("a", 1), metric("b", 2), metric("c", 3)];
  const after = [metric("a", 4), metric("b", 2), metric("c", 3)];
  for (const descending of [false, true]) {
    const state = { sort: "metric:loss", descending };
    const first = traceDrawOrder(sources, sortedRunIds(runs, before, state));
    const next = traceDrawOrder(sources, sortedRunIds(runs, after, state));
    assert.notDeepEqual(next, first);
    assert.equal(next.at(-1), descending ? "a/accuracy" : "b/loss");
  }
  const state = { sort: "name", descending: false };
  assert.deepEqual(
    sortedRunIds(runs, before, state),
    sortedRunIds(runs, after, state),
  );
});

test("explicit sources use run identities even outside selection; unmatched fallback is stable", () => {
  const explicit = [
    { id: "opaque:[a]", runId: "a" },
    { id: "external:two", runId: "external" },
    { id: "opaque:b", runId: "b" },
    { id: "external:one", runId: "external" },
    { id: "orphan", runId: "unavailable" },
    { id: "opaque:a:second", runId: "a" },
  ];
  assert.deepEqual(traceDrawOrder(explicit, ["a", "c", "b"]), [
    "external:two",
    "external:one",
    "orphan",
    "opaque:b",
    "opaque:[a]",
    "opaque:a:second",
  ]);
  assert.deepEqual(
    traceDrawOrder(explicit, []),
    explicit.map((s) => s.id),
  );
});

test("physical slots preserve logical indexes and keep observations with their trace", () => {
  const ids = sources.map((s) => s.id);
  const indices = traceDrawIndices(
    ids,
    traceDrawOrder(sources, ["a", "b", "c"]),
  );
  assert.deepEqual(indices, [3, 1, 0, 2]);
  const paired = ["x", ...ids.flatMap((id) => [id, `${id}:raw`])];
  assert.deepEqual(permuteTracePairs(paired, indices), [
    "x",
    "c/loss",
    "c/loss:raw",
    "b/loss",
    "b/loss:raw",
    "a/loss",
    "a/loss:raw",
    "a/accuracy",
    "a/accuracy:raw",
  ]);
  assert.deepEqual(
    ids,
    sources.map((s) => s.id),
  );
  assert.deepEqual(traceDrawIndices(ids, []), [0, 1, 2, 3]);
  assert.deepEqual(traceDrawIndices(ids, ["absent", "a/loss"]), [1, 2, 3, 0]);
});
