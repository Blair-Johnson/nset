import test from "node:test";
import assert from "node:assert/strict";
import type { Run } from "./api";
import {
  conditionMatches,
  filterFields,
  readPath,
  runMatchesFilter,
  type FilterCondition,
} from "./run-filter";

const run = (id: string, params: Record<string, unknown>, tags = {}): Run => ({
  id,
  experiment_id: "e",
  name: id,
  status: "finished",
  params,
  tags,
  created_at: 0,
  updated_at: 0,
});
const nested = run("nested", {
  train: { optim: { lr: 0.001 } },
  seeds: [1, 2],
});
const dotted = run("dotted", { "train.optim.lr": 0.1 });
const bare = run("bare", { model: "resnet" }, { owner: "me" });
const lr = '$["train"]["optim"]["lr"]';
const cond = (patch: Partial<FilterCondition>): FilterCondition => ({
  scope: "params",
  path: lr,
  op: "lt",
  value: "0.01",
  missing: "exclude",
  ...patch,
});

test("readPath follows exact JSONPath identities, never literal dots", () => {
  assert.equal(readPath(nested.params, lr), 0.001);
  assert.equal(readPath(dotted.params, lr), undefined);
  assert.equal(readPath(dotted.params, '$["train.optim.lr"]'), 0.1);
  assert.equal(readPath(nested.params, '$["seeds"][1]'), 2);
  assert.equal(readPath(nested.params, '$["seeds"][5]'), undefined);
  assert.equal(readPath(nested.params, '$["train"]["nope"]'), undefined);
});

test("missing-path policy is explicit: exclude, include, or treat as a value", () => {
  assert.equal(conditionMatches(nested, cond({})), true);
  assert.equal(conditionMatches(bare, cond({ missing: "exclude" })), false);
  assert.equal(conditionMatches(bare, cond({ missing: "include" })), true);
  assert.equal(
    conditionMatches(bare, cond({ missing: "default", fallback: "0.001" })),
    true,
  );
  assert.equal(
    conditionMatches(bare, cond({ missing: "default", fallback: "1" })),
    false,
  );
  // "exists" is false for missing paths unless missing runs are included.
  assert.equal(conditionMatches(bare, cond({ op: "exists" })), false);
  assert.equal(conditionMatches(nested, cond({ op: "exists" })), true);
});

test("operators compare numbers numerically and JSON values exactly", () => {
  assert.equal(
    conditionMatches(nested, cond({ op: "gte", value: "0.001" })),
    true,
  );
  assert.equal(
    conditionMatches(nested, cond({ op: "gt", value: "0.001" })),
    false,
  );
  assert.equal(
    conditionMatches(nested, cond({ op: "eq", value: "1e-3" })),
    true,
  );
  const model = '$["model"]';
  assert.equal(
    conditionMatches(bare, cond({ path: model, op: "eq", value: "resnet" })),
    true,
  );
  assert.equal(
    conditionMatches(bare, cond({ path: model, op: "contains", value: "RES" })),
    true,
  );
  assert.equal(
    conditionMatches(bare, cond({ path: model, op: "neq", value: '"resnet"' })),
    false,
  );
  assert.equal(
    conditionMatches(
      bare,
      cond({ scope: "tags", path: '$["owner"]', op: "eq", value: "me" }),
    ),
    true,
  );
});

test("conditions combine with all/any; incomplete conditions are ignored", () => {
  const filter = (combine: "all" | "any") => ({
    combine,
    conditions: [
      cond({ missing: "exclude" }),
      cond({ path: '$["model"]', op: "eq" as const, value: "resnet" }),
      cond({ path: "" }),
    ],
  });
  assert.deepEqual(
    [nested, dotted, bare]
      .filter((r) => runMatchesFilter(r, filter("all")))
      .map((r) => r.id),
    [],
  );
  assert.deepEqual(
    [nested, dotted, bare]
      .filter((r) => runMatchesFilter(r, filter("any")))
      .map((r) => r.id),
    ["nested", "bare"],
  );
  assert.equal(
    runMatchesFilter(bare, { combine: "all", conditions: [] }),
    true,
  );
});

test("filterFields lists every leaf path with coverage, params before tags", () => {
  const fields = filterFields([nested, dotted, bare]);
  const lrField = fields.find((f) => f.path === lr)!;
  assert.equal(lrField.count, 1);
  assert.equal(lrField.label, "train.optim.lr");
  assert.ok(fields.some((f) => f.path === '$["train.optim.lr"]'));
  assert.equal(fields.at(-1)!.scope, "tags");
});
