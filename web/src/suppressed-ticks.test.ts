import test from "node:test";
import assert from "node:assert/strict";
import {
  defaults,
  formatValue,
  validateConfig,
  type Formatter,
} from "./config";
import { formatter, resolveOptions } from "./options";

test("axis formatters preserve uPlot's suppressed log ticks as empty labels", () => {
  for (const name of [
    "number",
    "fixed-2",
    "scientific",
    "iso-time",
  ] as Formatter[]) {
    const values = formatter(name) as (...args: unknown[]) => string[];
    const labels = values({}, [null, 10, null, 100], 1, 50, 10);
    assert.deepEqual(labels, [
      "",
      formatValue(10, name),
      "",
      formatValue(100, name),
    ]);
  }
  assert.equal(
    formatValue(NaN, "number"),
    "—",
    "missing readouts remain explicit",
  );
});

test("suppressed ticks stay blank in all X coordinate systems and explicit formats", () => {
  for (const axis of ["step", "timestamp", "relative"] as const) {
    for (const advanced of [{}, { axes: [{ values: "scientific" }] }]) {
      const config = validateConfig({ ...defaults(), axis, advanced });
      const values = resolveOptions(config, 600, [{}]).axes![0].values as (
        ...args: unknown[]
      ) => string[];
      const labels = values({}, [null, 1000, null], 0, 50, 1000);
      assert.equal(labels[0], "");
      assert.equal(labels[2], "");
      assert.notEqual(labels[1], "");
      assert.notEqual(labels[1], "—");
    }
  }
});
