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
