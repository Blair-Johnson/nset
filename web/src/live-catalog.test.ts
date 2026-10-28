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
