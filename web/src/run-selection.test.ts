import test from "node:test";
import assert from "node:assert/strict";
import type { Run } from "./api";
import { RunFilterSession } from "./run-filter-session";
import { reconcileRunSelection } from "./run-selection";
import { newWorkspace, validateWorkspace } from "./workspace";
import type { Catalog } from "./workspace-types";

const runs: Run[] = [1, 2].map((n) => ({
  id: `r${n}`,
  experiment_id: "e",
  name: `run ${n}`,
  status: n === 1 ? "running" : "finished",
  params: {},
  tags: {},
  created_at: n * 1000,
  updated_at: n * 1000,
}));
const catalog: Catalog = { experiments: [], runs, series: [] };
const workspace = () => newWorkspace("e", "test", ["r1", "r2"], catalog);

test("untouched selection survives; search/status prune permanently, not merely traces", () => {
  const w = workspace();
  const session = new RunFilterSession();
  session.setRuns(runs);
  assert.equal(reconcileRunSelection(w, session), false);
  session.setSearch("", "running");
  assert.equal(reconcileRunSelection(w, session), true);
  assert.deepEqual(w.selectedRunIds, ["r1"]);
  session.setSearch("", "all");
  assert.equal(reconcileRunSelection(w, session), false);
  assert.deepEqual(w.selectedRunIds, ["r1"]);
  w.selectedRunIds.push("r2");
  session.setSearch("run 2", "all");
  reconcileRunSelection(w, session);
  assert.deepEqual(w.selectedRunIds, ["r2"]);
  session.destroy();
});

test("unresolved intent round trips independently; true restores, false removes, unknown waits", () => {
  let w = workspace();
  const session = new RunFilterSession();
  session.setRuns(runs);
  let result: boolean | null = null;
  session.selectionResult = (run) => (run.id === "r1" ? true : result);
  reconcileRunSelection(w, session);
  assert.deepEqual(w.selectedRunIds, ["r1"]);
  assert.deepEqual(w.pendingSelectedRunIds, ["r2"]);
  w = validateWorkspace(JSON.parse(JSON.stringify(w)));
  assert.equal(reconcileRunSelection(w, session), false);
  result = true;
  reconcileRunSelection(w, session);
  assert.deepEqual(w.selectedRunIds, ["r1", "r2"]);
  assert.equal(w.pendingSelectedRunIds, undefined);
  result = false;
  reconcileRunSelection(w, session);
  result = true;
  reconcileRunSelection(w, session);
  assert.deepEqual(w.selectedRunIds, ["r1"]);
  session.destroy();
});

test("unloaded pages are not negative evidence, and duplicate pending IDs are rejected", () => {
  const w = workspace();
  const session = new RunFilterSession();
  session.setRuns([]);
  assert.equal(reconcileRunSelection(w, session), false);
  session.setSearch("run", "all");
  reconcileRunSelection(w, session);
  assert.deepEqual(w.selectedRunIds, []);
  assert.deepEqual(w.pendingSelectedRunIds, ["r1", "r2"]);
  session.setRuns(runs);
  reconcileRunSelection(w, session);
  assert.deepEqual(w.selectedRunIds, ["r1", "r2"]);
  assert.throws(() =>
    validateWorkspace({ ...w, pendingSelectedRunIds: ["r1"] }),
  );
  session.destroy();
});
