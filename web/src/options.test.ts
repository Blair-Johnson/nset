import { test } from "node:test";
import assert from "node:assert/strict";
import uPlot from "uplot";
import { defaults, validateConfig, styleFor } from "./config";
import {
  resolveOptions,
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
