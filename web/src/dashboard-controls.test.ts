import test from "node:test";
import assert from "node:assert/strict";
import { defaults, validateConfig, type ViewConfig } from "./config";
import { ema } from "./math";
import {
  MIN_SMOOTHING_ALPHA,
  strengthToAlpha,
  alphaToStrength,
  strengthToSmoothing,
  smoothingToStrength,
  applyDashboardControls,
} from "./dashboard-controls";

test("None to More has identity and finite strongest endpoints", () => {
  assert.deepEqual(strengthToSmoothing(0), { smoothing: false, alpha: 1 });
  assert.deepEqual(strengthToSmoothing(100), {
    smoothing: true,
    alpha: MIN_SMOOTHING_ALPHA,
  });
  assert.equal(strengthToAlpha(50), 0.1);
  assert.equal(alphaToStrength(1), 0);
  assert.equal(alphaToStrength(0.01), 100);
  assert.equal(smoothingToStrength(defaults()), 0);
});

test("slider increases strictly strengthen EMA, with fractional inverse round-trips", () => {
  let previousAlpha = 1;
  let previousOutput = 100;
  for (let strength = 0.25; strength <= 100; strength += 0.25) {
    const alpha = strengthToAlpha(strength);
    assert.ok(alpha > 0 && alpha < previousAlpha);
    assert.ok(Math.abs(alphaToStrength(alpha) - strength) < 1e-12);
    assert.ok(
      Math.abs(smoothingToStrength(strengthToSmoothing(strength)) - strength) <
        1e-12,
    );
    const output = ema(
      [
        [0, 0],
        [1, 100],
      ],
      alpha,
    )[1][1];
    assert.ok(output < previousOutput);
    previousAlpha = alpha;
    previousOutput = output;
  }
});

test("legacy alpha imports retain semantics until the slider is edited", () => {
  for (const alpha of [Number.MIN_VALUE, 0.0001, 0.01, 0.2, 0.9, 1]) {
    for (const smoothing of [true, false]) {
      const config = validateConfig({ smoothing, alpha });
      const before = structuredClone(config);
      const strength = smoothingToStrength(config);
      assert.equal(strength, smoothing ? alphaToStrength(alpha) : 0);
      assert.deepEqual(config, before);
      assert.deepEqual(applyDashboardControls(config, {}), config);
    }
  }
  assert.equal(alphaToStrength(Number.MIN_VALUE), 100);
  assert.equal(smoothingToStrength({ smoothing: true, alpha: 1 }), 0);
});

test("invalid slider/coefficient inputs fail explicitly", () => {
  for (const strength of [NaN, Infinity, -Infinity, -0.1, 100.1]) {
    assert.throws(() => strengthToAlpha(strength), RangeError);
    assert.throws(() => strengthToSmoothing(strength), RangeError);
    assert.throws(
      () => applyDashboardControls(defaults(), { smoothingStrength: strength }),
      RangeError,
    );
  }
  for (const alpha of [NaN, Infinity, -Infinity, 0, -0.1, 1.1]) {
    assert.throws(() => alphaToStrength(alpha), RangeError);
    assert.throws(
      () => smoothingToStrength({ smoothing: false, alpha }),
      RangeError,
    );
  }
});

const configured = () =>
  validateConfig({
    axis: "timestamp",
    xScale: "log",
    xMin: 10,
    xMax: 100,
    xFormat: "iso-time",
    xLabel: "User X title",
    yLabel: "Accuracy",
    yScale: "asinh",
    yMin: -3,
    yMax: 10,
    interpolation: "pchip",
    smoothing: true,
    alpha: 0.0001,
    runs: { one: { width: 3 } },
    advanced: {
      scales: {
        x: { dir: -1, log: 2, asinh: 5, auto: false, range: [20, 80] },
        y: { dir: 1, asinh: 0.5, range: [-2, 9] },
      },
      axes: [
        {
          label: "Explicit advanced title",
          splits: [20, 40],
          values: ["a", "b"],
          incrs: [10, 20],
          stroke: "red",
        },
        { values: "fixed-2", label: "User Y" },
      ],
      legend: { show: false },
    },
  });

test("axis changes deliberately clear coordinate-dependent X settings only, without mutation", () => {
  for (const axis of ["step", "relative"] as const) {
    const source = configured(),
      before = structuredClone(source);
    const next = applyDashboardControls(source, { axis });
    const expected = structuredClone(source);
    Object.assign(expected, {
      axis,
      xScale: "linear",
      xMin: null,
      xMax: null,
      xFormat: "number",
    });
    (expected.advanced.scales as Record<string, unknown>).x = { dir: -1 };
    (expected.advanced.axes as Record<string, unknown>[])[0] = {
      label: "Explicit advanced title",
      stroke: "red",
    };
    assert.deepEqual(next, expected);
    assert.deepEqual(source, before);
    assert.notEqual(next.advanced, source.advanced);
  }
});

test("smoothing-only or same-axis edits preserve advanced X settings; combined edits work", () => {
  const source = configured();
  assert.deepEqual(
    applyDashboardControls(source, { axis: "timestamp" }),
    source,
  );
  assert.deepEqual(applyDashboardControls(source, { smoothingStrength: 50 }), {
    ...source,
    smoothing: true,
    alpha: 0.1,
  });
  const next = applyDashboardControls(source, {
    axis: "relative",
    smoothingStrength: 0,
  });
  assert.equal(next.axis, "relative");
  assert.equal(next.smoothing, false);
  assert.equal(next.alpha, 1);
  assert.equal(next.xMin, null);
  assert.throws(
    () =>
      applyDashboardControls(source, { axis: "bogus" as ViewConfig["axis"] }),
    /axis/,
  );
  assert.equal(
    applyDashboardControls(defaults(), { axis: "timestamp" }).axis,
    "timestamp",
  );
});
