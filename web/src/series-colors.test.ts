import test from "node:test";
import assert from "node:assert/strict";
import { defaults, palette } from "./config";
import {
  runColor,
  setRunColor,
  withRunColors,
  RUN_COLORS_KEY,
} from "./series-colors";
import type { Catalog, ResolvedSeries } from "./workspace-types";
const catalog: Catalog = {
  experiments: [],
  series: [],
  runs: ["b", "a", "c"].map((id) => ({
    id,
    name: id,
    experiment_id: "e",
    created_at: 1,
    updated_at: 2,
    status: "finished",
    params: {},
    tags: {},
  })),
};
function store(initial = "{}"): Storage {
  const map = new Map([[RUN_COLORS_KEY, initial]]);
  return {
    get length() {
      return map.size;
    },
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
  };
}
function sources(): ResolvedSeries[] {
  return ["a", "b", "a"].map((runId, i) => ({
    id: `series${i}`,
    runId,
    key: `loss${i}`,
    kind: "metric",
    run: catalog.runs.find((r) => r.id === runId)!,
    label: runId,
  }));
}
test("shared colors remain independent of source order and selected subset", () => {
  const storage = store();
  assert.equal(runColor(catalog, "a", storage), palette[0]);
  assert.equal(runColor(catalog, "b", storage), palette[1]);
  assert.equal(
    runColor({ ...catalog, runs: [...catalog.runs].reverse() }, "a", storage),
    palette[0],
  );
  const full = withRunColors(defaults(), sources(), catalog);
  const subset = withRunColors(defaults(), sources().slice(1), catalog);
  assert.equal(full.runs.series1.color, subset.runs.series1.color);
  assert.equal(full.runs.series0.color, full.runs.series2.color);
});
test("overrides persist, normalize and reset transactionally", () => {
  const storage = store();
  assert.equal(setRunColor("a", "#ABCDEF", storage), true);
  assert.equal(runColor(catalog, "a", storage), "#abcdef");
  assert.equal(JSON.parse(storage.getItem(RUN_COLORS_KEY)!).a, "#abcdef");
  const reloaded = store(storage.getItem(RUN_COLORS_KEY)!);
  assert.equal(runColor(catalog, "a", reloaded), "#abcdef");
  assert.equal(setRunColor("a", null, storage), true);
  assert.equal(runColor(catalog, "a", storage), palette[0]);
});
test("invalid colors and failed writes cannot change the visible preference", () => {
  const storage = store('{"a":"#123456"}');
  for (const value of ["red", "#123", "#12345678", "url(x)", "#gggggg", ""])
    assert.equal(setRunColor("a", value, storage), false);
  assert.equal(setRunColor("", "#ffffff", storage), false);
  storage.setItem = () => {
    throw Error("quota");
  };
  assert.equal(setRunColor("a", "#ffffff", storage), false);
  assert.equal(setRunColor("a", null, storage), false);
  assert.equal(runColor(catalog, "a", storage), "#123456");
});
test("corrupt preferences fail safely and prototype-like run IDs are plain data", () => {
  for (const raw of ["null", "[]", "invalid", '{"a":1}'])
    assert.equal(runColor(catalog, "a", store(raw)), palette[0]);
  const storage = store();
  assert.equal(setRunColor("__proto__", "#123456", storage), true);
  assert.equal(runColor(catalog, "__proto__", storage), "#123456");
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});
test("display colors preserve explicit series styles without mutating saved config", () => {
  const config = defaults();
  config.runs.series1 = { color: "#ffffff", width: 5 };
  const before = structuredClone(config);
  const applied = withRunColors(config, sources(), catalog);
  assert.deepEqual(config, before);
  assert.equal(applied.runs.series1.color, "#ffffff");
  assert.equal(applied.runs.series1.width, 5);
  config.palette = false;
  assert.equal(withRunColors(config, sources(), catalog), config);
});
