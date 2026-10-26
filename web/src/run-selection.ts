import type { RunFilterSession } from "./run-filter-session";
import type { Workspace } from "./workspace-types";

/** Keep intent only while evidence is unresolved; confirmed exclusions are final.
 * Never derive selection from rendered rows (pagination/Selected mode are views).
 */
export function reconcileRunSelection(
  workspace: Workspace,
  session: RunFilterSession,
): boolean {
  const selected: string[] = [];
  const pending: string[] = [];
  const runs = new Map(session.runs.map((run) => [run.id, run]));
  for (const id of new Set([
    ...workspace.selectedRunIds,
    ...(workspace.pendingSelectedRunIds ?? []),
  ])) {
    const run = runs.get(id);
    // An unloaded catalog page is not evidence of exclusion. With no filters,
    // leave the untouched selection alone; otherwise withhold until loaded.
    const result = run
      ? session.selectionResult(run)
      : session.isNarrowed
        ? null
        : true;
    if (result === true) selected.push(id);
    else if (result === null) pending.push(id);
  }
  const equal = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  if (
    equal(selected, workspace.selectedRunIds) &&
    equal(pending, workspace.pendingSelectedRunIds ?? [])
  )
    return false;
  workspace.selectedRunIds = selected;
  if (pending.length) workspace.pendingSelectedRunIds = pending;
  else delete workspace.pendingSelectedRunIds;
  return true;
}
