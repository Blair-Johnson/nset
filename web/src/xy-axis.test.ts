import assert from "node:assert/strict";
import test from "node:test";
import { joinXY, makeXYInterpolator, type Point } from "./math.ts";
import { analyze, xQuantity } from "./analysis.ts";
import { defaults } from "./config.ts";
import { gaussianLocalLinear } from "./gaussian.ts";
import {
  cameraAxis,
  newChart,
  newWorkspace,
  resolveSources,
  validateChart,
} from "./workspace.ts";
import {
  dashboardSettings,
  withDashboardSettings,
} from "./workspace-settings.ts";
import { defaultXBinding, editorXChoices } from "./chart-editor.ts";
import type { Catalog } from "./workspace-types.ts";

const run = (id: string, experiment = "e1") =>
  ({
    id,
    experiment_id: experiment,
    name: `Run ${id}`,
    status: "finished",
    created_at: 1000,
    params: {},
  }) as unknown as Catalog["runs"][number];
const series = (run_id: string, key: string) => ({
  run_id,
  key,
  kind: "metric" as const,
  count: 3,
  last_step: 2,
  last_timestamp: 0,
  last_value: 0,
});
function catalog(): Catalog {
  return {
    experiments: [
      { id: "e1", name: "One" },
      { id: "e2", name: "Two" },
    ] as unknown as Catalog["experiments"],
    runs: [run("r1"), run("r2"), run("r3", "e2")],
    series: [
      series("r1", "loss"),
      series("r1", "data"),
      series("r2", "loss"),
      series("r2", "data"),
      series("r3", "loss"),
    ],
  };
}
const p = (step: number, value: number, seq = step): Point => ({
  seq,
  step,
  timestamp: step * 10,
  value,
});

test("joinXY pairs channels on the shared parameter over their overlap", () => {
  // X is sampled more sparsely and starts later: Y knots outside are dropped,
  // X knots inside interpolate Y. No extrapolation in either direction.
  const y: [number, number][] = [
    [0, 10],
    [1, 8],
    [2, 6],
    [3, 4],
  ];
  const x: [number, number][] = [
    [1, 100],
    [3, 300],
  ];
  assert.deepEqual(joinXY(y, x, "linear"), [
    [100, 8],
    [200, 6],
    [300, 4],
  ]);
  assert.deepEqual(joinXY(y, x, "linear", "y"), [
    [100, 8],
    [200, 6],
    [300, 4],
  ]);
  assert.deepEqual(joinXY([], x, "linear"), []);
  // Union of knots: an X knot between Y knots adds a sample.
  assert.deepEqual(
    joinXY(
      [
        [0, 0],
        [2, 2],
      ],
      [
        [0, 0],
        [1, 5],
        [2, 6],
      ],
      "linear",
    ),
    [
      [0, 0],
      [5, 1],
      [6, 2],
    ],
  );
});

test("XY interpolator reads monotonic X exactly and refuses ambiguous X", () => {
  const cumulative = makeXYInterpolator([
    [0, 4],
    [10, 2],
    [20, 1],
  ]);
  assert.equal(cumulative.monotonic, true);
  assert.equal(cumulative.at(5), 3);
  assert.equal(cumulative.at(25), null);
  assert.deepEqual(cumulative.crossings(1.5), { points: [15], plateaus: [] });
  const decreasing = makeXYInterpolator([
    [20, 1],
    [10, 2],
    [0, 4],
  ]);
  assert.equal(decreasing.at(5), 3);
  const loop = makeXYInterpolator([
    [0, 0],
    [10, 1],
    [5, 2],
  ]);
  assert.equal(loop.monotonic, false);
  assert.equal(loop.at(6), null);
  // Crossings still find every place the curve meets the level, sorted.
  assert.deepEqual(loop.crossings(1.5).points, [7.5]);
  assert.deepEqual(loop.crossings(0.5).points, [5]);
  // Repeated x keeps the later sample (duplicate-coordinate semantics).
  assert.equal(
    makeXYInterpolator([
      [0, 1],
      [0, 2],
      [1, 3],
    ]).at(0),
    2,
  );
});

test("analyze smooths independent coordinates before joining and retains raw observations", () => {
  const config = { ...defaults(), smoothing: true, smoothingSigma: 1 };
  const [trace] = analyze(
    [
      {
        run: run("r1"),
        raw: [p(0, 0), p(1, 4), p(2, 4)],
        x: { run: run("r1"), raw: [p(0, 0), p(1, 10), p(2, 20)], key: "data" },
      },
    ],
    config,
  );
  trace.points.forEach(([x], i) => assert.ok(Math.abs(x - i * 10) < 1e-12));
  assert.deepEqual(
    trace.points,
    joinXY(
      gaussianLocalLinear(
        [
          [0, 0],
          [1, 4],
          [2, 4],
        ],
        1,
      ),
      gaussianLocalLinear(
        [
          [0, 0],
          [1, 10],
          [2, 20],
        ],
        1,
      ),
      "linear",
    ),
  );
  assert.notDeepEqual(trace.points, trace.observations);
  assert.deepEqual(trace.observations, [
    [0, 0],
    [10, 4],
    [20, 4],
  ]);
  assert.ok(
    Math.abs(trace.fn.at(15)! - (trace.points[1][1] + trace.points[2][1]) / 2) <
      1e-12,
  );
  assert.deepEqual(trace.x, { key: "data" });
  assert.equal(xQuantity([trace], config), "metric");
  assert.equal(xQuantity([], config), "step");
});

test("key binding: one trace per selected run, runs lacking X are left out", () => {
  const card = newChart("timeseries", ["loss"]);
  card.x = { mode: "key", key: "data" };
  const resolved = resolveSources(
    validateChart(card),
    ["r1", "r2", "r3"],
    catalog(),
  );
  assert.deepEqual(
    resolved.map((s) => [s.runId, s.x?.ref.runId, s.x?.ref.key]),
    [
      ["r1", "r1", "data"],
      ["r2", "r2", "data"],
    ],
  );
});

test("series binding: specific series across runs and experiments", () => {
  const card = newChart("timeseries", []);
  card.source = {
    mode: "explicit",
    series: [{ runId: "r3", key: "loss", kind: "metric" }],
  };
  card.x = {
    mode: "series",
    series: { runId: "r1", key: "data", kind: "metric" },
  };
  const [only] = resolveSources(validateChart(card), ["r3"], catalog());
  assert.equal(only.runId, "r3");
  assert.equal(only.x?.ref.runId, "r1");
  assert.match(only.x!.label, /Run r1 · data/);
  // Missing X series: no half-traces.
  card.x.series.key = "missing";
  assert.deepEqual(resolveSources(card, ["r3"], catalog()), []);
  // Selected Y runs combine with a fixed X too.
  const followed = newChart("timeseries", ["loss"]);
  followed.x = {
    mode: "series",
    series: { runId: "r1", key: "data", kind: "metric" },
  };
  assert.equal(
    resolveSources(followed, ["r1", "r2", "r3"], catalog()).length,
    3,
  );
});

test("X binding validation round-trips and rejects malformed bindings", () => {
  const card = newChart("timeseries", ["loss"]);
  assert.equal(Object.hasOwn(validateChart(card), "x"), false);
  for (const x of [
    { mode: "key", key: "data" },
    { mode: "series", series: { runId: "r1", key: "data", kind: "metric" } },
  ] as const) {
    const chart = { ...card, x };
    assert.deepEqual(validateChart(JSON.parse(JSON.stringify(chart))), chart);
  }
  for (const x of [
    { mode: "key", key: "" },
    { mode: "key", key: "a", extra: 1 },
    { mode: "series", series: { runId: "r1", key: "img", kind: "image" } },
    { mode: "other" },
  ])
    assert.throws(() => validateChart({ ...card, x }));
  assert.throws(() =>
    validateChart({
      ...newChart("image", ["img"]),
      x: { mode: "key", key: "a" },
    }),
  );
});

test("camera identity changes with the X binding and join parameter", () => {
  const card = newChart("timeseries", ["loss"]);
  const plain = cameraAxis(card);
  assert.equal(plain, "step");
  card.x = { mode: "key", key: "data" };
  const keyed = cameraAxis(card);
  assert.notEqual(keyed, plain);
  card.config.axis = "timestamp";
  assert.notEqual(cameraAxis(card), keyed);
});

test("dashboard X control ignores XY charts but smoothing still applies", () => {
  const view = newWorkspace("e1", "XY", ["r1"], catalog());
  const xy = newChart("timeseries", ["loss"]);
  xy.x = { mode: "key", key: "data" };
  const timed = newChart("timeseries", ["loss"]);
  view.sections = [
    { id: "s", title: "S", collapsed: false, cards: [xy, timed] },
  ];
  assert.equal(dashboardSettings(view).axis, "step");
  const sections = withDashboardSettings(view, {
    smoothingSigma: 2,
  });
  const [nextXY, nextTimed] = sections[0].cards;
  assert.equal(nextXY.config.axis, "step");
  assert.equal(nextXY.config.smoothing, true);
  assert.equal(nextTimed.config.axis, "step");
  const changed = withDashboardSettings(view, { axis: "relative" });
  assert.equal(changed[0].cards[0].config.axis, "step");
  assert.equal(changed[0].cards[1].config.axis, "relative");
  assert.throws(
    () => withDashboardSettings(view, { axis: "relative", smoothingSigma: 2 }),
    /Mixed units/,
  );
});

test("editor X choices: keys from the Y runs, or any series; defaults avoid Y", () => {
  const card = newChart("timeseries", ["loss"]);
  const keys = editorXChoices(card, catalog(), ["r1", "r2"], "key");
  assert.deepEqual(
    keys.map((c) => c.value),
    ["data", "loss"],
  );
  assert.deepEqual(defaultXBinding(card, catalog(), ["r1", "r2"], "key"), {
    mode: "key",
    key: "data",
  });
  const all = editorXChoices(card, catalog(), [], "series");
  assert.equal(all.length, 5);
  assert.deepEqual(defaultXBinding(card, catalog(), [], "series"), {
    mode: "series",
    series: { runId: "r1", key: "data", kind: "metric" },
  });
  card.x = { mode: "key", key: "gone" };
  assert.equal(
    editorXChoices(card, catalog(), ["r1"], "key").find(
      (c) => c.value === "gone",
    )?.available,
    false,
  );
});
