import { Api } from "./api";
import { validateWorkspace } from "./workspace";
import type { Workspace } from "./workspace-types";
import { uuid } from "./uuid";

export interface ServerViewSummary {
  id: string;
  name: string;
  experimentId: string;
  revision: number;
  updatedAt: number;
}
export interface ServerView {
  id: string;
  revision: number;
  workspace: Workspace;
}
export const serverDraftKey = (id: string) =>
  `nset.server-view-draft.v1:${encodeURIComponent(id)}`;
export const publishedKey = (w: Workspace) =>
  JSON.stringify([w.name, w.selectedRunIds, w.pendingSelectedRunIds ?? [], w.sections]);
export function serverView(value: ServerView, id = value.id): ServerView {
  const workspace = validateWorkspace(value.workspace);
  if (
    !id.startsWith("server:") ||
    value.id !== id ||
    workspace.id !== id ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  )
    throw new Error("Invalid server view revision or identity.");
  return { id, revision: value.revision, workspace };
}
export async function listServerViews(
  api: Api,
  signal?: AbortSignal,
): Promise<ServerViewSummary[]> {
  const result = await api.json<{ views: ServerViewSummary[] }>(
    "/views",
    signal,
  );
  if (
    !Array.isArray(result.views) ||
    result.views.some(
      (v) =>
        typeof v.id !== "string" ||
        !v.id.startsWith("server:") ||
        typeof v.name !== "string" ||
        typeof v.experimentId !== "string" ||
        !Number.isSafeInteger(v.revision) ||
        v.revision < 1,
    )
  )
    throw new Error("Invalid server view list.");
  return result.views;
}
export async function fetchServerView(
  api: Api,
  id: string,
  signal?: AbortSignal,
  revision?: number,
) {
  const response = await api.response(
    `/views/${encodeURIComponent(id)}${revision === undefined ? "" : `?revision=${revision}`}`,
    signal,
  );
  return response.status === 204
    ? undefined
    : serverView(await response.json(), id);
}

/** Separate, per-view storage: server drafts never consume local library slots.
 * Workspace objects remain stable so existing card/drawer closures stay valid. */
export class ServerWorkspace {
  readonly workspace: Workspace;
  private base: ServerView;
  private edits = 0;
  private disposed = false;
  private action?: AbortController;
  busy = false;

  constructor(
    private api: Api,
    latest: ServerView,
    private storage: Storage = localStorage,
    private isCurrent: () => boolean = () => true,
  ) {
    this.base = serverView(latest);
    this.workspace = structuredClone(this.base.workspace);
    const saved = storage.getItem(serverDraftKey(latest.id));
    if (saved) {
      const draft = JSON.parse(saved) as {
        base: ServerView;
        workspace: Workspace;
      };
      const base = serverView(draft.base, latest.id);
      const workspace = validateWorkspace(draft.workspace);
      if (
        workspace.id !== latest.id ||
        workspace.experimentId !== base.workspace.experimentId
      )
        throw new Error("Invalid saved server draft identity.");
      if (publishedKey(workspace) !== publishedKey(base.workspace)) {
        this.base = base;
        delete this.workspace.pendingSelectedRunIds;
        Object.assign(this.workspace, workspace);
      }
    }
  }
  private get active() {
    return !this.disposed && this.isCurrent();
  }
  get revision() {
    return this.base.revision;
  }
  get dirty() {
    return publishedKey(this.workspace) !== publishedKey(this.base.workspace);
  }
  private persist(base = this.base, workspace = this.workspace) {
    if (publishedKey(workspace) === publishedKey(base.workspace))
      this.storage.removeItem(serverDraftKey(base.id));
    else
      this.storage.setItem(
        serverDraftKey(base.id),
        JSON.stringify({ base, workspace }),
      );
  }
  edited() {
    if (!this.active) throw new Error("This server view is no longer active.");
    this.persist();
    this.edits++;
  }
  dispose() {
    this.disposed = true;
    this.action?.abort();
  }
  private adopt(next: ServerView, workspace = next.workspace) {
    const replacement = structuredClone(workspace);
    this.persist(next, replacement);
    this.base = structuredClone(next);
    delete this.workspace.pendingSelectedRunIds;
    Object.assign(this.workspace, replacement);
  }
  async poll(
    signal: AbortSignal,
    canAdopt: () => boolean = () => true,
  ): Promise<boolean> {
    if (!this.active || this.dirty || this.busy || !canAdopt()) return false;
    const edits = this.edits,
      revision = this.revision;
    const next = await fetchServerView(
      this.api,
      this.workspace.id,
      signal,
      revision,
    );
    if (
      signal.aborted ||
      !this.active ||
      !canAdopt() ||
      this.busy ||
      this.edits !== edits ||
      this.dirty ||
      this.revision !== revision ||
      !next ||
      next.revision <= revision
    )
      return false;
    this.adopt(next);
    return true;
  }
  private async operation<T>(
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (!this.active) return undefined;
    if (this.busy)
      throw new Error("A server view operation is already in progress.");
    this.busy = true;
    const action = (this.action = new AbortController());
    try {
      return await run(action.signal);
    } finally {
      this.busy = false;
      this.action = undefined;
    }
  }
  async save() {
    return this.operation(async (signal) => {
      const snapshot = structuredClone(this.workspace),
        edits = this.edits;
      const next = serverView(
        await this.api.put<ServerView>(
          `/views/${encodeURIComponent(snapshot.id)}`,
          { revision: this.revision, workspace: snapshot },
          signal,
        ),
        snapshot.id,
      );
      if (signal.aborted || !this.active) return false;
      // The acknowledged snapshot becomes the new baseline, not edits made while awaiting it.
      this.adopt(next, this.edits === edits ? next.workspace : this.workspace);
      return true;
    });
  }
  async revert() {
    return this.operation(async (signal) => {
      const edits = this.edits;
      const next = await fetchServerView(this.api, this.workspace.id, signal);
      if (signal.aborted || !this.active) return false;
      if (this.edits !== edits)
        throw new Error(
          "New edits were made while reverting. Your draft was retained; revert again to discard them.",
        );
      if (!next) throw new Error("Server did not return the latest view.");
      this.adopt(next);
      return true;
    });
  }
  async saveAsLocal(name: string, commit: (copy: Workspace) => boolean) {
    return this.operation(async (signal) => {
      const edits = this.edits;
      const copy = validateWorkspace({
        ...structuredClone(this.workspace),
        id: `view:${uuid()}`,
        name,
        updatedAt: Date.now(),
      });
      const next = await fetchServerView(this.api, this.workspace.id, signal);
      if (signal.aborted || !this.active) return false;
      if (this.edits !== edits)
        throw new Error(
          "New edits were made while saving a copy. Your draft was retained; try again.",
        );
      if (!next) throw new Error("Server did not return the latest view.");
      if (!commit(copy)) return false;
      this.adopt(next);
      return true;
    });
  }
}

/** Includes explicit and fixed X bindings, not only the selected-run drawer. */
export function referencedRunIds(workspace: Workspace): string[] {
  return [
    ...new Set([
      ...workspace.selectedRunIds,
      ...(workspace.pendingSelectedRunIds ?? []),
      ...workspace.sections.flatMap((s) =>
        s.cards.flatMap((c) => [
          ...(c.source.mode === "explicit"
            ? c.source.series.map((s) => s.runId)
            : []),
          ...(c.x?.mode === "series" ? [c.x.series.runId] : []),
          ...(c.records?.runUids.map(
            (uid) => `${c.records!.sourceId}:${uid}`,
          ) ?? []),
        ]),
      ),
    ]),
  ];
}
