import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "./config";
import { smoothingCoordinate, smoothingUnit } from "./smoothing-coordinate";

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("linear sigma uses steps or seconds for ordinary and joined coordinates", () => {
  for (const axis of ["step", "timestamp", "relative"] as const) {
    const config = { ...defaults(), axis };
    for (const joined of [false, true]) {
      const coordinate = smoothingCoordinate(config, joined);
      assert.equal(coordinate.transform(2000), axis === "step" ? 2000 : 2);
      assert.equal(coordinate.unit, axis === "step" ? "steps" : "seconds");
    }
    assert.equal(
      smoothingCoordinate(config, true).signature,
      smoothingCoordinate(config, false).signature,
    );
  }
});

test("log bandwidth uses configured decades or doublings and rejects nonpositive inputs", () => {
  const config = defaults();
  config.xScale = "log";
  config.joinScale = "log";
  for (const base of [2, 10] as const) {
    config.advanced = { scales: { x: { log: base } } };
    config.joinLog = base;
    for (const joined of [false, true]) {
      const coordinate = smoothingCoordinate(config, joined);
      near(coordinate.transform(base ** 3), 3);
      assert.equal(coordinate.unit, base === 2 ? "doublings" : "decades");
      for (const invalid of [0, -1, NaN, Infinity, -Infinity])
        assert.ok(Number.isNaN(coordinate.transform(invalid)));
    }
  }
});

test("joined time converts milliseconds to seconds before nonlinear transforms", () => {
  const config = { ...defaults(), axis: "relative" as const };
  config.joinScale = "log";
  near(smoothingCoordinate(config, true).transform(100_000), 2);
  config.xScale = "log";
  near(smoothingCoordinate(config, false).transform(100_000), 5);
  // A constant log offset does not change Gaussian distances.
  assert.equal(
    smoothingCoordinate(config, true).signature,
    smoothingCoordinate(config, false).signature,
  );
  config.joinScale = "asinh";
  config.joinAsinh = 2;
  config.xScale = "asinh";
  config.advanced = { scales: { x: { asinh: 2 } } };
  near(smoothingCoordinate(config, true).transform(4000), Math.asinh(2));
  near(smoothingCoordinate(config, false).transform(4000), Math.asinh(2000));
  assert.notEqual(
    smoothingCoordinate(config, true).signature,
    smoothingCoordinate(config, false).signature,
  );
  config.advanced = { scales: { x: { asinh: 2000 } } };
  assert.equal(
    smoothingCoordinate(config, true).signature,
    smoothingCoordinate(config, false).signature,
  );
});

test("XY coordinate ignores displayed metric X transform and unused join parameters", () => {
  const config = defaults();
  const original = smoothingCoordinate(config, true);
  config.xScale = "asinh";
  config.advanced = { scales: { x: { asinh: 75, log: 2, dir: -1 } } };
  config.joinLog = 2;
  config.joinAsinh = 100;
  assert.equal(smoothingCoordinate(config, true).signature, original.signature);
  assert.equal(smoothingCoordinate(config, true).transform(8), 8);
  config.joinScale = "asinh";
  assert.notEqual(
    smoothingCoordinate(config, true).signature,
    original.signature,
  );
  near(smoothingCoordinate(config, true).transform(-100), Math.asinh(-1));
  assert.equal(smoothingUnit(config, true), "asinh units");
});

test("signatures include axis and effective parameters, not cosmetic or inactive settings", () => {
  const config = defaults();
  const step = smoothingCoordinate(config, false).signature;
  config.joinScale = "log";
  config.advanced = { scales: { x: { log: 2, asinh: 3, dir: -1 } } };
  assert.equal(smoothingCoordinate(config, false).signature, step);
  config.axis = "timestamp";
  const timestamp = smoothingCoordinate(config, false).signature;
  assert.notEqual(timestamp, step);
  config.axis = "relative";
  assert.notEqual(smoothingCoordinate(config, false).signature, timestamp);
  config.xScale = "log";
  const log2 = smoothingCoordinate(config, false).signature;
  config.advanced = { scales: { x: { log: 10 } } };
  assert.notEqual(smoothingCoordinate(config, false).signature, log2);
  config.xScale = "asinh";
  const asinh1 = smoothingCoordinate(config, false).signature;
  config.advanced = { scales: { x: { asinh: 2 } } };
  assert.notEqual(smoothingCoordinate(config, false).signature, asinh1);
});

test("extreme finite inputs retain valid transforms and distinct effective thresholds", () => {
  const config = {
    ...defaults(),
    axis: "relative" as const,
    joinScale: "log" as const,
  };
  assert.ok(
    Number.isFinite(
      smoothingCoordinate(config, true).transform(Number.MIN_VALUE),
    ),
  );
  config.xScale = "asinh";
  config.advanced = { scales: { x: { asinh: Number.MIN_VALUE } } };
  const first = smoothingCoordinate(config, false);
  assert.ok(Number.isFinite(first.transform(Number.MAX_VALUE)));
  config.advanced = { scales: { x: { asinh: Number.MIN_VALUE * 2 } } };
  assert.notEqual(
    first.signature,
    smoothingCoordinate(config, false).signature,
  );
});

test("subnormal normalization does not conflate distinct asinh bandwidths", () => {
  const config = defaults();
  config.axis = "relative";
  config.xScale = "asinh";
  config.advanced = { scales: { x: { asinh: Number.MIN_VALUE * 1000 } } };
  const first = smoothingCoordinate(config, false).signature;
  config.advanced = { scales: { x: { asinh: Number.MIN_VALUE * 1001 } } };
  assert.notEqual(first, smoothingCoordinate(config, false).signature);
});
