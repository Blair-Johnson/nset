import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfigTree } from "./run-config";

test("event subtree limits bound traversal while retaining exact source paths", () => {
  const value = {
    "a.b": 1,
    a: { b: 2 },
    wide: Array.from({ length: 10000 }, (_, i) => i),
  };
  const tree = buildConfigTree(
    { config: value },
    {
      exact: true,
      sourcePath: ["event", "config"],
      maxFields: 1000,
      maxDepth: 16,
    },
  );
  assert.equal(tree.fields, 1000);
  assert.equal(tree.nodes.length, 1000);
  assert.equal(tree.truncated, true);
  const paths = tree.nodes.flatMap((node) =>
    node.values.map((v) => v.sourcePath),
  );
  assert.ok(paths.includes('$["event"]["config"]["a.b"]'));
  assert.ok(paths.includes('$["event"]["config"]["a"]["b"]'));
  assert.notEqual(
    tree.nodes.find((n) => n.values.some((v) => v.sourcePath === paths[1])),
    tree.nodes.find((n) =>
      n.values.some((v) => v.sourcePath === '$["event"]["config"]["a"]["b"]'),
    ),
  );
});

test("deep event previews stop safely and do not mutate the value", () => {
  let value: unknown = 1;
  for (let i = 0; i < 100; i++) value = { next: value };
  const tree = buildConfigTree(
    { value },
    { exact: true, maxFields: 1000, maxDepth: 16 },
  );
  assert.equal(tree.fields, 17);
  assert.equal(tree.truncated, true);
  assert.equal(
    buildConfigTree(
      { scalar: false },
      { exact: true, maxFields: 1000, maxDepth: 16 },
    ).truncated,
    false,
  );
});

test("event path byte limits reject amplifying ancestors before indexing descendants", () => {
  const value = {
    config: {
      ["x".repeat(200000)]: Object.fromEntries(
        Array.from({ length: 999 }, (_, i) => [`f${i}`, i]),
      ),
      safe: 7,
    },
  };
  const raw = JSON.stringify(value);
  assert.ok(Buffer.byteLength(raw) < 256 * 1024);
  const tree = buildConfigTree(value, {
    exact: true,
    maxFields: 1000,
    maxDepth: 16,
    maxPathBytes: 4096,
  });
  assert.equal(tree.truncated, true);
  assert.equal(tree.fields, 2);
  assert.ok(
    tree.nodes.reduce((size, n) => size + n.path.length + n.search.length, 0) <
      1024,
  );
  assert.equal(tree.nodes.at(-1)?.values[0].sourcePath, '$["config"]["safe"]');
  assert.equal(JSON.stringify(value), raw);
});

test("event path bounds count cumulative UTF-8 and JSON escaping without altering exact addresses", () => {
  for (const key of ["\u00e9".repeat(2050), "\u0000".repeat(700)]) {
    const tree = buildConfigTree(
      { config: { [key]: { child: 1 }, safe: 2 } },
      {
        exact: true,
        maxPathBytes: 4096,
      },
    );
    assert.equal(tree.truncated, true);
    assert.equal(tree.fields, 2);
  }
  const key = "a".repeat(1500);
  const tree = buildConfigTree(
    { [key]: { [key]: { [key]: 1 } } },
    {
      exact: true,
      maxPathBytes: 4096,
    },
  );
  assert.equal(tree.fields, 2);
  assert.equal(tree.truncated, true);
  assert.ok(
    tree.nodes.every((n) =>
      n.values.every((v) => Buffer.byteLength(v.sourcePath) <= 4096),
    ),
  );
  const exact = buildConfigTree(
    { '\u00e9"': 1 },
    { exact: true, maxPathBytes: 9 },
  );
  assert.equal(exact.truncated, false);
  assert.equal(Buffer.byteLength(exact.nodes[0].values[0].sourcePath), 9);
  assert.equal(
    buildConfigTree({ '\u00e9"': 1 }, { exact: true, maxPathBytes: 8 })
      .truncated,
    true,
  );
  assert.equal(
    buildConfigTree(
      { value: 1 },
      { exact: true, sourcePath: ["x".repeat(5000)], maxPathBytes: 4096 },
    ).fields,
    0,
  );
  // Native config indexing retains its existing behavior unless a bound is requested.
  assert.equal(buildConfigTree({ ["x".repeat(5000)]: 1 }).truncated, false);
});

test("namespace formatter is shared while exact event keys stay distinct", async () => {
  const { configNamespace } = await import("./run-config");
  const { recordPath } = await import("./records");
  for (const path of [
    ["config", "callbacks", "on_step_end", 0],
    ["config", "a.b"],
    ["config", "a", "b"],
    ["config", "\u65e5\u672c\u8a9e"],
    ['x"\\y', ""],
    ["0"],
    [0],
  ]) {
    assert.deepEqual(recordPath(configNamespace(path)), path);
  }
  const value = {
    config: { callbacks: { on_step_end: ["save"] }, data: { baseband: true } },
  };
  assert.deepEqual(
    buildConfigTree(value).nodes.map((n) => n.path),
    buildConfigTree(value, { exact: true }).nodes.map((n) => n.path),
  );
  const tree = buildConfigTree(
    { config: { "a.b": 1, a: { b: 2 } } },
    { exact: true },
  );
  assert.ok(tree.nodes.some((n) => n.path === 'config["a.b"]'));
  assert.ok(tree.nodes.some((n) => n.path === "config.a.b"));
});

test("exact Enter identity never resolves a substring or folds case", async () => {
  const { exactEventPath, rankedEventFields } =
    await import("./run-event-config");
  assert.equal(exactEventPath('$["config"]["data"]'), "config.data");
  assert.equal(exactEventPath('config["a.b"]'), 'config["a.b"]');
  assert.equal(exactEventPath("Config"), "Config");
  assert.equal(exactEventPath("\u65e5\u672c\u8a9e"), '["\u65e5\u672c\u8a9e"]');
  for (const query of [
    "",
    "config.",
    "a[",
    "x.".repeat(33) + "x",
    "\u65e5".repeat(400),
  ])
    assert.equal(exactEventPath(query), null);
  const hints = [
    "benchmark_args.config",
    "config.b",
    "Config",
    "config",
    "config.a",
  ].map((path) => ({ path, types: [], present: 1, values: [] }));
  assert.deepEqual(
    rankedEventFields(hints, "config").map((h) => h.path),
    ["config", "Config", "config.a", "config.b", "benchmark_args.config"],
  );
  assert.deepEqual(
    rankedEventFields(hints, '$["config"]').map((h) => h.path),
    rankedEventFields(hints, "config").map((h) => h.path),
  );
  assert.equal(rankedEventFields(hints, "Config")[0].path, "Config");
});

test("Unicode root-key prefixes rank before nested substrings", async () => {
  const { rankedEventFields } = await import("./run-event-config");
  const hints = [
    'nested["\u65e5\u672c"]',
    '$["\u65e5\u672c\u8a9e"]',
    '$["\u65e5\u672c"]',
  ].map((path) => ({ path, types: [], present: 1, values: [] }));
  assert.deepEqual(
    rankedEventFields(hints, "\u65e5\u672c").map((h) => h.path),
    [hints[2].path, hints[1].path, hints[0].path],
  );
});
