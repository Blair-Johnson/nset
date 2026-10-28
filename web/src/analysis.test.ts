import assert from "node:assert/strict";
import test from "node:test";
import { runStartTime, type Run } from "./api";
import { analyze, type PlotRun } from "./analysis";
import { defaults, type ViewConfig } from "./config";
import type { Point } from "./math";

const day = 86_400_000;
const start = 1_700_000_000_000;
const importedAt = start + 60 * day;
function run(id: string, created_at: number, originalStart?: number): Run {
  return {
    id,
    experiment_id: "e",
    name: id,
    status: "finished",
    params: {},
    tags: originalStart === undefined ? {} : {
      "mlflow_import.run_id": `original-${id}`,
      "mlflow_import.start_time": originalStart,
    },
    created_at,
    updated_at: created_at,
  };
}
function point(timestamp: number, value: number, seq = 1): Point {
  return { timestamp, value, seq, step: seq - 1 };
}
function config(axis: ViewConfig["axis"]): ViewConfig {
  return { ...defaults(), axis, smoothing: false, interpolation: "linear" };
}

test("relative time aligns imported original starts weeks apart and native runs", () => {
  const originals = [start, start + 21 * day];
  const data: PlotRun[] = originals.map((origin, i) => ({
    run: run(`imported-${i}`, importedAt + i * 1000, origin),
    raw: [point(origin + 5000, 2), point(origin + 7000, 6, 2)],
  }));
  data.push({
    run: run("native", importedAt),
    raw: [point(importedAt + 5000, 2), point(importedAt + 7000, 6, 2)],
  });
  const before = structuredClone(data);
  for (const trace of analyze(data, config("relative"))) {
    assert.deepEqual(trace.observations, [[5000, 2], [7000, 6]]);
    assert.equal(trace.fn.at(0), null); // Delayed logging is not run start.
    assert.equal(trace.fn.at(6000), 4);
  }
  assert.deepEqual(data, before);
  // Wall time and step still use exactly the recorded coordinates.
  assert.deepEqual(
    analyze(data, config("timestamp")).map((trace) => trace.observations),
    data.map(({ raw }) => raw.map((p) => [p.timestamp, p.value])),
  );
  for (const trace of analyze(data, config("step"))) {
    assert.deepEqual(trace.observations, [[0, 2], [1, 6]]);
  }
  assert.deepEqual(data, before);
});

test("relative channels retain different logging delays within the same imported run", () => {
  const imported = run("imported", importedAt, start);
  const y = [point(start + 5000, 10), point(start + 15000, 0, 2)];
  const x = [point(start + 10000, 100), point(start + 20000, 200, 2)];
  const traces = analyze([
    { run: imported, raw: y },
    { run: imported, raw: x },
    { run: imported, raw: y, x: { run: imported, raw: x, key: "counter" } },
  ], config("relative"));
  assert.deepEqual(traces[0].observations, [[5000, 10], [15000, 0]]);
  assert.deepEqual(traces[1].observations, [[10000, 100], [20000, 200]]);
  assert.deepEqual(traces[2].points, [[100, 5], [150, 0]]);
  assert.deepEqual(traces[2].observations, [[150, 0]]);
});

test("relative XY joins resolve the original start of each run independently", () => {
  const laterStart = start + 21 * day;
  const [trace] = analyze([{
    run: run("y", importedAt, start),
    raw: [point(start + 5000, 10), point(start + 15000, 0, 2)],
    x: {
      run: run("x", importedAt + 1000, laterStart),
      raw: [point(laterStart + 10000, 100), point(laterStart + 20000, 200, 2)],
      key: "counter",
    },
  }], config("relative"));
  assert.deepEqual(trace.points, [[100, 5], [150, 0]]);
  assert.deepEqual(trace.observations, [[150, 0]]);
});

test("run origin accepts importer milliseconds including zero and rejects malformed tags", () => {
  assert.equal(runStartTime(run("native", start)), start);
  assert.equal(runStartTime(run("imported", importedAt, start)), start);
  assert.equal(runStartTime(run("epoch", importedAt, 0)), 0);
  for (const invalid of [undefined, null, "", "1700000000000", true, {}, [],
    NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const malformed = run("malformed", start);
    malformed.tags["mlflow_import.start_time"] = invalid;
    assert.equal(runStartTime(malformed), start);
    const [trace] = analyze([
      { run: malformed, raw: [point(start + 5000, 2)] },
    ], config("relative"));
    assert.deepEqual(trace.observations, [[5000, 2]]);
  }
});
