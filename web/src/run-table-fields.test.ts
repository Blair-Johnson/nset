import test from "node:test";
import assert from "node:assert/strict";
import {
  scalarParameters,
  parameterLabel,
  compareParameters,
} from "./run-table-fields";

test("scalar fields keep exact source identities and never mutate params", () => {
  const params = {
    "train.optim.lr": 0,
    train: { optim: { lr: 0.001 } },
    nil: null,
    flag: false,
    empty: "",
    text: "false",
    object: {},
    list: [0, false, null, { "a.b": "value" }],
    '"\\[]': 1,
    __proto__: null,
  };
  const before = JSON.stringify(params);
  const fields = new Map(
    scalarParameters(params).map((field) => [field.sourcePath, field]),
  );
  assert.equal(fields.get('$["train.optim.lr"]')?.value, 0);
  assert.equal(fields.get('$["train"]["optim"]["lr"]')?.value, 0.001);
  assert.match(
    fields.get('$["train"]["optim"]["lr"]')!.search,
    /train.optim.lr/,
  );
  assert.equal(fields.get('$["list"][3]["a.b"]')?.value, "value");
  assert.equal(fields.has('$["object"]'), false);
  assert.equal(fields.has('$["list"]'), false);
  assert.equal(JSON.stringify(params), before);
});

test("null, missing, zero, false and strings are distinct, with numeric sorting", () => {
  assert.deepEqual(
    [undefined, null, false, 0, "", "false"].map(parameterLabel),
    ["—", "null", "false", "0", '""', '"false"'],
  );
  assert.ok(compareParameters(2, 10, false) < 0);
  assert.ok(compareParameters(2, 10, true) > 0);
  for (const descending of [true, false]) {
    assert.ok(compareParameters(undefined, null, descending) > 0);
    assert.ok(compareParameters(null, 0, descending) > 0);
    assert.ok(
      compareParameters(false, true, descending) * (descending ? -1 : 1) < 0,
    );
  }
});
