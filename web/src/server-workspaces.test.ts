import test from "node:test";
import assert from "node:assert/strict";
import { Api } from "./api";
import {
  ServerWorkspace,
  fetchServerView,
  listServerViews,
  publishedKey,
  referencedRunIds,
  serverDraftKey,
  serverView,
  type ServerView,
} from "./server-workspaces";
import {
  loadLibrary,
  newChart,
  saveLibrary,
  validateWorkspace,
} from "./workspace";
import type { Workspace } from "./workspace-types";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
const envelope = (revision = 1, name = "Shared"): ServerView => ({
  id: "server:test / exact",
  revision,
  workspace: {
    version: 2,
    id: "server:test / exact",
    experimentId: "exp",
    name,
    selectedRunIds: ["run"],
    sections: [
      {
        id: "section",
        title: "Metrics",
        collapsed: false,
        cards: [newChart("timeseries", ["loss"])],
      },
    ],
    updatedAt: revision,
  },
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function backend(initial = envelope()) {
  let current = structuredClone(initial);
  const requests: { path: string; method: string; body?: any }[] = [];
  let failure = 0;
  let gate: Promise<void> | undefined;
  const api = new Api(
    () => "secret",
    async (input, init) => {
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer secret",
      );
      const url = new URL(String(input), "http://test");
      const method = init?.method ?? "GET",
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname + url.search, method, body });
      const snapshot = structuredClone(current);
      const status = failure;
      if (gate) await gate;
      if (status) return response({ error: "Write failed" }, status);
      if (url.pathname === "/api/views")
        return response({
          views: [
            {
              id: current.id,
              revision: current.revision,
              name: current.workspace.name,
              experimentId: "exp",
              updatedAt: current.workspace.updatedAt,
            },
          ],
        });
      assert.equal(
        decodeURIComponent(url.pathname.slice("/api/views/".length)),
        initial.id,
      );
      if (method === "PUT") {
        if (body.revision !== current.revision)
          return response({ error: "Conflict" }, 409);
        current = {
          id: current.id,
          revision: current.revision + 1,
          workspace: { ...body.workspace, updatedAt: 100 },
        };
        return response(current);
      }
      if (Number(url.searchParams.get("revision")) === snapshot.revision)
        return new Response(null, { status: 204 });
      return response(snapshot);
    },
  );
  return {
    api,
    requests,
    get current() {
      return current;
    },
    set current(value: ServerView) {
      current = structuredClone(value);
    },
    fail(status: number) {
      failure = status;
    },
    delay() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}
function edit(state: ServerWorkspace, name: string) {
  state.workspace.name = name;
  state.edited();
}
const signal = () => new AbortController().signal;

test("clean views follow newer revisions in place; conditional fetch leaves unchanged view alone", async () => {
  const b = backend(),
    storage = new MemoryStorage(),
    state = new ServerWorkspace(b.api, b.current, storage);
  const identity = state.workspace,
    chartId = identity.sections[0].cards[0].id;
  assert.equal(await state.poll(signal()), false);
  b.current = {
    ...b.current,
    revision: 2,
    workspace: { ...b.current.workspace, name: "Updated" },
  };
  assert.equal(await state.poll(signal()), true);
  assert.equal(state.workspace, identity);
  assert.equal(state.workspace.sections[0].cards[0].id, chartId);
  assert.equal(state.workspace.name, "Updated");
  assert.equal(state.revision, 2);
  assert.equal(state.dirty, false);
  assert.equal(storage.length, 0);
});
test("name and selected runs are published edits; timestamps alone are not", () => {
  const b = backend(),
    state = new ServerWorkspace(b.api, b.current, new MemoryStorage());
  state.workspace.updatedAt++;
  assert.equal(state.dirty, false);
  state.workspace.selectedRunIds.push("second");
  state.edited();
  assert.equal(state.dirty, true);
  state.workspace.selectedRunIds.pop();
  state.edited();
  assert.equal(state.dirty, false);
  edit(state, "Renamed");
  assert.equal(state.dirty, true);
});
test("dirty draft survives polls and reload with its original revision, then stale save reports 409", async () => {
  const b = backend(),
    storage = new MemoryStorage(),
    state = new ServerWorkspace(b.api, b.current, storage);
  edit(state, "Draft");
  b.current = {
    ...b.current,
    revision: 2,
    workspace: { ...b.current.workspace, name: "Other client" },
  };
  assert.equal(await state.poll(signal()), false);
  assert.equal(b.requests.length, 0);
  const reload = new ServerWorkspace(b.api, b.current, storage);
  assert.equal(reload.workspace.name, "Draft");
  assert.equal(reload.revision, 1);
  await assert.rejects(() => reload.save(), /409.*draft is retained/);
  assert.equal(reload.dirty, true);
  assert.equal(reload.workspace.name, "Draft");
  assert.equal(
    JSON.parse(storage.getItem(serverDraftKey(state.workspace.id))!).base
      .revision,
    1,
  );
});
test("failed saves never mark a draft saved; successful saves use the acknowledged revision", async () => {
  const b = backend(),
    state = new ServerWorkspace(b.api, b.current, new MemoryStorage());
  edit(state, "Draft");
  b.fail(500);
  await assert.rejects(() => state.save(), /Write failed/);
  assert.equal(state.revision, 1);
  assert.equal(state.dirty, true);
  b.fail(0);
  await state.save();
  assert.equal(state.revision, 2);
  assert.equal(state.dirty, false);
  assert.equal(state.workspace.updatedAt, 100);
  assert.deepEqual(b.requests[1].body.workspace.name, "Draft");
});
test("edits made during a save survive, with the confirmed snapshot as their new base", async () => {
  const b = backend(),
    storage = new MemoryStorage(),
    state = new ServerWorkspace(b.api, b.current, storage);
  edit(state, "Submitted");
  const release = b.delay();
  const pending = state.save();
  assert.equal(state.busy, true);
  edit(state, "Newer local input");
  release();
  await pending;
  assert.equal(state.workspace.name, "Newer local input");
  assert.equal(state.revision, 2);
  assert.equal(state.dirty, true);
  const stored = JSON.parse(
    storage.getItem(serverDraftKey(state.workspace.id))!,
  );
  assert.equal(stored.base.workspace.name, "Submitted");
  assert.equal(stored.workspace.name, "Newer local input");
  const reload = new ServerWorkspace(b.api, b.current, storage);
  assert.equal(reload.revision, 2);
  assert.equal(reload.workspace.name, "Newer local input");
});
test("revert fetches latest, not the old draft base", async () => {
  const b = backend(),
    storage = new MemoryStorage(),
    state = new ServerWorkspace(b.api, b.current, storage);
  edit(state, "Draft");
  b.current = {
    ...b.current,
    revision: 4,
    workspace: { ...b.current.workspace, name: "Latest" },
  };
  await state.revert();
  assert.equal(state.workspace.name, "Latest");
  assert.equal(state.revision, 4);
  assert.equal(state.dirty, false);
  assert.equal(storage.length, 0);
  assert.equal(b.requests[0].path.includes("revision="), false);
});
test("revert and save-as protect edits made while awaiting the server", async () => {
  for (const copy of [false, true]) {
    const b = backend(),
      state = new ServerWorkspace(b.api, b.current, new MemoryStorage());
    edit(state, "Draft");
    const release = b.delay();
    let copied = false;
    const pending = copy
      ? state.saveAsLocal("Copy", () => {
          copied = true;
          return true;
        })
      : state.revert();
    edit(state, "Newer");
    release();
    await assert.rejects(() => pending, /New edits.*retained/);
    assert.equal(state.workspace.name, "Newer");
    assert.equal(state.dirty, true);
    assert.equal(copied, false);
  }
});
test("Save as creates an ordinary new local workspace and resets original to current server version", async () => {
  const b = backend(),
    storage = new MemoryStorage(),
    state = new ServerWorkspace(b.api, b.current, storage);
  edit(state, "Draft");
  b.current = {
    ...b.current,
    revision: 3,
    workspace: { ...b.current.workspace, name: "Server latest" },
  };
  let copy!: Workspace;
  await state.saveAsLocal("Local copy", (value) => {
    copy = value;
    return true;
  });
  assert.notEqual(copy.id, state.workspace.id);
  assert.match(copy.id, /^view:/);
  assert.equal(copy.name, "Local copy");
  assert.deepEqual(validateWorkspace(copy), copy);
  assert.equal("revision" in copy, false);
  assert.equal("base" in copy, false);
  assert.equal(state.workspace.name, "Server latest");
  assert.equal(state.revision, 3);
  assert.equal(state.dirty, false);
  assert.equal(storage.length, 0);
  assert.equal(
    b.requests.some((r) => r.method === "PUT"),
    false,
  );
});
test("failed local copy persistence leaves original draft unchanged", async () => {
  const b = backend(),
    state = new ServerWorkspace(b.api, b.current, new MemoryStorage());
  edit(state, "Draft");
  assert.equal(await state.saveAsLocal("Copy", () => false), false);
  assert.equal(state.workspace.name, "Draft");
  assert.equal(state.dirty, true);
});
test("independent clients detect conflicting writes without losing either draft", async () => {
  const b = backend(),
    first = new ServerWorkspace(b.api, b.current, new MemoryStorage()),
    second = new ServerWorkspace(b.api, b.current, new MemoryStorage());
  edit(first, "First");
  edit(second, "Second");
  await first.save();
  await assert.rejects(() => second.save(), /409/);
  assert.equal(first.dirty, false);
  assert.equal(second.workspace.name, "Second");
  await second.revert();
  assert.equal(second.workspace.name, "First");
});
test("poll responses cannot overwrite intervening edits or disposed views", async () => {
  for (const dispose of [false, true]) {
    const b = backend(),
      state = new ServerWorkspace(b.api, b.current, new MemoryStorage());
    b.current = {
      ...b.current,
      revision: 2,
      workspace: { ...b.current.workspace, name: "Remote" },
    };
    const release = b.delay();
    const pending = state.poll(signal());
    if (dispose) state.dispose();
    else edit(state, "Local");
    release();
    assert.equal(await pending, false);
    assert.equal(state.workspace.name, dispose ? "Shared" : "Local");
  }
});
test("navigation/logout disposal ignores delayed save results and preserves recoverable draft", async () => {
  const b = backend(),
    storage = new MemoryStorage(),
    state = new ServerWorkspace(b.api, b.current, storage);
  edit(state, "Submitted");
  const release = b.delay();
  const pending = state.save();
  state.dispose();
  release();
  assert.equal(await pending, false);
  assert.equal(state.revision, 1);
  assert.equal(state.dirty, true);
  assert.equal(storage.length, 1);
});
test("explicit operations are serialized; a second action cannot race an ongoing save", async () => {
  const b = backend(),
    state = new ServerWorkspace(b.api, b.current, new MemoryStorage());
  edit(state, "Draft");
  const release = b.delay();
  const pending = state.save();
  await assert.rejects(() => state.revert(), /already in progress/);
  assert.equal(await state.poll(signal()), false);
  release();
  await pending;
  assert.equal(state.busy, false);
});
test("server drafts don't enter or consume the 128-slot local library", () => {
  const storage = new MemoryStorage(),
    b = backend();
  const views = Array.from({ length: 128 }, (_, i) => ({
    ...b.current.workspace,
    id: `local:${i}`,
  }));
  saveLibrary(
    { version: 2, views, activeByExperiment: { exp: "local:0" } },
    storage,
  );
  const state = new ServerWorkspace(b.api, b.current, storage);
  edit(state, "Server draft");
  assert.equal(loadLibrary(storage).views.length, 128);
  assert.equal(loadLibrary(storage).activeByExperiment.exp, "local:0");
  assert.equal(
    loadLibrary(storage).views.some((v) => v.id === state.workspace.id),
    false,
  );
});
test("API URLs encode exact identities, list entries are separate, and malformed revisions fail", async () => {
  const b = backend();
  await fetchServerView(b.api, b.current.id, signal(), 1);
  assert.equal(
    b.requests[0].path,
    `/api/views/${encodeURIComponent(b.current.id)}?revision=1`,
  );
  assert.equal((await listServerViews(b.api))[0].name, "Shared");
  assert.throws(() => serverView({ ...b.current, revision: 0 }), /Invalid/);
  assert.throws(
    () => serverView({ ...b.current, revision: Number.MAX_SAFE_INTEGER + 1 }),
    /Invalid/,
  );
  assert.throws(
    () => serverView({ ...b.current, id: "server:other" }),
    /Invalid/,
  );
});
test("catalog dependency scan includes selected, explicit, and fixed X runs", () => {
  const w = envelope().workspace,
    card = w.sections[0].cards[0];
  card.source = {
    mode: "explicit",
    series: [{ runId: "explicit", key: "loss", kind: "metric" }],
  };
  card.x = {
    mode: "series",
    series: { runId: "x-run", key: "time", kind: "metric" },
  };
  assert.deepEqual(referencedRunIds(w), ["run", "explicit", "x-run"]);
  assert.equal(publishedKey(w).includes("updatedAt"), false);
});

test("active-route and open-editor guards reject replies even before disposal", async () => {
  for (const routeChange of [false, true]) {
    const b = backend();
    let active = true,
      editorClosed = true;
    const state = new ServerWorkspace(
      b.api,
      b.current,
      new MemoryStorage(),
      () => active,
    );
    b.current = {
      ...b.current,
      revision: 2,
      workspace: { ...b.current.workspace, name: "Remote" },
    };
    const release = b.delay();
    const pending = state.poll(signal(), () => editorClosed);
    if (routeChange) active = false;
    else editorClosed = false;
    release();
    assert.equal(await pending, false);
    assert.equal(state.workspace.name, "Shared");
  }
});

test("catalog dependency scan includes pinned rx UIDs outside the drawer selection", () => {
  const w = envelope().workspace,
    card = w.sections[0].cards[0];
  card.records = {
    sourceId: "rx:repo",
    runUids: ["new-run"],
    x: "step",
    ys: ["loss"],
    filters: { any: false, conditions: [] },
  };
  assert.deepEqual(referencedRunIds(w), ["run", "rx:repo:new-run"]);
  card.records.runUids = [];
  assert.deepEqual(referencedRunIds(w), ["run"]);
});
