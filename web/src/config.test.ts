import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafe,
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
  "scales",
  "series",
  "plugins",
  "mode",
  "width",
  "height",
  "bands",
  "tzDate",
  "select",
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
  { legend: { markers: {} } },
  { padding: [2] },
  { axes: [{ grid: { width: -1 } }] },
  { axes: [{ scale: "other" }] },
  { axes: [{ grid: { stroke: "red" } }] },
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
