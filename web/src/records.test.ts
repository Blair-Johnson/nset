import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "./config";
import { analyze, xQuantity } from "./analysis";
import {
  newChart,
  validateChart,
  cameraAxis,
  validateWorkspace,
} from "./workspace";
import {
  recordPath,
  recordValue,
  validateRecordBinding,
  recordRuns,
  recordRequest,
  loadRecordPlot,
  appendRxCatalog,
  type RecordBinding,
} from "./records";
import { Api, type Run } from "./api";
import type { Catalog } from "./workspace-types";
const run: Run = {
  id: "rx:test:uid",
  experiment_id: "rx:test",
  name: "r859",
  status: "finished",
  params: {},
  tags: {},
  created_at: 0,
  updated_at: 1,
  rx: { sourceId: "rx:test", uid: "uid", state: "succeeded" },
};
const catalog: Catalog = {
  experiments: [{ id: "rx:test", name: "rx repo", created_at: 0 }],
  runs: [run],
  series: [],
  rx: { id: "rx:test", name: "repo" },
};
const binding: RecordBinding = {
  sourceId: "rx:test",
  runUids: [],
  x: "epoch",
  ys: ["train_loss", "val_loss"],
  filters: {
    any: false,
    conditions: [{ path: "kind", op: "eq", value: "epoch" }],
  },
};

test("record paths preserve nested/literal collisions, array indices, case and missing values", () => {
  const value = {
    metrics: { loss: 1 },
    "metrics.loss": 2,
    "": 4,
    arr: [{ value: 3 }],
  };
  assert.deepEqual(recordPath("metrics.loss"), ["metrics", "loss"]);
  assert.deepEqual(recordPath('$["metrics.loss"]'), ["metrics.loss"]);
  assert.equal(recordValue(value, "metrics.loss"), 1);
  assert.equal(recordValue(value, '$["metrics.loss"]'), 2);
  assert.equal(recordValue(value, "arr[0].value"), 3);
  assert.equal(recordValue(value, '$[""]'), 4);
  assert.equal(recordValue(value, "Metrics.loss"), undefined);
  for (const bad of ["", "$", "metrics.", "a[-1]", "a..b", "a[", "a b"])
    assert.throws(() => recordPath(bad));
});
test("record charts and layouts save/reopen exact unsuggested fields and filters", () => {
  const chart = newChart("timeseries", [], "Records");
  chart.records = {
    ...structuredClone(binding),
    ys: ["metrics.loss", '$["metrics.loss"]', "unseen.field"],
    group: "phase",
  };
  chart.layout = { width: 700, height: 400 };
  const saved = JSON.parse(JSON.stringify(chart));
  assert.deepEqual(validateChart(saved), chart);
  assert.equal(
    cameraAxis(chart),
    JSON.stringify(["records", "rx:test", "epoch"]),
  );
  const workspace = {
    version: 2,
    id: "view-rx",
    name: "Records",
    experimentId: "rx:test",
    selectedRunIds: [run.id],
    updatedAt: 1,
    sections: [
      { id: "section", title: "Charts", collapsed: false, cards: [chart] },
    ],
  };
  assert.deepEqual(
    validateWorkspace(JSON.parse(JSON.stringify(workspace))),
    workspace,
  );
  assert.throws(() => validateChart({ ...saved, kind: "image" }));
  assert.throws(() => validateRecordBinding({ ...binding, ys: [] }));
  assert.throws(() =>
    validateRecordBinding({
      ...binding,
      filters: {
        any: false,
        conditions: [{ path: "kind", op: "eq", value: {} }],
      },
    }),
  );
  assert.deepEqual(recordRuns(binding, catalog, [run.id]), ["uid"]);
  assert.deepEqual(recordRequest(binding, catalog, [run.id]).runs, ["uid"]);
});
test("paired record analysis retains fractional/repeated/restarted X in event order", () => {
  const points: [number, number][] = [
    [0.25, 3],
    [0.25, 2],
    [0.1, 1],
    [2, 4],
  ];
  const config = defaults();
  config.smoothing = false;
  const data = analyze(
    [{ run, raw: [], paired: { key: "epochs_seen", points } }],
    config,
  );
  assert.deepEqual(data[0].observations, points);
  assert.deepEqual(data[0].points, points);
  assert.equal(data[0].count, 4);
  assert.equal(xQuantity(data, config), "metric");
  assert.equal(data[0].fn.monotonic, false);
});
test("paired loader never downloads independent histories or invents a step", async () => {
  const requests: string[] = [];
  const api = new Api(
    () => "test",
    async (url, init) => {
      requests.push(String(url));
      const request = JSON.parse(init!.body as string);
      assert.equal(request.x, "epoch");
      assert.deepEqual(request.ys, ["train_loss", "val_loss"]);
      return new Response(
        JSON.stringify({
          traces: [
            {
              run_uid: "uid",
              y: "train_loss",
              group: null,
              points: [
                [1.5, 0.1, 5],
                [1.5, 0.2, 9],
              ],
            },
          ],
          diagnostics: {
            scanned: 3,
            matched: 2,
            skipped_axes: 1,
            reasons: [],
            partial: false,
            skipped_groups: 0,
            oversized: 0,
            invalid_json: 0,
            omitted_traces: 0,
          },
        }),
      );
    },
  );
  const result = await loadRecordPlot(api, binding, catalog, [run.id]);
  assert.deepEqual(requests, ["/api/rx/plot"]);
  assert.deepEqual(result.data[0].raw, []);
  assert.equal(result.sources[0].id, result.data[0].run.id);
  assert.equal(result.sources[0].runId, run.id);
  assert.deepEqual(result.data[0].paired?.points, [
    [1.5, 0.1],
    [1.5, 0.2],
  ]);
  assert.match(result.notes, /Repeated\/restarted X/);
  assert.match(result.notes, /missing\/non-numeric/);
});
test("rx catalog preserves stored state and readonly identity, with bounded pagination", async () => {
  let calls = 0;
  const api = new Api(
    () => "test",
    async () => {
      calls++;
      return new Response(
        JSON.stringify({
          source: { id: "rx:test", name: "repo", readonly: true },
          runs: [
            {
              id: calls,
              run_uid: `uid${calls}`,
              state: "queued",
              alias: null,
              config: "summary",
              argv: "[]",
              created_at: "2026-01-01T00:00:00Z",
              started_at: null,
              finished_at: null,
              exit_code: null,
            },
          ],
          next_after: calls,
        }),
      );
    },
  );
  const result = await appendRxCatalog(api, {
    experiments: [],
    runs: [],
    series: [],
  });
  assert.equal(calls, 5);
  assert.equal(result.runs[0].rx?.state, "queued");
  assert.equal(result.runs[0].id, "rx:test:uid1");
  assert.equal(result.rx?.nextAfter, 5);
});

test("paired EMA follows event order and ambiguous duplicate-X cursors stay undefined", () => {
  const config = defaults();
  config.smoothing = true;
  config.alpha = 0.5;
  const points: [number, number][] = [
    [1, 4],
    [1, 2],
    [0.5, 0],
  ];
  const [data] = analyze(
    [{ run, raw: [], paired: { key: "epoch", points } }],
    config,
  );
  assert.deepEqual(data.points, [
    [1, 4],
    [1, 3],
    [0.5, 1.5],
  ]);
  assert.deepEqual(data.observations, points);
  assert.equal(data.fn.at(1), null);
  assert.equal(data.fn.monotonic, false);
});
