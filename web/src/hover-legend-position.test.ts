import test from "node:test";
import assert from "node:assert/strict";
import {
  legendSide,
  type LegendCorners,
  type LegendSide,
} from "./hover-legend-position";

const boxes: LegendCorners = {
  left: { x: -35, y: -10, width: 290, height: 80 },
  right: { x: 365, y: -10, width: 290, height: 80 },
};

test("approach each actual popup edge, including plot-local negative offsets", () => {
  for (const p of [
    [353, 20],
    [667, 20],
    [500, -22],
    [500, 82],
  ] as const)
    assert.equal(legendSide("right", p, boxes), "left");
  for (const p of [
    [352, 20],
    [668, 20],
    [500, -23],
    [500, 83],
  ] as const)
    assert.equal(legendSide("right", p, boxes), "right");
});

test("right is restored only beyond release margin, not on boundary jitter", () => {
  let side: LegendSide = legendSide("right", [360, 30], boxes);
  assert.equal(side, "left");
  for (const x of [350, 355, 360, 352, 340, 337]) {
    side = legendSide(side, [x, 30], boxes);
    assert.equal(side, "left");
  }
  assert.equal(legendSide(side, [336, 30], boxes), "right");
  assert.equal(legendSide(side, [500, 99], boxes), "right");
});

test("approaching the left popup uses a safe right corner", () => {
  assert.equal(legendSide("left", [250, 30], boxes), "right");
  // Right is outside approach, but not release: escape current left if possible.
  const overlapping = { ...boxes, right: { ...boxes.right, x: 280 } };
  assert.equal(legendSide("left", [267, 30], overlapping), "right");
  assert.equal(legendSide("right", [267, 30], overlapping), "right");
});

test("narrow cards keep their side when neither corner has room", () => {
  const narrow = { ...boxes, right: { ...boxes.right, x: 0 } };
  for (const initial of ["left", "right"] as const) {
    let side: LegendSide = initial;
    for (let i = 0; i < 40; i++) {
      side = legendSide(side, [120 + (i % 2), 20], narrow);
      assert.equal(side, initial);
    }
  }
  assert.equal(legendSide("left", [120, 100], narrow), "right");
});

test("resized popup dimensions and both pointer coordinates determine collision", () => {
  assert.equal(legendSide("right", [500, 200], boxes), "right");
  const taller = {
    left: { ...boxes.left, height: 240 },
    right: { ...boxes.right, height: 240 },
  };
  assert.equal(legendSide("right", [500, 200], taller), "left");
  const maximized = { ...boxes, right: { ...boxes.right, x: 1000 } };
  assert.equal(legendSide("left", [500, 20], maximized), "right");
});
