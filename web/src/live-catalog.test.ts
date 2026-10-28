import test from "node:test";
import assert from "node:assert/strict";
import { applyMetricHints } from "./live-catalog";
import type { Catalog } from "./workspace-types";
import type { LiveChange } from "./live";
const base = (): Catalog => ({
  metric_seq: 10,
  experiments: [],
  runs: [],
  series: [
    {
      run_id: "r",
      key: "a",
      kind: "metric",
      count: 5,
      last_step: 5,
      last_timestamp: 5,
      last_value: 5,
    },
  ],
});
const hint = (key: string, high: number, count = 1): LiveChange => ({
  kind: "metric",
  runId: "r",
  key,
  high,
  count,
  last: { seq: high, step: 1, timestamp: 0, value: high },
});
test("catalog watermark ignores bootstrap overlap and replay without discarding sibling streams", () => {
  const before = base();
  const changes = [
    hint("a", 10, 5),
    hint("a", 14, 2),
    hint("b", 13),
    hint("a", 15),
  ];
  const next = applyMetricHints(before, changes);
  assert.equal(next.metric_seq, 15);
  assert.equal(next.series[0].count, 8);
  assert.equal(next.series[0].last_step, 1);
  assert.equal(next.series[0].last_timestamp, 0);
  assert.equal(next.series[0].last_value, 15);
  assert.equal(next.series[1].count, 1);
  assert.equal(applyMetricHints(next, changes), next);
  assert.equal(before.series[0].count, 5);
});
test("quiet/metadata-only notifications do not replace the catalog", () => {
  const before = base();
  assert.equal(applyMetricHints(before, []), before);
  assert.equal(
    applyMetricHints(before, [{ kind: "catalog" }, { kind: "rx" }]),
    before,
  );
});

test("server activity updates runs immutably and ignores sample clocks, overlap and replay", () => {
  const run = (id: string) => ({
    id,
    experiment_id: "e",
    name: id,
    status: "running" as const,
    params: {},
    tags: {},
    created_at: 10,
    updated_at: 100,
  });
  const before = { ...base(), runs: [run("r"), run("other")] };
  const activity = (
    high: number,
    timestamp: number,
    runUpdatedAt?: number,
  ): LiveChange => ({
    kind: "metric",
    runId: "r",
    key: "a",
    high,
    count: 1,
    last: { seq: high, step: high, timestamp, value: 1 },
    ...(runUpdatedAt === undefined ? {} : { runUpdatedAt }),
  });
  // Even a newer activity time cannot override the catalog transaction watermark.
  assert.equal(applyMetricHints(before, [activity(10, 0, 999)]), before);
  const future = applyMetricHints(before, [activity(11, 999999)]);
  assert.equal(future.runs[0], before.runs[0]);
  assert.equal(future.runs[0].updated_at, 100);
  const changes = [activity(12, 0, 120), activity(13, 1, 110)];
  const next = applyMetricHints(future, changes);
  assert.equal(next.runs[0].updated_at, 120);
  assert.notEqual(next.runs[0], before.runs[0]);
  assert.equal(next.runs[1], before.runs[1]);
  assert.equal(before.runs[0].updated_at, 100);
  assert.equal(next.series[0].last_timestamp, 1);
  assert.equal(applyMetricHints(next, changes), next);
  const legacy = applyMetricHints(next, [activity(14, 999999)]);
  assert.equal(legacy.runs[0], next.runs[0]);
  const backfill = applyMetricHints(legacy, [activity(15, 0, 130)]);
  assert.equal(backfill.runs[0].updated_at, 130);
  assert.equal(backfill.series[0].last_timestamp, 0);
});
