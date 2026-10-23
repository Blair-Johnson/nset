import test from "node:test";
import assert from "node:assert/strict";
import { defaults, validateConfig } from "./config";
import { resolveOptions } from "./options";

test("timestamp defaults produce distinct UTC ticks with adequate spacing", () => {
  const config = defaults();
  config.axis = "timestamp";
  const options = resolveOptions(config, 1000, [{}]);
  const axis = options.axes![0];
  const values = axis.values as (...args: unknown[]) => string[];
  const labels = values({}, [1735689600000, 1735689605000], 0, 170, 5000);
  assert.notEqual(labels[0], labels[1]);
  assert.match(labels[0], /2025-01-01.*00:00:00/);
  assert.match(labels[1], /2025-01-01.*00:00:05/);
  assert.ok(Number(axis.space) >= 160);
});

test("explicit advanced timestamp formatter and spacing remain configurable", () => {
  const config = validateConfig({
    ...defaults(),
    axis: "timestamp",
    advanced: {
      axes: [{ values: "scientific", space: 80 }],
    },
  });
  const axis = resolveOptions(config, 1000, [{}]).axes![0];
  assert.equal(axis.space, 80);
  const values = axis.values as (...args: unknown[]) => string[];
  assert.match(values({}, [1735689600000], 0, 80, 5000)[0], /e\+12/);
});
