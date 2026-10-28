import test from "node:test";
import assert from "node:assert/strict";
import { defaults, validateConfig, type ViewConfig } from "./config";
import { applyDashboardControls, smoothingValue } from "./dashboard-controls";

test("sigma is an unbounded positive bandwidth, and zero only disables", () => {
  assert.equal(smoothingValue(defaults()), 0);
  for (const sigma of [Number.MIN_VALUE, 0.25, 1, 50, 1000]) {
    const enabled = applyDashboardControls(defaults(), {
      smoothingSigma: sigma,
    });
    assert.equal(enabled.smoothing, true);
    assert.equal(smoothingValue(enabled), sigma);
    const disabled = applyDashboardControls(enabled, { smoothingSigma: 0 });
    assert.equal(disabled.smoothing, false);
    assert.equal(disabled.smoothingSigma, sigma);
    assert.equal(smoothingValue(disabled), 0);
    assert.deepEqual(applyDashboardControls(disabled, {}), disabled);
  }
});

test("invalid sigma edits fail without mutation; old alpha is rejected", () => {
  const source = defaults();
  for (const sigma of [NaN, Infinity, -Infinity, -0.1]) {
    assert.throws(
      () => applyDashboardControls(source, { smoothingSigma: sigma }),
      RangeError,
    );
    assert.deepEqual(source, defaults());
  }
  assert.throws(
    () => validateConfig({ smoothing: true, alpha: 0.2 }),
    /unknown setting/,
  );
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
    smoothingSigma: 0.0001,
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
  assert.deepEqual(applyDashboardControls(source, { smoothingSigma: 50 }), {
    ...source,
    smoothing: true,
    smoothingSigma: 50,
  });
  const next = applyDashboardControls(source, {
    axis: "relative",
    smoothingSigma: 0,
  });
  assert.equal(next.axis, "relative");
  assert.equal(next.smoothing, false);
  assert.equal(next.smoothingSigma, source.smoothingSigma);
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
