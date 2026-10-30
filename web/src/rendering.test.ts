import test from "node:test";
import assert from "node:assert/strict";
import { makeInterpolator, type XY } from "./math";
import {
  tessellate,
  type RenderBounds,
  type TessellationOptions,
} from "./rendering";

type Project = (x: number, y: number) => XY;
const identity: Project = (x, y) => [x, y];
const linear = (points: XY[]) => makeInterpolator(points, "linear").at;
const all = (segments: XY[][]) => segments.flat();
const near = (actual: number, expected: number, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );

function projector(
  b: RenderBounds,
  fx: (x: number) => number,
  fy: (y: number) => number,
  width = 800,
  height = 600,
  reverse = false,
): Project {
  return (x, y) => {
    const px = (fx(x) - fx(b.xMin)) / (fx(b.xMax) - fx(b.xMin));
    const py = (fy(y) - fy(b.yMin)) / (fy(b.yMax) - fy(b.yMin));
    return [width * (reverse ? 1 - px : px), height * (reverse ? py : 1 - py)];
  };
}

function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy),
    ),
  );
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

// Dense OFF-VERTEX checks per returned edge, including non-dyadic locations.
// Perpendicular pixel error is the helper's stated metric, not y-only error.
function checkError(
  segments: XY[][],
  at: (x: number) => number | null,
  project: Project,
  tolerance = 0.35,
) {
  let worst = 0;
  for (const segment of segments)
    for (let i = 1; i < segment.length; i++) {
      const a = segment[i - 1],
        b = segment[i];
      for (let j = 1; j < 80; j++) {
        const x = a[0] + ((b[0] - a[0]) * j) / 80;
        const y = at(x);
        assert.notEqual(y, null);
        worst = Math.max(
          worst,
          segmentDistance(project(x, y!), project(...a), project(...b)),
        );
      }
    }
  assert.ok(
    worst <= tolerance * 1.05,
    `off-vertex pixel error ${worst} exceeds ${tolerance}`,
  );
}

const id = (x: number) => x;

test("log y keeps numerical midpoint 50.5, not endpoint-chord value 10", () => {
  const points: XY[] = [
    [0, 1],
    [1, 100],
  ];
  const at = linear(points),
    bounds = { xMin: 0, xMax: 1, yMin: 1, yMax: 100 };
  const project = projector(bounds, id, Math.log10);
  const result = tessellate(points, at, project, bounds);
  assert.equal(result.limited, false);
  assert.ok(all(result.segments).some(([x, y]) => x === 0.5 && y === 50.5));
  assert.equal(at(0.5), 50.5);
  assert.notEqual(at(0.5), 10);
  checkError(result.segments, at, project);
});

test("log x keeps original-domain affine interpolation", () => {
  const points: XY[] = [
      [1, 0],
      [100, 1],
    ],
    at = linear(points);
  const bounds = { xMin: 1, xMax: 100, yMin: 0, yMax: 1 };
  const project = projector(bounds, Math.log10, id);
  const result = tessellate(points, at, project, bounds);
  near(at(10)!, 9 / 99);
  assert.equal(result.limited, false);
  assert.ok(all(result.segments).length > 2);
  checkError(result.segments, at, project);
});

test("quarter probes detect a symmetric asinh S whose midpoint is on the chord", () => {
  const points: XY[] = [
      [-100, -100],
      [100, 100],
    ],
    at = linear(points);
  const bounds = { xMin: -100, xMax: 100, yMin: -100, yMax: 100 };
  const project = projector(bounds, id, Math.asinh);
  near(
    segmentDistance(
      project(0, 0),
      project(...points[0]),
      project(...points[1]),
    ),
    0,
  );
  const result = tessellate(points, at, project, bounds);
  assert.equal(result.limited, false);
  assert.ok(all(result.segments).length > 4);
  checkError(result.segments, at, project);
});

for (const kind of ["linear", "pchip"] as const) {
  test(`${kind}: nonlinear x/y, resize, reverse, log bases and asinh thresholds`, () => {
    const points: XY[] = [
      [0.01, -900],
      [0.04, -20],
      [2, 0],
      [9, 300],
      [100, 1000],
    ];
    const fn = makeInterpolator(points, kind);
    const bounds = { xMin: 0.01, xMax: 100, yMin: -900, yMax: 1000 };
    const queries = [0.01, 0.025, 0.15, 1, 8, 73, 100];
    const before = queries.map(fn.at);
    const snapshot = JSON.stringify(points);
    for (const width of [240, 1600])
      for (const reverse of [false, true])
        for (const log of [Math.log2, Math.log10])
          for (const threshold of [0.1, 10, 200]) {
            const project = projector(
              bounds,
              log,
              (y) => Math.asinh(y / threshold),
              width,
              width * 0.7,
              reverse,
            );
            const result = tessellate(points, fn.at, project, bounds);
            assert.equal(result.limited, false);
            for (const p of points)
              assert.ok(
                all(result.segments).some(
                  (q) => q[0] === p[0] && q[1] === p[1],
                ),
              );
            checkError(result.segments, fn.at, project);
          }
    assert.deepEqual(queries.map(fn.at), before);
    assert.equal(JSON.stringify(points), snapshot);
  });
}

test("PCHIP on extreme positive ranges with both axes logarithmic", () => {
  const points: XY[] = [
    [0.001, 1e-6],
    [0.1, 1e-3],
    [1, 10],
    [20, 1e6],
  ];
  const fn = makeInterpolator(points, "pchip");
  const bounds = { xMin: 0.001, xMax: 20, yMin: 1e-6, yMax: 1e6 };
  const project = projector(bounds, Math.log, Math.log);
  const result = tessellate(points, fn.at, project, bounds);
  assert.equal(result.limited, false);
  checkError(result.segments, fn.at, project);
});

test("adding unrelated sampling knots never determines another curve approximation", () => {
  const points: XY[] = [
      [0, 1],
      [1, 100],
    ],
    at = linear(points);
  const bounds = { xMin: 0, xMax: 1, yMin: 1, yMax: 100 };
  const project = projector(bounds, id, Math.log10, 1200, 900);
  const baseline = tessellate(points, at, project, bounds);
  // Even if a caller supplies extra comparison-grid locations, both results
  // must independently meet the tolerance; identical vertices are not required.
  const grid = [0, 0.003, 0.02, 0.47, 0.71, 0.999, 1].map(
    (x) => [x, at(x)!] as XY,
  );
  const extra = tessellate(grid, at, project, bounds);
  checkError(baseline.segments, at, project);
  checkError(extra.segments, at, project);
  assert.deepEqual(tessellate(points, at, project, bounds), baseline);
});

test("clips exact x and y boundary intersections before any log projection", () => {
  const points: XY[] = [
      [-2, -2],
      [2, 2],
    ],
    at = linear(points);
  const bounds = { xMin: 0.25, xMax: 1.75, yMin: 0.5, yMax: 1.5 };
  const project: Project = (x, y) => {
    assert.ok(x >= 0.25 && x <= 1.75 && y >= 0.5 && y <= 1.5);
    return [Math.log(x) * 100, Math.log(y) * 100];
  };
  const result = tessellate(points, at, project, bounds);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].length, 2);
  near(result.segments[0][0][0], 0.5);
  near(result.segments[0][1][0], 1.5);
  assert.equal(result.segments[0][0][1], 0.5);
  assert.equal(result.segments[0][1][1], 1.5);
  const clippedX = tessellate(points, at, identity, {
    ...bounds,
    yMin: -3,
    yMax: 3,
  });
  assert.deepEqual(clippedX.segments, [
    [
      [0.25, 0.25],
      [1.75, 1.75],
    ],
  ]);
});

test("PCHIP y clipping searches original function, not endpoint linear chord", () => {
  const points: XY[] = [
    [0, 0],
    [1, 1],
    [2, 10],
  ];
  const fn = makeInterpolator(points, "pchip");
  const bounds = { xMin: 0, xMax: 2, yMin: 0.2, yMax: 5 };
  const result = tessellate(points, fn.at, identity, bounds);
  const vertices = all(result.segments),
    first = vertices[0],
    last = vertices.at(-1)!;
  assert.equal(first[1], 0.2);
  assert.equal(last[1], 5);
  // Clip vertices are geometric approximations, not new evaluator samples.
  near(first[0], fn.crossings(0.2).points[0], 0.035);
  near(last[0], fn.crossings(5).points[0], 0.035);
  assert.ok(vertices.some(([x, y]) => x === 1 && y === 1));
});

test("descending spans and invisible excursions produce separate paths, not bridges", () => {
  const points: XY[] = [
    [0, 2],
    [1, -2],
    [2, 2],
    [3, 4],
    [4, 2],
  ];
  const bounds = { xMin: 0, xMax: 4, yMin: 1, yMax: 3 };
  const result = tessellate(points, linear(points), identity, bounds);
  assert.deepEqual(result.segments, [
    [
      [0, 2],
      [0.25, 1],
    ],
    [
      [1.75, 1],
      [2, 2],
      [2.5, 3],
    ],
    [
      [3.5, 3],
      [4, 2],
    ],
  ]);
  assert.equal(result.limited, false);
});

test("null or nonfinite samples break paths but retain visible original knots", () => {
  const points: XY[] = [
    [0, 1],
    [1, 1],
    [2, 1],
  ];
  const bounds = { xMin: 0, xMax: 2, yMin: 0, yMax: 2 };
  for (const invalid of [null, NaN, Infinity]) {
    const at = (x: number) => (x > 0 && x < 1 ? invalid : 1);
    const result = tessellate(points, at, identity, bounds);
    assert.deepEqual(result.segments, [
      [[0, 1]],
      [
        [1, 1],
        [2, 1],
      ],
    ]);
    assert.equal(result.limited, true);
  }
});

test("budget/depth exhaustion reported without losing raw knots or clip boundaries", () => {
  const points: XY[] = [
    [0, 1],
    [1, 100],
    [2, 1],
    [3, 100],
    [4, 1],
  ];
  const at = linear(points),
    bounds = { xMin: 0.2, xMax: 3.8, yMin: 1, yMax: 100 };
  const project = projector(bounds, id, Math.log);
  for (const options of [
    { maxExtraPoints: 0 },
    { maxDepth: 0 },
    { maxExtraPoints: 3 },
  ]) {
    const result = tessellate(points, at, project, bounds, options);
    const vertices = all(result.segments);
    assert.equal(result.limited, true);
    for (const p of points.slice(1, -1))
      assert.ok(vertices.some((q) => q[0] === p[0] && q[1] === p[1]));
    assert.equal(vertices[0][0], bounds.xMin);
    assert.equal(vertices.at(-1)![0], bounds.xMax);
    assert.ok(vertices.length <= 5 + (options.maxExtraPoints ?? 0));
  }
});

test("zero budget does not mark a genuinely straight screen-space line limited", () => {
  const points: XY[] = [
    [0, 0],
    [1, 1],
    [2, 0],
  ];
  assert.deepEqual(
    tessellate(
      points,
      linear(points),
      identity,
      { xMin: 0, xMax: 2, yMin: 0, yMax: 1 },
      { maxExtraPoints: 0 },
    ),
    { segments: [points], limited: false },
  );
});

test("empty, singleton, invisible, plateau, boundary knot and touching viewport cases", () => {
  const bounds = { xMin: 0, xMax: 2, yMin: 1, yMax: 3 };
  for (const points of [[], [[-1, 2]], [[1, 0]], [[3, 2]]] as XY[][])
    assert.deepEqual(tessellate(points, linear(points), identity, bounds), {
      segments: [],
      limited: false,
    });
  for (const points of [
    [[1, 2]],
    [
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  ] as XY[][])
    assert.deepEqual(
      tessellate(points, linear(points), identity, bounds).segments,
      [points],
    );
  const tangent: XY[] = [
    [-1, 0],
    [1, 1],
    [3, 0],
  ];
  assert.deepEqual(
    tessellate(tangent, linear(tangent), identity, bounds).segments,
    [[[1, 1]]],
  );
  const atEdge: XY[] = [
    [-1, 2],
    [0, 2],
  ];
  assert.deepEqual(
    tessellate(atEdge, linear(atEdge), identity, bounds).segments,
    [[[0, 2]]],
  );
});

test("zoomed calls do not evaluate off-viewport x or mutate frozen inputs", () => {
  const points = Array.from({ length: 1001 }, (_, x) =>
    Object.freeze([x, x + 1]),
  ) as unknown as XY[];
  Object.freeze(points);
  const at = (x: number) => {
    assert.ok(x >= 499.2 && x <= 501.8);
    return x + 1;
  };
  const bounds = { xMin: 499.2, xMax: 501.8, yMin: 499, yMax: 504 };
  const result = tessellate(points, at, identity, bounds);
  assert.deepEqual(result.segments, [
    [
      [499.2, 500.2],
      [500, 501],
      [501, 502],
      [501.8, 502.8],
    ],
  ]);
});

test("rejects invalid input rather than inventing positive coordinates", () => {
  const points: XY[] = [
      [0, 1],
      [1, 2],
    ],
    at = linear(points);
  const bounds = { xMin: 0, xMax: 1, yMin: 1, yMax: 2 };
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => tessellate([[bad, 1]], at, identity, bounds),
      RangeError,
    );
    assert.throws(
      () => tessellate(points, at, identity, { ...bounds, yMin: bad }),
      RangeError,
    );
    assert.throws(
      () => tessellate(points, at, identity, bounds, { tolerance: bad }),
      RangeError,
    );
    assert.throws(
      () => tessellate(points, at, () => [0, bad], bounds),
      RangeError,
    );
  }
  for (const bad of [0, -1])
    assert.throws(() =>
      tessellate(points, at, identity, bounds, { tolerance: bad }),
    );
  for (const options of [
    { maxDepth: -1 },
    { maxDepth: 53 },
    { maxDepth: 0.5 },
    { maxExtraPoints: 200001 },
    { maxExtraPoints: -1 },
    { maxExtraPoints: 1.5 },
  ] as TessellationOptions[])
    assert.throws(
      () => tessellate(points, at, identity, bounds, options),
      RangeError,
    );
  assert.throws(
    () =>
      tessellate(
        [
          [1, 1],
          [1, 2],
        ],
        at,
        identity,
        bounds,
      ),
    RangeError,
  );
  assert.throws(
    () =>
      tessellate(
        [
          [1, 1],
          [0, 2],
        ],
        at,
        identity,
        bounds,
      ),
    RangeError,
  );
  assert.throws(
    () => tessellate(points, at, identity, { ...bounds, xMax: 0 }),
    RangeError,
  );
  const excluded: XY[] = [
    [0, -2],
    [1, -1],
  ];
  assert.deepEqual(
    tessellate(
      excluded,
      linear(excluded),
      () => {
        throw Error("must not project excluded data");
      },
      bounds,
    ).segments,
    [],
  );
});

test("unrepresentable crossings yield bounded clip geometry, never new numerical log samples", () => {
  const points: XY[] = [
    [1, -1],
    [1 + Number.EPSILON, 1],
  ];
  const bounds = { xMin: 1, xMax: 2, yMin: 0.1, yMax: 2 };
  const at = linear(points),
    before = points.map(([x]) => at(x));
  const result = tessellate(
    points,
    at,
    (x, y) => {
      assert.ok(y >= bounds.yMin && y <= bounds.yMax);
      return [x, Math.log(y)];
    },
    bounds,
  );
  assert.equal(result.limited, false);
  assert.deepEqual(result.segments, [
    [
      [1 + Number.EPSILON, 0.1],
      [1 + Number.EPSILON, 1],
    ],
  ]);
  // The clip vertex is ONLY geometry. The evaluator still reports the raw 1,
  // and the nonpositive endpoint has never become a positive observation.
  assert.equal(at(result.segments[0][0][0]), 1);
  assert.deepEqual(
    points.map(([x]) => at(x)),
    before,
  );
  assert.equal(at(1), -1);

  // If those adjacent x values span the screen, no small-error geometric
  // approximation is justified; preserve the original conservative fallback.
  const zoom = { ...bounds, xMax: points[1][0] };
  const unresolved = tessellate(
    points,
    at,
    projector(zoom, id, Math.log),
    zoom,
  );
  assert.equal(unresolved.limited, true);
  assert.deepEqual(unresolved.segments, [[[1 + Number.EPSILON, 1]]]);
});

test("zero adaptive budget still retains a large raw series without thinning", () => {
  const points: XY[] = Array.from({ length: 10001 }, (_, x) => [
    x,
    x % 2 ? 100 : 1,
  ]);
  const bounds = { xMin: 0, xMax: 10000, yMin: 1, yMax: 100 };
  const project = projector(bounds, id, Math.log, 100000, 600);
  const result = tessellate(points, linear(points), project, bounds, {
    maxExtraPoints: 0,
  });
  assert.equal(result.limited, true);
  assert.deepEqual(result.segments, [points]);
});

test("unsmoothed steep affine spans survive log-x clipping with bounded work and reversed axes", () => {
  for (const base of [1e3, 1e6])
    for (const dx of [base * Number.EPSILON * 8, 1e-5])
      for (const direction of [-1, 1])
        for (const reverse of [false, true]) {
          const points: XY[] = [
            [base, -direction * 1e12],
            [base + dx, direction * 1e12],
          ];
          const at = linear(points),
            snapshot = JSON.stringify(points);
          const queries = [base, base + dx / 2, base + dx],
            before = queries.map(at);
          const bounds = { xMin: 1, xMax: 1e9, yMin: -3, yMax: 7 };
          const project = projector(bounds, Math.log10, id, 1600, 900, reverse);
          let evaluations = 0;
          const result = tessellate(
            points,
            (x) => {
              evaluations++;
              return at(x);
            },
            project,
            bounds,
          );
          assert.equal(result.limited, false);
          assert.equal(result.segments.length, 1);
          const segment = result.segments[0];
          assert.ok(segment.length >= 2);
          assert.equal(
            segment[0][1],
            direction > 0 ? bounds.yMin : bounds.yMax,
          );
          assert.equal(
            segment.at(-1)![1],
            direction > 0 ? bounds.yMax : bounds.yMin,
          );
          assert.ok(
            evaluations <= 140,
            `unexpected boundary work: ${evaluations}`,
          );
          assert.ok(
            segment.every(
              ([x, y]) => x >= base && x <= base + dx && y >= -3 && y <= 7,
            ),
          );
          // Analytic continuous affine geometry, NOT new numerical observations:
          // discrete representable x samples can miss most of this visible arc.
          for (let j = 0; j <= 20; j++) {
            const y = -3 + j / 2;
            const x =
              base +
              (points[1][0] - base) *
                ((y - points[0][1]) / (points[1][1] - points[0][1]));
            const p = project(x, y);
            assert.ok(
              Math.min(
                ...segment
                  .slice(1)
                  .map((b, i) =>
                    segmentDistance(p, project(...segment[i]), project(...b)),
                  ),
              ) <= 0.35,
            );
          }
          assert.deepEqual(queries.map(at), before);
          assert.equal(JSON.stringify(points), snapshot);
        }
});

test("steep log-x spans retain an actual x-viewport intersection as well as the y clip", () => {
  const base = 1e6,
    dx = 1e-5;
  const points: XY[] = [
      [base - dx, -1e12],
      [base + dx, 1e12],
    ],
    at = linear(points);
  const bounds = { xMin: base, xMax: 1e9, yMin: -3, yMax: 7 };
  const result = tessellate(
    points,
    at,
    projector(bounds, Math.log10, id),
    bounds,
  );
  assert.equal(result.limited, false);
  assert.equal(result.segments.length, 1);
  assert.deepEqual(result.segments[0][0], [base, at(base)]);
  assert.equal(result.segments[0].at(-1)![1], 7);
});

test("overlapping subpixel clip brackets retain an arc with no representable visible sample", () => {
  const points: XY[] = [
      [1e6, -1e12],
      [1e6 + 1e-9, 1e12],
    ],
    at = linear(points);
  const bounds = { xMin: 1, xMax: 1e9, yMin: 1, yMax: 2 };
  const result = tessellate(
    points,
    at,
    projector(bounds, Math.log10, Math.log10),
    bounds,
  );
  assert.equal(result.limited, false);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].length, 2);
  assert.equal(result.segments[0][0][1], 1);
  assert.equal(result.segments[0][1][1], 2);
  assert.equal(result.segments[0][0][0], result.segments[0][1][0]);
  assert.ok(result.segments[0].every(([x, y]) => at(x) !== y));
});

test("boundary search work stays bounded across subnormal-to-huge log-x decades", () => {
  const points: XY[] = [
    [Number.MIN_VALUE, Math.log10(Number.MIN_VALUE)],
    [1e300, 300],
  ];
  const bounds = {
    xMin: Number.MIN_VALUE,
    xMax: 1e300,
    yMin: -290.123,
    yMax: 280.456,
  };
  for (const reverse of [false, true]) {
    let evaluations = 0,
      projections = 0;
    const rawProject = projector(bounds, Math.log10, id, 800, 600, reverse);
    const project: Project = (x, y) => {
      projections++;
      return rawProject(x, y);
    };
    const result = tessellate(
      points,
      (x) => {
        evaluations++;
        return Math.log10(x);
      },
      project,
      bounds,
    );
    assert.equal(result.limited, false);
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0][0][1], bounds.yMin);
    assert.equal(result.segments[0].at(-1)![1], bounds.yMax);
    assert.ok(evaluations <= 140, `unexpected boundary work: ${evaluations}`);
    assert.ok(projections <= 300, `unexpected projection work: ${projections}`);
    checkError(result.segments, Math.log10, project);
  }
});

test("wholly offscreen x data causes no evaluator or projection calls", () => {
  const bounds = { xMin: 10, xMax: 20, yMin: 1, yMax: 2 };
  const forbidden = (): never =>
    assert.fail("offscreen span must not be evaluated/projected");
  for (const points of [
    [
      [1, -1],
      [2, 3],
    ],
    [
      [30, -1],
      [40, 3],
    ],
  ] as XY[][])
    assert.deepEqual(tessellate(points, forbidden, forbidden, bounds), {
      segments: [],
      limited: false,
    });
});

test("a null boundary probe still breaks a narrow continuous-span candidate", () => {
  const points: XY[] = [
    [1e6, -1e12],
    [1e6 + 1e-5, 1e12],
  ];
  const bounds = { xMin: 1, xMax: 1e9, yMin: 1, yMax: 2 };
  const result = tessellate(
    points,
    () => null,
    projector(bounds, Math.log10, Math.log10),
    bounds,
  );
  assert.equal(result.limited, true);
  assert.deepEqual(result.segments, []);
});
