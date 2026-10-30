import test, { after } from "node:test";
import assert from "node:assert/strict";
import uPlot from "uplot";
import { matchedPath, type MatchedPathOptions } from "./matched-path";
import { makeInterpolator, type XY } from "./math";
import { tessellate } from "./rendering";

class MockPath {
  commands: { kind: string; args: number[] }[] = [];
  moveTo(...args: number[]) {
    this.commands.push({ kind: "M", args });
  }
  lineTo(...args: number[]) {
    this.commands.push({ kind: "L", args });
  }
  rect(...args: number[]) {
    this.commands.push({ kind: "R", args });
  }
  closePath() {
    this.commands.push({ kind: "Z", args: [] });
  }
}
const pathDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Path2D");
Object.defineProperty(globalThis, "Path2D", {
  configurable: true,
  writable: true,
  value: MockPath,
});
after(() => {
  if (pathDescriptor)
    Object.defineProperty(globalThis, "Path2D", pathDescriptor);
  else Reflect.deleteProperty(globalThis, "Path2D");
});

type Scale = { min: number; max: number; distr: number; dir: number };
function plot(
  xMin = 0,
  xMax = 1,
  yMin = 0,
  yMax = 100,
  xDistr = 1,
  yDistr = 1,
) {
  const scales: Record<string, Scale> = {
    x: { min: xMin, max: xMax, distr: xDistr, dir: 1 },
    y: { min: yMin, max: yMax, distr: yDistr, dir: 1 },
  };
  const bbox = { left: 17, top: 29, width: 800, height: 600 };
  const data = [
    [xMin, xMax],
    [yMin, yMax],
  ];
  const calls: [number, string, boolean][] = [];
  const series = [{}, { fill: "red" as string | null }];
  const valToPos = (value: number, key: string, canvas = false) => {
    assert.equal(canvas, true);
    const s = scales[key];
    assert.ok(
      Number.isFinite(value) && value >= s.min && value <= s.max,
      `${key}=${value} outside viewport`,
    );
    if (s.distr === 3) assert.ok(value > 0);
    calls.push([value, key, canvas]);
    const transform =
      s.distr === 3
        ? Math.log10
        : s.distr === 4
          ? Math.asinh
          : (v: number) => v;
    let ratio =
      (transform(value) - transform(s.min)) /
      (transform(s.max) - transform(s.min));
    if (s.dir === -1) ratio = 1 - ratio;
    return key === "x"
      ? bbox.left + ratio * bbox.width
      : bbox.top + (1 - ratio) * bbox.height;
  };
  const mock = {
    scales,
    bbox,
    data,
    series,
    valToPos,
    redraw: () => assert.fail("path builder must not redraw"),
  };
  return { ...mock, calls, u: mock as unknown as uPlot };
}
const commands = (path: unknown) => (path as MockPath).commands;
const vertices = (path: unknown): XY[] =>
  commands(path)
    .filter((c) => c.kind === "M" || c.kind === "L")
    .map((c) => c.args as XY);
const near = (a: number, b: number, epsilon = 1e-8) =>
  assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b}`);
function build(
  points: XY[],
  p: ReturnType<typeof plot>,
  options?: MatchedPathOptions,
) {
  return matchedPath(points, makeInterpolator(points, "linear").at, options)(
    p.u,
    1,
    99,
    100,
  )!;
}
function polygonGroups(path: unknown): XY[][] {
  const groups: XY[][] = [];
  for (const c of commands(path)) {
    if (c.kind === "M") groups.push([]);
    if (c.kind === "M" || c.kind === "L")
      groups[groups.length - 1].push(c.args as XY);
  }
  return groups;
}

for (const [label, points, p] of [
  [
    "log y",
    [
      [0, 1],
      [1, 100],
    ],
    plot(0, 1, 1, 100, 1, 3),
  ],
  [
    "log x",
    [
      [1, 0],
      [100, 1],
    ],
    plot(1, 100, 0, 1, 3, 1),
  ],
  [
    "asinh y",
    [
      [-100, -100],
      [100, 100],
    ],
    plot(-100, 100, -100, 100, 1, 4),
  ],
] as [string, XY[], ReturnType<typeof plot>][]) {
  test(`${label}: draws the numerical curve, not a transformed endpoint chord`, () => {
    const at = makeInterpolator(points, "linear").at;
    const result = matchedPath(points, at)(p.u, 1, 0, 1)!;
    const v = vertices(result.stroke);
    assert.ok(v.length > 4);
    const mid = (points[0][0] + points[1][0]) / 2;
    const expected = [
      p.valToPos(mid, "x", true),
      p.valToPos(at(mid)!, "y", true),
    ];
    assert.ok(
      v.some(
        (q) =>
          Math.abs(q[0] - expected[0]) < 1e-9 &&
          Math.abs(q[1] - expected[1]) < 1e-9,
      ),
    );
    if (label === "log y") assert.equal(at(0.5), 50.5);
    if (label === "log x") near(at(10)!, 9 / 99);
    assert.deepEqual(commands(result.clip), [
      { kind: "R", args: [17, 29, 800, 600] },
    ]);
  });
}

test("preserves all original knots with PCHIP and reversed axes; aligned arrays stay untouched", () => {
  const points: XY[] = [
    [1, -100],
    [2, 0],
    [5, 3],
    [100, 100],
  ];
  points.forEach(Object.freeze);
  Object.freeze(points);
  const p = plot(1, 100, -100, 100, 3, 4);
  p.scales.x.dir = -1;
  p.scales.y.dir = -1;
  p.data.forEach(Object.freeze);
  Object.freeze(p.data);
  const before = JSON.stringify({ points, data: p.data });
  const at = makeInterpolator(points, "pchip").at;
  const result = matchedPath(points, at)(p.u, 1, 1, 1)!;
  const v = vertices(result.stroke);
  for (const [x, y] of points)
    assert.ok(
      v.some(
        (q) =>
          q[0] === p.valToPos(x, "x", true) &&
          q[1] === p.valToPos(y, "y", true),
      ),
    );
  assert.ok(v[0][0] > v[v.length - 1][0]);
  assert.equal(JSON.stringify({ points, data: p.data }), before);
});

test("every call uses latest scale bounds, projection, bbox, and size", () => {
  const points: XY[] = [
    [0, 1],
    [1, 100],
  ];
  const p = plot(0, 1, 1, 100, 1, 3);
  let evaluations = 0;
  const builder = matchedPath(points, (x) => {
    evaluations++;
    return 1 + 99 * x;
  });
  const first = builder(p.u, 1, 0, 1)!;
  const count = evaluations;
  p.scales.x.min = 0.25;
  p.scales.x.max = 0.75;
  p.scales.y.min = 10;
  p.scales.y.max = 90;
  p.bbox.width = 1600;
  p.bbox.height = 900;
  p.bbox.left = 100;
  const second = builder(p.u, 1, 500, 500)!;
  assert.ok(evaluations > count);
  assert.notDeepEqual(commands(first.stroke), commands(second.stroke));
  assert.deepEqual(commands(second.clip), [
    { kind: "R", args: [100, 29, 1600, 900] },
  ]);
  const v = vertices(second.stroke);
  near(v[0][0], 100);
  near(v[v.length - 1][0], 1700);
});

test("default tolerance follows public static pixel ratio on each call; explicit tolerance overrides", () => {
  const points: XY[] = [
      [0, 1],
      [1, 100],
    ],
    at = makeInterpolator(points, "linear").at;
  const p = plot(0, 1, 1, 100, 1, 3);
  p.series[1].fill = null;
  const prior = uPlot.pxRatio;
  try {
    const builder = matchedPath(points, at);
    for (const ratio of [1, 4]) {
      uPlot.pxRatio = ratio;
      const actual = vertices(builder(p.u, 1, 0, 1)!.stroke);
      const project = (x: number, y: number): XY => [
        p.valToPos(x, "x", true),
        p.valToPos(y, "y", true),
      ];
      const expected = tessellate(
        points,
        at,
        project,
        { xMin: 0, xMax: 1, yMin: 1, yMax: 100 },
        { tolerance: 0.35 * ratio },
      );
      assert.deepEqual(
        actual,
        expected.segments.flat().map((v) => project(...v)),
      );
    }
    uPlot.pxRatio = 1;
    const one = build(points, p, { tolerance: 0.1 });
    uPlot.pxRatio = 4;
    assert.deepEqual(
      commands(one.stroke),
      commands(build(points, p, { tolerance: 0.1 }).stroke),
    );
  } finally {
    uPlot.pxRatio = prior;
  }
});

test("positive log viewport clips negative original-domain values before projection", () => {
  const p = plot(0.25, 1.75, 0.5, 1.5, 3, 3);
  const result = build(
    [
      [-2, -2],
      [2, 2],
    ],
    p,
  );
  const v = vertices(result.stroke);
  near(v[0][0], p.valToPos(0.5, "x", true));
  near(v[v.length - 1][0], p.valToPos(1.5, "x", true));
  assert.ok(p.calls.every(([value]) => value > 0));
});

test("fill covers visible area when the curve is wholly above the viewport", () => {
  for (const distr of [1, 3]) {
    const p = plot(0, 1, 1, 10, 1, distr);
    const result = build(
      [
        [0, 20],
        [1, 30],
      ],
      p,
    );
    assert.equal(commands(result.stroke).length, 0);
    assert.deepEqual(vertices(result.fill), [
      [17, 29],
      [817, 29],
      [817, 629],
      [17, 629],
    ]);
    assert.equal(commands(result.fill).at(-1)?.kind, "Z");
  }
});

test("configured fill baseline is used, including reversed axes and geometric clipping", () => {
  for (const reversed of [false, true])
    for (const fillTo of [-100, 4, 100]) {
      const p = plot(0, 1, 1, 10, 1, 3);
      if (reversed) {
        p.scales.x.dir = -1;
        p.scales.y.dir = -1;
      }
      const result = build(
        [
          [0, 20],
          [1, 30],
        ],
        p,
        { fillTo },
      );
      const v = vertices(result.fill),
        base = p.valToPos(Math.max(1, Math.min(10, fillTo)), "y", true);
      near(v[v.length - 1][1], base);
      near(v[v.length - 2][1], base);
    }
  const p = plot(0, 1, -10, 10);
  const fill = vertices(
    build(
      [
        [0, 5],
        [1, 5],
      ],
      p,
    ).fill,
  );
  near(fill.at(-1)![1], p.valToPos(0, "y", true));
});

test("log fill never bridges negative intervals or zero plateaus, even with a high baseline", () => {
  for (const middle of [-1, 0]) {
    const p = plot(0, 3, 0.125, 10, 1, 3);
    const result = build(
      [
        [0, 1],
        [1, middle],
        [2, middle],
        [3, 1],
      ],
      p,
      { fillTo: 5 },
    );
    for (const path of [result.stroke, result.fill]) {
      const groups = polygonGroups(path);
      assert.equal(groups.length, 2);
      assert.ok(groups[0].every((v) => v[0] <= p.valToPos(1, "x", true)));
      assert.ok(groups[1].every((v) => v[0] >= p.valToPos(2, "x", true)));
    }
  }
});

test("positive log curve below viewport still fills to a configured baseline above it", () => {
  const p = plot(0, 1, 1, 10, 1, 3);
  const result = build(
    [
      [0, 0.1],
      [1, 0.2],
    ],
    p,
    { fillTo: 5 },
  );
  assert.equal(commands(result.stroke).length, 0);
  const fill = vertices(result.fill);
  near(fill[0][1], 629);
  near(fill[1][1], 629);
  near(fill[2][1], p.valToPos(5, "y", true));
});

test("unexpected null samples split stroke/fill and report limited without redraw", () => {
  const p = plot(0, 1, 1, 100, 1, 3),
    limited: boolean[] = [];
  const result = matchedPath(
    [
      [0, 1],
      [1, 100],
    ],
    (x) => (x === 0.5 ? null : 1 + 99 * x),
    { onLimited: (value) => limited.push(value) },
  )(p.u, 1, 0, 1)!;
  assert.equal(commands(result.stroke).length, 0);
  assert.equal(commands(result.fill).length, 0);
  assert.deepEqual(limited, [true]);
});

test("limited is reported once per call and resets with a new linear projection", () => {
  const p = plot(0, 1, 1, 100, 1, 3),
    limited: boolean[] = [];
  const builder = matchedPath(
    [
      [0, 1],
      [1, 100],
    ],
    (x) => 1 + 99 * x,
    {
      maxExtraPoints: 0,
      maxDepth: 0,
      onLimited: (value) => limited.push(value),
    },
  );
  builder(p.u, 1, 0, 1);
  p.scales.y.distr = 1;
  builder(p.u, 1, 0, 1);
  assert.deepEqual(limited, [true, false]);
});

test("empty/singleton paths leave markers to parent and invalid viewports are rejected", () => {
  const p = plot();
  for (const points of [[], [[0.5, 3]]] as XY[][]) {
    const result = build(points, p);
    assert.equal(commands(result.stroke).length, 0);
    assert.equal(commands(result.fill).length, 0);
  }
  p.scales.x.max = Infinity;
  assert.throws(
    () =>
      build(
        [
          [0, 1],
          [1, 2],
        ],
        p,
      ),
    /finite ascending/,
  );
  p.scales.x.max = 1;
  p.scales.x.distr = 3;
  assert.throws(
    () =>
      build(
        [
          [0, 1],
          [1, 2],
        ],
        p,
      ),
    /positive log/,
  );
});

test("devicePixelRatio fallback is read afresh when static ratio is unavailable", () => {
  const p = plot(0, 1, 1, 100, 1, 3),
    points: XY[] = [
      [0, 1],
      [1, 100],
    ];
  const ratio = uPlot.pxRatio;
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "devicePixelRatio",
  );
  try {
    uPlot.pxRatio = NaN;
    Object.defineProperty(globalThis, "devicePixelRatio", {
      configurable: true,
      value: 3,
    });
    assert.deepEqual(
      commands(build(points, p).stroke),
      commands(build(points, p, { tolerance: 1.05 }).stroke),
    );
  } finally {
    uPlot.pxRatio = ratio;
    if (descriptor)
      Object.defineProperty(globalThis, "devicePixelRatio", descriptor);
    else Reflect.deleteProperty(globalThis, "devicePixelRatio");
  }
});

test("fill remains continuous over an above-viewport peak while stroke stays split", () => {
  const p = plot(0, 2, 1, 10, 1, 3);
  const result = build(
    [
      [0, 2],
      [1, 20],
      [2, 2],
    ],
    p,
  );
  assert.equal(polygonGroups(result.stroke).length, 2);
  assert.equal(polygonGroups(result.fill).length, 1);
  assert.ok(
    vertices(result.fill).some(
      (v) => v[0] === p.valToPos(1, "x", true) && v[1] === 29,
    ),
  );
});

test("explicit pixel alignment snaps display vertices only", () => {
  const p = plot(0, 1, 1, 100, 1, 3),
    points: XY[] = [
      [0, 1],
      [1, 100],
    ];
  p.u.series[1].pxAlign = 3;
  const result = build(points, p);
  assert.ok(vertices(result.stroke).every((v) => v.every((n) => n % 3 === 0)));
  assert.deepEqual(points, [
    [0, 1],
    [1, 100],
  ]);
});

test("native null-returning fill callback skips fill tessellation", () => {
  const p = plot(0, 1, 1, 100, 1, 3);
  p.u.series[1].fill = (() => null) as unknown as uPlot.Series.Fill;
  const result = build(
    [
      [0, 1],
      [1, 100],
    ],
    p,
  );
  assert.equal(commands(result.fill).length, 0);
});

test("unsmoothed steep log-x strokes reach both viewport edges, including reversed axes", () => {
  for (const base of [1e3, 1e6])
    for (const reverse of [false, true])
      for (const fill of [null, "red"]) {
        const points: XY[] = [
          [base, -1e12],
          [base + base * Number.EPSILON * 8, 1e12],
        ];
        const at = makeInterpolator(points, "linear").at;
        const before = points.map(([x]) => at(x));
        const p = plot(1, 1e9, -3, 7, 3, 1),
          limited: boolean[] = [];
        p.series[1].fill = fill;
        if (reverse) p.scales.x.dir = p.scales.y.dir = -1;
        let evaluations = 0;
        const result = matchedPath(
          points,
          (x) => {
            evaluations++;
            return at(x);
          },
          {
            onLimited: (value) => limited.push(value),
          },
        )(p.u, 1, 0, 1)!;
        const v = vertices(result.stroke);
        assert.ok(v.length >= 2);
        assert.equal(polygonGroups(result.stroke).length, 1);
        near(v[0][1], p.valToPos(-3, "y", true));
        near(v.at(-1)![1], p.valToPos(7, "y", true));
        assert.ok(v.every((q) => q.every(Number.isFinite)));
        assert.deepEqual(limited, [false]);
        assert.ok(evaluations <= 150);
        assert.deepEqual(
          points.map(([x]) => at(x)),
          before,
        );
      }
});

test("wholly offscreen spans skip stroke, log-fill searches and all projections", () => {
  for (const points of [
    [
      [1, -1],
      [2, 3],
    ],
    [
      [30, -1],
      [40, 3],
    ],
  ] as XY[][]) {
    const p = plot(10, 20, 1, 2, 3, 3);
    const result = matchedPath(points, () =>
      assert.fail("offscreen evaluator call"),
    )(p.u, 1, 0, 1)!;
    assert.equal(commands(result.stroke).length, 0);
    assert.equal(commands(result.fill).length, 0);
    assert.equal(p.calls.length, 0);
  }
});

test("log-fill domain search is bounded across extreme x decades", () => {
  const points: XY[] = [
    [Number.MIN_VALUE, Math.log10(Number.MIN_VALUE)],
    [1e300, 300],
  ];
  const p = plot(Number.MIN_VALUE, 1e300, 0.125, 10, 3, 3);
  let evaluations = 0;
  const result = matchedPath(
    points,
    (x) => {
      evaluations++;
      return Math.log10(x);
    },
    {
      maxDepth: 0,
      maxExtraPoints: 0,
    },
  )(p.u, 1, 0, 1)!;
  assert.ok(vertices(result.stroke).length >= 2);
  assert.ok(vertices(result.fill).length >= 4);
  assert.ok(evaluations <= 210, `unexpected boundary work: ${evaluations}`);
  assert.ok(p.calls.every(([value]) => value > 0));
});
