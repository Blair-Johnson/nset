import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "./api";
import { fetchCatalog, MetricStore } from "./catalog";
import type { Point } from "./math";
import type { SeriesRef } from "./workspace-types";

const ref = (key: string): SeriesRef => ({ runId: "run", key, kind: "metric" });
const points: Point[] = [{ seq: 1, step: 1, timestamp: 2, value: 3 }];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferredApi() {
  const calls: {
    key: string;
    signal: AbortSignal;
    resolve: (p: Point[]) => void;
    reject: (e: unknown) => void;
    progress: (n: number, t: number) => void;
  }[] = [];
  const api = {
    metrics(
      _run: string,
      key: string,
      signal: AbortSignal,
      progress: (n: number, t: number) => void,
    ) {
      return new Promise<Point[]>((resolve, reject) =>
        calls.push({ key, signal, resolve, reject, progress }),
      );
    },
  } as unknown as Api;
  return { api, calls };
}
test("default concurrency is four; FIFO queue starts only after a slot settles", async () => {
  const { api, calls } = deferredApi(),
    store = new MetricStore(api);
  const loads = Array.from({ length: 7 }, (_, i) => store.load(ref(String(i))));
  assert.equal(calls.length, 4);
  calls[0].resolve(points);
  await tick();
  assert.equal(calls.length, 5);
  calls[1].resolve(points);
  calls[2].resolve(points);
  calls[3].resolve(points);
  await tick();
  assert.equal(calls.length, 7);
  calls.slice(4).forEach((c) => c.resolve(points));
  await Promise.all(loads);
});
test("shared requests deduplicate and one subscriber abort does not cancel another", async () => {
  const { api, calls } = deferredApi(),
    store = new MetricStore(api),
    controller = new AbortController();
  const first = store.load(ref("loss"), controller.signal),
    rejected = assert.rejects(first, { name: "AbortError" });
  const second = store.load(ref("loss"));
  assert.equal(calls.length, 1);
  controller.abort();
  assert.equal(calls[0].signal.aborted, false);
  calls[0].resolve(points);
  await rejected;
  assert.deepEqual(await second, points);
  assert.deepEqual(await store.load(ref("loss")), points);
  assert.equal(calls.length, 1);
});
test("last subscriber abort cancels transport, drops queued jobs and permits fresh retry", async () => {
  const { api, calls } = deferredApi(),
    store = new MetricStore(api, 1);
  const a = new AbortController(),
    b = new AbortController();
  const first = store.load(ref("a"), a.signal),
    rejectedA = assert.rejects(first, { name: "AbortError" });
  const second = store.load(ref("b"), b.signal),
    rejectedB = assert.rejects(second, { name: "AbortError" });
  b.abort();
  a.abort();
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve(points);
  await Promise.all([rejectedA, rejectedB]);
  await tick();
  assert.equal(calls.length, 1);
  const retry = store.load(ref("a"));
  assert.equal(calls.length, 2);
  calls[1].resolve(points);
  await retry;
});
test("clear rejects active/queued subscribers and ignores stale transport results", async () => {
  const { api, calls } = deferredApi(),
    store = new MetricStore(api, 1);
  const a = store.load(ref("a")),
    b = store.load(ref("b"));
  const rejectedA = assert.rejects(a, { name: "AbortError" }),
    rejectedB = assert.rejects(b, { name: "AbortError" });
  store.clear();
  assert.equal(calls[0].signal.aborted, true);
  const fresh = store.load(ref("a"));
  // Even a transport ignoring abort cannot exceed the concurrency limit or cache its stale response.
  assert.equal(calls.length, 1);
  calls[0].resolve([{ seq: 1, step: 0, timestamp: 0, value: -1 }]);
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve(points);
  await Promise.all([rejectedA, rejectedB]);
  assert.deepEqual(await fresh, points);
  assert.deepEqual(await store.load(ref("a")), points);
  assert.equal(calls.length, 2);
});
test("completed cache is LRU and bounded to 24 by default", async () => {
  const calls: string[] = [];
  const api = {
    async metrics(_run: string, key: string) {
      calls.push(key);
      return points;
    },
  } as unknown as Api;
  const store = new MetricStore(api);
  for (let i = 0; i < 24; i++) await store.load(ref(String(i)));
  await store.load(ref("0"));
  await store.load(ref("24"));
  await store.load(ref("0"));
  assert.equal(calls.length, 25);
  await store.load(ref("1"));
  assert.equal(calls.length, 26);
  store.clear();
  await store.load(ref("0"));
  assert.equal(calls.length, 27);
});
test("no partial results or failed cache entries; progress callback failures are isolated", async () => {
  const { api, calls } = deferredApi(),
    store = new MetricStore(api);
  let resolved = false;
  const progress: number[] = [];
  const first = store.load(ref("a"), undefined, () => {
    throw new Error("UI error");
  });
  const second = store.load(ref("a"), undefined, (done) => progress.push(done));
  void first.then(
    () => {
      resolved = true;
    },
    () => {},
  );
  const rejectedA = assert.rejects(first, /incomplete/),
    rejectedB = assert.rejects(second, /incomplete/);
  calls[0].progress(1, 2);
  await tick();
  assert.equal(resolved, false);
  assert.deepEqual(progress, [1]);
  calls[0].reject(new Error("incomplete"));
  await Promise.all([rejectedA, rejectedB]);
  const retry = store.load(ref("a"));
  assert.equal(calls.length, 2);
  calls[1].resolve(points);
  await retry;
});
test("Api.metrics loads every page before publishing a cached snapshot", async () => {
  const urls: string[] = [];
  const api = new Api(
    () => "token",
    async (input) => {
      urls.push(String(input));
      return Response.json(
        urls.length === 1
          ? { points, next_after: 1, snapshot: 7, total: 2 }
          : {
              points: [{ seq: 2, step: 2, timestamp: 3, value: 1000 }],
              next_after: null,
              snapshot: 7,
              total: 2,
            },
      );
    },
  );
  const store = new MetricStore(api),
    all = await store.load(ref("loss"));
  assert.equal(all.length, 2);
  assert.equal(all[1].value, 1000);
  assert.ok(urls[1].includes("snapshot=7"));
  assert.ok(urls[1].includes("after=1"));
  await store.load(ref("loss"));
  assert.equal(urls.length, 2);
});
test("already aborted subscribers and image refs make no request", async () => {
  const { api, calls } = deferredApi(),
    store = new MetricStore(api),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(store.load(ref("a"), controller.signal), {
    name: "AbortError",
  });
  await assert.rejects(store.load({ ...ref("a"), kind: "image" }), /metric/);
  assert.equal(calls.length, 0);
  assert.throws(() => new MetricStore(api, 0));
});
test("cache-hit delivery still respects cancellation and clear", async () => {
  const api = {
      async metrics() {
        return points;
      },
    } as unknown as Api,
    store = new MetricStore(api);
  await store.load(ref("a"));
  const controller = new AbortController();
  const cancelled = store.load(ref("a"), controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  const stale = store.load(ref("a"));
  store.clear();
  await assert.rejects(stale, { name: "AbortError" });
});
function metadata() {
  return {
    experiments: [
      { id: "e", name: "Experiment", created_at: 1 },
      { id: "empty", name: "Empty", created_at: 1 },
    ],
    runs: [
      {
        id: "r",
        experiment_id: "e",
        name: "Run",
        status: "finished",
        params: {},
        tags: {},
        created_at: 1,
        updated_at: 2,
      },
    ],
    series: [
      {
        run_id: "r",
        key: "loss",
        kind: "metric",
        count: 10,
        last_step: 1,
        last_timestamp: 2,
        last_value: 3,
      },
    ],
  };
}
test("catalog fetch uses only authenticated compact endpoint and retains empty experiments", async () => {
  const paths: string[] = [];
  const api = new Api(
    () => "secret",
    async (input, init) => {
      paths.push(String(input));
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer secret",
      );
      return Response.json(metadata());
    },
  );
  assert.deepEqual(await fetchCatalog(api), metadata());
  assert.deepEqual(paths, ["/api/catalog"]);
});
test("catalog rejects duplicate identities, unknown kinds, dangling references and unsafe metadata", async () => {
  const invalid = [
    { ...metadata(), series: [...metadata().series, ...metadata().series] },
    { ...metadata(), series: [{ ...metadata().series[0], kind: "video" }] },
    { ...metadata(), series: [{ ...metadata().series[0], count: -1 }] },
    { ...metadata(), series: [{ ...metadata().series[0], run_id: "missing" }] },
    { ...metadata(), runs: [{ ...metadata().runs[0], status: "unknown" }] },
    {
      ...metadata(),
      runs: [{ ...metadata().runs[0], params: JSON.parse('{"__proto__":{}}') }],
    },
  ];
  for (const value of invalid)
    await assert.rejects(
      fetchCatalog(
        new Api(
          () => "",
          async () => Response.json(value),
        ),
      ),
    );
});
