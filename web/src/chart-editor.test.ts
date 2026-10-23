import { test } from "node:test";
import assert from "node:assert/strict";
import {
  choicePage,
  editorSourceChoices,
  editorAxisTitle,
  removeOverride,
  setEditorAxis,
  setEditorBounds,
  setEditorToggle,
  smoothingAlpha,
} from "./chart-editor";
import { defaults, effectiveRange, validateConfig } from "./config";
import { newChart, seriesId, validateChart } from "./workspace";
import type { Catalog, SeriesRef } from "./workspace-types";

const catalog: Catalog = {
  experiments: [
    { id: "e1", name: "Baseline", created_at: 0 },
    { id: "e2", name: "Transfer", created_at: 0 },
  ],
  runs: [
    {
      id: "r1",
      experiment_id: "e1",
      name: "Seed one",
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
    },
    {
      id: "r2",
      experiment_id: "e2",
      name: "Seed two",
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
    },
  ],
  series: [
    {
      run_id: "r1",
      key: "train/loss",
      kind: "metric",
      count: 400,
      last_step: 399,
      last_timestamp: 500,
      last_value: 0.2,
    },
    {
      run_id: "r2",
      key: "eval/loss",
      kind: "metric",
      count: 40,
      last_step: 39,
      last_timestamp: 500,
      last_value: 0.3,
    },
    {
      run_id: "r1",
      key: "eval/image",
      kind: "image",
      count: 4,
      last_step: 39,
      last_timestamp: 500,
      last_value: null,
    },
  ],
};

test("selected-run picker filters kind and run IDs, retains unavailable chosen keys", () => {
  const card = newChart("timeseries", ["train/loss", "old/loss"]);
  const before = structuredClone(card);
  const choices = editorSourceChoices(card, catalog, ["r1"]);
  assert.deepEqual(
    choices.map((choice) => choice.key),
    ["old/loss", "train/loss"],
  );
  assert.equal(choices[0].available, false);
  assert.equal(choices[0].selected, true);
  assert.equal(choices[1].available, true);
  assert.deepEqual(card, before);
  assert.deepEqual(
    editorSourceChoices(newChart("image", []), catalog, ["r1"]).map(
      (choice) => choice.key,
    ),
    ["eval/image"],
  );
});

test("explicit sources can cross experiments; unavailable refs remain independently removable", () => {
  const card = newChart("timeseries", []);
  const missing: SeriesRef = { runId: "gone", key: "old/loss", kind: "metric" };
  card.source = { mode: "explicit", series: [missing] };
  const choices = editorSourceChoices(card, catalog, []);
  assert.equal(choices.length, 3);
  assert.ok(
    choices.some((choice) => choice.detail.includes("Transfer / Seed two")),
  );
  assert.equal(
    choices.find((choice) => choice.id === seriesId(missing))?.available,
    false,
  );
  assert.equal(
    choices.find((choice) => choice.id === seriesId(missing))?.selected,
    true,
  );
  assert.ok(choices.every((choice) => choice.ref?.kind === "metric"));
});

test("search and paging never render a hidden select-all catalog", () => {
  const choices = Array.from({ length: 1300 }, (_, i) => ({
    id: String(i),
    key: `metric/${i}`,
    label: `metric/${i}`,
    detail: i % 2 ? "Transfer Seed two" : "Baseline Seed one",
    selected: i % 2 === 0,
    available: true,
  }));
  const first = choicePage(choices, "", 0);
  assert.equal(first.total, 1300);
  assert.equal(first.rows.length, 20);
  assert.equal(first.pages, 65);
  assert.equal(choicePage(choices, "", 1).rows[0].id, "20");
  assert.equal(choicePage(choices, "transfer two", 999).rows.length, 10);
  assert.equal(choicePage(choices, "baseline", 0, true).total, 650);
  assert.equal(choicePage(choices, "no match", 9).page, 0);
});

test("editing bounds replaces conflicting advanced auto/range only", () => {
  const config = validateConfig({
    advanced: {
      title: "keep",
      scales: { y: { auto: false, range: [2, 5], dir: -1, log: 2 } },
      axes: [{ stroke: "navy" }, { label: "Value" }],
    },
  });
  setEditorBounds(config, "y", null, 8);
  assert.deepEqual(effectiveRange(config, "y"), [null, 8]);
  assert.deepEqual(config.advanced.scales, { y: { dir: -1, log: 2 } });
  assert.equal(config.advanced.title, "keep");
  validateConfig(config);
});

test("labels, format, grid, ticks and legend remove only their conflicting literal", () => {
  const config = validateConfig({
    advanced: {
      axes: [
        {
          label: "Old X",
          values: ["one", "two"],
          splits: [1, 2],
          grid: { show: false, stroke: "navy" },
          ticks: { show: false, width: 2 },
        },
        { label: "Old Y", grid: { show: true, stroke: "red" } },
      ],
      legend: { show: false, isolate: true },
      padding: [10, 20, 30, 40],
    },
  });
  setEditorAxis(config, "x", "label", "New X");
  setEditorAxis(config, "x", "values", "scientific");
  setEditorToggle(config, "grid", true);
  setEditorToggle(config, "ticks", true);
  setEditorToggle(config, "legend", true);
  const axes = config.advanced.axes as any[];
  assert.equal(axes[0].label, undefined);
  assert.equal(axes[0].values, undefined);
  assert.deepEqual(axes[0].splits, [1, 2]);
  assert.deepEqual(axes[0].grid, { stroke: "navy" });
  assert.deepEqual(axes[0].ticks, { width: 2 });
  assert.equal(axes[1].label, "Old Y");
  assert.deepEqual(config.advanced.legend, { isolate: true });
  assert.deepEqual(config.advanced.padding, [10, 20, 30, 40]);
  validateConfig(config);
});

test("missing overrides are a no-op and safe validation remains enforced", () => {
  const config = defaults();
  removeOverride(config, ["axes", 0, "grid", "show"]);
  assert.deepEqual(config.advanced, {});
  const card = newChart("timeseries", ["train/loss"]);
  card.config.yScale = "log";
  setEditorBounds(card.config, "y", -1, 4);
  assert.throws(() => validateChart(card), /positive/);
});

test("smoothing strength has predictable positive alpha at both ends", () => {
  assert.equal(smoothingAlpha(0), 1);
  assert.equal(smoothingAlpha(80), 0.19999999999999996);
  assert.equal(smoothingAlpha(99), 0.010000000000000009);
  assert.equal(smoothingAlpha(100), 0.01);
  assert.equal(smoothingAlpha(-10), 1);
});

test("automatic axis titles use actual metric keys, honest mixed labels, and never mutate the card", () => {
  const card = newChart("timeseries", ["train/loss"]);
  const before = structuredClone(card);
  assert.equal(editorAxisTitle(card, "y"), "train/loss");
  assert.equal(editorAxisTitle(card, "x"), "Step");
  assert.deepEqual(card, before);
  card.config.axis = "timestamp";
  assert.equal(editorAxisTitle(card, "x"), "Time");
  card.source = {
    mode: "explicit",
    series: [
      { runId: "r1", key: "eval/loss", kind: "metric" },
      { runId: "r2", key: "eval/loss", kind: "metric" },
    ],
  };
  assert.equal(editorAxisTitle(card, "y"), "eval/loss");
  card.source.series.push({ runId: "r1", key: "accuracy", kind: "metric" });
  assert.equal(editorAxisTitle(card, "y"), "Metric value (mixed metrics)");
  card.source = { mode: "selected", keys: [] };
  assert.equal(editorAxisTitle(card, "y"), "Metric value");
});

test("saved axis titles and literal empty labels remain authoritative", () => {
  const card = newChart("timeseries", ["train/loss"]);
  card.config.yLabel = "Loss (nats)";
  assert.equal(editorAxisTitle(card, "y"), "Loss (nats)");
  card.config.advanced.axes = [{ label: "Epoch" }, { label: "Literal score" }];
  assert.equal(editorAxisTitle(card, "y"), "Literal score");
  assert.equal(editorAxisTitle(card, "x"), "Epoch");
  (card.config.advanced.axes as any[])[1].label = "";
  assert.equal(editorAxisTitle(card, "y"), "");
  setEditorAxis(card.config, "y", "label", "Edited title");
  assert.equal(editorAxisTitle(card, "y"), "Edited title");
  setEditorAxis(card.config, "y", "label", "");
  assert.equal(editorAxisTitle(card, "y"), "train/loss");
});
