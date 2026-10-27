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

test("semantic aliases preserve authored labels and internal IDs despite collisions", () => {
  const ctx = context();
  const chart = newChart("timeseries", ["loss"]);
  ctx.runLabels = { a: "Alias", b: "Alias" };
  assert.deepEqual(
    chartDetailsData(chart, ctx).columns.map((column) => column.name),
    ["Alias", "Alias"],
  );
  assert.deepEqual(
    chartDetailsData(chart, ctx).columns.map((column) => column.id),
    ["a", "b"],
  );
  ctx.labelMode = "original";
  assert.deepEqual(
    chartDetailsData(chart, ctx).columns.map((column) => column.name),
    ["Same name", "Same name"],
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
    ["Same name (b)", "Same name"],
  );
  for (const column of columns) {
    const first = sources.find((source) => source.runId === column.id)!;
    assert.equal(column.name, identities.get(first.id)!.name);
  }
});

test("identity labels are exact, catalog-independent, and never append run or trace IDs", () => {
  const ctx = context();
  const chart = newChart("timeseries", ["loss", "accuracy"]);
  const sources = resolveSources(chart, ctx.selectedRunIds, ctx.catalog);
  const uuid = "639b1886-300e-46a0-942c-3a5690eb019b";
  const source = {
    ...sources[0],
    id: JSON.stringify(["metric", uuid, "loss"]),
    runId: uuid,
    run: { ...sources[0].run, id: uuid, name: "  Raw name  " },
  };
  const duplicate = { ...source, id: "independent-trace" };
  const traces = [source, duplicate, sources[1]];
  ctx.runLabels = { [uuid]: "  Authored alias  " };
  const ids = traces.map((trace) => trace.id);
  const semantic = chartIdentities(traces, ctx);
  assert.deepEqual([...semantic.keys()], ids);
  assert.deepEqual(
    [...semantic.values()].map((identity) => identity.id),
    ids,
  );
  for (const trace of [source, duplicate]) {
    assert.equal(semantic.get(trace.id)!.runId, uuid);
    assert.equal(semantic.get(trace.id)!.name, "  Authored alias  ");
    assert.equal(semantic.get(trace.id)!.metric, "loss");
    assert.equal(semantic.get(trace.id)!.label, "  Authored alias   · loss");
  }
  ctx.catalog.runs.push({ ...source.run, id: "unplotted" });
  assert.deepEqual(chartIdentities(traces, ctx), semantic);
  ctx.labelMode = "original";
  assert.equal(
    chartIdentities(traces, ctx).get(source.id)!.name,
    "  Raw name  ",
  );
  ctx.labelMode = "semantic";
  ctx.runLabels = { [uuid]: "   " };
  assert.equal(
    chartIdentities(traces, ctx).get(source.id)!.name,
    "  Raw name  ",
  );
  ctx.runLabels = Object.create({ [uuid]: "Inherited alias" });
  assert.equal(
    chartIdentities(traces, ctx).get(source.id)!.name,
    "  Raw name  ",
  );
  const singleMetric = chartIdentities([source, duplicate], ctx);
  assert.equal(singleMetric.size, 2);
  assert.deepEqual(
    [...singleMetric.values()].map((identity) => identity.label),
    ["  Raw name  ", "  Raw name  "],
  );
  assert.ok(
    [...singleMetric.values()].every((identity) => identity.metric === ""),
  );
});

test("authored compact headings survive naming modes and chart-local source order", () => {
  const ctx = context();
  const chart = newChart("timeseries", ["loss"]);
  chart.details = { configRunLabels: { a: "A", b: "D" } };
  ctx.runLabels = { a: "Alias A", b: "Alias B" };
  for (const mode of ["semantic", "original"] as const) {
    ctx.labelMode = mode;
    assert.deepEqual(
      chartDetailsData(chart, ctx).columns.map((column) => column.name),
      ["A", "D"],
    );
    chart.source = {
      mode: "explicit",
      series: [{ runId: "b", key: "loss", kind: "metric" }],
    };
    assert.deepEqual(
      chartDetailsData(chart, ctx).columns.map((column) => column.name),
      ["D"],
    );
    chart.source = { mode: "selected", keys: ["loss"] };
  }
  chart.details.configRunLabels = { a: "A" };
  assert.deepEqual(
    chartDetailsData(chart, ctx).columns.map((column) => column.name),
    ["A", "Same name"],
  );
  chart.details.configRunLabels = Object.create({ a: "Inherited heading" });
  assert.equal(chartDetailsData(chart, ctx).columns[0].name, "Same name");
});

test("all authored rows remain ordered and differences compare raw values, not display text", () => {
  const ctx = context();
  const prefix = "x".repeat(110);
  ctx.catalog.runs[0].params = {
    typed: 1,
    missing: "\u2014",
    long: `${prefix}a`,
    same: { a: [1, 2] },
  };
  ctx.catalog.runs[1].params = {
    typed: "1",
    long: `${prefix}b`,
    same: { a: [1, 2] },
  };
  const chart = newChart("timeseries", ["loss", "accuracy"]);
  chart.details = {
    configFields: ["same", "typed", "missing", "long", "absent"].map((key) => ({
      path: [key],
    })),
  };
  const data = chartDetailsData(chart, ctx);
  assert.deepEqual(
    data.fields.map((field) => [field.label, field.differs]),
    [
      ["same", false],
      ["typed", true],
      ["missing", true],
      ["long", true],
      ["absent", false],
    ],
  );
  assert.deepEqual(data.columns[0].values, data.columns[1].values);
  assert.equal(data.columns[0].values[3], `${"x".repeat(97)}\u2026`);
  assert.equal(ctx.catalog.runs[0].params.long, `${prefix}a`);
  ctx.selectedRunIds = ["a"];
  assert.ok(
    chartDetailsData(chart, ctx).fields.every((field) => !field.differs),
  );
  ctx.selectedRunIds = [];
  assert.ok(
    chartDetailsData(chart, ctx).fields.every((field) => !field.differs),
  );
});

test("display truncation matches the prototype boundary without changing path safety", () => {
  assert.equal(
    chartConfigValue({ value: "x".repeat(100) }, ["value"]),
    "x".repeat(100),
  );
  assert.equal(
    chartConfigValue({ value: "x".repeat(101) }, ["value"]),
    `${"x".repeat(97)}\u2026`,
  );
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(chartConfigValue({ value: cycle }, ["value"]), "\u2014");
});
