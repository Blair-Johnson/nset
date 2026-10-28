import test from "node:test";
import assert from "node:assert/strict";
import { Api, type MetricPage } from "./api";
const point = (seq: number) => ({ seq, step: seq, timestamp: seq, value: seq });
function mocked(pages: MetricPage[], seen: string[] = []) {
  return new Api(
    () => "test-token",
    async (input, init) => {
      const url = String(input);
      seen.push(url);
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer test-token",
      );
      assert.equal(url.includes("test-token"), false);
      const page = pages.shift();
      if (!page) throw new Error("Unexpected fetch");
      return new Response(JSON.stringify(page), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
}
test("snapshot full pagination supplies stable snapshot and cursor", async () => {
  const seen: string[] = [];
  const api = mocked(
    [
      { points: [point(1), point(2)], next_after: 2, snapshot: 4, total: 4 },
      { points: [point(3), point(4)], next_after: null, snapshot: 4, total: 4 },
    ],
    seen,
  );
  const progress: number[] = [];
  const result = await api.metrics(
    "run",
    "loss / validation",
    new AbortController().signal,
    (n) => progress.push(n),
  );
  assert.equal(result.length, 4);
  assert.deepEqual(progress, [2, 4]);
  assert.match(seen[1], /snapshot=4/);
  assert.match(seen[1], /after=2/);
  assert.equal(
    new URL(seen[0], "http://localhost").searchParams.get("key"),
    "loss / validation",
  );
});
test("empty snapshot is valid and complete", async () =>
  assert.deepEqual(
    await mocked([
      { points: [], snapshot: 0, next_after: null, total: 0 },
    ]).metrics("r", "k", new AbortController().signal),
    [],
  ));
test("changed snapshot is rejected instead of mixing versions", async () => {
  const api = mocked([
    { points: [point(1)], next_after: 1, snapshot: 2, total: 2 },
    { points: [point(2)], next_after: null, snapshot: 3, total: 2 },
  ]);
  await assert.rejects(
    () => api.metrics("r", "k", new AbortController().signal),
    /snapshot changed/,
  );
});
test("partial final page is rejected", async () => {
  await assert.rejects(
    () =>
      mocked([
        { points: [point(1)], snapshot: 5, next_after: null, total: 5 },
      ]).metrics("r", "k", new AbortController().signal),
    /Incomplete/,
  );
});
test("non-progressing cursor fails instead of infinite loading", async () => {
  await assert.rejects(
    () =>
      mocked([
        { points: [point(1)], snapshot: 3, next_after: 1, total: 3 },
        { points: [point(1)], snapshot: 3, next_after: 1, total: 3 },
      ]).metrics("r", "k", new AbortController().signal),
    /pagination cursor/,
  );
});
test("aborted fetch completion never becomes authoritative", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      mocked([{ points: [], snapshot: 0, next_after: null, total: 0 }]).metrics(
        "r",
        "k",
        controller.signal,
      ),
    { name: "AbortError" },
  );
});
test("API error messages surface without token leakage", async () => {
  const api = new Api(
    () => "hidden",
    async () =>
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  );
  await assert.rejects(() => api.json("/experiments"), /Unauthorized/);
});

test("batched tails pin each stream, tolerate seq gaps and repeated steps, and return only complete results", async () => {
  const bodies: {
    series: { runId: string; key: string; after: number; snapshot?: number }[];
    limit: number;
  }[] = [];
  const api = new Api(
    () => "secret",
    async (input, init) => {
      assert.equal(String(input), "/api/metrics/tail");
      assert.equal(init?.method, "POST");
      assert.equal(init?.cache, "no-store");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer secret",
      );
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(
        bodies.length === 1
          ? {
              series: [
                {
                  runId: "r",
                  key: "y",
                  points: [{ ...point(7), step: 1 }],
                  snapshot: 12,
                  next_after: 7,
                },
                {
                  runId: "r",
                  key: "x",
                  points: [],
                  snapshot: 2,
                  next_after: null,
                },
              ],
            }
          : {
              series: [
                {
                  runId: "r",
                  key: "y",
                  points: [{ ...point(12), step: 1 }],
                  snapshot: 12,
                  next_after: null,
                },
              ],
            },
      );
    },
  );
  const result = await api.metricTails([
    { runId: "r", key: "y", after: 3 },
    { runId: "r", key: "x", after: 2 },
  ]);
  assert.deepEqual(
    result[0].points.map((p) => [p.seq, p.step]),
    [
      [7, 1],
      [12, 1],
    ],
  );
  assert.equal(result[1].points.length, 0);
  assert.deepEqual(bodies[1], {
    series: [{ runId: "r", key: "y", after: 7, snapshot: 12 }],
    limit: 1000,
  });
});

test("tail validation rejects unsafe cursors, mismatched identities, nonprogress and changed snapshots", async () => {
  const request = { runId: "r", key: "k", after: 2 };
  const page = {
    runId: "r",
    key: "k",
    points: [point(4)],
    snapshot: 8,
    next_after: null,
  };
  const invalid = [
    { ...page, snapshot: -1 },
    { ...page, snapshot: Number.MAX_SAFE_INTEGER + 1 },
    { ...page, snapshot: 1 },
    { ...page, points: [point(2)] },
    { ...page, points: [point(9)] },
    { ...page, points: [point(4), point(3)] },
    { ...page, points: [point(4), point(4)] },
    { ...page, points: [{ ...point(4), value: null }] },
    { ...page, next_after: 5 },
    { ...page, next_after: 4, points: [] },
    { ...page, next_after: 8, points: [point(8)] },
    { ...page, key: "other" },
    { ...page, next_after: undefined },
  ];
  for (const value of invalid) {
    const api = new Api(
      () => "",
      async () => Response.json({ series: [value] }),
    );
    await assert.rejects(api.metricTails([request]));
  }
  for (const series of [[], [page, page]]) {
    const api = new Api(
      () => "",
      async () => Response.json({ series }),
    );
    await assert.rejects(api.metricTails([request]));
  }
  let calls = 0;
  const api = new Api(
    () => "",
    async () =>
      Response.json({
        series: [
          ++calls === 1
            ? { ...page, next_after: 4 }
            : { ...page, points: [point(7)], snapshot: 9 },
        ],
      }),
  );
  await assert.rejects(api.metricTails([request]), /snapshot/);
});

test("tail request limits and abort authority prevent invalid publication", async () => {
  let calls = 0;
  const api = new Api(
    () => "",
    async () => {
      calls++;
      return Response.json({ series: [] });
    },
  );
  const ref = { runId: "r", key: "k", after: 0 };
  for (const refs of [
    [],
    [ref, ref],
    [{ ...ref, after: -1 }],
    Array.from({ length: 65 }, (_, i) => ({ ...ref, key: String(i) })),
  ])
    await assert.rejects(api.metricTails(refs));
  await assert.rejects(api.metricTails([ref], undefined, 1001));
  assert.equal(calls, 0);
  const controller = new AbortController();
  const slow = new Api(
    () => "",
    async () => {
      controller.abort();
      return Response.json({
        series: [{ ...ref, points: [point(2)], snapshot: 2, next_after: null }],
      });
    },
  );
  await assert.rejects(slow.metricTails([ref], controller.signal), {
    name: "AbortError",
  });
});

test("a later failed tail page never resolves a partial snapshot", async () => {
  let requests = 0;
  let fail!: (error: unknown) => void;
  const api = new Api(
    () => "",
    async () => {
      if (++requests === 1)
        return Response.json({
          series: [
            {
              runId: "r",
              key: "k",
              points: [point(4)],
              snapshot: 9,
              next_after: 4,
            },
          ],
        });
      return new Promise<Response>((_resolve, reject) => {
        fail = reject;
      });
    },
  );
  let published = false;
  const result = api.metricTails([{ runId: "r", key: "k", after: 1 }]);
  void result.then(
    () => {
      published = true;
    },
    () => {},
  );
  const rejected = assert.rejects(result, /offline/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  assert.equal(published, false);
  fail(new Error("offline"));
  await rejected;
  assert.equal(published, false);
});
