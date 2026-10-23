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
  });
  assert.deepEqual(view, before);
  view.sections[0].cards[2].config.axis = "relative";
  view.sections[0].cards[2].config.smoothing = true;
  assert.deepEqual(dashboardSettings(view), {
    count: 2,
    axis: null,
    smoothing: null,
  });
  assert.deepEqual(dashboardSettings({ ...view, sections: [] }), {
    count: 0,
    axis: null,
    smoothing: null,
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
    smoothingStrength: 50,
  });
  assert.equal(sections[0].cards[1], view.sections[0].cards[1]);
  assert.equal(sections[0].cards[0].source, card.source);
  assert.equal(sections[0].cards[0].layout, card.layout);
  assert.equal(sections[0].cards[0].config.xMin, null);
  assert.equal(sections[0].cards[0].config.yScale, "log");
  assert.equal(sections[0].cards[0].config.alpha, 0.1);
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
  assert.throws(() => withDashboardSettings(view, { smoothingStrength: 101 }));
  assert.deepEqual(view, before);
  const sections = withDashboardSettings(view, { axis: "step" });
  assert.equal(sections[0].cards[0], view.sections[0].cards[0]);
  assert.equal(sections[0].cards[2], view.sections[0].cards[2]);
});
test("distinct legacy smoothing coefficients remain Mixed even if both reach slider maximum", () => {
  const view = workspace();
  for (const card of view.sections[0].cards) card.config.smoothing = true;
  view.sections[0].cards[0].config.alpha = 0.001;
  view.sections[0].cards[2].config.alpha = 0.002;
  assert.equal(dashboardSettings(view).smoothing, null);
});
