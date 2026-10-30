import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { patchUplotLogRanges, uplotLogRanges } from "../build/uplot-compat";

test("log-range compatibility patch matches the pinned uPlot exactly once", () => {
  const source = readFileSync(
    new URL("../node_modules/uplot/dist/uPlot.esm.js", import.meta.url),
    "utf8",
  );
  const patched = patchUplotLogRanges(source);
  assert.notEqual(patched, source);
  assert.ok(patched.includes("Math.log10(opts.max) > Math.log10(opts.min)"));
  assert.ok(patched.includes(": opts.max - opts.min < 1e-16"));
});

test("dependency drift cannot silently skip or duplicate the log-range patch", () => {
  assert.throws(
    () => patchUplotLogRanges("different source"),
    /no longer matches/,
  );
  assert.throws(
    () =>
      patchUplotLogRanges(
        "opts.max - opts.min < 1e-16; opts.max - opts.min < 1e-16",
      ),
    /no longer matches/,
  );
});

test("dev query suffixes and production source use the same transform", () => {
  const transform = uplotLogRanges().transform;
  assert.equal(typeof transform, "function");
  const source = "if (opts.max - opts.min < 1e-16) return;";
  for (const suffix of ["", "?v=cache-key"]) {
    const result = Reflect.apply(transform as Function, {}, [
      source,
      `/node_modules/uplot/dist/uPlot.esm.js${suffix}`,
    ]);
    assert.equal(result.code, patchUplotLogRanges(source));
  }
  assert.equal(
    Reflect.apply(transform as Function, {}, [source, "/src/plot.ts"]),
    undefined,
  );
});
