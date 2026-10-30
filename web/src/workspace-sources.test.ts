import test from "node:test";
import assert from "node:assert/strict";
import type { Run } from "./api";
import { applyMetricHints } from "./live-catalog";
import type { LiveChange } from "./live";
import {
  chartHasSources,
  newChart,
  resolveSources,
  seriesId,
} from "./workspace";
import type { Catalog, ChartSpec, SeriesRef } from "./workspace-types";

const run = (id: string, name = id): Run => ({
  id,
  name,
  experiment_id: "e",
  status: "finished",
  params: {},
  tags: {},
  created_at: 1,
  updated_at: 2,
});
const series = (
  run_id: string,
  key: string,
  kind: SeriesRef["kind"] = "metric",
): Catalog["series"][number] => ({
  run_id,
  key,
  kind,
  count: 0,
  last_step: 0,
  last_timestamp: 1,
  last_value: null,
});
const catalog = (): Catalog => ({
  experiments: [],
  runs: [run("r1", "Run"), run("r2", "Run"), run("r3")],
  series: [
    series("r1", "y"),
    series("r2", "y"),
    series("r1", "x"),
    series("r3", "x"),
    series("r1", "picture", "image"),
    series("orphan", "y"),
    series("orphan", "picture", "image"),
  ],
});
function presence(
  card: ChartSpec,
  c: Catalog,
  selected: string[],
  expected: boolean,
) {
  assert.equal(chartHasSources(card, c, selected), expected);
  assert.equal(resolveSources(card, selected, c).length > 0, expected);
}

test("native selected charts require the requested kind, key and an existing run", () => {
  const c = catalog();
  const scalar = newChart("timeseries", ["y"]);
  presence(scalar, c, ["r1"], true);
  presence(scalar, c, ["r3"], false);
  presence(scalar, c, [], false);
  presence(scalar, c, ["orphan"], false);
  presence(newChart("timeseries", []), c, ["r1"], false);
  presence(newChart("timeseries", ["picture"]), c, ["r1"], false);
  const image = newChart("image", ["picture"]);
  presence(image, c, ["r1"], true);
  presence(image, c, ["r2"], false);
  presence(image, c, ["orphan"], false);
  presence(newChart("image", ["y"]), c, ["r1"], false);
  presence(newChart("image", ["absent", "picture"]), c, ["r2", "r1"], true);
});

test("explicit native sources narrow selection and reject missing and wrong-kind references", () => {
  const c = catalog();
  for (const [kind, key, sourceKind] of [
    ["timeseries", "y", "metric"],
    ["image", "picture", "image"],
  ] as const) {
    const card = newChart(kind, []);
    card.source = {
      mode: "explicit",
      series: [{ runId: "r1", key, kind: sourceKind }],
    };
    presence(card, c, [], false);
    presence(card, c, ["r3"], false);
    presence(card, c, ["r1", "r3"], true);
    card.source.series = [{ runId: "orphan", key, kind: sourceKind }];
    presence(card, c, ["r1"], false);
    card.source.series = [{ runId: "r1", key: "absent", kind: sourceKind }];
    presence(card, c, ["r1"], false);
    card.source.series = [
      {
        runId: "r1",
        key: sourceKind === "metric" ? "picture" : "y",
        kind: sourceKind === "metric" ? "image" : "metric",
      },
    ];
    presence(card, c, ["r1"], false);
    card.source.series = [];
    presence(card, c, ["r1"], false);
  }
});

test("keyed XY requires X and Y on the same eligible run", () => {
  const c = catalog();
  const card = newChart("timeseries", ["y"]);
  card.x = { mode: "key", key: "x" };
  presence(card, c, ["r1"], true);
  presence(card, c, ["r2", "r3"], false);
  presence(card, c, ["r2", "r1"], true);
  assert.deepEqual(
    resolveSources(card, ["r2", "r1"], c).map((s) => s.runId),
    ["r1"],
  );
  card.source = {
    mode: "explicit",
    series: [{ runId: "r1", key: "y", kind: "metric" }],
  };
  presence(card, c, [], false);
  presence(card, c, ["r1"], true);
  card.x = { mode: "key", key: "picture" };
  presence(card, c, ["r1"], false);
});

test("fixed XY can use an unselected X run but still requires metric X and Y", () => {
  const c = catalog();
  const card = newChart("timeseries", ["y"]);
  card.x = {
    mode: "series",
    series: { runId: "r3", key: "x", kind: "metric" },
  };
  presence(card, c, ["r2"], true);
  presence(card, c, ["r3"], false);
  assert.equal(resolveSources(card, ["r2"], c)[0].x?.run.id, "r3");
  card.source = {
    mode: "explicit",
    series: [{ runId: "r2", key: "y", kind: "metric" }],
  };
  presence(card, c, [], false);
  presence(card, c, ["r2"], true);
  assert.equal(resolveSources(card, ["r2"], c)[0].x?.run.id, "r3");
  for (const ref of [
    { runId: "r1", key: "picture", kind: "image" },
    { runId: "r1", key: "picture", kind: "metric" },
    { runId: "orphan", key: "y", kind: "metric" },
    { runId: "r3", key: "absent", kind: "metric" },
  ] as SeriesRef[]) {
    card.x = { mode: "series", series: ref };
    presence(card, c, ["r2"], false);
  }
});

test("resolution preserves ordering, deduplication and globally disambiguated X/Y labels", () => {
  const c = catalog();
  const card = newChart("timeseries", ["y", "x"]);
  assert.deepEqual(
    resolveSources(card, ["r2", "r1", "r2"], c).map((s) => [
      s.runId,
      s.key,
      s.label,
    ]),
    [
      ["r2", "y", "Run (r2) · y"],
      ["r1", "y", "Run (r1) · y"],
      ["r1", "x", "Run (r1) · x"],
    ],
  );
  card.source = {
    mode: "explicit",
    series: [
      { runId: "r1", key: "y", kind: "metric" },
      { runId: "r1", key: "y", kind: "metric" },
      { runId: "r2", key: "y", kind: "metric" },
    ],
  };
  card.x = {
    mode: "series",
    series: { runId: "r1", key: "x", kind: "metric" },
  };
  const resolved = resolveSources(card, ["r2", "r1", "r3"], c);
  assert.deepEqual(
    resolved.map((s) => s.runId),
    ["r1", "r2"],
  );
  assert.deepEqual(
    resolveSources(card, ["r2", "r3"], c).map((s) => s.runId),
    ["r2"],
  );
  presence(card, c, [], false);
  assert.equal(card.source.series.length, 3);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].label, "Run (r1) · y");
  assert.equal(resolved[0].x?.label, "Run (r1) · x");
  assert.notEqual(resolved[0].x?.ref, card.x.series);
  assert.equal(resolved[0].id, seriesId(card.source.series[0]));
});

test("tuple identities do not confuse separators, quotes, keys or kinds", () => {
  const c: Catalog = {
    experiments: [],
    runs: [run("a/b"), run("a")],
    series: [series("a/b", 'c/"d')],
  };
  presence(newChart("timeseries", ['c/"d']), c, ["a/b"], true);
  presence(newChart("timeseries", ['b/c/"d']), c, ["a"], false);
  presence(newChart("image", ['c/"d']), c, ["a/b"], false);
});

test("rx record charts remain visible for eligible runs without scalar or field evidence", () => {
  const rxRun = (id: string, sourceId: string, uid: string): Run => ({
    ...run(id, "Records"),
    rx: { sourceId, uid, state: "finished" },
  });
  const c: Catalog = {
    experiments: [],
    runs: [
      run("native"),
      rxRun("a", "rx:one", "u1"),
      rxRun("b", "rx:one", "u2"),
      rxRun("c", "rx:two", "u1"),
    ],
    series: [],
  };
  const card = newChart("timeseries", []);
  card.records = {
    sourceId: "rx:one",
    runUids: [],
    x: "unknown_x",
    ys: ["unknown_y", "other_y"],
    filters: {
      any: false,
      conditions: [{ path: "unknown", op: "eq", value: 1 }],
    },
  };
  presence(card, c, ["a"], true);
  presence(card, c, [], false);
  presence(card, c, ["native", "c", "missing"], false);
  const resolved = resolveSources(card, ["b", "a", "a"], c);
  assert.deepEqual(
    resolved.map((s) => s.runId),
    ["a", "a", "b", "b"],
  );
  assert.equal(
    resolved[0].id,
    JSON.stringify(["rx:one", "u1", "unknown_y", null]),
  );
  assert.equal(resolved[0].label, "Records · unknown_y");
  card.records.runUids = ["u2"];
  presence(card, c, [], false);
  presence(card, c, ["c"], false);
  presence(card, c, ["a"], false);
  presence(card, c, ["b"], true);
  assert.deepEqual(
    resolveSources(card, ["a", "b", "c"], c).map((s) => s.runId),
    ["b", "b"],
  );
  assert.deepEqual(card.records.runUids, ["u2"]);
  card.records.runUids = ["missing"];
  presence(card, c, ["a"], false);
  card.records.sourceId = "rx:missing";
  card.records.runUids = ["u1"];
  presence(card, c, ["a"], false);
});

test("live hints invalidate both indexes while replay and older snapshots stay correct", () => {
  const c = catalog();
  const card = newChart("timeseries", ["new_y"]);
  presence(card, c, ["r1"], false);
  const hint: LiveChange = {
    kind: "metric",
    runId: "r1",
    key: "new_y",
    high: 1,
    count: 1,
    runUpdatedAt: 10,
    last: { seq: 1, step: 1, timestamp: 1, value: 1 },
  };
  const next = applyMetricHints(c, [hint]);
  presence(card, next, ["r1"], true);
  assert.equal(resolveSources(card, ["r1"], next)[0].run.updated_at, 10);
  presence(card, c, ["r1"], false);
  assert.equal(applyMetricHints(next, [hint]), next);
  presence(card, next, ["r1"], true);
});

test("replacing arrays on the same catalog invalidates membership, metadata and duplicate labels", () => {
  const c = catalog();
  const card = newChart("timeseries", ["y"]);
  presence(card, c, ["r1"], true);
  assert.equal(resolveSources(card, ["r1"], c)[0].label, "Run (r1) · y");
  c.runs = c.runs.filter((r) => r.id !== "r2");
  assert.equal(resolveSources(card, ["r1"], c)[0].label, "Run · y");
  c.runs = c.runs.map((r) => ({ ...r, name: "Renamed", updated_at: 20 }));
  assert.equal(resolveSources(card, ["r1"], c)[0].label, "Renamed (r1) · y");
  assert.equal(resolveSources(card, ["r1"], c)[0].run.updated_at, 20);
  c.series = c.series.filter((s) => s.run_id !== "r1");
  presence(card, c, ["r1"], false);
  c.series = [...c.series, series("r1", "y")];
  presence(card, c, ["r1"], true);
  c.runs = c.runs.filter((r) => r.id !== "r1");
  presence(card, c, ["r1"], false);
});

test("rx index follows source/UID metadata replacement, not just native membership", () => {
  const c = catalog();
  const card = newChart("timeseries", []);
  card.records = {
    sourceId: "rx:one",
    runUids: ["u1"],
    x: "x",
    ys: ["y"],
    filters: { any: false, conditions: [] },
  };
  presence(card, c, ["r1"], false);
  c.runs = c.runs.map((r) => ({
    ...r,
    rx: { sourceId: "rx:one", uid: "u1", state: "finished" },
  }));
  presence(card, c, ["r1"], true);
  c.runs = c.runs.map((r) => ({
    ...r,
    rx: { sourceId: "rx:two", uid: "u2", state: "finished" },
  }));
  presence(card, c, ["r1"], false);
});

test("presence and resolution share indexes across chart, selection and catalog-wrapper changes", () => {
  const c = catalog();
  let runReads = 0,
    seriesReads = 0;
  c.runs = new Proxy(c.runs, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) runReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  c.series = new Proxy(c.series, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) seriesReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  Object.freeze(c.runs);
  Object.freeze(c.series);
  const card = newChart("timeseries", ["y"]);
  assert.equal(chartHasSources(card, c, ["r1"]), true);
  assert.ok(runReads > 0 && seriesReads > 0);
  const reads = [runReads, seriesReads];
  for (let i = 0; i < 10; i++) {
    presence(card, { ...c }, ["r2"], true);
    presence(newChart("image", ["picture"]), c, ["r1"], true);
    presence(card, c, [], false);
  }
  assert.deepEqual([runReads, seriesReads], reads);
});
