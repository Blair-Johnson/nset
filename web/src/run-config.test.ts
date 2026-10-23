import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConfigTree,
  matchingConfigNodes,
  configPath,
  configJSON,
  configType,
} from "./run-config";

test("dotted and nested namespaces keep all original values and exact source paths", () => {
  const params = {
    "data.source.root_path": "/mnt/source",
    "train.optim.lr": 0.001,
    train: { optim: { lr: 0.002 } },
    "data.source": false,
    data: null,
  };
  const before = JSON.stringify(params);
  const tree = buildConfigTree(params);
  const lr = tree.nodes.find((n) => n.path === "train.optim.lr")!;
  assert.deepEqual(
    lr.values.map((v) => v.value),
    [0.001, 0.002],
  );
  assert.deepEqual(
    lr.values.map((v) => v.sourcePath),
    ['$["train.optim.lr"]', '$["train"]["optim"]["lr"]'],
  );
  const data = tree.root.children.get("data")!;
  assert.equal(data.values[0].value, null);
  assert.equal(data.children.get("source")!.values[0].value, false);
  assert.equal(
    data.children.get("source")!.children.get("root_path")!.values[0].value,
    "/mnt/source",
  );
  assert.equal(JSON.stringify(params), before);
});

test("array elements, null, empty containers and string/scalar types stay distinct", () => {
  const params = {
    items: [1, false, null, { name: "α" }],
    string: "false",
    empty: {},
    list: [],
    zero: 0,
  };
  const tree = buildConfigTree(params);
  const all = tree.nodes.flatMap((node) => node.values);
  assert.equal(
    all.find((v) => v.sourcePath === '$["items"][3]["name"]')!.value,
    "α",
  );
  assert.equal(
    all.find((v) => v.sourcePath === '$["empty"]')!.preview,
    "{0 keys}",
  );
  assert.equal(
    all.find((v) => v.sourcePath === '$["list"]')!.preview,
    "[0 items]",
  );
  assert.equal(
    all.find((v) => v.sourcePath === '$["string"]')!.preview,
    '"false"',
  );
  assert.deepEqual([null, [], {}, true, 1, "1"].map(configType), [
    "null",
    "array",
    "object",
    "boolean",
    "number",
    "string",
  ]);
  assert.deepEqual(JSON.parse(configJSON(params)), params);
});

test("prototype and HTML-like keys remain inert data; empty and escaped paths are exact", () => {
  const params = JSON.parse(
    '{"__proto__.polluted":true,"constructor.prototype.x":3,"__proto__":{"x":1},"":null,"a..b":"<img onerror=alert(1)>","a\\\"b":2}',
  );
  const tree = buildConfigTree(params);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(
    tree.root.children.get("__proto__")!.children.get("polluted")!.values[0]
      .value,
    true,
  );
  assert.equal(tree.root.children.get("")!.values[0].value, null);
  assert.equal(configPath(['a"b', 0, ""]), '$["a\\"b"][0][""]');
  assert.deepEqual(JSON.parse(configJSON(params)), params);
});

test("search matches paths and scalar values case-insensitively, retaining ancestors", () => {
  const tree = buildConfigTree({
    "data.source.root_path": "/DATA/Long",
    train: { optim: { lr: 0.03 } },
    absent: null,
  });
  const matches = matchingConfigNodes(tree, "  /data/long  ")!;
  assert.deepEqual(
    tree.nodes.filter((n) => matches.has(n.id)).map((n) => n.path),
    ["data", "data.source", "data.source.root_path"],
  );
  assert.equal(matchingConfigNodes(tree, "missing")!.size, 0);
  assert.equal(matchingConfigNodes(tree, "  "), null);
  const numbers = matchingConfigNodes(tree, "0.03")!;
  assert.ok(
    tree.nodes
      .filter((n) => numbers.has(n.id))
      .some((n) => n.path === "train.optim.lr"),
  );
});

test("thousands of fields are indexed without dropping values or mutating input", () => {
  const params = Object.fromEntries(
    Array.from({ length: 2500 }, (_, i) => [`train.optim.field_${i}`, i]),
  );
  const tree = buildConfigTree(params);
  assert.equal(tree.fields, 2500);
  assert.equal(tree.nodes.length, 2502);
  const matches = matchingConfigNodes(tree, "field_2499")!;
  assert.equal(tree.nodes.filter((n) => matches.has(n.id)).length, 3);
  assert.equal(Object.keys(params).length, 2500);
});
