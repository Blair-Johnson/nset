import assert from "node:assert/strict";
import test from "node:test";
import { gaussianLocalLinear } from "./gaussian";
import type { XY } from "./math";

function near(actual: number, expected: number, tolerance = 2e-11): void {
  assert.ok(Number.isFinite(actual));
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} != ${expected}`,
  );
}
// Deliberately independent, two-pass weighted covariance reference.
function reference(
  points: XY[],
  sigma: number,
  targets = points.map((_, i) => i),
): number[] {
  return targets.map((i) => {
    const x = points[i][0];
    const local = points
      .filter((p) => Math.abs((p[0] - x) / sigma) <= 3)
      .map(([u, y]) => ({
        d: (u - x) / sigma,
        y,
        w: Math.exp(-0.5 * ((u - x) / sigma) ** 2),
      }));
    const weight = local.reduce((s, p) => s + p.w, 0);
    const mx = local.reduce((s, p) => s + p.w * p.d, 0) / weight;
    const my = local.reduce((s, p) => s + p.w * p.y, 0) / weight;
    const variance = local.reduce((s, p) => s + p.w * (p.d - mx) ** 2, 0);
    const covariance = local.reduce(
      (s, p) => s + p.w * (p.d - mx) * (p.y - my),
      0,
    );
    return variance > 0 ? my - (covariance / variance) * mx : points[i][1];
  });
}

test("Gaussian preserves constant and affine functions including irregular-grid edges", () => {
  for (const sigma of [0.01, 1, 10, 1e9]) {
    for (const slope of [0, -2.5, 13]) {
      const points: XY[] = [-9, -8.9, -3, 0, 0.001, 2, 17].map((x) => [
        x,
        4 + slope * x,
      ]);
      const before = structuredClone(points);
      gaussianLocalLinear(points, sigma).forEach(([x, y], i) => {
        assert.equal(x, points[i][0]);
        near(y, points[i][1]);
      });
      assert.deepEqual(points, before);
    }
  }
});

test("Gaussian impulse is symmetric, centered, and uses a closed ±3 sigma cutoff", () => {
  const points: XY[] = Array.from({ length: 25 }, (_, i) => [
    i - 12,
    i === 12 ? 1 : 0,
  ]);
  const out = gaussianLocalLinear(points, 1);
  for (let i = 0; i < out.length; i++)
    near(out[i][1], out[out.length - 1 - i][1]);
  assert.ok(out[12][1] > out[11][1]);
  assert.ok(out[15][1] > 0);
  assert.equal(out[16][1], 0);
  const cutoff: XY[] = [
    [-1, 0],
    [0, 0],
    [1, 0],
    [3, 20],
    [3.000001, 1e6],
  ];
  near(
    gaussianLocalLinear(cutoff, 1)[1][1],
    reference(cutoff.slice(0, -1), 1, [1])[0],
  );
});

test("Gaussian sparse 1000-step gaps with sigma 10 are unchanged, without invented points", () => {
  const sparse: XY[] = [
    [0, 7],
    [1000, -4],
    [2000, 80],
    [3000, 0],
  ];
  assert.deepEqual(gaussianLocalLinear(sparse, 10), sparse);
  assert.deepEqual(gaussianLocalLinear([], 10), []);
  assert.deepEqual(gaussianLocalLinear([[8, 3]], 10), [[8, 3]]);
});

test("Gaussian log-coordinate invariance and invalid log-coordinate fallback", () => {
  const points: XY[] = [
    [1, 1],
    [2, 8],
    [4, -2],
    [8, 3],
    [16, 4],
  ];
  const transformed = points.map(([x, y]): XY => [Math.log2(x), y]);
  const expected = gaussianLocalLinear(transformed, 1);
  const actual = gaussianLocalLinear(points, 1, Math.log2);
  actual.forEach(([x, y], i) => {
    assert.equal(x, points[i][0]);
    near(y, expected[i][1]);
  });
  const invalid: XY[] = [[-1, 101], [0, 99], ...points];
  assert.deepEqual(
    gaussianLocalLinear(invalid, 1, Math.log2).slice(0, 2),
    invalid.slice(0, 2),
  );
  assert.deepEqual(gaussianLocalLinear(invalid, 1, Math.log2).slice(2), actual);
});

test("Gaussian supports unsorted inputs, repeated coordinates, invalid transforms and degeneracy", () => {
  const sorted: XY[] = [
    [0, 1],
    [1, 8],
    [2, -2],
    [3, 4],
  ];
  const order = [2, 0, 3, 1],
    expected = gaussianLocalLinear(sorted, 2);
  assert.deepEqual(
    gaussianLocalLinear(
      order.map((i) => sorted[i]),
      2,
    ),
    order.map((i) => expected[i]),
  );
  const repeated: XY[] = [
    [1, 1],
    [1, 7],
    [1, 3],
  ];
  assert.deepEqual(gaussianLocalLinear(repeated, 2), repeated);
  assert.deepEqual(
    gaussianLocalLinear(sorted, 2, () => NaN),
    sorted,
  );
  const duplicates: XY[] = [
    [0, 1],
    [1, 3],
    [1, 7],
    [2, 2],
  ];
  const output = gaussianLocalLinear(duplicates, 1);
  assert.equal(output.length, duplicates.length);
  near(output[1][1], output[2][1]);
  output.forEach((p, i) => near(p[1], reference(duplicates, 1)[i]));
  for (const sigma of [0, -1, NaN, Infinity])
    assert.throws(() => gaussianLocalLinear([], sigma), RangeError);
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => gaussianLocalLinear([[bad, 1]], 1), RangeError);
    assert.throws(() => gaussianLocalLinear([[1, bad]], 1), RangeError);
  }
});

test("dense-bin Gaussian weights meet the documented kernel truncation bound", () => {
  for (let i = 0; i <= 200; i++)
    for (let j = 0; j <= 100; j++) {
      const d = (3 + 1 / 8) * ((2 * i) / 200 - 1),
        z = ((2 * j) / 100 - 1) / 8;
      let previous = 1,
        coefficient = -d,
        power = z,
        approximation = 1 + coefficient * z;
      for (let k = 2; k <= 10; k++) {
        const next = (-d * coefficient - previous) / k;
        previous = coefficient;
        coefficient = next;
        power *= z;
        approximation += coefficient * power;
      }
      const exact = Math.exp(-d * z - (z * z) / 2);
      assert.ok(Math.abs(approximation / exact - 1) < 1e-12);
    }
});

test("dense moment path agrees with exact fits, including cutoff bins and very broad sigma", () => {
  // Irregular clusters force dense bins and partial-bin cutoff ranges.
  const points: XY[] = Array.from({ length: 2200 }, (_, i) => {
    const x = Math.floor(i / 400) * 2.9 + (i % 400) * 0.00007;
    return [x, Math.sin(i * 1.7) + Math.cos(x * 0.8) + 0.1 * x];
  });
  const targets = [0, 1, 17, 399, 400, 789, 800, 1200, 1700, 2198, 2199];
  for (const sigma of [0.1, 1, 2, 10, 1000]) {
    const expected = reference(points, sigma, targets),
      actual = gaussianLocalLinear(points, sigma);
    targets.forEach((i, k) => near(actual[i][1], expected[k], 2e-9));
    const affine = points.map(([x]): XY => [x, 4 - 3 * x]);
    gaussianLocalLinear(affine, sigma).forEach((p, i) =>
      near(p[1], affine[i][1], 2e-9),
    );
  }
});

test("Gaussian append recomputation equals fresh analysis and can revise earlier values", () => {
  const prefix: XY[] = [
    [0, 1],
    [1, 4],
    [2, 0],
  ];
  const old = gaussianLocalLinear(prefix, 2);
  prefix.push([3, 9]);
  const appended = gaussianLocalLinear(prefix, 2);
  assert.deepEqual(
    appended,
    gaussianLocalLinear(
      [
        [0, 1],
        [1, 4],
        [2, 0],
        [3, 9],
      ],
      2,
    ),
  );
  assert.notEqual(appended[2][1], old[2][1]);
});

test("wider dense bins agree with independent direct fits on irregular full-width bins", () => {
  const points: XY[] = Array.from({ length: 4000 }, (_, i) => [
    i * 0.013 + 0.004 * Math.sin(i * 7),
    Math.sin(i * 1.7) + Math.cos(i / 61),
  ]);
  const targets = [0, 1, 7, 58, 97, 201, 500, 1111, 2000, 3001, 3998, 3999];
  for (const sigma of [0.4, 3, 12, 1000, 1e9]) {
    const expected = reference(points, sigma, targets),
      output = gaussianLocalLinear(points, sigma);
    targets.forEach((i, k) => near(output[i][1], expected[k], 2e-10));
  }
});

test("dense-bin midpoint offsets remain accurate at very large absolute coordinates", () => {
  const points: XY[] = Array.from({ length: 1800 }, (_, i) => [
    1e16 + 2 * Math.floor(i / 30),
    Math.sin(i / 7),
  ]);
  const targets = [0, 31, 100, 411, 900, 1349, 1799];
  for (const sigma of [8, 16, 100]) {
    const actual = gaussianLocalLinear(points, sigma),
      expected = reference(points, sigma, targets);
    targets.forEach((i, k) => near(actual[i][1], expected[k], 2e-10));
  }
});

test("incremental Gaussian handles append, correction, deletion, relocation and unsorted inputs", () => {
  const original: XY[] = Array.from({ length: 900 }, (_, i) => [
    i / 3,
    Math.sin(i / 11),
  ]);
  for (const sigma of [0.1, 2, 10, 1000]) {
    const previous = gaussianLocalLinear(original, sigma);
    const variants: XY[][] = [
      [...original, [301, 7]],
      [[-1, 7], ...original],
      original.slice(1),
      original.map((p, i) => (i === 240 ? [p[0], 9] : p)),
      original.filter((_, i) => i !== 240),
      original.map((p, i) => (i === 240 ? [270.1, p[1]] : p)),
      [...original].reverse(),
      [],
    ];
    for (const next of variants) {
      const actual = gaussianLocalLinear(next, sigma, undefined, previous);
      const expected = gaussianLocalLinear(next, sigma);
      assert.deepEqual(
        actual.map((p) => p[0]),
        next.map((p) => p[0]),
      );
      actual.forEach((p, i) => near(p[1], expected[i][1], 2e-10));
    }
    const appended = gaussianLocalLinear(
      [...original, [301, 7]],
      sigma,
      undefined,
      previous,
    );
    if (sigma < 10) assert.equal(appended[0][1], previous[0][1]);
  }
});

test("incremental snapshots survive caller mutation, duplicate multiplicity, and closed-boundary changes", () => {
  const source: XY[] = [
    [0, 1],
    [1, 8],
    [1, -2],
    [2, 3],
    [3, 4],
    [20, 8],
    [21, 2],
    [22, 7],
  ];
  const previous = gaussianLocalLinear(source, 1);
  source[1][1] = 15;
  previous[1][1] = 12345;
  const variants: XY[][] = [
    source,
    source.filter((_, i) => i !== 2),
    [...source, [1, 5]],
    source.map((p) => (p[0] === 3 ? [3, 100] : p)),
    source.map((p) => (p[0] === 3 ? [3.0001, 100] : p)),
  ];
  for (const next of variants) {
    const expected = gaussianLocalLinear(next, 1);
    gaussianLocalLinear(next, 1, undefined, previous).forEach((p, i) =>
      near(p[1], expected[i][1]),
    );
  }
});

test("incremental Gaussian invalidates sigma and transform changes, including invalid logs", () => {
  const source: XY[] = [
    [-1, 9],
    [0, 8],
    [1, 1],
    [2, 7],
    [4, -3],
    [8, 4],
    [16, 2],
  ];
  const previous = gaussianLocalLinear(source, 1, Math.log2);
  for (const transform of [
    Math.log2,
    Math.log10,
    Math.asinh,
    (x: number) => x,
  ]) {
    for (const sigma of [1, 3]) {
      const next: XY[] = [...source, [32, 11]];
      const expected = gaussianLocalLinear(next, sigma, transform);
      gaussianLocalLinear(next, sigma, transform, previous).forEach((p, i) =>
        near(p[1], expected[i][1]),
      );
    }
  }
  // A foreign array is not a cache, even if it has the same shape.
  assert.deepEqual(
    gaussianLocalLinear(source, 1, undefined, source),
    gaussianLocalLinear(source, 1),
  );
});

// No CI wall-clock threshold. rx captures environment, cold and live timings.
// GAUSSIAN_BENCHMARK=1 npx tsx --test src/gaussian.test.ts
// The initial fixture/warmup exactly matches baseline r693.
test(
  "Gaussian initial and incremental timing probe",
  { skip: !process.env.GAUSSIAN_BENCHMARK },
  () => {
    console.log(
      JSON.stringify({
        kind: "environment",
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      }),
    );
    for (const n of [24000, 100000])
      for (const sigma of [1, 10, 100, 10000]) {
        const points: XY[] = Array.from({ length: n }, (_, i) => [
          i,
          Math.sin(i / 47) + 0.2 * Math.cos(i / 3),
        ]);
        gaussianLocalLinear(points.slice(0, 1000), sigma);
        let began = performance.now();
        const output = gaussianLocalLinear(points, sigma);
        console.log(
          JSON.stringify({
            kind: "gaussian_benchmark",
            mode: "initial",
            n,
            sigma,
            milliseconds: performance.now() - began,
          }),
        );
        const next: XY[] = [...points, [n, 2]];
        began = performance.now();
        const appended = gaussianLocalLinear(next, sigma, undefined, output);
        console.log(
          JSON.stringify({
            kind: "gaussian_benchmark",
            mode: "append",
            n,
            sigma,
            milliseconds: performance.now() - began,
          }),
        );
        began = performance.now();
        const unchanged = gaussianLocalLinear(next, sigma, undefined, appended);
        console.log(
          JSON.stringify({
            kind: "gaussian_benchmark",
            mode: "unchanged",
            n,
            sigma,
            milliseconds: performance.now() - began,
          }),
        );
        const fresh = gaussianLocalLinear(next, sigma);
        let maxError = 0;
        for (let i = 0; i < next.length; i++) {
          near(appended[i][1], fresh[i][1], 2e-9);
          assert.equal(unchanged[i][1], appended[i][1]);
          maxError = Math.max(maxError, Math.abs(appended[i][1] - fresh[i][1]));
        }
        console.log(
          JSON.stringify({ kind: "gaussian_accuracy", n, sigma, maxError }),
        );
      }
  },
);
