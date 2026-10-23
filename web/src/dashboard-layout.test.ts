import test from "node:test";
import assert from "node:assert/strict";
import { addMissingCharts } from "./dashboard-layout";
import { newWorkspace, validateWorkspace } from "./workspace";
import type { Catalog } from "./workspace-types";
const catalog: Catalog = {
  experiments: [{ id: "e", name: "Study", created_at: 0 }],
  runs: [{ id: "r", name: "Run", experiment_id: "e", status: "finished", params: {}, tags: {}, created_at: 0, updated_at: 0 }],
  series: ["train/loss", "train/accuracy"].map(key => ({ run_id: "r", key, kind: "metric", count: 1, last_step: 0, last_timestamp: 0, last_value: 1 })),
};
test("restoring edited automatic cards allocates unique identities and preserves renamed sections", () => {
  const workspace = newWorkspace("e", "Review", ["r"], catalog);
  const section = workspace.sections[0];
  section.title = "My training charts";
  const loss = section.cards.find(card => card.source.mode === "selected" && card.source.keys[0] === "train/loss")!;
  loss.source = { mode: "selected", keys: ["train/accuracy"] };
  addMissingCharts(workspace, catalog);
  assert.equal(workspace.sections.length, 1);
  assert.equal(section.title, "My training charts");
  assert.equal(section.cards.length, 3);
  assert.equal(new Set(section.cards.map(card => card.id)).size, 3);
  assert.doesNotThrow(() => validateWorkspace(workspace));
  addMissingCharts(workspace, catalog);
  assert.equal(section.cards.length, 3);
});
test("source signatures cannot collide on delimiter characters", () => {
  const expanded = { ...catalog, series: [...catalog.series, { ...catalog.series[0], key: "a|b" }] };
  const workspace = newWorkspace("e", "Review", ["r"], expanded);
  const special = workspace.sections.flatMap(section => section.cards).find(card => card.source.mode === "selected" && card.source.keys[0] === "a|b")!;
  special.source = { mode: "selected", keys: ["a", "b"] };
  addMissingCharts(workspace, expanded);
  assert.equal(workspace.sections.flatMap(section => section.cards).length, 4);
  assert.doesNotThrow(() => validateWorkspace(workspace));
});
