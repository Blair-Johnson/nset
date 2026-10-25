import assert from "node:assert/strict";
import { test } from "node:test";
import { uuid } from "./uuid";

const v4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function withoutRandomUUID(run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(crypto, "randomUUID", descriptor);
    else Reflect.deleteProperty(crypto, "randomUUID");
  }
}

test("uses native randomUUID with its crypto receiver when available", (t) => {
  const expected = "12345678-1234-4234-8234-123456789abc";
  const native = t.mock.method(crypto, "randomUUID", function (this: Crypto) {
    assert.equal(this, crypto);
    return expected;
  });
  t.mock.method(crypto, "getRandomValues", () => {
    throw new Error("Native UUID generation must not use the fallback");
  });
  assert.equal(uuid(), expected);
  assert.equal(native.mock.callCount(), 1);
});

test("fallback sets version/variant bits and retains zero padding", (t) => {
  let fill = 0;
  const random = t.mock.method(
    crypto,
    "getRandomValues",
    (bytes: Uint8Array) => {
      assert.equal(bytes.length, 16);
      return bytes.fill(fill);
    },
  );
  withoutRandomUUID(() => {
    assert.equal(uuid(), "00000000-0000-4000-8000-000000000000");
    fill = 255;
    assert.equal(uuid(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
  });
  assert.equal(random.mock.callCount(), 2);
});

test("fallback generates valid, distinct v4 UUIDs with real getRandomValues", () => {
  withoutRandomUUID(() => {
    const ids = Array.from({ length: 10_000 }, () => uuid());
    for (const id of ids) assert.match(id, v4);
    assert.equal(new Set(ids).size, ids.length);
  });
});
