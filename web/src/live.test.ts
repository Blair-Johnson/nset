import test from "node:test";
import assert from "node:assert/strict";
import { LiveUpdates, liveReply, type LiveStatus } from "./live";
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const response = (value: unknown, status = 200) =>
  ({ ok: status === 200, status, json: async () => value }) as Response;
const reply = { cursor: "epoch:0", reset: false, changes: [] };

test("an hour without observations stays healthy using empty server responses", async (t) => {
  let now = 1000,
    polls = 0,
    resets = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states: LiveStatus[] = [];
  const live = new LiveUpdates(
    () => "secret",
    {
      changes: async () => assert.fail("No observations expected"),
      reset: async () => {
        resets++;
      },
      status: (s) => states.push(s),
    },
    async (_url, options) => {
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        "Bearer secret",
      );
      polls++;
      return new Promise((resolve) =>
        setTimeout(() => resolve(response(reply)), 20000),
      );
    },
  );
  t.after(() => live.stop());
  live.start("epoch:0");
  await flush();
  for (let i = 0; i < 180; i++) {
    now += 20000;
    t.mock.timers.tick(20000);
    await flush();
    t.mock.timers.tick(0);
    await flush();
  }
  assert.equal(resets, 0);
  assert.ok(polls >= 180 && polls <= 182, String(polls));
  assert.equal(states.filter((s) => s === "reconnecting").length, 0);
  assert.equal(states.at(-1), "live");
});

test("one transient failure does not flash reconnecting; sustained failure does", async (t) => {
  let now = 1000,
    failing = true,
    calls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0.5);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states: LiveStatus[] = [];
  const live = new LiveUpdates(
    () => "t",
    {
      changes: async () => {},
      reset: async () => {},
      status: (s) => states.push(s),
    },
    async () => {
      calls++;
      if (failing) throw new Error("offline");
      return response(reply);
    },
  );
  t.after(() => live.stop());
  const advance = async (ms: number) => {
    now += ms;
    t.mock.timers.tick(ms);
    await flush();
  };
  live.start("epoch:0");
  await flush();
  assert.ok(!states.includes("reconnecting"));
  failing = false;
  await advance(500);
  assert.equal(states.at(-1), "live");
  assert.ok(!states.includes("reconnecting"));
  failing = true;
  await advance(100);
  await advance(500);
  await advance(1000);
  await advance(2000);
  assert.equal(states.at(-1), "reconnecting");
  failing = false;
  await advance(4000);
  assert.equal(states.at(-1), "live");
  assert.ok(calls < 12);
});

test("stopped noncooperative responses cannot deliver changes", async () => {
  let resolve!: (value: Response) => void,
    applied = 0;
  const live = new LiveUpdates(
    () => "t",
    {
      changes: async () => {
        applied++;
      },
      reset: async () => {
        applied++;
      },
      status: () => {},
    },
    async () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  live.start("epoch:0");
  await flush();
  live.stop();
  resolve(response({ ...reply, changes: [{ kind: "catalog" }] }));
  await flush();
  assert.equal(applied, 0);
});

test("invalid feed messages cannot be acknowledged", () => {
  assert.throws(() => liveReply({ ...reply, changes: [{ kind: "unknown" }] }));
  assert.throws(() =>
    liveReply({
      ...reply,
      changes: [
        {
          kind: "metric",
          runId: "r",
          key: "k",
          count: 1,
          high: 3,
          last: { seq: 2, value: 1, step: 1, timestamp: 1 },
        },
      ],
    }),
  );
  assert.deepEqual(liveReply(reply), reply);
});

test("metric activity timestamp is optional for old servers but validated when present", () => {
  const change = {
    kind: "metric",
    runId: "r",
    key: "loss",
    high: 1,
    count: 1,
    last: { seq: 1, step: 0, timestamp: 999999, value: 1 },
  };
  const payload = (c: unknown) => ({ ...reply, changes: [c] });
  assert.doesNotThrow(() => liveReply(payload(change)));
  for (const runUpdatedAt of [0, 1234, Number.MAX_SAFE_INTEGER])
    assert.doesNotThrow(() => liveReply(payload({ ...change, runUpdatedAt })));
  for (const runUpdatedAt of [
    null,
    "1234",
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () => liveReply(payload({ ...change, runUpdatedAt })),
      /Invalid live metric/,
    );
});
