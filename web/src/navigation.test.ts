import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_LIMIT,
  ViewHistory,
  navigateRange,
  transform,
  inverse,
} from "./navigation";
import { resolveOptions } from "./options";
import { validateConfig } from "./config";

const close = (actual: number, expected: number) =>
  assert.ok(
    Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)),
    `${actual} != ${expected}`,
  );
test("linear zoom, anchored zoom, pan and reversed display directions", () => {
  assert.deepEqual(navigateRange([0, 100], {}, 2), [25, 75]);
  assert.deepEqual(navigateRange([0, 100], {}, 2, 0, 0.2), [10, 60]);
  assert.deepEqual(navigateRange([0, 100], {}, 1, 0.1), [10, 110]);
  assert.deepEqual(navigateRange([0, 100], { dir: -1 }, 1, 0.1), [-10, 90]);
});
test("log pan preserves multiplicative span, zoom uses geometric midpoint", () => {
  const scale = { distr: 3 };
  const zoom = navigateRange([1, 100], scale, 2)!;
  close(zoom[0], Math.sqrt(10));
  close(zoom[1], Math.sqrt(1000));
  const pan = navigateRange([1, 100], scale, 1, 0.5)!;
  close(pan[0], 10);
  close(pan[1], 1000);
});
test("asinh threshold and reversal remain invertible across zero", () => {
  const scale = { distr: 4, asinh: 3, dir: -1 };
  for (const value of [-100, -1, 0, 1, 100])
    close(inverse(transform(value, scale), scale), value);
  const range = navigateRange([-100, 100], scale, 2)!;
  close(transform(range[1], scale), transform(100, scale) / 2);
  close(range[0], -range[1]);
  const pan = navigateRange([-100, 100], scale, 1, 0.1)!;
  assert.ok(pan[0] < -100 && pan[1] < 100);
});
test("invalid and overflow navigation is rejected rather than corrupting scales", () => {
  for (const factor of [0, -1, Infinity, NaN])
    assert.equal(navigateRange([1, 100], { distr: 3 }, factor), null);
  assert.equal(navigateRange([1, 100], { distr: 3 }, 1, 1e8), null);
  assert.equal(navigateRange([0, 100], { distr: 3 }), null);
  assert.equal(navigateRange([1, 1], {}), null);
});
test("history is bounded, snapshots are copied and duplicate views are omitted", () => {
  const history = new ViewHistory();
  const view = { x: [0, 1] as [number, number], y: [0, 1] as [number, number] };
  history.push(view);
  history.push(view);
  view.x[0] = -1;
  assert.equal(history.length, 1);
  assert.deepEqual(history.pop()?.x, [0, 1]);
  for (let i = 0; i < 100; i++) history.push({ x: [i, i + 1], y: [0, 1] });
  assert.equal(history.length, HISTORY_LIMIT);
  for (let i = 99; i >= 100 - HISTORY_LIMIT; i--)
    assert.equal(history.pop()?.x[0], i);
  assert.equal(history.pop(), undefined);
});
test("light axes retain advanced explicit color overrides", () => {
  const options = resolveOptions(validateConfig({}), 800, [{}]);
  assert.equal(options.axes?.[0].stroke, "#475569");
  assert.equal(options.axes?.[0].grid?.stroke, "#e2e8f0");
  const custom = resolveOptions(
    validateConfig({
      advanced: { axes: [{ stroke: "red", grid: { stroke: "blue" } }] },
    }),
    800,
    [{}],
  );
  assert.equal(custom.axes?.[0].stroke, "red");
  assert.equal(custom.axes?.[0].grid?.stroke, "blue");
});

test("no-op nonlinear navigation does not drift or create new history", () => {
  for (const scale of [{ distr: 3 }, { distr: 4, asinh: 3 }]) {
    assert.deepEqual(navigateRange([1.23, 99.87], scale), [1.23, 99.87]);
  }
});
