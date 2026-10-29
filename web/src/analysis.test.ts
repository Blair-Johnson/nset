import assert from "node:assert/strict";
import test from "node:test";
import { runStartTime, type Run } from "./api";
import { analyze, type PlotRun } from "./analysis";
import { defaults, type ViewConfig } from "./config";
import { canonicalize, joinXY, type Point, type XY } from "./math";
import { gaussianLocalLinear } from "./gaussian";

const day = 86_400_000;
const start = 1_700_000_000_000;
const importedAt = start + 60 * day;
function run(id: string, created_at: number, originalStart?: number): Run {
  return {
    id,
    experiment_id: "e",
    name: id,
    status: "finished",
    params: {},
    tags:
      originalStart === undefined
        ? {}
        : {
            "mlflow_import.run_id": `original-${id}`,
            "mlflow_import.start_time": originalStart,
          },
    created_at,
    updated_at: created_at,
  };
}
function point(timestamp: number, value: number, seq = 1): Point {
  return { timestamp, value, seq, step: seq - 1 };
}
function config(axis: ViewConfig["axis"]): ViewConfig {
  return { ...defaults(), axis, smoothing: false, interpolation: "linear" };
}

test("relative time aligns imported original starts weeks apart and native runs", () => {
  const originals = [start, start + 21 * day];
  const data: PlotRun[] = originals.map((origin, i) => ({
    run: run(`imported-${i}`, importedAt + i * 1000, origin),
    raw: [point(origin + 5000, 2), point(origin + 7000, 6, 2)],
  }));
  data.push({
    run: run("native", importedAt),
    raw: [point(importedAt + 5000, 2), point(importedAt + 7000, 6, 2)],
  });
  const before = structuredClone(data);
  for (const trace of analyze(data, config("relative"))) {
    assert.deepEqual(trace.observations, [
      [5000, 2],
      [7000, 6],
    ]);
    assert.equal(trace.fn.at(0), null); // Delayed logging is not run start.
    assert.equal(trace.fn.at(6000), 4);
  }
  assert.deepEqual(data, before);
  // Wall time and step still use exactly the recorded coordinates.
  assert.deepEqual(
    analyze(data, config("timestamp")).map((trace) => trace.observations),
    data.map(({ raw }) => raw.map((p) => [p.timestamp, p.value])),
  );
  for (const trace of analyze(data, config("step"))) {
    assert.deepEqual(trace.observations, [
      [0, 2],
      [1, 6],
    ]);
  }
  assert.deepEqual(data, before);
});

test("relative channels retain different logging delays within the same imported run", () => {
  const imported = run("imported", importedAt, start);
  const y = [point(start + 5000, 10), point(start + 15000, 0, 2)];
  const x = [point(start + 10000, 100), point(start + 20000, 200, 2)];
  const traces = analyze(
    [
      { run: imported, raw: y },
      { run: imported, raw: x },
      { run: imported, raw: y, x: { run: imported, raw: x, key: "counter" } },
    ],
    config("relative"),
  );
  assert.deepEqual(traces[0].observations, [
    [5000, 10],
    [15000, 0],
  ]);
  assert.deepEqual(traces[1].observations, [
    [10000, 100],
    [20000, 200],
  ]);
  assert.deepEqual(traces[2].points, [
    [100, 5],
    [150, 0],
  ]);
  assert.deepEqual(traces[2].observations, [[150, 0]]);
});

test("relative XY joins resolve the original start of each run independently", () => {
  const laterStart = start + 21 * day;
  const [trace] = analyze(
    [
      {
        run: run("y", importedAt, start),
        raw: [point(start + 5000, 10), point(start + 15000, 0, 2)],
        x: {
          run: run("x", importedAt + 1000, laterStart),
          raw: [
            point(laterStart + 10000, 100),
            point(laterStart + 20000, 200, 2),
          ],
          key: "counter",
        },
      },
    ],
    config("relative"),
  );
  assert.deepEqual(trace.points, [
    [100, 5],
    [150, 0],
  ]);
  assert.deepEqual(trace.observations, [[150, 0]]);
});

test("run origin accepts importer milliseconds including zero and rejects malformed tags", () => {
  assert.equal(runStartTime(run("native", start)), start);
  assert.equal(runStartTime(run("imported", importedAt, start)), start);
  assert.equal(runStartTime(run("epoch", importedAt, 0)), 0);
  for (const invalid of [
    undefined,
    null,
    "",
    "1700000000000",
    true,
    {},
    [],
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const malformed = run("malformed", start);
    malformed.tags["mlflow_import.start_time"] = invalid;
    assert.equal(runStartTime(malformed), start);
    const [trace] = analyze(
      [{ run: malformed, raw: [point(start + 5000, 2)] }],
      config("relative"),
    );
    assert.deepEqual(trace.observations, [[5000, 2]]);
  }
});

function nearPoints(actual: XY[], expected: XY[]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((p, i) =>
    p.forEach((v, j) =>
      assert.ok(
        Math.abs(v - expected[i][j]) <=
          1e-10 * Math.max(1, Math.abs(expected[i][j])),
        `${v} != ${expected[i][j]}`,
      ),
    ),
  );
}

test("analysis uses Gaussian seconds on time axes while preserving raw millisecond placement", () => {
  const r = run("r", start);
  const raw = [1, 7, -2, 8, 3].map((v, i) => point(start + i * 1000, v, i + 1));
  const expected = gaussianLocalLinear(
    raw.map((p, i): XY => [i, p.value]),
    1,
  );
  for (const axis of ["timestamp", "relative"] as const) {
    const cfg = { ...config(axis), smoothing: true, smoothingSigma: 1 };
    const [trace] = analyze([{ run: r, raw }], cfg);
    const canonical = canonicalize(raw, axis, start);
    assert.deepEqual(trace.observations, canonical);
    nearPoints(
      trace.points,
      expected.map((p, i): XY => [canonical[i][0], p[1]]),
    );
    trace.points.forEach(([x, y]) => assert.equal(trace.fn.at(x), y));
  }
});

test("analysis smooths normal charts in their log coordinate, preserving invalid-log observations", () => {
  const r = run("r", start);
  const raw = [0, 1, 2, 4, 8, 16].map((step, i) => ({
    ...point(start + i, [99, 1, 8, -2, 3, 4][i], i + 1),
    step,
  }));
  const cfg: ViewConfig = {
    ...config("step"),
    smoothing: true,
    smoothingSigma: 5,
    xScale: "log",
  };
  const [trace] = analyze([{ run: r, raw }], cfg);
  const expected = gaussianLocalLinear(
    canonicalize(raw, "step"),
    (5 * Math.log10(16)) / 15,
    Math.log10,
  );
  nearPoints(trace.points, expected);
  assert.deepEqual(trace.points[0], [0, 99]);
});

test("XY smooths BOTH scalar channels on the explicit common coordinate BEFORE joining", () => {
  const r = run("r", start);
  const y = [1, 8, -2, 3, 4].map((value, i) => ({
    ...point(start + i, value, i + 1),
    step: 2 ** i,
  }));
  const x = [0, 3, 10, 2, 7].map((value, i) => ({
    ...point(start + i, value, i + 1),
    step: 2 ** i,
  }));
  const cfg: ViewConfig = {
    ...config("step"),
    smoothing: true,
    smoothingSigma: 15 / 4, // One doubling across this 15-step domain.
    joinScale: "log",
    joinLog: 2,
    joinAsinh: 1,
    xScale: "asinh",
  };
  const data: PlotRun[] = [
    { run: r, raw: y, x: { run: r, raw: x, key: "counter" } },
  ];
  const before = structuredClone(data);
  const [trace] = analyze(data, cfg);
  const yc = canonicalize(y, "step"),
    xc = canonicalize(x, "step");
  const ys = gaussianLocalLinear(yc, 1, Math.log2),
    xs = gaussianLocalLinear(xc, 1, Math.log2);
  nearPoints(trace.points, joinXY(ys, xs, "linear"));
  assert.deepEqual(trace.observations, joinXY(yc, xc, "linear", "y"));
  assert.notEqual(trace.points[2][0], trace.observations[2][0]);
  assert.notEqual(trace.points[2][1], trace.observations[2][1]);
  assert.deepEqual(data, before);
});

test("paired records without independent coordinate metadata remain unsmoothed", () => {
  const observations: XY[] = [
    [5, 1],
    [2, 8],
    [5, -2],
    [0, 3],
  ];
  const cfg = { ...config("step"), smoothing: true, smoothingSigma: 100 };
  const [trace] = analyze(
    [
      {
        run: run("r", start),
        raw: [],
        paired: { key: "paired", points: observations },
      },
    ],
    cfg,
  );
  assert.deepEqual(trace.points, observations);
  assert.deepEqual(trace.observations, observations);
  assert.equal(trace.fn.at(5), null);
  assert.equal(trace.fn.monotonic, false);
});

test("analysis latest-per-step eliminates old timestamp placements before smoothing", () => {
  const r = run("r", start);
  const raw = [
    point(start, 1, 1),
    point(start + 1000, 8, 2),
    { ...point(start + 2000, -2, 3), step: 0 },
    point(start + 3000, 5, 4),
  ];
  const cfg = { ...config("timestamp"), smoothing: true, smoothingSigma: 1 };
  const [trace] = analyze([{ run: r, raw }], cfg);
  assert.deepEqual(trace.observations, [
    [start + 1000, 8],
    [start + 2000, -2],
    [start + 3000, 5],
  ]);
  assert.equal(trace.count, 4); // backend/history count still includes every record
  const canonical = canonicalize(raw, "timestamp");
  nearPoints(
    trace.points,
    gaussianLocalLinear(canonical, 1, (x) => x / 1000),
  );
});

test("analysis live append is a full deterministic fit equivalent to a fresh data load", () => {
  const r = run("r", start),
    cfg = { ...config("step"), smoothing: true, smoothingSigma: 2 };
  const raw = [
    point(start, 1, 1),
    point(start + 1, 4, 2),
    point(start + 2, 0, 3),
  ];
  const before = analyze([{ run: r, raw }], cfg)[0];
  raw.push(point(start + 3, 9, 4));
  const updated = analyze([{ run: r, raw }], cfg)[0];
  const fresh = analyze([{ run: r, raw: structuredClone(raw) }], cfg)[0];
  assert.deepEqual(updated.points, fresh.points);
  assert.deepEqual(updated.observations, fresh.observations);
  assert.notEqual(updated.points[2][1], before.points[2][1]);
});

test("analysis honors advanced log base and asinh threshold for ordinary charts", () => {
  const r = run("r", start);
  const raw = [1, 2, 4, 8, 16].map((step, i) => ({
    ...point(start + i, [1, 7, -3, 5, 2][i], i + 1),
    step,
  }));
  const canonical = canonicalize(raw, "step");
  for (const scale of ["log", "asinh"] as const) {
    const cfg: ViewConfig = {
      ...config("step"),
      smoothing: true,
      smoothingSigma: 5,
      xScale: scale,
      advanced: { scales: { x: { log: 2, asinh: 3 } } },
    };
    const [trace] = analyze([{ run: r, raw }], cfg);
    const transform =
      scale === "log" ? Math.log2 : (x: number) => Math.asinh(x / 3);
    const sigma = (5 * (transform(16) - transform(1))) / 15;
    nearPoints(trace.points, gaussianLocalLinear(canonical, sigma, transform));
  }
});

test("XY Gaussian fits each staggered time channel before forming union knots", () => {
  const r = run("r", start);
  const y = [1, 8, -2, 3].map((v, i) => point(start + 2000 * i, v, i + 1));
  const x = [2, -4, 7, 1].map((v, i) =>
    point(start + 1000 + 2000 * i, v, i + 1),
  );
  const cfg: ViewConfig = {
    ...config("relative"),
    smoothing: true,
    smoothingSigma: 2,
    joinScale: "linear",
    xScale: "log",
  };
  const [trace] = analyze(
    [{ run: r, raw: y, x: { run: r, raw: x, key: "x" } }],
    cfg,
  );
  const yc = canonicalize(y, "relative", start),
    xc = canonicalize(x, "relative", start);
  nearPoints(
    trace.points,
    joinXY(
      gaussianLocalLinear(yc, 2, (x) => x / 1000),
      gaussianLocalLinear(xc, 2, (x) => x / 1000),
      "linear",
    ),
  );
  assert.deepEqual(trace.observations, joinXY(yc, xc, "linear", "y"));
  assert.equal(trace.points.length, 6);
  assert.equal(trace.observations.length, 3);
});

test("analysis previous projection matches fresh after append, old-step correction, deletion and relocation", () => {
  const r = run("live", start);
  const initial = Array.from({ length: 600 }, (_, i) =>
    point(start + i * 1000, Math.sin(i / 13), i + 1),
  );
  for (const axis of ["step", "timestamp", "relative"] as const) {
    const cfg = { ...config(axis), smoothing: true, smoothingSigma: 8 };
    const before = analyze([{ run: r, raw: initial }], cfg);
    const changes = [
      [...initial, point(start + 600_000, 9, 601)],
      [...initial, { ...point(start + 280_000, 17, 601), step: 200 }],
      initial.filter((p) => p.step !== 200),
      initial.map((p) =>
        p.step === 200 ? { ...p, timestamp: start + 550_500 } : p,
      ),
    ];
    for (const raw of changes) {
      const updated = analyze([{ run: r, raw }], cfg, before)[0];
      const fresh = analyze([{ run: r, raw }], cfg)[0];
      nearPoints(updated.points, fresh.points);
      assert.deepEqual(updated.observations, fresh.observations);
      assert.equal(updated.count, raw.length);
    }
  }
});

test("analysis previous projection invalidates every setting and survives repeated live updates", () => {
  const r = run("live", start);
  let raw = Array.from({ length: 200 }, (_, i) =>
    point(start + i * 1000, Math.cos(i / 7), i + 1),
  );
  const cfg = { ...config("step"), smoothing: true, smoothingSigma: 3 };
  let previous = analyze([{ run: r, raw }], cfg);
  for (let i = 200; i < 210; i++) {
    raw = [...raw, point(start + i * 1000, Math.cos(i / 7), i + 1)];
    const next = analyze([{ run: r, raw }], cfg, previous);
    nearPoints(next[0].points, analyze([{ run: r, raw }], cfg)[0].points);
    previous = next;
  }
  const settings: ViewConfig[] = [
    { ...cfg, smoothingSigma: 30 },
    { ...cfg, smoothing: false },
    { ...cfg, xScale: "log" },
    { ...cfg, xScale: "asinh" },
    { ...cfg, axis: "timestamp" },
    { ...cfg, interpolation: "pchip" },
    {
      ...cfg,
      xScale: "log",
      advanced: { scales: { x: { log: 2, asinh: 4 } } },
    },
  ];
  for (const changed of settings) {
    nearPoints(
      analyze([{ run: r, raw }], changed, previous)[0].points,
      analyze([{ run: r, raw }], changed)[0].points,
    );
  }
});

test("XY live reuse updates each independent channel before join and preserves paired records", () => {
  const r = run("live", start);
  const y = Array.from({ length: 400 }, (_, i) =>
    point(start + i * 2000, Math.sin(i / 11), i + 1),
  );
  const x = Array.from({ length: 400 }, (_, i) =>
    point(start + i * 2000 + 1000, Math.cos(i / 17), i + 1),
  );
  const cfg: ViewConfig = {
    ...config("relative"),
    smoothing: true,
    smoothingSigma: 12,
    joinScale: "linear",
  };
  const data = (raw: Point[], xr: Point[]): PlotRun[] => [
    { run: r, raw, x: { run: r, raw: xr, key: "counter" } },
  ];
  const before = analyze(data(y, x), cfg);
  const variants = [
    data([...y, point(start + 800_000, 4, 401)], x),
    data(y, [...x, point(start + 801_000, 8, 401)]),
    data(
      [...y, { ...point(start + 300_000, 10, 401), step: 20 }],
      x.filter((p) => p.step !== 150),
    ),
  ];
  for (const next of variants) {
    const updated = analyze(next, cfg, before)[0],
      fresh = analyze(next, cfg)[0];
    nearPoints(updated.points, fresh.points);
    assert.deepEqual(updated.observations, fresh.observations);
  }
  for (const nextConfig of [
    { ...cfg, joinScale: "asinh" as const, joinAsinh: 5 },
    { ...cfg, joinScale: "log" as const, joinLog: 2 as const },
  ]) {
    nearPoints(
      analyze(data(y, x), nextConfig, before)[0].points,
      analyze(data(y, x), nextConfig)[0].points,
    );
  }
  const paired: PlotRun[] = [
    {
      run: r,
      raw: [],
      paired: {
        key: "p",
        points: [
          [2, 8],
          [1, 4],
          [2, 7],
        ],
      },
    },
  ];
  assert.deepEqual(
    analyze(paired, cfg, before)[0].points,
    paired[0].paired!.points,
  );
});

test("nonlinear runs share the full domain regardless of sampling density or viewport", () => {
  const sparse = [1, 10, 100, 1000].map((step, i) => ({
    ...point(start + i, [1, 8, -2, 3][i], i + 1),
    step,
  }));
  const dense = Array.from({ length: 100 }, (_, i) => ({
    ...point(start + i, Math.sin(i / 3), i + 1),
    step: i + 10,
  }));
  const data = [
    { run: run("sparse", start), raw: sparse },
    { run: run("dense", start), raw: dense },
  ];
  let log10: ReturnType<typeof analyze> | undefined;
  for (const scale of ["log", "asinh"] as const) {
    for (const base of [10, 2] as const) {
      const cfg: ViewConfig = {
        ...config("step"),
        smoothing: true,
        smoothingSigma: 200,
        xScale: scale,
        advanced: { scales: { x: { log: base, asinh: 3 } } },
      };
      const transform =
        scale === "log"
          ? base === 2
            ? Math.log2
            : Math.log10
          : (x: number) => Math.asinh(x / 3);
      const sigma = (200 * (transform(1000) - transform(1))) / 999;
      const traces = analyze(data, cfg);
      for (let i = 0; i < traces.length; i++) {
        const canonical = canonicalize(data[i].raw, "step");
        nearPoints(
          traces[i].points,
          gaussianLocalLinear(canonical, sigma, transform),
        );
        assert.deepEqual(traces[i].observations, canonical);
      }
      const clipped = analyze(data, { ...cfg, xMin: 30, xMax: 50 });
      traces.forEach((trace, i) => nearPoints(clipped[i].points, trace.points));
      // Adding interior samples in another run does not change the bandwidth.
      nearPoints(traces[0].points, analyze([data[0]], cfg)[0].points);
      // Fitting the dense run against only its own span is deliberately different.
      assert.notDeepEqual(traces[1].points, analyze([data[1]], cfg)[0].points);
      if (scale === "log") {
        if (log10)
          traces.forEach((trace, i) =>
            nearPoints(trace.points, log10![i].points),
          );
        else log10 = traces;
      }
    }
  }
});

test("ordinary nonlinear time smoothing maps equivalent seconds without moving observations", () => {
  for (const axis of ["relative", "timestamp"] as const) {
    const origin = axis === "relative" ? start : 0;
    const r = run("time", origin);
    const raw = [1, 2, 4, 8, 16].map((seconds, i) =>
      point(origin + seconds * 1000, [1, 8, -2, 7, 3][i], i + 1),
    );
    const canonical = canonicalize(raw, axis, origin);
    for (const scale of ["log", "asinh"] as const) {
      for (const base of [2, 10] as const) {
        const cfg: ViewConfig = {
          ...config(axis),
          smoothing: true,
          smoothingSigma: 4,
          xScale: scale,
          advanced: { scales: { x: { log: base, asinh: 2000 } } },
        };
        const transform =
          scale === "log"
            ? base === 2
              ? Math.log2
              : Math.log10
            : (x: number) => Math.asinh(x / 2000);
        const sigma = (4 * (transform(16000) - transform(1000))) / 15;
        const [trace] = analyze([{ run: r, raw }], cfg);
        nearPoints(
          trace.points,
          gaussianLocalLinear(canonical, sigma, transform),
        );
        assert.deepEqual(trace.observations, canonical);
      }
    }
  }
});

test("XY nonlinear bandwidth includes both pre-join domains across all runs", () => {
  for (const axis of ["step", "relative"] as const) {
    const make = (xs: number[], phase: number) =>
      xs.map((x, i) => ({
        ...point(start + x * 1000, Math.sin(i + phase) * 10, i + 1),
        step: x,
      }));
    const data: PlotRun[] = [
      {
        run: run("first-y", start),
        raw: make([2, 4, 8, 16, 32], 0),
        x: {
          run: run("first-x", start),
          raw: make([1, 4, 16, 64, 256], 1),
          key: "x",
        },
      },
      {
        run: run("second-y", start),
        raw: make([2, 8, 32], 2),
        x: {
          run: run("second-x", start),
          raw: make([1, 10, 100, 1000], 3),
          key: "x",
        },
      },
    ];
    for (const scale of ["log", "asinh"] as const) {
      for (const base of [2, 10] as const) {
        const cfg: ViewConfig = {
          ...config(axis),
          smoothing: true,
          smoothingSigma: 150,
          joinScale: scale,
          joinLog: base,
          joinAsinh: 3,
          xScale: "asinh",
          advanced: { scales: { x: { asinh: 999 } } },
        };
        const log = base === 2 ? Math.log2 : Math.log10;
        const divisor = axis === "step" ? 1 : 1000;
        const transform =
          scale === "log"
            ? (x: number) => log(x) - log(divisor)
            : (x: number) => Math.asinh(x / 3 / divisor);
        const sigma =
          (150 * (transform(1000 * divisor) - transform(divisor))) / 999;
        const traces = analyze(data, cfg);
        traces.forEach((trace, i) => {
          const yc = canonicalize(data[i].raw, axis, start);
          const xc = canonicalize(data[i].x!.raw, axis, start);
          nearPoints(
            trace.points,
            joinXY(
              gaussianLocalLinear(yc, sigma, transform),
              gaussianLocalLinear(xc, sigma, transform),
              "linear",
            ),
          );
          assert.deepEqual(trace.observations, joinXY(yc, xc, "linear", "y"));
        });
        // Metric-X display settings cannot redefine the join bandwidth.
        const cosmetic = analyze(data, {
          ...cfg,
          xScale: "log",
          xMin: -2,
          xMax: 2,
        });
        traces.forEach((trace, i) =>
          nearPoints(cosmetic[i].points, trace.points),
        );
      }
    }
  }
});

test("live domain growth refits untouched runs and both XY channels with unchanged config", () => {
  const raw = Array.from({ length: 128 }, (_, i) => ({
    ...point(start + i * 1000, Math.sin(i / 5), i + 1),
    step: i + 1,
  }));
  for (const joined of [false, true]) {
    for (const scale of ["log", "asinh"] as const) {
      for (const base of [2, 10] as const) {
        const cfg: ViewConfig = {
          ...config("step"),
          smoothing: true,
          smoothingSigma: 64,
          xScale: scale,
          joinScale: scale,
          joinLog: base,
          joinAsinh: 3,
          advanced: { scales: { x: { log: base, asinh: 3 } } },
        };
        const make = (extra: Point[]): PlotRun[] => [
          { run: run("untouched", start), raw },
          {
            run: run("growing", start),
            raw: joined ? raw : [...raw, ...extra],
            x: joined
              ? {
                  run: run("growing-x", start),
                  raw: [...raw, ...extra],
                  key: "x",
                }
              : undefined,
          },
        ];
        const before = analyze(make([]), cfg);
        const next = make([{ ...point(start + 4096000, 4, 129), step: 4096 }]);
        const updated = analyze(next, cfg, before);
        const fresh = analyze(next, cfg);
        updated.forEach((trace, i) => {
          nearPoints(trace.points, fresh[i].points);
          assert.deepEqual(trace.observations, fresh[i].observations);
        });
        assert.notDeepEqual(updated[0].points, before[0].points);
        // Domain contraction must also invalidate the mapped bandwidth.
        const contracted = analyze(make([]), cfg, updated);
        contracted.forEach((trace, i) =>
          nearPoints(trace.points, before[i].points),
        );
      }
    }
  }
});

test("nonlinear degenerate domains preserve observations and can become smoothable live", () => {
  for (const scale of ["log", "asinh"] as const) {
    const cfg: ViewConfig = {
      ...config("step"),
      smoothing: true,
      smoothingSigma: 10,
      xScale: scale,
    };
    const domains =
      scale === "log" ? [[], [2], [-2, 0], [0, 0]] : [[], [2], [0, 0]];
    for (const steps of domains) {
      const raw = steps.map((step, i) => ({
        ...point(start + i, i + 3, i + 1),
        step,
      }));
      const data = [{ run: run("degenerate", start), raw }];
      const previous = analyze(data, cfg);
      assert.deepEqual(previous[0].points, previous[0].observations);
      const next = [
        {
          ...data[0],
          raw: [
            ...raw,
            ...[4, 8, 16].map((step, i) => ({
              ...point(start + 10 + i, i % 2, 10 + i),
              step,
            })),
          ],
        },
      ];
      nearPoints(
        analyze(next, cfg, previous)[0].points,
        analyze(next, cfg)[0].points,
      );
    }
  }
  const r = run("canonical-domain", start);
  const cfg: ViewConfig = {
    ...config("relative"),
    smoothing: true,
    smoothingSigma: 4,
    xScale: "log",
  };
  const raw = [1, 2, 4, 8, 16].map((seconds, i) =>
    point(start + seconds * 1000, i % 2, i + 1),
  );
  // This obsolete row must not expand the domain before latest-per-step wins.
  const old = { ...raw[0], timestamp: start + 1e12, seq: 0 };
  nearPoints(
    analyze([{ run: r, raw: [old, ...raw] }], cfg)[0].points,
    analyze([{ run: r, raw }], cfg)[0].points,
  );
});
// Measures the pure analysis pipeline, not browser rendering/network latency.
test(
  "analysis live timing probe",
  { skip: !process.env.GAUSSIAN_BENCHMARK },
  () => {
    const r = run("bench", start),
      n = 24000;
    for (const xy of [false, true])
      for (const sigma of [10, 100, 10000]) {
        const cfg = {
          ...config("step"),
          smoothing: true,
          smoothingSigma: sigma,
        };
        const raw = Array.from({ length: n }, (_, i) =>
          point(start + i * 1000, Math.sin(i / 47), i + 1),
        );
        const x = xy
          ? {
              run: r,
              raw: raw.map((p) => ({ ...p, value: Math.cos(p.step / 31) })),
              key: "counter",
            }
          : undefined;
        let began = performance.now();
        const previous = analyze([{ run: r, raw, x }], cfg);
        console.log(
          JSON.stringify({
            kind: "analysis_benchmark",
            mode: "initial",
            xy,
            n,
            sigma,
            milliseconds: performance.now() - began,
          }),
        );
        raw.push(point(start + n * 1000, 2, n + 1));
        began = performance.now();
        const updated = analyze([{ run: r, raw, x }], cfg, previous);
        console.log(
          JSON.stringify({
            kind: "analysis_benchmark",
            mode: "append",
            xy,
            n,
            sigma,
            milliseconds: performance.now() - began,
          }),
        );
        nearPoints(
          updated[0].points,
          analyze([{ run: r, raw, x }], cfg)[0].points,
        );
      }
  },
);
