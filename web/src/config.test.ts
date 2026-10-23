import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafe,
  JSON_LIMITS,
  parseSafeJson,
  isSafeColor,
  effectiveRange,
  explicitRangeBounds,
  CONFIG_HELP,
  deepMerge,
  defaults,
  formatValue,
  parseAdvanced,
  styleFor,
  validateAdvanced,
  validateConfig,
} from "./config";
import { readLibrary, validateView } from "./views";
import {
  boundedIndex,
  extent,
  finiteInput,
  Latest,
  numberText,
  unionSorted,
} from "./utils";

test("deep merge keeps callbacks and merges axis patches by index without mutation", () => {
  const callback = () => 1;
  const base = {
    hooks: { draw: [callback] },
    axes: [
      { grid: { show: true, stroke: "#333333" }, label: "x" },
      { label: "y" },
    ],
  };
  const merged = deepMerge(base, { axes: [{ grid: { stroke: "#ffffff" } }] });
  assert.equal(merged.hooks.draw[0], callback);
  assert.deepEqual(merged.axes, [
    { grid: { show: true, stroke: "#ffffff" }, label: "x" },
    { label: "y" },
  ]);
  assert.equal(base.axes[0].grid?.stroke, "#333333");
});
for (const key of ["__proto__", "constructor", "prototype"])
  test(`rejects dangerous ${key} at arbitrary depth`, () => {
    const object = JSON.parse(`{"axes":[{"grid":{"${key}":{}}}]}`);
    assert.throws(() => assertSafe(object), /protected key/);
    assert.throws(() => deepMerge({}, object), /protected key/);
  });
for (const root of [
  "data",
  "hooks",
  "series",
  "plugins",
  "mode",
  "width",
  "height",
  "bands",
  "tzDate",
])
  test(`protects uPlot ${root}`, () =>
    assert.throws(
      () => validateAdvanced({ [root]: {} }),
      /protected inspector/,
    ));
test("supported JSON subset validates each nested field", () => {
  const value = {
    title: "<b>plain text</b>",
    padding: [10, 20, 30, 40],
    axes: [
      {
        values: "scientific",
        grid: { show: false, stroke: "#112233", dash: [2, 4] },
      },
      { label: "loss", ticks: { size: 4 } },
    ],
    legend: { show: true, live: false },
    cursor: { show: true, drag: { x: true, y: true, dist: 12 } },
  };
  assert.deepEqual(parseAdvanced(JSON.stringify(value)), value);
});
for (const value of [
  { axes: [{ values: "(x)=>x" }] },
  { axes: [{ filter: "return null" }] },
  { cursor: { bind: {} } },
  { legend: { markers: { dash: [2, 3] } } },
  { padding: [2] },
  { axes: [{ grid: { width: -1 } }] },
  { axes: [{ scale: "other" }] },
  { axes: [{ grid: { stroke: "url(https://example.com)" } }] },
])
  test(`rejects invalid or callback-valued patch ${JSON.stringify(value)}`, () =>
    assert.throws(() => validateAdvanced(value)));
test("no function or exotic object sneaks through non-JSON callers", () => {
  assert.throws(() => assertSafe({ value: () => 1 }), /executable/);
  assert.throws(() => assertSafe(new Date()), /plain JSON/);
  assert.throws(() => assertSafe({ value: NaN }));
});
test("invalid config rejects rather than silently correcting", () => {
  for (const patch of [
    { alpha: 0 },
    { alpha: 1.1 },
    { xMin: 4, xMax: 2 },
    { xScale: "log", xMin: 0 },
    { height: 0 },
    { style: { path: "javascript" } },
    { runs: { one: { width: -1 } } },
    { unexpected: true },
    { grid: "true" },
    { palette: "yes" },
  ])
    assert.throws(() => validateConfig(patch));
});
test("config round trip and run style precedence", () => {
  const c = validateConfig({
    ...defaults(),
    runs: { one: { color: "#112233", width: 4 } },
  });
  assert.deepEqual(validateConfig(JSON.parse(JSON.stringify(c))), c);
  assert.equal(styleFor(c, "one", 0).width, 4);
  assert.equal(styleFor(c, "one", 0).color, "#112233");
  c.palette = false;
  c.style.color = "#345678";
  assert.equal(styleFor(c, "other", 2).color, "#345678");
});
test("finite numeric formatters never evaluate strings", () => {
  assert.equal(formatValue(1.234, "fixed-2"), "1.23");
  assert.match(formatValue(1000, "scientific"), /e\+3/);
  assert.equal(formatValue(0, "iso-time"), "1970-01-01 00:00:00Z");
  assert.equal(formatValue(Infinity, "number"), "—");
});
const saved = () => ({
  format: "nset-view",
  version: 1,
  config: defaults(),
  experiment: "exp",
  runIds: ["r1"],
  metric: "loss",
  pins: { a: 0, b: 1, threshold: null },
});
test("saved views validate and reject secret/unknown fields", () => {
  assert.equal(validateView(saved()).metric, "loss");
  assert.throws(
    () => validateView({ ...saved(), token: "secret" }),
    /Unknown saved view/,
  );
  assert.throws(() =>
    validateView({ ...saved(), pins: { a: NaN, b: 1, threshold: null } }),
  );
  assert.throws(() => validateView({ ...saved(), version: 2 }));
  assert.throws(() =>
    validateView({
      ...saved(),
      pins: { a: 1, b: 1, threshold: null, other: 2 },
    }),
  );
});
test("saved library safe loading", () => {
  assert.deepEqual(readLibrary({ getItem: () => null }), {});
  const library = readLibrary({
    getItem: () => JSON.stringify({ baseline: saved() }),
  });
  assert.equal(library.baseline.metric, "loss");
  assert.throws(() => readLibrary({ getItem: () => '{"__proto__":{}}' }));
});
test("numeric utilities preserve zero and distinguish blank", () => {
  assert.equal(finiteInput("0"), 0);
  assert.equal(finiteInput(" "), null);
  assert.equal(finiteInput("NaN"), null);
  assert.equal(finiteInput("Infinity"), null);
  assert.equal(numberText(null), "—");
  assert.equal(numberText(0), "0");
});
test("large extents avoid function argument spread", () => {
  assert.deepEqual(
    extent(Array.from({ length: 200_000 }, (_, i) => i)),
    [0, 199_999],
  );
  assert.equal(extent([]), null);
  assert.deepEqual(extent([NaN, 4, Infinity, -2]), [-2, 4]);
  assert.deepEqual(
    unionSorted([
      [4, 1, 1],
      [2, 4, 7],
    ]),
    [1, 2, 4, 7],
  );
});
test("latest guard rejects stale responses", () => {
  const guard = new Latest();
  const first = guard.next(),
    second = guard.next();
  assert.equal(guard.current(first), false);
  assert.equal(guard.current(second), true);
});
test("timeline clamps endpoints, including empty sequence", () => {
  assert.equal(boundedIndex(-1, 5), 0);
  assert.equal(boundedIndex(8, 5), 4);
  assert.equal(boundedIndex(1, 0), 0);
});

test("tick length cannot silently pass through grid or border options", () => {
  assert.throws(() => validateAdvanced({ axes: [{ grid: { size: 5 } }] }));
  assert.throws(() => validateAdvanced({ axes: [{ border: { size: 5 } }] }));
  assert.doesNotThrow(() =>
    validateAdvanced({ axes: [{ ticks: { size: 5 } }] }),
  );
});

test("inherited property names are not accepted as view settings", () => {
  assert.throws(
    () => validateConfig(JSON.parse('{"toString":"ignored"}')),
    /unknown setting/,
  );
  assert.throws(
    () => validateConfig(JSON.parse('{"hasOwnProperty":false}')),
    /unknown setting/,
  );
});

test("literal presentation families cover the audited uPlot surface", () => {
  const advanced = {
    scales: {
      x: { dir: -1, log: 2, asinh: 0.1, auto: false, range: [1, 100] },
      y: {
        dir: 1,
        range: {
          min: { pad: 0.1, soft: 1, mode: 2, hard: 0.1 },
          max: { pad: 0.2, soft: 100, mode: 3, hard: 200 },
        },
      },
    },
    axes: [
      {
        side: 0,
        align: 1,
        alignTo: 2,
        lineGap: 1.2,
        space: 20,
        incrs: [1, 5, 10],
        splits: [1, 2, 3],
        values: ["one", 2, null],
        grid: { cap: "round" },
      },
      { side: 1, ticks: { cap: "square" }, border: { cap: "butt" } },
    ],
    cursor: {
      lock: true,
      points: {
        show: true,
        one: true,
        size: 8,
        width: 2,
        stroke: "red",
        fill: "#abcd",
      },
      focus: { prox: 20, bias: -1 },
      hover: { prox: null, bias: 1, skip: [null, 0] },
      drag: { x: true, y: true, setScale: false, uni: null, dist: 10 },
    },
    legend: {
      show: true,
      live: false,
      isolate: true,
      markers: {
        show: true,
        width: 2,
        stroke: "rgb(1 2 3 / 50%)",
        fill: "transparent",
        dash: "dashed",
      },
    },
    padding: [null, 10, null, 0],
    focus: { alpha: 0.25 },
    pxAlign: 0.5,
    drawOrder: ["series", "axes"],
    select: { show: false, over: false },
  };
  assert.deepEqual(parseAdvanced(JSON.stringify(advanced)), advanced);
  assert.doesNotThrow(() => validateConfig({ advanced }));
});

test("dash, increments, splits, range, padding and marker arrays replace rather than retain stale tails", () => {
  const base = {
    style: { dash: [1, 2, 3, 4], markers: { dash: [4, 5] } },
    axes: [
      { incrs: [1, 2, 3], splits: [1, 2], values: ["a", "b"] },
      { label: "y" },
    ],
    padding: [1, 2, 3, 4],
  };
  const result = deepMerge(base, {
    style: { dash: [], markers: { dash: [1] } },
    axes: [{ incrs: [5], splits: [], values: [] }],
    padding: [null, 4, 5, 6],
  });
  assert.deepEqual(result.style.dash, []);
  assert.deepEqual(result.style.markers.dash, [1]);
  assert.deepEqual(result.axes, [
    { incrs: [5], splits: [], values: [] },
    { label: "y" },
  ]);
  assert.deepEqual(result.padding, [null, 4, 5, 6]);
  assert.deepEqual(base.style.dash, [1, 2, 3, 4]);
});

test("advanced ranges supersede built-in bounds, including partial bounds", () => {
  const c = validateConfig({
    xScale: "log",
    xMin: -4,
    xMax: -8,
    advanced: { scales: { x: { range: [1, null] } } },
  });
  assert.deepEqual(effectiveRange(c, "x"), [1, null]);
  assert.deepEqual(
    explicitRangeBounds({ min: { hard: 2 }, max: { soft: 9 } }),
    [2, null],
  );
  assert.doesNotThrow(() =>
    validateConfig({
      yMin: 0,
      yMax: 10,
      advanced: { scales: { y: { auto: false } } },
    }),
  );
  assert.doesNotThrow(() =>
    validateConfig({
      advanced: {
        scales: {
          y: { auto: false, range: { min: { hard: -2 }, max: { hard: 3 } } },
        },
      },
    }),
  );
  assert.throws(
    () =>
      validateConfig({
        yMin: 0,
        yMax: 10,
        advanced: { scales: { y: { auto: false, range: [null, 20] } } },
      }),
    /auto:false/,
  );
  assert.throws(
    () => validateConfig({ advanced: { scales: { x: { auto: false } } } }),
    /auto:false/,
  );
  assert.throws(
    () =>
      validateConfig({ xMin: 0, advanced: { scales: { x: { auto: false } } } }),
    /auto:false/,
  );
});

for (const advanced of [
  { scales: { z: { dir: 1 } } },
  { scales: { x: { distr: 3 } } },
  { scales: { x: { ori: 1 } } },
  { scales: { x: { time: true } } },
  { scales: { x: { from: "y" } } },
  { scales: { x: { clamp: 1 } } },
  { scales: { x: { log: 3 } } },
  { scales: { x: { dir: 0 } } },
  { scales: { x: { asinh: 0 } } },
  { scales: { x: { range: [4, 4] } } },
  { scales: { x: { range: [4, 2] } } },
  { scales: { x: { range: [1] } } },
  { scales: { x: { range: { min: { pad: -1 }, max: {} } } } },
  { scales: { x: { range: { min: { mode: 4 }, max: {} } } } },
  { scales: { x: { range: { min: { hard: 4 }, max: { hard: 2 } } } } },
  { scales: { x: { range: { min: { soft: 4 }, max: { hard: 2 } } } } },
  { scales: { x: { range: { min: {} } } } },
  { scales: { x: { range: { min: { soft: 4 }, max: { soft: 2 } } } } },
  { axes: [{ side: 1 }] },
  { axes: [{}, { side: 2 }] },
  { axes: [{ align: 0 }] },
  { axes: [{ alignTo: 0 }] },
  { axes: [{ lineGap: -1 }] },
  { axes: [{ space: 0 }] },
  { axes: [{ incrs: [] }] },
  { axes: [{ incrs: [0, 1] }] },
  { axes: [{ incrs: [1, 1] }] },
  { axes: [{ splits: [2, 1] }] },
  { axes: [{ values: ["a"] }] },
  { axes: [{ splits: [1, 2], values: ["a"] }] },
  { axes: [{ splits: [1], values: [{}] }] },
  { axes: [{ side: 0, rotate: 10 }] },
  { axes: [{}, { rotate: 10 }] },
  { axes: [{ grid: { cap: "flat" } }] },
  { cursor: { points: { bbox: [] } } },
  { cursor: { points: { show: "auto" } } },
  { cursor: { hover: { skip: [{}] } } },
  { cursor: { focus: { dist: 5 } } },
  { cursor: { hover: { bias: 2 } } },
  { cursor: { drag: { uni: -1 } } },
  { cursor: { sync: { key: "shared" } } },
  { legend: { markers: { fill: "url(image)" } } },
  { legend: { markers: { dash: "1px dashed red" } } },
  { legend: { mount: "callback" } },
  { focus: { alpha: 2 } },
  { pxAlign: -1 },
  { drawOrder: ["axes", "axes"] },
  { drawOrder: ["series"] },
  { select: { left: 20 } },
])
  test(`rejects invalid audited literal ${JSON.stringify(advanced)}`, () =>
    assert.throws(() => validateAdvanced(advanced)));

for (const advanced of [
  { scales: { x: { range: [0, 10] } } },
  { scales: { x: { range: [null, -1] } } },
  { scales: { x: { range: { min: { soft: 0 }, max: {} } } } },
  { scales: { x: { range: { min: {}, max: { hard: -1 } } } } },
  { axes: [{ splits: [-1, 1] }] },
])
  test(`log cross-field validation ${JSON.stringify(advanced)}`, () =>
    assert.throws(
      () => validateConfig({ xScale: "log", advanced }),
      /positive/,
    ));

test("extended series styles round-trip and nested overrides inherit correctly", () => {
  const style = {
    cap: "round",
    alpha: 0.4,
    pxAlign: false,
    fillColor: "hsl(20 40% 50% / .5)",
    fillTo: -3,
    auto: false,
    markers: {
      show: "auto",
      size: 7,
      space: 12,
      width: 2,
      stroke: "red",
      fill: "#0000",
      dash: [2, 4],
      cap: "square",
    },
    pathOptions: { alignGaps: -1, align: 1, ascDesc: true, extend: true },
  };
  const c = validateConfig({
    style,
    runs: {
      one: { markers: { size: 10, dash: [] }, pathOptions: { align: -1 } },
    },
  });
  assert.deepEqual(validateConfig(JSON.parse(JSON.stringify(c))), c);
  const merged = styleFor(c, "one", 0);
  assert.equal(merged.markers?.size, 10);
  assert.equal(merged.markers?.show, "auto");
  assert.deepEqual(merged.markers?.dash, []);
  assert.equal(merged.pathOptions?.align, -1);
  assert.equal(merged.pathOptions?.extend, true);
  assert.equal(c.style.markers?.size, 7);
});
for (const style of [
  { alpha: -1 },
  { cap: "flat" },
  { pxAlign: 11 },
  { auto: 1 },
  { fillTo: "0" },
  { fillColor: "var(--x)" },
  { markers: { show: "always" } },
  { markers: { filter: [] } },
  { markers: { size: -1 } },
  { markers: { dash: [-1] } },
  { markers: { cap: "flat" } },
  { pathOptions: { align: 0 } },
  { pathOptions: { alignGaps: 2 } },
  { pathOptions: { extend: 1 } },
  { pathOptions: { spanGaps: true } },
])
  test(`invalid extended run style ${JSON.stringify(style)}`, () =>
    assert.throws(() => validateConfig({ runs: { one: style } })));

test("safe CSS fallback supports literal colors but rejects dynamic or external CSS", () => {
  for (const color of [
    "red",
    "rebeccapurple",
    "transparent",
    "#abc",
    "#abcd",
    "#12345678",
    "rgb(1, 2, 3)",
    "rgba(1, 2, 3, .5)",
    "rgb(1 2 3 / 50%)",
    "hsl(180deg 20% 50%)",
  ])
    assert.equal(isSafeColor(color), true, color);
  for (const color of [
    "",
    "notacolor",
    "currentColor",
    "inherit",
    "url(https://example.com/x)",
    "var(--color)",
    "red; background: blue",
    "rgb(1 2)",
    "rgb(1,2,3,4,5)",
    "hsl(0 10 20)",
    "rgb(from red r g b)",
    "rgb(calc(1) 2 3)",
    "rgb(1 2 3 /)",
    "rgb(1/*x*/ 2 3)",
  ])
    assert.equal(isSafeColor(color), false, color);
});

test("browser CSS.supports is authoritative after the literal safety filter", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  const calls: string[] = [];
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: {
      supports: (property: string, value: string) => {
        assert.equal(property, "color");
        calls.push(value);
        return value === "oklch(60% .2 30)";
      },
    },
  });
  try {
    assert.equal(isSafeColor("oklch(60% .2 30)"), true);
    assert.equal(isSafeColor("red"), false);
    assert.equal(isSafeColor("url(image)"), false);
    assert.equal(isSafeColor("var(--a)"), false);
    assert.deepEqual(calls, ["oklch(60% .2 30)", "red"]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "CSS", descriptor);
    else Reflect.deleteProperty(globalThis, "CSS");
  }
});

test("JSON budgets cover input bytes, values, strings, arrays, depth and object keys", () => {
  assert.throws(
    () => parseAdvanced(" ".repeat(JSON_LIMITS.bytes + 1) + "{}"),
    /bytes/,
  );
  assert.throws(
    () => parseSafeJson(JSON.stringify("😀".repeat(JSON_LIMITS.bytes / 4))),
    /bytes/,
  );
  assert.throws(() => assertSafe("a".repeat(JSON_LIMITS.string + 1)), /string/);
  assert.throws(
    () => assertSafe({ ["a".repeat(JSON_LIMITS.string + 1)]: 0 }),
    /string/,
  );
  assert.throws(
    () => assertSafe(Array(JSON_LIMITS.array + 1).fill(0)),
    /array/,
  );
  assert.throws(
    () => assertSafe(Array.from({ length: 10 }, () => Array(2500).fill(0))),
    /count/,
  );
  assert.throws(
    () => assertSafe(Array.from({ length: 40 }, () => "a".repeat(8000))),
    /bytes/,
  );
  let nested: unknown = null;
  for (let i = 0; i < 34; i++) nested = { nested };
  assert.throws(() => assertSafe(nested), /nesting/);
  assert.doesNotThrow(() =>
    assertSafe({
      a: "x".repeat(JSON_LIMITS.string),
      b: Array(JSON_LIMITS.array).fill(0),
    }),
  );
});

test("non-JSON shapes and accessors never execute", () => {
  let invoked = false;
  const input = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      invoked = true;
      return 1;
    },
  });
  assert.throws(() => assertSafe(input), /accessors/);
  assert.equal(invoked, false);
  assert.throws(() => assertSafe(new Array(2)), /dense/);
  assert.throws(() => assertSafe({ [Symbol("x")]: 1 }), /symbol/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => assertSafe(cycle), /nesting/);
});

test("documentation states adaptive rendering and updated safe merge contract", () => {
  assert.match(CONFIG_HELP, /0.35 CSS-pixel/);
  assert.match(CONFIG_HELP, /arrays replace/);
  assert.doesNotMatch(CONFIG_HELP, /16 subdivisions|arrays merge by index/);
});

test("array subclasses cannot execute inherited serialization hooks", () => {
  let invoked = false;
  class ExoticArray extends Array {
    toJSON() {
      invoked = true;
      return [];
    }
  }
  assert.throws(() => assertSafe(new ExoticArray()), /plain JSON/);
  assert.equal(invoked, false);
});

test("run style lookup never treats inherited object names as overrides", () => {
  assert.equal(styleFor(defaults(), "toString", 0).width, 2);
});

test("byte budget counts JSON escaping, punctuation and multibyte values", () => {
  const value = Array.from({ length: 40 }, () => "\u0000".repeat(1200));
  assert.throws(() => assertSafe(value), /bytes/);
  assert.equal(isSafeColor("hsl(20% 30% 40%)"), false);
});

test("all X axes round-trip in v1 configs without changing legacy smoothing", () => {
  for (const axis of ["step", "timestamp", "relative"] as const) {
    const config = validateConfig({
      version: 1,
      axis,
      smoothing: true,
      alpha: 0.0001,
    });
    assert.equal(config.axis, axis);
    assert.equal(config.alpha, 0.0001);
    assert.deepEqual(
      validateConfig(JSON.parse(JSON.stringify(config))),
      config,
    );
    assert.equal(validateView({ ...saved(), config }).config.axis, axis);
  }
  assert.deepEqual(validateConfig({ version: 1 }), defaults());
  assert.equal(validateConfig({ smoothing: false, alpha: 0.2 }).alpha, 0.2);
  for (const axis of ["elapsed", "wall", "", null])
    assert.throws(() => validateConfig({ axis }), /axis/);
});
