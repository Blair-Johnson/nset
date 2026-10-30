import { test } from "node:test";
import assert from "node:assert/strict";
import uPlot from "uplot";
import { logAxisSplits } from "./log-ticks";
import { defaults, validateConfig, styleFor } from "./config";
import {
  resolveOptions,
  coordinateFormatter,
  formatDuration,
  resolveScale,
  rawMarkerOptions,
  fillColor,
  pairedVisibility,
  cosmeticPath,
} from "./options";

const resolve = (
  advanced: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  resolveOptions(validateConfig({ ...extra, advanced }), 900, [
    {},
    { label: "derived" },
    { label: "raw" },
  ]);
const bounds = (scale: uPlot.Scale, lo: number, hi: number) =>
  (scale.range as uPlot.Range.Function)({} as uPlot, lo, hi, "x");

test("resolved scale literals retain direction/base/threshold and trusted ranges", () => {
  const opts = resolve(
    {
      scales: {
        x: { dir: -1, log: 2, range: [1, 64], auto: false },
        y: {
          asinh: 0.25,
          range: { min: { pad: 0.1, hard: -20 }, max: { pad: 0.2, hard: 30 } },
        },
      },
    },
    { xScale: "log", yScale: "asinh" },
  );
  assert.equal(opts.scales!.x.distr, 3);
  assert.equal(opts.scales!.x.dir, -1);
  assert.equal(opts.scales!.x.log, 2);
  assert.equal(opts.scales!.x.auto, false);
  assert.deepEqual(bounds(opts.scales!.x, 2, 16), [1, 64]);
  assert.equal(opts.scales!.y.distr, 4);
  assert.equal(opts.scales!.y.asinh, 0.25);
  assert.deepEqual(bounds(opts.scales!.y, 0, 10), [-1, 12]);
});

test("range object adapter works for aligned x and preserves hard bounds", () => {
  const opts = resolve({
    scales: { x: { range: { min: { pad: 0.2 }, max: { pad: 0.1 } } } },
  });
  assert.deepEqual(bounds(opts.scales!.x, 0, 10), [-2, 11]);
  assert.deepEqual(
    bounds(resolveScale("linear", "x", 3, 9, { range: [1, 20] }), 2, 5),
    [1, 20],
  );
  assert.deepEqual(
    bounds(resolveScale("linear", "x", null, 5), 10, 20),
    [4, 5],
  );
  assert.deepEqual(
    bounds(resolveScale("linear", "x", 10, null), 0, 5),
    [10, 11],
  );
});

test("log numeric padding never creates a nonpositive bound", () => {
  const scale = resolveScale("log", "x", null, null, {
    log: 2,
    range: { min: { pad: 1 }, max: { pad: 0.1 } },
  });
  const [lo, hi] = bounds(scale, 1, 100);
  assert.equal(lo, 0.5);
  assert.ok(hi! > 100);
  for (const kind of ["linear", "log", "asinh"] as const) {
    const b = bounds(resolveScale(kind, "y", null, null), Infinity, -Infinity);
    assert.ok(b.every((x) => Number.isFinite(x)));
    assert.ok(b[0]! < b[1]!);
    if (kind === "log") assert.ok(b[0]! > 0);
  }
  assert.throws(
    () =>
      bounds(
        resolveScale("linear", "x", null, null, {
          range: {
            min: { pad: Number.MAX_VALUE },
            max: { pad: Number.MAX_VALUE },
          },
        }),
        -10,
        10,
      ),
    /finite ascending/,
  );
});

test("resolved axis static labels stay tied to explicit split values", () => {
  const opts = resolve({
    axes: [
      {
        side: 0,
        align: 2,
        alignTo: 1,
        lineGap: 1.5,
        space: 30,
        incrs: [1, 2, 5],
        splits: [1, 2, 4],
        values: ["one", 2, null],
        ticks: { cap: "round", size: 4 },
        grid: { cap: "square", dash: [] },
        border: { cap: "butt" },
      },
    ],
  });
  const x = opts.axes![0];
  assert.equal(x.side, 0);
  assert.equal(x.align, 2);
  assert.equal(x.alignTo, 1);
  assert.equal(x.lineGap, 1.5);
  assert.equal(x.space, 30);
  assert.deepEqual(x.incrs, [1, 2, 5]);
  assert.equal(x.ticks!.cap, "round");
  assert.deepEqual(
    (x.values as Exclude<uPlot.Axis.Values, string | unknown[]>)(
      {} as uPlot,
      [2, 4],
      0,
      1,
      1,
    ),
    [2, ""],
  );
  assert.deepEqual(
    (x.filter as uPlot.Axis.Filter)({} as uPlot, [1, 2, 4], 0, 1, 1),
    [1, 2, 4],
  );
  assert.equal(opts.axes![1].size, 76);
});

test("resolved cursor/legend/global presentation literal families", () => {
  const advanced = {
    cursor: {
      show: true,
      lock: true,
      drag: { x: true, y: true, dist: 2, uni: 8, setScale: false },
      focus: { prox: 25, bias: 1 },
      hover: { prox: null, bias: -1 },
      points: {
        show: true,
        one: true,
        size: 9,
        width: 2,
        stroke: "#ff0000",
        fill: "#000000",
      },
    },
    legend: {
      isolate: true,
      live: true,
      markers: {
        show: true,
        width: 2,
        stroke: "#ff0000",
        fill: "#000000",
        dash: "dotted",
      },
    },
    focus: { alpha: 0.2 },
    pxAlign: false,
    drawOrder: ["series", "axes"],
    select: { show: true, over: false },
    padding: [null, 0, 20, null],
  };
  const opts = resolve(advanced);
  assert.deepEqual(opts.cursor!.drag, advanced.cursor.drag);
  assert.deepEqual(opts.cursor!.focus, advanced.cursor.focus);
  assert.deepEqual(opts.cursor!.hover, advanced.cursor.hover);
  const { show: _show, ...expectedPoints } = advanced.cursor.points;
  assert.deepEqual(opts.cursor!.points, expectedPoints);
  assert.equal(opts.cursor!.lock, true);
  assert.deepEqual(opts.legend!.markers, advanced.legend.markers);
  assert.equal(opts.legend!.isolate, true);
  assert.deepEqual(opts.focus, { alpha: 0.2 });
  assert.equal(opts.pxAlign, false);
  assert.deepEqual(opts.drawOrder, ["series", "axes"]);
  assert.deepEqual(opts.select, advanced.select);
  assert.deepEqual(opts.padding, [null, 0, 20, null]);
  const roundTrip = JSON.parse(JSON.stringify(validateConfig({ advanced })));
  assert.deepEqual(validateConfig(roundTrip), validateConfig({ advanced }));
});

test("run style marker and fill literals resolve without exposing callbacks", () => {
  const c = validateConfig({
    palette: false,
    style: {
      color: "#123456",
      cap: "round",
      alpha: 0.4,
      pxAlign: 0.5,
      auto: false,
      fill: 0.5,
      fillColor: "#abcdef",
      fillTo: 3,
      markers: {
        show: "auto",
        size: 8,
        space: 12,
        width: 2,
        stroke: "#001122",
        fill: "#334455",
        dash: [2, 1],
        cap: "square",
      },
      path: "stepped-after",
      pathOptions: { align: -1, alignGaps: 0, ascDesc: true, extend: true },
    },
  });
  const s = styleFor(c, "a", 0),
    p = rawMarkerOptions(s);
  assert.equal(s.color, "#123456");
  assert.equal(s.fillTo, 3);
  assert.equal(s.auto, false);
  assert.equal(s.alpha, 0.4);
  assert.equal(s.pxAlign, 0.5);
  assert.equal(fillColor(s), "#abcdef80");
  assert.equal(p.show, undefined);
  assert.equal(p.size, 8);
  assert.equal(p.space, 12);
  assert.equal(p.cap, "square");
  assert.deepEqual(p.dash, [2, 1]);
  assert.equal(typeof cosmeticPath(s), "function");
  assert.equal(fillColor(defaults().style), undefined);
});

test("legend toggles and isolation keep derived/raw pairs together", () => {
  const current = [true, true, true, true, false, true, true];
  const enabled = [true, false, true];
  assert.deepEqual(pairedVisibility(current, 2, false, enabled), [
    true,
    false,
    false,
    true,
    false,
    true,
    true,
  ]);
  assert.deepEqual(pairedVisibility(current, 3, true, enabled), [
    true,
    false,
    false,
    true,
    false,
    false,
    false,
  ]);
  const isolated = pairedVisibility(current, 1, true, enabled);
  assert.deepEqual(isolated, [true, true, true, false, false, false, false]);
  assert.deepEqual(pairedVisibility(isolated, 2, true, enabled), current);
  assert.deepEqual(pairedVisibility(current, 0, true, enabled), current);
});

test("internal hover undefined exclusion and disabled uni survive literal resolution", () => {
  const opts = resolve({
    cursor: { drag: { uni: null }, hover: { skip: [null, 7] } },
  });
  assert.equal(opts.cursor!.drag!.uni, undefined);
  assert.deepEqual(opts.cursor!.hover!.skip, [undefined, null, 7]);
});

test("explicit log fill baselines reject nonpositive defaults and inherited run overrides", () => {
  assert.throws(
    () => validateConfig({ yScale: "log", style: { fillTo: 0 } }),
    /log fillTo must be positive/,
  );
  assert.throws(
    () => validateConfig({ yScale: "log", runs: { a: { fillTo: -1 } } }),
    /log fillTo must be positive/,
  );
  assert.equal(
    validateConfig({ yScale: "log", style: { fillTo: 2 } }).style.fillTo,
    2,
  );
});

test("elapsed duration formatting handles signs, milliseconds, carries and long runs", () => {
  for (const [value, expected] of [
    [0, "0 ms"],
    [-0, "0 ms"],
    [0.125, "0.125 ms"],
    [-25, "-25 ms"],
    [999, "999 ms"],
    [1000, "1s"],
    [-1501, "-1.501s"],
    [60_000, "1m"],
    [59_999.9, "1m"],
    [3_600_001, "1h 0.001s"],
    [86_400_000, "1d"],
    [183_845_006, "2d 3h 4m 5.006s"],
    [-183_845_006, "-2d 3h 4m 5.006s"],
    [400 * 86_400_000, "400d"],
  ] as const)
    assert.equal(formatDuration(value), expected);
  for (const value of [NaN, Infinity, -Infinity])
    assert.equal(formatDuration(value), "\u2014");
  assert.equal(formatDuration(Number.MIN_VALUE), "5e-324 ms");
  assert.match(formatDuration(Number.MAX_VALUE), /^\d[.\de+]*d$/);
  assert.doesNotMatch(
    formatDuration(Number.MAX_SAFE_INTEGER),
    /NaN|Infinity|Z/,
  );
});

const axisValues = (options: uPlot.Options, values: number[], index = 0) =>
  (options.axes![index].values as (...args: unknown[]) => unknown[])(
    {},
    values,
    index,
    100,
    1000,
  );

test("relative axes default to elapsed durations, never legacy ISO dates", () => {
  for (const xFormat of ["number", "iso-time"] as const) {
    const opts = resolve({}, { axis: "relative", xFormat });
    assert.match(String(opts.axes![0].label), /Relative time.*run start/);
    assert.deepEqual(axisValues(opts, [-1000, 0, 500, 90_000]), [
      "-1s",
      "0 ms",
      "500 ms",
      "1m 30s",
    ]);
    assert.equal(opts.scales!.x.time, false);
  }
  const legacyAdvanced = resolve(
    { axes: [{ values: "iso-time" }] },
    { axis: "relative" },
  );
  assert.deepEqual(axisValues(legacyAdvanced, [0, 1000]), ["0 ms", "1s"]);
});

test("relative axes preserve explicit labels and numeric formatting overrides", () => {
  const basic = resolve(
    {},
    { axis: "relative", xLabel: "Training elapsed", xFormat: "fixed-2" },
  );
  assert.equal(basic.axes![0].label, "Training elapsed");
  assert.deepEqual(axisValues(basic, [1234]), ["1234.00"]);
  const numeric = resolve(
    { axes: [{ label: "Custom title", values: "scientific" }] },
    { axis: "relative" },
  );
  assert.equal(numeric.axes![0].label, "Custom title");
  assert.match(String(axisValues(numeric, [1234])[0]), /e\+3/);
  const labels = resolve(
    { axes: [{ splits: [0, 1000], values: ["Launch", "Warmup"] }] },
    { axis: "relative" },
  );
  assert.deepEqual(axisValues(labels, [1000, 0]), ["Warmup", "Launch"]);
  // Relative formatting applies to X only, not an explicitly date-formatted Y.
  const y = resolve(
    { axes: [{}, { values: "iso-time" }] },
    { axis: "relative" },
  );
  assert.deepEqual(axisValues(y, [0], 1), ["1970-01-01 00:00:00Z"]);
});

test("coordinate formatters share advanced notation with axes and fall back for static labels", () => {
  const config = validateConfig({
    xFormat: "fixed-2",
    yFormat: "scientific",
    advanced: {
      axes: [{ values: "scientific" }, { values: "fixed-2" }],
    },
  });
  const opts = resolveOptions(config, 900, [{}]);
  for (const [index, value] of [50, 75].entries()) {
    assert.equal(
      coordinateFormatter(config, "step", index)(value),
      (opts.axes![index].values as uPlot.Axis.DynamicValues)(
        {} as uPlot,
        [value],
        index,
        50,
        25,
      )[0],
    );
  }
  const labels = validateConfig({
    xFormat: "fixed-2",
    advanced: { axes: [{ splits: [0, 100], values: ["low", "high"] }] },
  });
  assert.equal(coordinateFormatter(labels, "step", 0)(50), "50.00");
  assert.equal(
    coordinateFormatter(
      validateConfig({ advanced: { axes: [{ values: "number" }] } }),
      "timestamp",
      0,
    )(50),
    "50",
  );
});

test("default log ticks are bounded independently of smoothing and direction", () => {
  const opts = resolve(
    {
      scales: { x: { log: 2, dir: -1 }, y: { log: 10, dir: -1 } },
      axes: [{ values: "fixed-2" }],
    },
    { xScale: "log", yScale: "log", smoothing: false },
  );
  for (const axis of opts.axes!) {
    assert.equal(axis.splits, logAxisSplits);
    assert.deepEqual(
      (axis.filter as uPlot.Axis.Filter)({} as uPlot, [1, 2, 5], 0, 0, 0),
      [1, 2, 5],
    );
  }
  assert.deepEqual(
    (opts.axes![0].values as uPlot.Axis.DynamicValues)(
      {} as uPlot,
      [0.125],
      0,
      0,
      0,
    ),
    ["0.13"],
  );
  const other = resolve({}, { xScale: "linear", yScale: "asinh" });
  assert.equal(other.axes![0].splits, undefined);
  assert.equal(other.axes![1].splits, undefined);
});

test("log split overrides and their static labels remain user-owned", () => {
  const opts = resolve(
    {
      axes: [
        { splits: [1, 2, 5], values: ["one", "two", "five"] },
        { splits: [1, 10] },
      ],
    },
    { xScale: "log", yScale: "log", smoothing: false },
  );
  const [x, y] = opts.axes!;
  assert.deepEqual(x.splits, [1, 2, 5]);
  assert.deepEqual(y.splits, [1, 10]);
  assert.equal(y.filter, undefined);
  assert.deepEqual(
    (x.values as uPlot.Axis.DynamicValues)({} as uPlot, [2, 5], 0, 0, 0),
    ["two", "five"],
  );
  assert.deepEqual(
    (x.filter as uPlot.Axis.Filter)({} as uPlot, [1, 2, 5], 0, 0, 0),
    [1, 2, 5],
  );
});
