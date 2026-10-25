import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Api, type Run } from "./api";
import { RunFilterSession } from "./run-filter-session";
import { type FilterCondition, type RunFilter } from "./run-filter";

const run = (uid: string, sourceId = "rx:one", native = false): Run => ({
  id: `${sourceId}:${uid}`,
  experiment_id: sourceId,
  name: uid,
  status: "finished",
  params: { seed: 1 },
  tags: { owner: "team" },
  created_at: 0,
  updated_at: 0,
  ...(native ? {} : { rx: { sourceId, uid, state: "succeeded" } }),
});
const event = (patch: Partial<FilterCondition> = {}): FilterCondition => ({
  scope: "event",
  path: "metrics.loss",
  op: "lt",
  value: "0.5",
  missing: "exclude",
  ...patch,
});
const filter = (...conditions: FilterCondition[]): RunFilter => ({
  combine: "all",
  conditions,
});
interface RequestBody {
  source_id: string;
  runs: string[];
  conditions: { path: string; op: string; value: unknown }[];
  cursor?: string;
  search?: string;
}
interface Call {
  path: string;
  body: RequestBody;
  signal: AbortSignal;
}
const page = (
  uids: string[],
  values: (boolean | null)[] = [true],
  cursor: string | null = null,
) => ({
  source_generation: "generation-a",
  runs: uids.map((uid) => ({ uid, conditions: values })),
  cursor,
  diagnostics: { scanned: uids.length, partial: cursor !== null },
});
function mockApi(
  answer: (call: Call, index: number) => unknown | Promise<unknown>,
) {
  const calls: Call[] = [];
  const api = new Api(
    () => "test-token",
    async (path, init) => {
      assert.ok(init);
      assert.equal(init.method, "POST");
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer test-token",
      );
      assert.ok(init.signal);
      const call = {
        path: String(path),
        body: JSON.parse(String(init.body)),
        signal: init.signal,
      };
      calls.push(call);
      const result = await answer(call, calls.length - 1);
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  return { api, calls };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("mixed native/Event AND and OR retain unknown until evidence proves a result", async (t) => {
  const a = run("a"),
    b = { ...run("b"), params: { seed: 2 } };
  const native = event({
    scope: "params",
    path: '$["seed"]',
    op: "eq",
    value: "1",
  });
  const { api } = mockApi(({ body }) => page(body.runs, [null]));
  const session = new RunFilterSession(filter(native, event()), api);
  t.after(() => session.destroy());
  session.setRuns([a, b]);
  assert.deepEqual([session.result(a), session.result(b)], [null, false]);
  assert.equal(session.matches(a), false);
  assert.equal(session.count(), 0);
  assert.equal(session.pending, 1);
  const either: RunFilter = { combine: "any", conditions: [native, event()] };
  assert.deepEqual(
    [session.result(a, either), session.result(b, either)],
    [true, null],
  );
  assert.equal(session.count(either), 1);
  await session.continueScan();
  assert.deepEqual([session.result(a), session.result(b)], [null, false]);
  // An unresolved terminal response is an error, never a finished partial search.
  assert.match(session.error, /could not read/);
  assert.equal(session.canContinue, false);
  assert.equal(session.pending, 1);
});

test("multiple Event clauses combine proof independently from config and tags", async (t) => {
  const runs = [run("a"), run("b"), run("c")];
  const { api } = mockApi(() => ({
    source_generation: "generation-a",
    runs: [
      { uid: "a", conditions: [true, false] },
      { uid: "b", conditions: [false, false] },
      { uid: "c", conditions: [true, true] },
    ],
    cursor: null,
    diagnostics: { scanned: 7, partial: false },
  }));
  const tag = event({
    scope: "tags",
    path: '$["owner"]',
    op: "eq",
    value: "team",
  });
  const conditions = [
    event(),
    tag,
    event({ path: "phase", op: "eq", value: "train" }),
  ];
  const session = new RunFilterSession(filter(...conditions), api);
  t.after(() => session.destroy());
  session.setRuns(runs);
  await session.continueScan();
  assert.deepEqual(
    runs.map((r) => session.result(r)),
    [false, false, true],
  );
  assert.equal(session.count(), 1);
  assert.equal(session.scanned, 7);
  assert.deepEqual(
    runs.map((r) =>
      session.result(r, {
        combine: "any",
        conditions: [conditions[0], conditions[2]],
      }),
    ),
    [true, false, true],
  );
});

test("native runs cannot match Event comparisons, while missing means no event has the path", () => {
  const session = new RunFilterSession(filter(event()));
  const native = run("native", "native", true);
  assert.equal(session.result(native), false);
  assert.equal(session.result(native, filter(event({ op: "missing" }))), true);
  assert.equal(
    session.result(run("rx"), filter(event({ op: "missing" }))),
    null,
  );
  session.destroy();
});

test("193 candidates automatically finish all exact UID batches of at most 32", async (t) => {
  const runs = Array.from({ length: 193 }, (_, i) => run(`uid-${i}`));
  const { api, calls } = mockApi(({ body }) => page(body.runs));
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  session.setRuns([...runs, runs[0]]);
  await session.continueScan();
  assert.equal(calls.length, 7);
  assert.ok(
    calls.every(
      (c) => c.path === "/api/rx/run-filter" && c.body.runs.length <= 32,
    ),
  );
  assert.deepEqual(
    calls.flatMap((c) => c.body.runs),
    runs.map((r) => r.rx!.uid),
  );
  assert.equal(session.result(runs[192]), true);
  assert.equal(session.pending, 0);
  assert.equal(session.scanned, 193);
  assert.equal(session.canContinue, false);
  assert.equal(session.error, "");
});

test("automatic cursor pages retain candidates and missing stays pending until final absence proof", async (t) => {
  const candidate = run("a");
  const { api, calls } = mockApi(({ body }, i) => {
    assert.equal(session.result(candidate), null);
    return page(
      body.runs,
      [i < 7 ? null : true],
      i < 7 ? `cursor-${i + 1}` : null,
    );
  });
  const session = new RunFilterSession(filter(event({ op: "missing" })), api);
  t.after(() => session.destroy());
  session.setRuns([candidate]);
  await session.continueScan();
  assert.equal(calls.length, 8);
  assert.deepEqual(
    calls.map((c) => c.body.cursor),
    [undefined, ...Array.from({ length: 7 }, (_, i) => `cursor-${i + 1}`)],
  );
  assert.ok(calls.every((c) => JSON.stringify(c.body.runs) === '["a"]'));
  assert.equal(session.result(candidate), true);
  assert.equal(session.pending, 0);
});

test("sources with identical UIDs never share proof or selectors", async (t) => {
  const runs = [run("same", "rx:a"), run("same", "rx:b")];
  const { api, calls } = mockApi(({ body }) =>
    page(body.runs, [body.source_id === "rx:a"]),
  );
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  session.setRuns(runs);
  await session.continueScan();
  assert.deepEqual(
    calls.map((c) => c.body.source_id),
    ["rx:a", "rx:b"],
  );
  assert.deepEqual(
    runs.map((r) => session.result(r)),
    [true, false],
  );
});

test("wire values preserve scalar types, exact paths, and neq maps to any-present-unequal ne", async (t) => {
  const conditions = [
    event({ path: '$["literal.dot"]', op: "neq", value: '"0.001"' }),
    event({ value: "1e-3" }),
    event({ value: "true" }),
    event({ value: "null" }),
    event({ op: "exists", value: "ignored" }),
    event({ op: "missing", value: "ignored" }),
  ];
  const { api, calls } = mockApi(({ body }) =>
    page(
      body.runs,
      conditions.map(() => true),
    ),
  );
  const session = new RunFilterSession(filter(...conditions), api);
  t.after(() => session.destroy());
  session.setRuns([run("a")]);
  await session.continueScan();
  assert.deepEqual(calls[0].body.conditions, [
    { path: '$["literal.dot"]', op: "ne", value: "0.001" },
    { path: "metrics.loss", op: "lt", value: 0.001 },
    { path: "metrics.loss", op: "lt", value: true },
    { path: "metrics.loss", op: "lt", value: null },
    { path: "metrics.loss", op: "exists", value: null },
    { path: "metrics.loss", op: "missing", value: null },
  ]);
});

for (const value of ["9007199254740993", "1e999", '{"x":1}', "[1]"]) {
  test(`invalid scalar ${value} never reaches the backend or becomes a match`, async (t) => {
    const { api, calls } = mockApi(() => assert.fail("Invalid value sent"));
    const session = new RunFilterSession(filter(event({ value })), api);
    t.after(() => session.destroy());
    const candidate = run("a");
    session.setRuns([candidate]);
    await session.continueScan();
    assert.equal(calls.length, 0);
    assert.ok(session.error);
    assert.equal(session.result(candidate), null);
    assert.equal(session.busy, false);
  });
}

test("subscription scans are debounced and duplicate actions do not overlap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<ReturnType<typeof page>>();
  const { api, calls } = mockApi(() => pending.promise);
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  session.setRuns([run("a")]);
  t.mock.timers.tick(1000);
  assert.equal(calls.length, 0); // No host is observing yet.
  const unsubscribe = session.subscribe(() => {});
  t.mock.timers.tick(179);
  assert.equal(calls.length, 0);
  session.setFilter(filter(event({ value: "0.2" })));
  t.mock.timers.tick(179);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.conditions[0].value, 0.2);
  await session.continueScan();
  assert.equal(calls.length, 1);
  pending.resolve(page(["a"]));
  await setImmediate();
  assert.equal(session.busy, false);
  unsubscribe();
});

for (const change of [
  "condition",
  "source",
  "catalog",
  "unsubscribe",
  "destroy",
] as const) {
  test(`${change} aborts an active scan and ignores a late response even if fetch ignores abort`, async (t) => {
    const late = deferred<ReturnType<typeof page>>();
    const { api, calls } = mockApi(() => late.promise);
    const session = new RunFilterSession(filter(event()), api);
    t.after(() => session.destroy());
    const candidate = run("a");
    session.setRuns([candidate], 1);
    let notices = 0;
    const unsubscribe = session.subscribe(() => {
      notices++;
    });
    const work = session.continueScan();
    assert.equal(calls.length, 1);
    if (change === "condition")
      session.setFilter(filter(event({ value: "0.01" })));
    if (change === "source") session.setRuns([run("a", "rx:other")], 2);
    if (change === "catalog") session.setRuns([candidate], 2);
    if (change === "unsubscribe") unsubscribe();
    if (change === "destroy") session.destroy();
    assert.equal(calls[0].signal.aborted, true);
    const previousNotices = notices;
    late.resolve(page(["a"]));
    await work;
    assert.equal(session.result(candidate), null);
    assert.equal(session.scanned, 0);
    assert.equal(session.busy, false);
    assert.equal(notices, previousNotices);
  });
}

test("same catalog revision preserves proof; a changed revision invalidates it", async (t) => {
  const { api, calls } = mockApi(({ body }) => page(body.runs));
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  const candidate = run("a");
  session.setRuns([candidate], 1);
  await session.continueScan();
  session.setRuns([candidate], 1);
  assert.equal(session.result(candidate), true);
  assert.equal(calls.length, 1);
  session.setRuns([candidate], 2);
  assert.equal(session.result(candidate), null);
  await session.continueScan();
  assert.equal(calls.length, 2);
});

test("scan errors leave runs unknown and explicit retry can recover", async (t) => {
  const { api, calls } = mockApi(({ body }, i) => {
    if (!i) throw new Error("source unavailable");
    return page(body.runs, [false]);
  });
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  const candidate = run("a");
  session.setRuns([candidate]);
  await session.continueScan();
  assert.equal(session.error, "source unavailable");
  assert.equal(session.result(candidate), null);
  assert.equal(session.matches(candidate), false);
  assert.equal(session.pending, 1);
  assert.equal(session.busy, false);
  session.restart();
  await session.continueScan();
  assert.equal(calls.length, 2);
  assert.equal(session.error, "");
  assert.equal(session.result(candidate), false);
});

test("discovery honors cancellation and catalog changes, never publishing stale hints", async (t) => {
  const late = deferred<unknown>();
  const { api, calls } = mockApi(() => late.promise);
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  session.setRuns([run("a")], 1);
  const controller = new AbortController();
  const work = session.discover("metrics", controller.signal);
  const rejected = assert.rejects(work, { name: "AbortError" });
  assert.equal(calls[0].path, "/api/rx/fields");
  assert.deepEqual(calls[0].body.runs, ["a"]);
  session.setRuns([run("b")], 2);
  assert.equal(calls[0].signal.aborted, true);
  late.resolve({
    fields: [{ path: "metrics.old", types: ["number"], values: [1] }],
    next_cursor: null,
  });
  await rejected;
});

for (const teardown of ["unsubscribe", "destroy"] as const) {
  test(`${teardown} before the debounce expires prevents any scan`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { api, calls } = mockApi(() => assert.fail("Scan after teardown"));
    const session = new RunFilterSession(filter(event()), api);
    t.after(() => session.destroy());
    session.setRuns([run("a")]);
    const unsubscribe = session.subscribe(() => {});
    t.mock.timers.tick(179);
    if (teardown === "unsubscribe") unsubscribe();
    else session.destroy();
    t.mock.timers.tick(1000);
    await setImmediate();
    assert.equal(calls.length, 0);
  });
}

test("native edits and AND/OR changes reuse current Event proofs without rescanning", async (t) => {
  const { api, calls } = mockApi(({ body }) => page(body.runs));
  const candidate = run("a");
  const condition = event();
  const native = event({
    scope: "params",
    path: '$["seed"]',
    op: "eq",
    value: "2",
  });
  const session = new RunFilterSession(filter(condition), api);
  t.after(() => session.destroy());
  session.setRuns([candidate]);
  await session.continueScan();
  session.setFilter(filter(condition, native));
  assert.equal(session.result(candidate), false);
  session.setFilter({ combine: "any", conditions: [condition, native] });
  assert.equal(session.result(candidate), true);
  await session.continueScan();
  assert.equal(calls.length, 1);
  assert.equal(session.pending, 0);
});

for (const [op, value] of [
  ["exists", true],
  ["exists", false],
  ["missing", true],
  ["missing", false],
] as const) {
  test(`stale continuation revokes cached ${op}=${value} before explicit retry`, async (t) => {
    const { api, calls } = mockApi(({ body }, i) => {
      if (i === 4)
        return new Response(
          JSON.stringify({
            error: "invalid/stale run filter cursor; restart filtering",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      return page(body.runs, [value], i < 4 ? `cursor-${i}` : null);
    });
    const candidate = run("a");
    const session = new RunFilterSession(filter(event({ op })), api);
    t.after(() => session.destroy());
    session.setRuns([candidate]);
    let sawProof = false;
    const unsubscribe = session.subscribe(() => {
      if (session.result(candidate) === value && session.scanned === 4)
        sawProof = true;
    });
    await session.continueScan();
    unsubscribe();
    assert.equal(sawProof, true);
    assert.match(session.error, /invalid\/stale/);
    assert.equal(session.result(candidate), null);
    assert.equal(session.matches(candidate), false);
    assert.equal(session.count(), 0);
    assert.equal(session.scanned, 0);
    assert.equal(session.canContinue, false);
    assert.equal(
      session.result(candidate, {
        combine: "any",
        conditions: [
          event({ op }),
          event({ scope: "params", path: '$["seed"]', op: "eq", value: "1" }),
        ],
      }),
      true,
    ); // Native evidence is not revoked.
    await session.continueScan();
    assert.equal(calls.length, 5); // No implicit retry with discarded state.
    session.restart();
    await session.continueScan();
    assert.equal(calls[5].body.cursor, undefined);
    assert.equal(session.result(candidate), value);
  });
}

test("cursorless batches cannot mix physical source generations or retain old absence proofs", async (t) => {
  const runs = Array.from({ length: 160 }, (_, i) => run(`uid-${i}`));
  const { api, calls } = mockApi(({ body }, i) => ({
    ...page(body.runs, [true, false]),
    source_generation: i < 4 ? "generation-a" : "generation-b",
  }));
  const conditions = [event({ op: "missing" }), event({ op: "exists" })];
  const session = new RunFilterSession(filter(...conditions), api);
  t.after(() => session.destroy());
  session.setRuns(runs);
  let sawOldProof = false;
  const unsubscribe = session.subscribe(() => {
    if (session.scanned === 128) {
      assert.equal(session.result(runs[0], filter(conditions[0])), true);
      assert.equal(session.result(runs[0], filter(conditions[1])), false);
      sawOldProof = true;
    }
  });
  await session.continueScan();
  unsubscribe();
  assert.equal(sawOldProof, true);
  assert.ok(calls.every((c) => !c.body.cursor));
  assert.match(session.error, /source changed/);
  assert.ok(
    runs.every((r) => session.result(r, filter(conditions[0])) === null),
  );
  assert.ok(
    runs.every((r) => session.result(r, filter(conditions[1])) === null),
  );
  assert.equal(session.count(), 0);
  assert.equal(session.scanned, 0);
  assert.equal(session.canContinue, false);
  session.restart();
  await session.continueScan();
  assert.equal(session.error, "");
  assert.equal(session.result(runs[0], filter(conditions[0])), true);
});

test("catalog refresh clears the source generation as well as proof and scan counts", async (t) => {
  const { api } = mockApi(({ body }, i) => ({
    ...page(body.runs),
    source_generation: `generation-${i}`,
  }));
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  const candidate = run("a");
  session.setRuns([candidate], 1);
  await session.continueScan();
  assert.equal(session.result(candidate), true);
  session.setRuns([candidate, run("b")], 2);
  assert.equal(session.scanned, 0);
  assert.equal(session.result(candidate), null);
  await session.continueScan();
  assert.equal(session.error, "");
  assert.equal(session.scanned, 2);
  assert.equal(session.count(), 2);
});

test("a repeated cursor fails visibly instead of spinning forever", async (t) => {
  const { api, calls } = mockApi(({ body }) =>
    page(body.runs, [null], "stuck"),
  );
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  session.setRuns([run("a")]);
  await session.continueScan();
  assert.equal(calls.length, 2);
  assert.match(session.error, /no progress/);
  assert.equal(session.count(), 0);
  assert.equal(session.canContinue, false);
});

test("Refresh invalidation aborts immediately and revokes proofs before catalog returns", async (t) => {
  const late = deferred<ReturnType<typeof page>>();
  const { api, calls } = mockApi(({ body }, i) =>
    i === 0 ? page(body.runs, [true], "next") : late.promise,
  );
  const candidate = run("a");
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  session.setRuns([candidate]);
  const work = session.continueScan();
  await setImmediate();
  assert.equal(session.result(candidate), true);
  session.invalidate();
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(session.result(candidate), null);
  late.resolve(page(["a"]));
  await work;
  assert.equal(session.result(candidate), null);
});

test("the first Event page must belong to the catalog source generation", async (t) => {
  const { api } = mockApi(({ body }) => page(body.runs));
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  const candidate = run("a");
  session.setRuns([candidate], 1, {
    id: "rx:one",
    sourceGeneration: "catalog-generation",
  });
  await session.continueScan();
  assert.match(session.error, /source changed/);
  assert.equal(session.result(candidate), null);
});

test("suspended drawer subscriptions cannot keep an old scan running", async (t) => {
  const late = deferred<ReturnType<typeof page>>();
  const { api, calls } = mockApi(({ body }, i) =>
    i === 0 ? late.promise : page(body.runs),
  );
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  const candidate = run("a");
  session.setRuns([candidate]);
  const unsubscribe = session.subscribe(() => {});
  const work = session.continueScan();
  session.setActive(false);
  assert.equal(calls[0].signal.aborted, true);
  late.resolve(page(["a"], [true], "old-next"));
  await work;
  await session.continueScan();
  assert.equal(calls.length, 1);
  assert.equal(session.result(candidate), null);
  session.setActive(true);
  await session.continueScan();
  assert.equal(session.result(candidate), true);
  unsubscribe();
});

test("native clauses decide without Event requests; changing them starts the necessary search", async (t) => {
  const { api, calls } = mockApi(({ body }) => page(body.runs));
  const native = event({
    scope: "params",
    path: '$["seed"]',
    op: "eq",
    value: "2",
  });
  const session = new RunFilterSession(filter(native, event()), api);
  const candidate = run("a");
  t.after(() => session.destroy());
  session.setRuns([candidate]);
  await session.continueScan();
  assert.equal(calls.length, 0);
  assert.equal(session.result(candidate), false);
  session.setFilter({ combine: "any", conditions: [native, event()] });
  await session.continueScan();
  assert.equal(calls.length, 1);
  assert.equal(session.result(candidate), true);
});

test("condition edits during Refresh wait for the new catalog scope", async (t) => {
  const { api, calls } = mockApi(({ body }) => page(body.runs));
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  session.setRuns([run("old")], 1);
  session.invalidate();
  session.setFilter(filter(event({ op: "exists" })));
  await session.continueScan();
  assert.equal(calls.length, 0);
  session.setRuns([run("new")], 2);
  await session.continueScan();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.runs, ["new"]);
});

test("unavailable source metadata is an explicit retryable error even with no loaded runs", (t) => {
  const session = new RunFilterSession(filter(event()));
  t.after(() => session.destroy());
  session.setRuns([], 1, { id: "rx:one", error: "source unavailable" });
  assert.equal(session.error, "source unavailable");
  assert.equal(session.canContinue, false);
});

test("failure details survive until explicit recovery and loading/error/success notify controls", async (t) => {
  const detail = "source unavailable: " + "long-diagnostic/".repeat(40);
  let fail = true;
  const { api, calls } = mockApi(({ body }) =>
    fail
      ? new Response(JSON.stringify({ error: detail }), { status: 503 })
      : page(body.runs),
  );
  const session = new RunFilterSession(filter(event()), api);
  t.after(() => session.destroy());
  const states: { busy: boolean; error: string; count: number }[] = [];
  // Explicit scans run before the scheduled timer; check each transition deterministically.
  session.setRuns([run("a")]);
  const unsubscribe = session.subscribe(() =>
    states.push({
      busy: session.busy,
      error: session.error,
      count: session.count(),
    }),
  );
  t.after(unsubscribe);
  await session.continueScan();
  assert.equal(session.error, detail);
  assert.equal(session.count(), 0);
  assert.equal(session.canContinue, false);
  await session.continueScan();
  assert.equal(
    calls.length,
    1,
    "failure must not retry on another scan request",
  );
  fail = false;
  session.retry();
  assert.equal(session.error, "");
  await session.continueScan();
  assert.equal(session.count(), 1);
  assert.equal(calls.length, 2);
  assert.ok(states.some((state) => state.busy && !state.error));
  assert.ok(
    states.some(
      (state) => !state.busy && state.error === detail && state.count === 0,
    ),
  );
  assert.deepEqual(states.at(-1), { busy: false, error: "", count: 1 });
});
