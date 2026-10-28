import test from "node:test";
import assert from "node:assert/strict";
import { newChart, validateWorkspace } from "./workspace";
import { dashboardSettings, withDashboardSettings } from "./workspace-settings";
import type { Workspace } from "./workspace-types";
function workspace(): Workspace {
  return {
    version: 2,
    id: "w",
    name: "View",
    experimentId: "e",
    selectedRunIds: ["r"],
    updatedAt: 1,
    sections: [
      {
        id: "s",
        title: "train",
        collapsed: true,
        cards: [
          newChart("timeseries", ["loss"]),
          newChart("image", ["prediction"]),
          newChart("timeseries", ["accuracy"]),
        ],
      },
    ],
  };
}
test("global settings summarize all scalar plots including folded sections without mutation", () => {
  const view = workspace(),
    before = structuredClone(view);
  assert.deepEqual(dashboardSettings(view), {
    count: 2,
    axis: "step",
    smoothing: 0,
    smoothingUnit: "steps",
    smoothingSignature: JSON.stringify(["step", "linear", null]),
  });
  assert.deepEqual(view, before);
  view.sections[0].cards[2].config.axis = "relative";
  view.sections[0].cards[2].config.smoothing = true;
  assert.deepEqual(dashboardSettings(view), {
    count: 2,
    axis: null,
    smoothing: null,
    smoothingUnit: null,
    smoothingSignature: null,
  });
  assert.deepEqual(dashboardSettings({ ...view, sections: [] }), {
    count: 0,
    axis: null,
    smoothing: null,
    smoothingUnit: null,
    smoothingSignature: null,
  });
});
test("global apply stages scalar changes while preserving geometry, sources and image identity", () => {
  const view = workspace(),
    before = structuredClone(view);
  const card = view.sections[0].cards[0];
  card.layout = { width: 700, height: 450 };
  card.config.xMin = 12;
  card.config.yScale = "log";
  const sections = withDashboardSettings(view, {
    axis: "relative",
    smoothingSigma: 50,
  });
  assert.equal(sections[0].cards[1], view.sections[0].cards[1]);
  assert.equal(sections[0].cards[0].source, card.source);
  assert.equal(sections[0].cards[0].layout, card.layout);
  assert.equal(sections[0].cards[0].config.xMin, null);
  assert.equal(sections[0].cards[0].config.yScale, "log");
  assert.equal(sections[0].cards[0].config.smoothingSigma, 50);
  assert.equal(card.config.axis, "step");
  assert.equal(card.config.xMin, 12);
  assert.equal(view.selectedRunIds[0], before.selectedRunIds[0]);
  assert.equal(
    validateWorkspace({ ...view, sections }).sections[0].cards[0].config.axis,
    "relative",
  );
});
test("global updates reject invalid values atomically and no-op configs preserve card identity", () => {
  const view = workspace(),
    before = structuredClone(view);
  assert.throws(() => withDashboardSettings(view, { smoothingSigma: -1 }));
  assert.deepEqual(view, before);
  const sections = withDashboardSettings(view, { axis: "step" });
  assert.equal(sections[0].cards[0], view.sections[0].cards[0]);
  assert.equal(sections[0].cards[2], view.sections[0].cards[2]);
});
test("distinct sigma values remain mixed within compatible units", () => {
  const view = workspace();
  for (const card of view.sections[0].cards) card.config.smoothing = true;
  view.sections[0].cards[0].config.smoothingSigma = 0.001;
  view.sections[0].cards[2].config.smoothingSigma = 0.002;
  assert.equal(dashboardSettings(view).smoothing, null);
});

test("mixed coordinate signatures refuse positive global sigma but allow Off", () => {
  const view = workspace();
  const [ordinary, , xy] = view.sections[0].cards;
  ordinary.config.smoothing = true;
  ordinary.config.smoothingSigma = 2;
  xy.x = { mode: "key", key: "x" };
  xy.config.joinScale = "log";
  xy.config.smoothing = true;
  xy.config.smoothingSigma = 3;
  assert.equal(dashboardSettings(view).smoothingUnit, null);
  const before = structuredClone(view);
  assert.throws(
    () => withDashboardSettings(view, { smoothingSigma: 2 }),
    /Mixed units/,
  );
  assert.deepEqual(view, before);
  const sections = withDashboardSettings(view, { smoothingSigma: 0 });
  assert.equal(sections[0].cards[0].config.smoothing, false);
  assert.equal(sections[0].cards[0].config.smoothingSigma, 2);
  assert.equal(sections[0].cards[2].config.smoothing, false);
  assert.equal(sections[0].cards[2].config.smoothingSigma, 3);
});

test("final metric-X scales do not determine XY smoothing compatibility", () => {
  const view = workspace();
  const xy = view.sections[0].cards[2];
  xy.x = { mode: "key", key: "x" };
  xy.config.xScale = "log";
  xy.config.advanced = { scales: { x: { log: 2 } } };
  assert.equal(dashboardSettings(view).smoothingUnit, "steps");
  assert.equal(
    withDashboardSettings(view, { smoothingSigma: 0.5 })[0].cards[2].config
      .smoothingSigma,
    0.5,
  );
  xy.config.joinScale = "asinh";
  assert.equal(dashboardSettings(view).smoothingSignature, null);
});

test("same unit labels with different effective asinh thresholds remain incompatible", () => {
  const view = workspace();
  for (const card of view.sections[0].cards) card.config.xScale = "asinh";
  view.sections[0].cards[0].config.advanced = { scales: { x: { asinh: 2 } } };
  assert.equal(dashboardSettings(view).smoothingSignature, null);
  assert.throws(
    () => withDashboardSettings(view, { smoothingSigma: 1 }),
    /Mixed units/,
  );
});

test("paired record plots neither claim smoothing nor receive global edits", () => {
  const view = workspace();
  const card = view.sections[0].cards[0];
  card.records = {
    sourceId: "samples",
    runUids: [],
    x: "a",
    ys: ["b"],
    filters: { any: false, conditions: [] },
  };
  assert.equal(dashboardSettings(view).count, 1);
  assert.equal(
    withDashboardSettings(view, { smoothingSigma: 3 })[0].cards[0],
    card,
  );
});
