import test from "node:test";
import assert from "node:assert/strict";
import { Api, HttpError } from "./api";
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

test("catalog response entry budgets remain independent of unlimited local JSON", async () => {
  let nested: unknown = null;
  for (let i = 0; i < 33; i++) nested = { nested };
  for (const params of [
    { string: "a".repeat(8193) },
    { ["k".repeat(8193)]: 0 },
    { array: Array(4097).fill(0) },
    { values: Array.from({ length: 10 }, () => Array(2500).fill(0)) },
    Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [`k${i}`, 0])),
    { bytes: Array.from({ length: 40 }, () => "a".repeat(8000)) },
    { nested },
  ]) {
    const value = metadata();
    value.runs[0].params = params;
    await assert.rejects(
      fetchCatalog(
        new Api(
          () => "",
          async () => Response.json(value),
        ),
      ),
      /Catalog entry exceeds JSON/,
    );
  }
});

function liveApi() {
  const initial = deferredApi();
  const tails: {
    refs: import("./api").MetricTailRequest[];
    signal: AbortSignal;
    resolve: (result: import("./api").MetricTailSnapshot[]) => void;
    reject: (error: unknown) => void;
  }[] = [];
  initial.api.metricTails = (refs, signal) =>
    new Promise((resolve, reject) =>
      tails.push({ refs, signal: signal!, resolve, reject }),
    );
  return { ...initial, tails };
}
const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
function tailResult(
  call: ReturnType<typeof liveApi>["tails"][number],
  seq: number,
) {
  return call.refs.map((ref) => ({
    runId: ref.runId,
    key: ref.key,
    snapshot: seq,
    points: seq > ref.after ? [{ seq, step: 1, timestamp: 2, value: seq }] : [],
  }));
}

test("catalog accepts an optional safe native metric watermark", async () => {
  for (const metric_seq of [0, 123, Number.MAX_SAFE_INTEGER]) {
    const api = new Api(
      () => "",
      async () => Response.json({ ...metadata(), metric_seq }),
    );
    assert.equal((await fetchCatalog(api)).metric_seq, metric_seq);
  }
  for (const metric_seq of [-1, 1.2, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    const api = new Api(
      () => "",
      async () => Response.json({ ...metadata(), metric_seq }),
    );
    await assert.rejects(fetchCatalog(api), /metric_seq/);
  }
});

test("watch deduplicates shared X/Y refs and coalesces dirty series in one batch", async () => {
  const { api, calls, tails } = liveApi(),
    store = new MetricStore(api);
  let changes = 0;
  const stop = store.watch([ref("x"), ref("y"), ref("x")], () => changes++);
  const stopShared = store.watch([ref("x")], () => {});
  assert.equal(calls.length, 2);
  calls.forEach((call) => call.resolve(points));
  await tick();
  changes = 0;
  for (let i = 0; i < 20; i++) store.markDirty([ref("x"), ref("y"), ref("x")]);
  assert.equal(tails.length, 0);
  await wait();
  assert.equal(tails.length, 1);
  assert.equal(tails[0].refs.length, 2);
  tails[0].resolve(tailResult(tails[0], 9));
  await tick();
  assert.equal(changes, 1);
  assert.deepEqual(
    (await store.load(ref("x"))).map((p) => p.seq),
    [9],
  );
  assert.deepEqual(
    (await store.load(ref("y"))).map((p) => p.step),
    [1],
  );
  stop();
  stopShared();
  store.clear();
});

test("dirty hints racing initial loads and catchup survive publication", async () => {
  const { api, calls, tails } = liveApi(),
    store = new MetricStore(api);
  const stop = store.watch([ref("a")], () => {});
  store.markDirty([ref("a")]);
  calls[0].resolve(points);
  await tick();
  await wait();
  assert.equal(tails.length, 1);
  assert.equal(tails[0].refs[0].after, 1);
  store.markDirty([ref("a")]);
  tails[0].resolve(tailResult(tails[0], 7));
  await tick();
  await wait();
  assert.equal(tails.length, 2);
  assert.equal(tails[1].refs[0].after, 7);
  tails[1].resolve(tailResult(tails[1], 12));
  await tick();
  assert.deepEqual(
    (await store.load(ref("a"))).map((p) => p.seq),
    [12],
  );
  stop();
  store.clear();
});

test("dirty inactive caches wait for demand and evicted histories start fresh", async () => {
  const { api, calls, tails } = liveApi(),
    store = new MetricStore(api, 4, 1);
  const first = store.load(ref("a"));
  calls[0].resolve(points);
  await first;
  store.markDirty([ref("a"), ref("missing")]);
  await wait();
  assert.equal(calls.length, 1);
  assert.equal(tails.length, 0);
  const fresh = store.load(ref("a"));
  await wait();
  tails[0].resolve(tailResult(tails[0], 5));
  assert.equal((await fresh).length, 1);
  const b = store.load(ref("b"));
  calls[1].resolve(points);
  await b;
  store.markDirty([ref("a")]);
  const reloaded = store.load(ref("a"));
  assert.equal(calls.length, 3);
  calls[2].resolve(points);
  await reloaded;
  store.clear();
});

test("hidden tabs suspend and abort tails but leave initial loads intact", async () => {
  const { api, calls, tails } = liveApi(),
    store = new MetricStore(api);
  let changes = 0;
  const stop = store.watch([ref("a")], () => changes++);
  store.setLiveEnabled(false);
  assert.equal(calls[0].signal.aborted, false);
  calls[0].resolve(points);
  await tick();
  store.markDirty();
  await wait();
  assert.equal(tails.length, 0);
  store.setLiveEnabled(true);
  await wait();
  assert.equal(tails.length, 1);
  store.setLiveEnabled(false);
  assert.equal(tails[0].signal.aborted, true);
  tails[0].resolve(tailResult(tails[0], 50));
  await tick();
  assert.equal(changes, 1);
  store.setLiveEnabled(true);
  await wait();
  assert.equal(tails[1].refs[0].after, 1);
  tails[1].resolve(tailResult(tails[1], 7));
  await tick();
  assert.deepEqual(
    (await store.load(ref("a"))).map((p) => p.seq),
    [7],
  );
  stop();
  store.clear();
});

test("epoch reset refetches pinned prefixes and ignores noncooperative stale tails", async () => {
  const { api, calls, tails } = liveApi(),
    store = new MetricStore(api);
  let changes = 0;
  const stop = store.watch([ref("a")], () => changes++);
  calls[0].resolve(points);
  await tick();
  const displayed = await store.load(ref("a"));
  store.markDirty();
  await wait();
  store.resetLive();
  assert.equal(tails[0].signal.aborted, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(displayed, points);
  tails[0].resolve(tailResult(tails[0], 99));
  await tick();
  assert.equal(changes, 1);
  const newPoints = [{ seq: 2, step: 1, timestamp: 1, value: 2 }];
  calls[1].resolve(newPoints);
  await tick();
  assert.deepEqual(await store.load(ref("a")), newPoints);
  stop();
  store.clear();
});

test("failed catchup retains the complete prefix and retries with backoff", async () => {
  const { api, calls, tails } = liveApi(),
    store = new MetricStore(api);
  const statuses: (string | null)[] = [];
  store.setLiveStatusListener((error) => statuses.push(error));
  let changes = 0;
  const stop = store.watch([ref("a")], () => changes++);
  calls[0].resolve(points);
  await tick();
  const displayed = await store.load(ref("a"));
  store.markDirty();
  await wait();
  tails[0].reject(new Error("offline"));
  await tick();
  assert.deepEqual(displayed, points);
  assert.equal(changes, 1);
  assert.equal(statuses.at(-1), "offline");
  await wait(100);
  assert.equal(tails.length, 1);
  await wait(200);
  assert.equal(tails.length, 2);
  assert.equal(tails[1].refs[0].after, 1);
  tails[1].resolve(tailResult(tails[1], 8));
  await tick();
  assert.deepEqual(
    (await store.load(ref("a"))).map((p) => p.seq),
    [8],
  );
  assert.equal(statuses.at(-1), null);
  stop();
  store.clear();
});

test("more than 24 watched prefixes stay pinned and batches cap at 64 streams", async () => {
  let initial = 0;
  const batches: number[] = [];
  const api = {
    async metrics() {
      initial++;
      return points;
    },
    async metricTails(refs: import("./api").MetricTailRequest[]) {
      batches.push(refs.length);
      return refs.map((ref) => ({ ...ref, points: [], snapshot: ref.after }));
    },
  } as unknown as Api;
  const store = new MetricStore(api);
  const refs = Array.from({ length: 70 }, (_, i) => ref(String(i)));
  const stop = store.watch(refs, () => {});
  await Promise.all(refs.map((ref) => store.load(ref)));
  await Promise.all(refs.map((ref) => store.load(ref)));
  assert.equal(initial, 70);
  store.markDirty();
  await wait(250);
  assert.deepEqual(batches, [64, 6]);
  await Promise.all(refs.map((ref) => store.load(ref)));
  assert.equal(initial, 70);
  stop();
  store.clear();
});

test("reset also rejects initial waiters and prevents stale initial cache commits", async () => {
  const { api, calls } = liveApi(),
    store = new MetricStore(api, 1);
  const stop = store.watch([ref("a")], () => {});
  const original = store.load(ref("a"));
  const rejected = assert.rejects(original, { name: "AbortError" });
  store.resetLive();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls.length, 1);
  calls[0].resolve([{ ...points[0], value: -999 }]);
  await rejected;
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve(points);
  await tick();
  assert.deepEqual(await store.load(ref("a")), points);
  stop();
  store.clear();
});

test("auth failures retain dirtiness but do not automatically retry", async () => {
  const { api, calls, tails } = liveApi(),
    store = new MetricStore(api);
  const stop = store.watch([ref("a")], () => {});
  calls[0].resolve(points);
  await tick();
  store.markDirty();
  await wait();
  tails[0].reject(new HttpError("Unauthorized", 401));
  await tick();
  await wait(350);
  assert.equal(tails.length, 1);
  const retry = store.load(ref("a"));
  await wait();
  assert.equal(tails.length, 2);
  tails[1].resolve(tailResult(tails[1], 3));
  assert.deepEqual(
    (await retry).map((point) => point.seq),
    [3],
  );
  stop();
  store.clear();
});

test("a final dirty series recovers after a long outage without fresh hints", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { api, calls, tails } = liveApi();
  const store = new MetricStore(api);
  const stop = store.watch([ref("a")], () => {});
  t.after(() => {
    stop();
    store.clear();
  });
  calls[0].resolve(points);
  await tick();
  store.markDirty();
  now += 100;
  t.mock.timers.tick(100);
  await tick();
  for (let attempt = 0; attempt < 8; attempt++) {
    assert.equal(tails.length, attempt + 1);
    assert.equal(tails[attempt].refs[0].after, 1);
    tails[attempt].reject(new HttpError("temporarily offline", 503));
    await tick();
    now += 10000;
    t.mock.timers.tick(10000);
    await tick();
  }
  assert.equal(tails.length, 9);
  tails[8].resolve(tailResult(tails[8], 9));
  await tick();
  assert.deepEqual(
    (await store.load(ref("a"))).map((p) => p.seq),
    [9],
  );
  assert.equal(calls.length, 1);
});

test("initial chart projection chooses greatest seq, not timestamp or value", async () => {
  const { api, calls } = deferredApi(),
    store = new MetricStore(api);
  const old = { seq: 1, step: 4, timestamp: 100, value: 100 };
  const other = { seq: 2, step: 9, timestamp: 200, value: 5 };
  const winner = { seq: 3, step: 4, timestamp: -100, value: -10 };
  const raw = [old, other, winner];
  const loaded = store.load(ref("a"));
  calls[0].resolve(raw);
  assert.deepEqual(await loaded, [other, winner]);
  assert.deepEqual(raw, [old, other, winner]);
  assert.deepEqual(await store.load(ref("a")), [other, winner]);
  assert.equal(calls.length, 1);
  store.clear();
});

test("chart policy pins paged history and merges late old-step tails without reload", async () => {
  const old = { seq: 1, step: 1, timestamp: 100, value: 10 };
  const later = { seq: 4, step: 9, timestamp: 200, value: 20 };
  const correction = { seq: 12, step: 1, timestamp: -100, value: -10 };
  const gets: URLSearchParams[] = [];
  const tails: import("./api").MetricTailRequest[][] = [];
  const api = new Api(
    () => "",
    async (url, init) => {
      if (init?.method === "POST") {
        const { series } = JSON.parse(String(init.body));
        tails.push(series);
        const first = tails.length === 1;
        return Response.json({
          series: [
            {
              runId: "run",
              key: "a",
              snapshot: first ? 15 : 30,
              points: first ? [correction] : [],
              next_after: null,
            },
          ],
        });
      }
      gets.push(new URL(String(url), "http://local").searchParams);
      return Response.json({
        points: gets.length === 1 ? [old] : [later],
        total: 2,
        snapshot: 10,
        next_after: gets.length === 1 ? 1 : null,
      });
    },
  );
  const store = new MetricStore(api);
  const stop = store.watch([ref("a")], () => {});
  try {
    const displayed = await store.load(ref("a"));
    assert.deepEqual(displayed, [old, later]);
    assert.deepEqual(
      gets.map((q) => q.get("policy")),
      ["latest-per-step", "latest-per-step"],
    );
    assert.equal(gets[1].get("snapshot"), "10");
    store.markDirty();
    assert.deepEqual(await store.load(ref("a")), [later, correction]);
    assert.deepEqual(displayed, [old, later]);
    assert.equal(tails[0][0].after, 10);
    assert.equal(tails[0][0].policy, "latest-per-step");
    store.markDirty();
    assert.deepEqual(await store.load(ref("a")), [later, correction]);
    assert.equal(tails[1][0].after, 15);
    store.markDirty();
    await store.load(ref("a"));
    assert.equal(tails[2][0].after, 30);
    const shared = store.watch([ref("a")], () => {});
    await store.load(ref("a"));
    shared();
    assert.equal(gets.length, 2);
    assert.equal(tails.length, 3);
  } finally {
    stop();
    store.clear();
  }
});
