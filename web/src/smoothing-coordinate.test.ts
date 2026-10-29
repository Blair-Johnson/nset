import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "./config";
import {
  smoothingBandwidth,
  smoothingCoordinate,
  smoothingUnit,
} from "./smoothing-coordinate";
import type { XY } from "./math";

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

test("log coordinate retains configured decades or doublings and rejects nonpositive inputs", () => {
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
  assert.equal(smoothingUnit(config, true), "equivalent steps");
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

const channel = (xs: number[]): XY[] => xs.map((x) => [x, 1]);

test("editor units describe raw-equivalent bandwidth, not transformed coordinates", () => {
  for (const axis of ["step", "relative", "timestamp"] as const) {
    for (const scale of ["linear", "log", "asinh"] as const) {
      const config = { ...defaults(), axis, xScale: scale, joinScale: scale };
      const unit = axis === "step" ? "steps" : "seconds";
      for (const joined of [false, true])
        assert.equal(
          smoothingUnit(config, joined),
          scale === "linear" ? unit : `equivalent ${unit}`,
        );
    }
  }
});

test("linear bandwidth is exactly the configured sigma regardless of domain", () => {
  for (const axis of ["step", "relative", "timestamp"] as const) {
    const config = { ...defaults(), axis, smoothingSigma: 0.123456789 };
    for (const joined of [false, true]) {
      for (const channels of [[], [channel([1])], [channel([-1e300, 1e300])]])
        assert.equal(
          smoothingBandwidth(config, joined, channels),
          config.smoothingSigma,
        );
    }
  }
});

test("log bandwidth preserves the raw-span fraction for either base and shared sparse/dense channels", () => {
  for (const base of [2, 10] as const) {
    const config = {
      ...defaults(),
      smoothingSigma: 99,
      xScale: "log" as const,
      joinScale: "log" as const,
      joinLog: base,
      advanced: { scales: { x: { log: base } } },
    };
    const sparse = channel([1, 1000]);
    const dense = channel(Array.from({ length: 100 }, (_, i) => i + 10));
    for (const joined of [false, true]) {
      const coordinate = smoothingCoordinate(config, joined);
      const expected =
        (99 * (coordinate.transform(1000) - coordinate.transform(1))) / 999;
      near(smoothingBandwidth(config, joined, [sparse, dense]), expected);
      near(smoothingBandwidth(config, joined, [sparse]), expected);
      near(
        smoothingBandwidth(config, joined, [
          dense,
          sparse,
          channel([-1e20, 0, NaN, Infinity]),
        ]),
        expected,
      );
    }
  }
});

test("nonlinear time bandwidth uses raw seconds and preserves coordinate transform semantics", () => {
  for (const axis of ["step", "relative", "timestamp"] as const) {
    for (const scale of ["log", "asinh"] as const) {
      const config = {
        ...defaults(),
        axis,
        xScale: scale,
        joinScale: scale,
        smoothingSigma: 3,
        joinAsinh: 2,
        advanced: { scales: { x: { asinh: 2000 } } },
      };
      const lo = scale === "log" ? 1000 : -4000;
      const hi = 10000;
      for (const joined of [false, true]) {
        const coordinate = smoothingCoordinate(config, joined);
        const span = (hi - lo) / (axis === "step" ? 1 : 1000);
        const transformedSpan =
          coordinate.transform(hi) - coordinate.transform(lo);
        near(
          smoothingBandwidth(config, joined, [channel([lo, 2000, hi])]) /
            transformedSpan,
          3 / span,
        );
      }
    }
  }
});

test("empty, singleton, invalid-log and collapsed domains have no smoothing bandwidth", () => {
  for (const scale of ["log", "asinh"] as const) {
    const config = { ...defaults(), xScale: scale, joinScale: scale };
    for (const joined of [false, true]) {
      for (const xs of [[], [2], [2, 2], [NaN, Infinity, -Infinity]])
        assert.equal(smoothingBandwidth(config, joined, [channel(xs)]), 0);
    }
  }
  const config = { ...defaults(), xScale: "log" as const };
  assert.equal(smoothingBandwidth(config, false, [channel([-10, 0])]), 0);
  assert.equal(smoothingBandwidth(config, false, [channel([-10, 0, 2])]), 0);
  // Distinct raw inputs can round to the same transformed coordinate.
  assert.equal(
    smoothingBandwidth(config, false, [channel([1, 2])], {
      ...smoothingCoordinate(config, false),
      transform: () => 1,
    }),
    0,
  );
});

test("extreme finite bandwidth mapping never returns Infinity or NaN", () => {
  for (const axis of ["step", "relative"] as const) {
    for (const sigma of [Number.MIN_VALUE, 1, Number.MAX_VALUE]) {
      const config = {
        ...defaults(),
        axis,
        smoothingSigma: sigma,
        xScale: "asinh" as const,
      };
      for (const xs of [
        [-Number.MAX_VALUE, Number.MAX_VALUE],
        [Number.MIN_VALUE, Number.MIN_VALUE * 2],
        [-1, 1],
      ]) {
        const mapped = smoothingBandwidth(config, false, [channel(xs)]);
        assert.ok(Number.isFinite(mapped) && mapped >= 0, `${mapped}`);
      }
    }
  }
  const config = {
    ...defaults(),
    xScale: "asinh" as const,
    smoothingSigma: 1e300,
  };
  const mapped = smoothingBandwidth(config, false, [channel([-1e308, 1e308])]);
  near(mapped / (Math.asinh(1e308) * 1e-8), 1);
});

test("subnormal millisecond spans retain their equivalent seconds bandwidth", () => {
  const m = Number.MIN_VALUE;
  const config = {
    ...defaults(),
    axis: "relative" as const,
    xScale: "log" as const,
    smoothingSigma: m,
  };
  const coordinate = smoothingCoordinate(config, false);
  const span = coordinate.transform(601 * m) - coordinate.transform(m);
  const mapped = smoothingBandwidth(config, false, [channel([m, 601 * m])]);
  assert.ok(Math.abs(mapped - span * (5 / 3)) < 1e-11);
});
