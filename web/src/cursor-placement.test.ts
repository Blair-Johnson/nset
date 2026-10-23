import assert from "node:assert/strict";
import test from "node:test";
import { cursorPlacement, nextCursorPlacement } from "./cursor-placement.ts";

test("cycle is vertical → horizontal → OFF → vertical, always rearming A", () => {
  const vertical = {
    mode: "inspect",
    cursorAxis: "x",
    activePin: "b",
  } as const;
  const horizontal = nextCursorPlacement(vertical);
  assert.deepEqual(horizontal, {
    mode: "inspect",
    cursorAxis: "y",
    activePin: "a",
  });
  const off = nextCursorPlacement(horizontal);
  assert.deepEqual(off, { mode: "zoom", cursorAxis: "y", activePin: "a" });
  assert.deepEqual(nextCursorPlacement(off), { ...vertical, activePin: "a" });
  assert.deepEqual([vertical, horizontal, off].map(cursorPlacement), [
    "vertical",
    "horizontal",
    "off",
  ]);
});

test("completed placement's stale axis is OFF, and the helper cannot clear pins", () => {
  for (const mode of ["zoom", "pan", "threshold"] as const) {
    for (const cursorAxis of ["x", "y"] as const) {
      const pins = Object.freeze({ a: 20, b: 80, yA: 30, yB: 70 });
      const state = Object.freeze({ mode, cursorAxis, activePin: "b", pins });
      assert.equal(cursorPlacement(state), "off");
      assert.deepEqual(nextCursorPlacement(state), {
        mode: "inspect",
        cursorAxis: "x",
        activePin: "a",
      });
      assert.deepEqual(state, { mode, cursorAxis, activePin: "b", pins });
    }
  }
});

test("unspecified placement axis is the existing vertical default", () => {
  assert.equal(cursorPlacement({ mode: "inspect" }), "vertical");
  assert.deepEqual(nextCursorPlacement({ mode: "inspect" }), {
    mode: "inspect",
    cursorAxis: "y",
    activePin: "a",
  });
});
