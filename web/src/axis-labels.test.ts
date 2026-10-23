import test from "node:test";
import assert from "node:assert/strict";
import { defaults, formatValue, validateConfig } from "./config";
import {
  defaultLabelLayout,
  formatNumberTick,
  formatTimestampTick,
  timestampTickIncrements,
} from "./axis-labels";
import { formatXValue, resolveOptions } from "./options";

const labels = (
  config: Parameters<typeof resolveOptions>[0],
  index: number,
  values: unknown[],
) =>
  (
    resolveOptions(config, 600, [{}]).axes![index].values as (
      ...args: unknown[]
    ) => string[]
  )({}, values, index, 170, 1);

test("compact ticks are equivalent spellings, not further rounded readouts", () => {
  for (const n of [
    0,
    -0,
    1,
    -1,
    1e9,
    -3e9,
    1234567890,
    -0.00000123456789,
    1e-100,
    1e100,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
  ]) {
    const plain = formatValue(n, "number");
    const tick = formatNumberTick(n);
    assert.equal(Number(tick), Number(plain));
    assert.ok(tick.length <= plain.length);
  }
  assert.equal(formatNumberTick(3e9), "3e9");
  assert.equal(formatValue(3e9, "number"), "3000000000");
  assert.equal(formatNumberTick(NaN), "\u2014");
  assert.deepEqual(labels(defaults(), 1, [null, 3e9]), ["", "3e9"]);
});

test("timestamp tick retains complete date, UTC suffix and milliseconds; readout stays one line", () => {
  for (const value of [
    0, -1, 1700000000000, 1700000000001, 1735689599999, 1735689600000, 8.64e15,
  ]) {
    assert.equal(
      formatTimestampTick(value).replace("\n", " "),
      formatXValue(value, "timestamp", "number"),
    );
  }
  assert.equal(formatTimestampTick(1700000000001), "2023-11-14\n22:13:20.001Z");
  const config = validateConfig({ axis: "timestamp" });
  assert.deepEqual(labels(config, 0, [null, 0]), ["", "1970-01-01\n00:00:00Z"]);
  assert.equal(resolveOptions(config, 600, [{}]).axes![0].size, 44);
  assert.equal(resolveOptions(config, 600, [{}]).axes![0].align, 2);
  assert.equal(formatXValue(1000, "relative", "number"), "1s");
});

test("explicit formatting and all geometry literals opt out; cosmetic factory defaults do not", () => {
  const base = validateConfig({
    axis: "timestamp",
    advanced: {
      axes: [
        { stroke: "#aaa", grid: { stroke: "#aaa" } },
        { ticks: { stroke: "#aaa" } },
      ],
    },
  });
  assert.deepEqual(defaultLabelLayout(base), {
    compactY: true,
    multilineTime: true,
  });
  for (const patch of [
    { size: 88 },
    { label: "Custom" },
    { labelSize: 28 },
    { font: "14px monospace" },
    { side: 1 },
    { values: "number" },
    { ticks: { size: 12 } },
  ]) {
    const config = validateConfig({
      axis: "timestamp",
      advanced: { axes: [{}, patch] },
    });
    assert.deepEqual(defaultLabelLayout(config), {
      compactY: false,
      multilineTime: false,
    });
  }
  assert.equal(
    defaultLabelLayout(
      validateConfig({
        axis: "timestamp",
        advanced: { padding: [20, 22, 8, 8] },
      }),
    ).multilineTime,
    false,
  );
  for (const name of ["number", "fixed-2", "scientific", "iso-time"] as const) {
    const config = validateConfig({
      axis: "timestamp",
      advanced: { axes: [{ values: name }, { values: name }] },
    });
    assert.deepEqual(labels(config, 1, [3e9]), [formatValue(3e9, name)]);
    assert.deepEqual(labels(config, 0, [3e9]), [formatValue(3e9, name)]);
  }
  for (const name of ["fixed-2", "scientific", "iso-time"] as const) {
    assert.deepEqual(labels(validateConfig({ yFormat: name }), 1, [3e9]), [
      formatValue(3e9, name),
    ]);
    assert.equal(
      defaultLabelLayout(validateConfig({ axis: "timestamp", xFormat: name }))
        .multilineTime,
      false,
    );
  }
});

test("UTC tick increments have millisecond precision and cover the Date domain", () => {
  assert.equal(timestampTickIncrements[0], 1);
  assert.ok(timestampTickIncrements.every(Number.isInteger));
  assert.ok(timestampTickIncrements.at(-1)! > 1.728e16);
  assert.ok(
    timestampTickIncrements.every((v, i, all) => i === 0 || all[i - 1] < v),
  );
  const config = validateConfig({
    axis: "timestamp",
    advanced: { axes: [{ incrs: [0.25, 0.5, 1] }] },
  });
  assert.deepEqual(
    resolveOptions(config, 600, [{}]).axes![0].incrs,
    [0.25, 0.5, 1],
  );
});

test("nonlinear wall-time axes retain native legacy splits instead of promising whole milliseconds", () => {
  for (const xScale of ["log", "asinh"] as const) {
    const config = validateConfig({
      axis: "timestamp",
      xScale,
      xMin: 0.01,
      xMax: 1,
    });
    assert.equal(defaultLabelLayout(config).multilineTime, false);
    const axis = resolveOptions(config, 650, [{}]).axes![0];
    assert.equal(axis.size, 32);
    assert.equal(axis.align, undefined);
    assert.equal(axis.incrs, undefined);
    assert.deepEqual(
      labels(config, 0, [0.01, 0.1, 1]),
      [0.01, 0.1, 1].map((value) => formatXValue(value, "timestamp", "number")),
    );
  }
});
