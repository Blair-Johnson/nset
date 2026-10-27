import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "./api";
import { chartConfigValue, chartDetailsData } from "./chart-details-data";
import { chartIdentities } from "./chart-identities";
import { newChart, resolveSources } from "./workspace";
import type { CardContext } from "./workspace-types";

function context(): CardContext {
  return {
    api: new Api(() => ""),
    selectedRunIds: ["a", "b"],
    store: { load: async () => [], clear() {} },
    catalog: {
      experiments: [],
      runs: ["a", "b"].map((id) => ({
        id,
        name: "Same name",
        experiment_id: "e",
        status: "finished",
        params: { optimizer: { lr: id === "a" ? 0.01 : 0.02 }, hidden: 42 },
        tags: {},
        created_at: 1,
        updated_at: 1,
      })),
      series: ["a", "b"].flatMap((run_id) =>
        ["loss", "accuracy"].map((key) => ({
          run_id,
          key,
          kind: "metric",
          count: 1,
          last_step: 1,
          last_timestamp: 1,
          last_value: 1,
        })),
      ),
    },
  };
}

test("configuration paths are literal, own-only, and show explicit missing values", () => {
  const params = {
    "optimizer.lr": 3,
    optimizer: { lr: 0.1 },
    nil: null,
    flag: false,
    empty: "",
  };
  assert.equal(chartConfigValue(params, ["optimizer.lr"]), "3");
  assert.equal(chartConfigValue(params, ["optimizer", "lr"]), "0.1");
  assert.equal(chartConfigValue(params, ["nil"]), "null");
  assert.equal(chartConfigValue(params, ["flag"]), "false");
  assert.equal(chartConfigValue(params, ["empty"]), "");
  assert.equal(chartConfigValue(params, ["absent"]), "—");
  assert.equal(chartConfigValue(params, []), "—");
  assert.equal(
    chartConfigValue(Object.create({ inherited: 4 }), ["inherited"]),
    "—",
  );
  assert.equal(chartConfigValue({ constructor: 4 }, ["constructor"]), "—");
  assert.equal(chartConfigValue(params, ["optimizer", "__proto__"]), "—");
});

test("only chosen fields and plotted runs appear, once per run and in source order", () => {
  const ctx = context();
  const chart = newChart("timeseries", ["loss", "accuracy"]);
  chart.details = {
    configFields: [
      { path: ["optimizer", "lr"], label: "Learning rate" },
      { path: ["missing"] },
    ],
  };
  const data = chartDetailsData(chart, ctx);
  assert.deepEqual(
    data.columns.map((column) => column.id),
    ["a", "b"],
  );
  assert.deepEqual(
    data.columns.map((column) => column.values),
    [
      ["0.01", "—"],
      ["0.02", "—"],
    ],
  );
  assert.deepEqual(
    data.fields.map((field) => field.label),
    ["Learning rate", "missing"],
  );
  chart.source = {
    mode: "explicit",
    series: [{ runId: "b", key: "loss", kind: "metric" }],
  };
  assert.deepEqual(
    chartDetailsData(chart, ctx).columns.map((column) => column.id),
    ["b"],
  );
});

test("semantic aliases use stable IDs and collisions retain full identity", () => {
  const ctx = context();
  const chart = newChart("timeseries", ["loss"]);
  ctx.runLabels = { a: "Alias", b: "Alias" };
  assert.deepEqual(
    chartDetailsData(chart, ctx).columns.map((column) => column.name),
    ["Alias (a)", "Alias (b)"],
  );
  ctx.labelMode = "original";
  assert.deepEqual(
    chartDetailsData(chart, ctx).columns.map((column) => column.name),
    ["Same name (a)", "Same name (b)"],
  );
});

test("first plotted source style supplies the configuration identity color", () => {
  const ctx = context();
  const chart = newChart("timeseries", ["loss", "accuracy"]);
  const sources = resolveSources(chart, ctx.selectedRunIds, ctx.catalog);
  chart.config.runs[sources[0].id] = { color: "#123456", dash: [4, 2] };
  chart.config.runs[sources[1].id] = { color: "#abcdef" };
  const first = chartDetailsData(chart, ctx).columns[0];
  assert.equal(first.color, "#123456");
  assert.deepEqual(first.dash, [4, 2]);
});

test("catalog polling counts do not change the rendered data projection", () => {
  const ctx = context();
  const chart = newChart("timeseries", ["loss"]);
  const before = chartDetailsData(chart, ctx);
  ctx.catalog.series[0].count++;
  ctx.catalog.runs[0].updated_at++;
  assert.deepEqual(chartDetailsData(chart, ctx), before);
});

test("record bindings resolve portable UIDs to the same stable run identities", () => {
  const ctx = context();
  ctx.catalog.runs.forEach((run) => {
    run.rx = { sourceId: "records", uid: `uid-${run.id}`, state: "finished" };
  });
  const chart = newChart("timeseries", []);
  chart.records = {
    sourceId: "records",
    runUids: ["uid-b"],
    x: "step",
    ys: ["loss", "accuracy"],
    filters: { any: false, conditions: [] },
  };
  ctx.runLabels = { b: "Record alias" };
  chart.details = { configFields: [{ path: ["optimizer", "lr"] }] };
  const data = chartDetailsData(chart, ctx);
  assert.deepEqual(
    data.columns.map((column) => [column.id, column.name, column.values]),
    [["b", "Record alias", ["0.02"]]],
  );
  chart.records.runUids = [];
  ctx.selectedRunIds = ["a"];
  assert.deepEqual(
    chartDetailsData(chart, ctx).columns.map((column) => column.id),
    ["a"],
  );
});

test("column names exactly match the shared chart identity helper", () => {
  const ctx = context();
  const chart = newChart("timeseries", ["loss", "accuracy"]);
  ctx.runLabels = { a: "Same name (b)" };
  const sources = resolveSources(chart, ctx.selectedRunIds, ctx.catalog);
  const identities = chartIdentities(sources, ctx);
  const columns = chartDetailsData(chart, ctx).columns;
  assert.deepEqual(
    columns.map((column) => column.name),
    ["Same name (b) (a)", "Same name (b) (b)"],
  );
  for (const column of columns) {
    const first = sources.find((source) => source.runId === column.id)!;
    assert.equal(column.name, identities.get(first.id)!.name);
  }
});
