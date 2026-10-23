import test from "node:test";
import assert from "node:assert/strict";
import {
  naturalSecondDerivatives,
  splineControls,
  traceRun,
  traceRuns,
  type PathSink,
} from "./trace-path";
import type { XY } from "./math";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/** Evaluate segment i of the Bézier spline at u ∈ [0,1], with 1st/2nd derivatives. */
function bezier(p0: XY, c: [number, number, number, number], p1: XY, u: number) {
  const [c1x, c1y, c2x, c2y] = c;
  const at = (a: number, b: number, cc: number, d: number) => {
    const v = (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * b + 3 * (1 - u) * u ** 2 * cc + u ** 3 * d;
    const d1 = 3 * ((1 - u) ** 2 * (b - a) + 2 * (1 - u) * u * (cc - b) + u ** 2 * (d - cc));
    const d2 = 6 * ((1 - u) * (cc - 2 * b + a) + u * (d - 2 * cc + b));
    return [v, d1, d2];
  };
  return { x: at(p0[0], c1x, c2x, p1[0]), y: at(p0[1], c1y, c2y, p1[1]) };
}

test("natural spline: zero end curvature, exact on a straight line", () => {
  const t = [0, 1, 3, 4, 7],
    v = t.map((x) => 2 * x + 1);
  for (const m of naturalSecondDerivatives(t, v)) near(m, 0);
});

test("y(x) spline is C² across knots with uneven spacing, passes through every point", () => {
  const pts: XY[] = [[0, 0], [1, 3], [1.5, 1], [4, 2], [5, -1], [8, 0.5]];
  const c = splineControls(pts, "x");
  assert.equal(c.length, pts.length - 1);
  for (let i = 0; i < c.length; i++) {
    const start = bezier(pts[i], c[i], pts[i + 1], 0).y[0];
    const end = bezier(pts[i], c[i], pts[i + 1], 1).y[0];
    near(start, pts[i][1]);
    near(end, pts[i + 1][1]);
  }
  // dy/dx and d²y/dx² agree on both sides of each interior knot.
  for (let i = 1; i < c.length; i++) {
    const hL = pts[i][0] - pts[i - 1][0],
      hR = pts[i + 1][0] - pts[i][0];
    const left = bezier(pts[i - 1], c[i - 1], pts[i], 1).y,
      right = bezier(pts[i], c[i], pts[i + 1], 0).y;
    near(left[1] / hL, right[1] / hR, 1e-9);
    near(left[2] / hL ** 2, right[2] / hR ** 2, 1e-9);
  }
});

test("y(x) spline stays a function of x: control x's lie inside each segment", () => {
  const pts: XY[] = [[0, 0], [0.1, 5], [3, -2], [3.2, 4], [9, 0]];
  splineControls(pts, "x").forEach(([c1x, , c2x], i) => {
    assert.ok(c1x > pts[i][0] && c1x < pts[i + 1][0]);
    assert.ok(c2x > pts[i][0] && c2x < pts[i + 1][0]);
  });
});

test("chord spline handles XY traces that double back", () => {
  const loop: XY[] = [[0, 0], [2, 1], [1, 2], [-1, 1], [0, 0.2]];
  const c = splineControls(loop, "chord");
  assert.equal(c.length, 4);
  for (const v of c.flat()) assert.ok(Number.isFinite(v));
});

test("traceRun draws one Bézier per gap for splines, steps hold correctly", () => {
  const calls: string[] = [];
  const sink: PathSink = {
    moveTo: (x, y) => calls.push(`M${x},${y}`),
    lineTo: (x, y) => calls.push(`L${x},${y}`),
    bezierCurveTo: (_a, _b, _c, _d, x, y) => calls.push(`C${x},${y}`),
  };
  traceRun(sink, [[0, 0], [10, 10], [20, 0], [30, 10]], "spline", "x");
  assert.deepEqual(calls, ["M0,0", "C10,10", "C20,0", "C30,10"]);
  calls.length = 0;
  traceRun(sink, [[0, 0], [1, 1]], "stepped-after", "x");
  assert.deepEqual(calls, ["M0,0", "L1,0", "L1,1"]);
  calls.length = 0;
  traceRun(sink, [[0, 0], [1, 1]], "stepped-before", "x");
  assert.deepEqual(calls, ["M0,0", "L0,1", "L1,1"]);
  // Duplicate and sub-pixel knots are thinned: no NaN, endpoints kept.
  calls.length = 0;
  traceRun(sink, [[0, 0], [0, 0], [0.5, 3], [10, 10], [20, 0], [20.4, 1]], "spline", "x");
  assert.ok(calls.every((c) => !c.includes("NaN")));
  assert.equal(calls[0], "M0,0");
  assert.equal(calls.at(-1), "C20.4,1");
});
test("centripetal XY spline does not loop at a sharp spike", () => {
  // Up-and-back spike: chord-length knots would overshoot into a loop.
  const spike: XY[] = [[0, 100], [10, 100], [11, 20], [12, 100], [22, 100]];
  const c = splineControls(spike, "chord");
  // Control points around the spike stay within a modest band of it.
  for (const [c1x, , c2x] of c) {
    assert.ok(c1x > -5 && c1x < 27);
    assert.ok(c2x > -5 && c2x < 27);
  }
});

test("traceRuns breaks lines at invalid samples", () => {
  const runs = traceRuns(
    [[1, 1], [2, -1], [3, 2], [4, 3]],
    (_x, y) => y > 0,
  );
  assert.deepEqual(runs, [[[1, 1]], [[3, 2], [4, 3]]]);
});
