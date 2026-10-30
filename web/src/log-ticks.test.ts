import { test } from "node:test";
import assert from "node:assert/strict";
import type uPlot from "uplot";
import { logAxisSplits, logTicks } from "./log-ticks";

function checkTicks(ticks: number[], min: number, max: number, limit: number) {
  assert.ok(ticks.length > 0 && ticks.length <= limit);
  ticks.forEach((value, index) => {
    assert.ok(Number.isFinite(value) && value > 0);
    assert.ok(value >= min && value <= max);
    if (index) assert.ok(value > ticks[index - 1]);
  });
}

test("fractional pans through tiny log bounds produce finite ascending ticks", () => {
  // Native logAxisSplits can promote 1.1e-9 to an increment with no fixedDec
  // entry, round its next step to zero, and never leave the split loop.
  for (const min of [1e-10, 9.9e-10, 9.99e-8, 9.75e-4]) {
    const ticks = logTicks(min, 0.1, 10, 900, 50);
    checkTicks(ticks, min, 0.1, 19);
    assert.ok(ticks.includes(0.1));
  }
  assert.deepEqual(logTicks(1e3, 1e6, 10, 300, 50), [1e3, 1e4, 1e5, 1e6]);
});

test("decimal powers are canonical and minor ticks only appear with room", () => {
  assert.deepEqual(
    logTicks(1e-10, 0.1, 10, 900, 50),
    [1e-10, 1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 0.1],
  );
  assert.deepEqual(
    logTicks(1, 10, 10, 1000, 40),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(logTicks(1, 10, 10, 200, 50), [1, 2, 5, 10]);
  assert.deepEqual(logTicks(1, 10, 10, 100, 50), [1, 10]);
});

test("base two uses powers and optional binary minor ticks", () => {
  assert.deepEqual(logTicks(1, 16, 2, 400, 60), [1, 2, 4, 8, 16]);
  assert.deepEqual(logTicks(1, 2, 2, 1000, 100), [1, 1.5, 2]);
});

test("full positive double range, subnormals, and near-overflow windows are bounded", () => {
  for (const base of [2, 10] as const) {
    for (const [min, max] of [
      [Number.MIN_VALUE, Number.MAX_VALUE],
      [Number.MIN_VALUE, Number.MIN_VALUE * 20],
      [1e-320, 1e-310],
      [1e-100, 1e100],
      [1e300, Number.MAX_VALUE],
      [Number.MAX_VALUE / 2, Number.MAX_VALUE],
    ]) {
      const ticks = logTicks(min, max, base, 500, 50);
      checkTicks(ticks, min, max, 11);
      const log = base === 10 ? Math.log10 : Math.log2;
      for (let i = 1; i < ticks.length; i++) {
        const gap =
          ((log(ticks[i]) - log(ticks[i - 1])) / (log(max) - log(min))) * 500;
        assert.ok(gap >= 50 - 1e-6);
      }
    }
    checkTicks(
      logTicks(Number.MIN_VALUE, Number.MAX_VALUE, base, 1e9, 0),
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      4096,
    );
  }
});

test("empty, invalid, tiny, and narrower-than-one-tick viewports terminate", () => {
  for (const [min, max] of [
    [0, 1],
    [-1, 1],
    [1, 1],
    [2, 1],
    [NaN, 2],
    [1, Infinity],
  ]) {
    assert.deepEqual(logTicks(min, max, 10, 500), []);
  }
  for (const pixels of [0, -1, NaN, Infinity]) {
    assert.deepEqual(logTicks(1, 10, 10, pixels), []);
  }
  assert.deepEqual(logTicks(1.01, 1.02, 10, 500), [1.01]);
  assert.deepEqual(logTicks(1, 10, 10, 1), [1]);
  const min = 1e300,
    max = min * (1 + Number.EPSILON);
  checkTicks(logTicks(min, max, 10, 500), min, max, 11);
});

test("uPlot adapter honors x/y bases, CSS space callbacks, and reversed directions", () => {
  for (const base of [2, 10] as const) {
    for (const dir of [1, -1]) {
      for (const axisIndex of [0, 1]) {
        const key = axisIndex === 0 ? "x" : "y";
        const min = 1,
          max = base ** 4,
          pixels = axisIndex === 0 ? 800 : 400;
        let calls = 0;
        const plot = {
          axes: [{ scale: "x" }, { scale: "y" }],
          scales: { x: { log: base, dir }, y: { log: base, dir } },
          valToPos: (value: number, scaleKey: string) => {
            assert.equal(scaleKey, key);
            return ((dir * Math.log(value)) / Math.log(max)) * pixels;
          },
        } as unknown as uPlot;
        plot.axes[axisIndex].space = (_u, index, lo, hi, dimension) => {
          calls++;
          assert.deepEqual(
            [index, lo, hi, dimension],
            [axisIndex, min, max, pixels],
          );
          return 60;
        };
        assert.deepEqual(
          logAxisSplits(plot, axisIndex, min, max, 0, 0),
          logTicks(min, max, base, pixels, 60),
        );
        assert.equal(calls, 1);
      }
    }
  }
});

test("tiny-decade pans refresh ticks despite oversized native increment spacing", () => {
  for (const base of [2, 10] as const) {
    for (const dir of [1, -1]) {
      for (const axisIndex of [0, 1]) {
        const key = axisIndex === 0 ? "x" : "y";
        const pixels = 1000;
        const log = base === 10 ? Math.log10 : Math.log2;
        let min = 1e3,
          max = 1e6;
        const plot = {
          axes: [
            { scale: "x", space: 50 },
            { scale: "y", space: 50 },
          ],
          scales: { x: { log: base, dir }, y: { log: base, dir } },
          valToPos: (value: number, scaleKey: string) => {
            assert.equal(scaleKey, key);
            return (
              ((dir * (log(value) - log(min))) / (log(max) - log(min))) * pixels
            );
          },
        } as unknown as uPlot;
        let previous = logAxisSplits(plot, axisIndex, min, max, 1e5, 100);
        for (const bounds of [
          [1e-100, 1e-90],
          [1e-300, 1e-290],
        ]) {
          [min, max] = bounds;
          // Installed uPlot's default findIncr scans to this known increment:
          // tiny bounds have intDigits=1 and fixedDec(1e-16)=16, so 1+16<=17.
          // Its positive foundSpace passes axesCalc's pre-split gate, but is
          // unrelated to useful log tick spacing and must not suppress ticks.
          const foundIncr = 1e-16;
          const foundSpace = (pixels * foundIncr) / (max - min);
          assert.ok(Number.isFinite(foundSpace) && foundSpace > pixels);
          const ticks = logAxisSplits(
            plot,
            axisIndex,
            min,
            max,
            foundIncr,
            foundSpace,
          );
          checkTicks(ticks, min, max, 21);
          assert.ok(ticks.length > 1);
          assert.ok(ticks.some((value) => value > min && value < max));
          assert.notDeepEqual(ticks, previous);
          assert.deepEqual(ticks, logTicks(min, max, base, pixels, 50));
          previous = ticks;
        }
      }
    }
  }
});
