import { test } from "node:test";
import assert from "node:assert/strict";
import { Api, type Run } from "./api";
import type { Catalog } from "./workspace-types";
import {
  appendRxCatalog,
  loadRecordPage,
  loadRecordPlot,
  recordRequest,
  validateRecordBinding,
  type RecordBinding,
  type RecordResult,
} from "./records";

const binding: RecordBinding = {
  sourceId: "rx:test",
  runUids: [],
  x: "step",
  ys: ["loss", "score"],
  group: "phase",
  filters: { any: false, conditions: [] },
};
function catalog(count = 160): Catalog {
  return {
    experiments: [],
    series: [],
    rx: { id: "rx:test", name: "test", sourceGeneration: "g1" },
    runs: Array.from({ length: count }, (_, index): Run => ({
      id: `run${index}`,
      experiment_id: "rx:test",
      name: `r${index}`,
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
      rx: { sourceId: "rx:test", uid: `u${index}`, state: "succeeded" },
    })),
  };
}
function page(overrides: Partial<RecordResult> = {}): RecordResult {
  return {
    source_generation: "g1",
    coverage: "captured high-water",
    fields: [],
    records: [],
    traces: [],
    next_cursor: null,
    diagnostics: {
      scanned: 0,
      matched: 0,
      bytes: 0,
      points: 0,
      invalid_json: 0,
      oversized: 0,
      skipped_axes: 0,
      skipped_groups: 0,
      omitted_traces: 0,
      partial: false,
      reasons: [],
    },
    ...overrides,
  };
}
const reply = (value: unknown) => new Response(JSON.stringify(value));

test("160 selected runs automatically batch and finish every trace/page, retaining repeated X", async () => {
  const c = catalog();
  const uids = c.runs.map((run) => run.rx!.uid);
  assert.equal(
    validateRecordBinding({ ...binding, runUids: uids }).runUids.length,
    160,
  );
  let calls = 0;
  let active = 0;
  const seen = new Set<string>();
  const api = new Api(
    () => "test",
    async (_url, init) => {
      assert.equal(++active, 1, "requests should be sequential");
      calls++;
      const q = JSON.parse(init!.body as string);
      assert.equal(q.source_generation, "g1");
      assert.ok(q.runs.length <= 32);
      const offset = q.cursor ? Number(q.cursor) : 0;
      const traces: RecordResult["traces"] = [];
      for (const uid of q.runs as string[]) {
        const index = Number(uid.slice(1));
        seen.add(uid);
        if (index % 7 === 0) continue; // Missing requested fields are not errors.
        for (const y of q.ys as string[]) {
          for (const group of [1, "1"]) {
            const count = index === 1 && group === 1 ? 20_005 : 1;
            const points: [number, number, string][] = [];
            for (let i = offset; i < Math.min(count, offset + 10_000); i++)
              points.push([(i % 17) + 0.25, y === "loss" ? i : -i, String(i)]);
            if (points.length)
              traces.push({
                id: JSON.stringify([uid, y, group]),
                run_uid: uid,
                y,
                group,
                points,
              });
          }
        }
      }
      const more = q.runs.includes("u1") && offset < 20_000;
      const result = page({
        traces,
        next_cursor: more ? String(offset + 10_000) : null,
      });
      result.diagnostics.scanned = 10_000;
      result.diagnostics.matched = 10_000;
      result.diagnostics.partial = more;
      result.diagnostics.reasons = more ? ["scan budget reached"] : [];
      active--;
      return reply(result);
    },
  );
  const result = await loadRecordPlot(
    api,
    binding,
    c,
    c.runs.map((run) => run.id),
  );
  const eligible = c.runs.filter((_, index) => index % 7 !== 0).length;
  assert.equal(seen.size, 160);
  assert.equal(calls, 7);
  assert.equal(result.data.length, eligible * 4);
  assert.equal(result.warning, "");
  assert.doesNotMatch(result.notes, /Partial/);
  assert.match(result.notes, /Repeated\/restarted X/);
  assert.equal(result.sources.length, result.data.length);
  const curve = result.data.find(
    (value) => value.run.id === JSON.stringify(["u1", "loss", 1]),
  )!;
  assert.equal(curve.paired!.points.length, 20_005);
  assert.deepEqual(curve.paired!.points[10_000], [
    (10_000 % 17) + 0.25,
    10_000,
  ]);
  assert.deepEqual(curve.paired!.points.at(-1), [(20_004 % 17) + 0.25, 20_004]);
  assert.ok(result.sources.some((source) => source.run.rx?.uid === "u159"));
});

test("catalog discovery includes late eligible runs before selected-run plotting", async () => {
  const c: Catalog = { experiments: [], runs: [], series: [] };
  let plotted: string[] = [];
  const api = new Api(
    () => "test",
    async (url, init) => {
      if (!init?.body) {
        const after = new URL(String(url), "http://test").searchParams.has(
          "after",
        );
        return reply({
          source: { id: "rx:test", name: "test", readonly: true },
          high_water: "160",
          source_generation: "g1",
          next_after: after ? null : "100",
          runs: Array.from({ length: after ? 60 : 100 }, (_, i) => ({
            id: String(i + (after ? 100 : 0)),
            run_uid: `u${i + (after ? 100 : 0)}`,
            state: "succeeded",
            argv: "[]",
            created_at: "2026-01-01T00:00:00Z",
          })),
        });
      }
      const q = JSON.parse(init.body as string);
      plotted.push(...q.runs);
      return reply(
        page({
          traces: q.runs.includes("u159")
            ? [
                {
                  run_uid: "u159",
                  y: "loss",
                  group: null,
                  points: [[1, 2, "1"]],
                },
              ]
            : [],
        }),
      );
    },
  );
  await appendRxCatalog(api, c);
  const result = await loadRecordPlot(
    api,
    binding,
    c,
    c.runs.map((run) => run.id),
  );
  assert.equal(plotted.length, 160);
  assert.equal(result.data.length, 1);
  assert.equal(result.sources[0].run.rx!.uid, "u159");
});

test("loader aborts between batches and rejects stale responses without publishing partial data", async () => {
  const c = catalog(64);
  const selected = c.runs.map((r) => r.id);
  const controller = new AbortController();
  let calls = 0;
  const canceled = new Api(
    () => "test",
    async () => {
      calls++;
      controller.abort();
      return reply(page());
    },
  );
  await assert.rejects(
    loadRecordPlot(canceled, binding, c, selected, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
  calls = 0;
  const stale = new Api(
    () => "test",
    async () => reply(page({ source_generation: ++calls === 1 ? "g1" : "g2" })),
  );
  await assert.rejects(
    loadRecordPlot(stale, binding, c, selected),
    /source changed/,
  );
  assert.equal(calls, 2);
  const repeated = new Api(
    () => "test",
    async () => reply(page({ next_cursor: "same" })),
  );
  await assert.rejects(
    loadRecordPlot(repeated, binding, c, selected),
    /no progress/,
  );
  const failed = new Api(
    () => "test",
    async () =>
      new Response(JSON.stringify({ error: "actual read failure" }), {
        status: 503,
      }),
  );
  await assert.rejects(
    loadRecordPlot(failed, binding, c, selected),
    /actual read failure/,
  );
});

test("field discovery visits every selected batch and record inspection moves past empty batches", async () => {
  const c = catalog();
  const query = recordRequest(
    binding,
    c,
    c.runs.map((r) => r.id),
  );
  let calls = 0;
  const api = new Api(
    () => "test",
    async (url, init) => {
      calls++;
      const q = JSON.parse(init!.body as string);
      assert.ok(q.runs.length <= 32);
      assert.equal(q.source_generation, "g1");
      if (String(url).endsWith("/fields"))
        return reply(
          page({
            fields: q.runs.includes("u159")
              ? [
                  {
                    path: "late.field",
                    present: 1,
                    types: ["number"],
                    values: [2],
                  },
                ]
              : [],
          }),
        );
      return reply(
        page({
          records: q.runs.includes("u159")
            ? [
                {
                  run_uid: "u159",
                  seq: "1",
                  received_at: "now",
                  data: { late: 2 },
                },
              ]
            : [],
        }),
      );
    },
  );
  const hints = await loadRecordPage(api, "/rx/fields", query);
  assert.equal(calls, 5);
  assert.equal(hints.fields[0].path, "late.field");
  assert.equal(hints.next_cursor, null);
  calls = 0;
  const records = await loadRecordPage(api, "/rx/records", query);
  assert.equal(calls, 5);
  assert.equal(records.records[0].run_uid, "u159");
  assert.equal(records.next_cursor, null);
});

test("composite inspection cursors bind the entire selection and propagate backend pages", async () => {
  const c = catalog(64);
  const query = recordRequest(
    binding,
    c,
    c.runs.map((r) => r.id),
  );
  let calls = 0;
  const api = new Api(
    () => "test",
    async (_url, init) => {
      calls++;
      const q = JSON.parse(init!.body as string);
      return reply(
        page({
          records: [
            {
              run_uid: q.runs[0],
              seq: q.cursor ? "2" : "1",
              received_at: "now",
              data: {},
            },
          ],
          next_cursor: q.cursor ? null : "next",
        }),
      );
    },
  );
  const first = await loadRecordPage(api, "/rx/records", query);
  const second = await loadRecordPage(api, "/rx/records", {
    ...query,
    cursor: first.next_cursor,
  });
  const third = await loadRecordPage(api, "/rx/records", {
    ...query,
    cursor: second.next_cursor,
  });
  assert.equal(second.records[0].seq, "2");
  assert.equal(third.records[0].run_uid, "u32");
  await assert.rejects(
    loadRecordPage(api, "/rx/records", {
      ...query,
      runs: query.runs.slice(0, 63),
      cursor: first.next_cursor,
    }),
    /selection changed/,
  );
  assert.equal(calls, 3);
});
