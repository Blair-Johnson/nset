import test from "node:test";
import assert from "node:assert/strict";
import { CrossingPath, crossingNeighbors, nearestCrossingRuns, plottedSeries } from "./crossings";
import { traceRun, type TraceKind } from "./trace-path";
import { defaults } from "./config";
import { makeInterpolator, type XY } from "./math";
import type { Analyzed } from "./analysis";

function path(points: XY[], kind: TraceKind = "linear") {
  const p = new CrossingPath();
  traceRun(p, points, kind, "chord");
  return p;
}
const neighbors = (p: CrossingPath, axis: "x" | "y", fixed: number, mouse: number, bounds: XY = [-100, 100]) =>
  crossingNeighbors(p.crossings(axis, fixed, mouse, bounds), mouse);

test("vertical/horizontal loop crossings preserve parameter order and repeated X", () => {
  const p = path([[0, 0], [10, 10], [0, 10], [10, 0], [0, 0]]);
  assert.deepEqual(neighbors(p, "x", 2, 5), [2, 8]);
  assert.deepEqual(neighbors(p, "y", 2, 5), [2, 8]);
  assert.deepEqual(neighbors(p, "x", 2, 9), [8, 10]);
  assert.deepEqual(neighbors(p, "x", 2, 20), [10]);
  assert.deepEqual(neighbors(p, "y", 2, -1), [2]);
  assert.deepEqual(neighbors(p, "x", 2, 2), [2]);
});
test("shared and duplicate vertices collapse; no extrapolation or offscreen roots", () => {
  const p = path([[0, 0], [5, 5], [5, 5], [10, 0]]);
  assert.deepEqual(neighbors(p, "x", 5, 10), [5]);
  assert.deepEqual(neighbors(p, "y", 5, 0), [5]);
  assert.deepEqual(neighbors(p, "x", 11, 0), []);
  assert.deepEqual(neighbors(p, "x", 5, 0, [0, 4]), []);
});
test("coincident segments, vertical repeated X and step edges return the nearest finite point", () => {
  const p = path([[2, 0], [2, 10], [2, 10]]);
  assert.deepEqual(neighbors(p, "x", 2, 6), [6]);
  assert.deepEqual(neighbors(p, "x", 2, 12), [10]);
  assert.deepEqual(neighbors(p, "x", 2, -4, [3, 7]), [3]);
  for (const kind of ["stepped-after", "stepped-before"] as const) {
    const step = path([[0, 0], [10, 10]], kind);
    assert.deepEqual(neighbors(step, "y", 5, 2), [kind === "stepped-after" ? 10 : 0]);
    assert.deepEqual(neighbors(step, "x", 5, 3), [kind === "stepped-after" ? 0 : 10]);
  }
});
test("cubic tangencies and multiple roots are solved, not coarse sampled", () => {
  const p = new CrossingPath();
  p.moveTo(0, 0);
  p.bezierCurveTo(1 / 3, 1, 2 / 3, 1, 1, 0);
  assert.ok(Math.abs(neighbors(p, "y", 0.75, 0)[0] - 0.5) < 1e-9);
  const pair = neighbors(p, "y", 0.5, 0.5);
  assert.equal(pair.length, 2);
  assert.ok(Math.abs(pair[0] - (1 - Math.sqrt(1 / 3)) / 2) < 1e-9);
  assert.ok(Math.abs(pair[1] - (1 + Math.sqrt(1 / 3)) / 2) < 1e-9);
  assert.deepEqual(neighbors(p, "y", 0.8, 0.5), []);
  const q = new CrossingPath();
  q.moveTo(0, 0);
  q.bezierCurveTo(2, 1 / 3, -1, 2 / 3, 1, 1);
  assert.equal(q.crossings("x", 0.5, 0.5, [0, 1]).length, 3);
  assert.ok(Math.abs(neighbors(q, "x", 0.5, 0.5)[0] - 0.5) < 1e-12);
});
test("natural splines reuse the drawn controls; invalid geometry never produces a root", () => {
  const p = path([[0, 0], [5, 10], [10, 0]], "spline");
  const roots = neighbors(p, "y", 8, 5);
  assert.equal(roots.length, 2);
  assert.ok(roots[0] < 5 && roots[1] > 5);
  assert.deepEqual(neighbors(path([[0, NaN], [2, Infinity]]), "x", 1, 0), []);
});
test("nearest four RUNS aggregate metrics/groups, keep equal-name IDs and stable ties", () => {
  const rows = [90, 10, 20, 30, 40, 50, 11].map((p, index) => ({ index, positions: [p] }));
  const identity = (index: number) => index === 6 ? "run1" : `run${index}`;
  assert.deepEqual(nearestCrossingRuns(rows, identity, 12).map((p) => p.index), [6, 2, 3, 4]);
  assert.deepEqual(nearestCrossingRuns(rows, identity, 89).map((p) => p.index), [0, 5, 4, 3]);
  const ties = [{ index: 1, positions: [4] }, { index: 0, positions: [6] }];
  assert.deepEqual(nearestCrossingRuns(ties, identity, 5).map((p) => p.index), [0, 1]);
  assert.deepEqual(nearestCrossingRuns(ties.reverse(), identity, 5).map((p) => p.index), [0, 1]);
  const grouped = nearestCrossingRuns([{ index: 1, positions: [1, 9] }, { index: 6, positions: [4, 6] }], identity, 5);
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].positions, [4, 6]);
});
test("distance ranking uses displayed log/reversed coordinates, not raw values", () => {
  const values = [2, 1000];
  const rows = values.map((v, index) => ({ index, positions: [Math.log10(v)] }));
  // Raw distance from 100 prefers 2; on log display 1000 is closer.
  assert.equal(nearestCrossingRuns(rows, String, Math.log10(100))[0].index, 1);
  assert.equal(nearestCrossingRuns(rows.map((r) => ({ ...r, positions: r.positions.map((p) => -p) })), String, -2)[0].index, 1);
});
test("legend eligibility excludes empty, invalid, log-excluded and invisible geometry but retains markers", () => {
  const config = defaults();
  const d = (points: XY[], observations = points) => ({ run: { id: "r" }, points, observations, fn: makeInterpolator([...new Map(points.filter((p) => p.every(Number.isFinite)))].sort((a, b) => a[0] - b[0]), "linear") } as Analyzed);
  assert.equal(plottedSeries(d([]), config, 0), false);
  assert.equal(plottedSeries(d([[NaN, 2], [2, Infinity]]), config, 0), false);
  config.xScale = "log";
  assert.equal(plottedSeries(d([[-2, 1], [-1, 2]]), config, 0), false);
  config.xScale = "linear";
  config.yScale = "log";
  assert.equal(plottedSeries(d([[1, -2], [2, 0]]), config, 0), false);
  config.yScale = "linear";
  assert.equal(plottedSeries(d([[1, 2], [1, 2]]), config, 0), false);
  config.style.width = 0;
  config.style.fill = 0;
  config.style.points = false;
  assert.equal(plottedSeries(d([[1, 2], [2, 3]]), config, 0), false);
  assert.equal(plottedSeries(d([[1, 2]]), config, 0), true); // Automatic singleton.
  config.style.points = true;
  assert.equal(plottedSeries(d([[1, 2], [2, 3]]), config, 0), true);
  config.style.pointSize = 0;
  assert.equal(plottedSeries(d([[1, 2], [2, 3]]), config, 0), false);
  config.style.pointSize = 4;
  config.style.alpha = 0;
  assert.equal(plottedSeries(d([[1, 2], [2, 3]]), config, 0), false);
});


test("distinct-run popup keeps nearest-series identity while combining crossings", () => {
  const rows = [{ index: 0, positions: [10, 90] }, { index: 1, positions: [45, 55] }];
  const identity = () => "same-run";
  assert.equal(nearestCrossingRuns(rows, identity, 50)[0].index, 1);
  assert.deepEqual(nearestCrossingRuns(rows, identity, 50)[0].positions, [45, 55]);
  assert.equal(nearestCrossingRuns(rows, identity, 11)[0].index, 0);
  const ties = [{ index: 1, positions: [40] }, { index: 0, positions: [60] }];
  assert.equal(nearestCrossingRuns(ties, identity, 50)[0].index, 0);
  assert.deepEqual(rows[0].positions, [10, 90]);
});
