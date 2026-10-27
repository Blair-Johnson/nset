import test from "node:test";
import { readFileSync } from "node:fs";
import { palette } from "./config";
import assert from "node:assert/strict";
import {
  defaultSections,
  exportWorkspace,
  importWorkspace,
  loadLibrary,
  newChart,
  newWorkspace,
  resetChart,
  reorderSections,
  resolveSources,
  saveLibrary,
  seriesId,
  validateChart,
  validateWorkspace,
} from "./workspace";
import type { Catalog, WorkspaceLibrary } from "./workspace-types";

function catalog(): Catalog {
  return {
    experiments: ["e1", "e2"].map((id) => ({ id, name: id, created_at: 1 })),
    runs: ["r1", "r2"].map((id, i) => ({
      id,
      name: "Run",
      experiment_id: `e${i + 1}`,
      status: "finished",
      params: {},
      tags: {},
      created_at: 1,
      updated_at: 2,
    })),
    series: [
      { run_id: "r1", key: "train/loss", kind: "metric" },
      { run_id: "r1", key: "train/accuracy", kind: "metric" },
      { run_id: "r1", key: "train/sample", kind: "image" },
      { run_id: "r2", key: "train/loss", kind: "metric" },
      { run_id: "r1", key: "score", kind: "metric" },
      { run_id: "r1", key: "train/deep/loss", kind: "metric" },
    ].map((s) => ({
      ...s,
      kind: s.kind as "metric" | "image",
      count: 0,
      last_step: 0,
      last_timestamp: 1,
      last_value: s.kind === "image" ? null : 0,
    })),
  };
}
function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (i) => [...values.keys()][i] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
test("default sections mix media, retain nested namespaces and use stable identities", () => {
  const c = catalog();
  const sections = defaultSections(c, ["r1"]);
  assert.deepEqual(
    sections.map((s) => s.title),
    ["Overview", "train", "train/deep"],
  );
  assert.deepEqual(
    sections[1].cards.map((c) => c.kind),
    ["timeseries", "timeseries", "image"],
  );
  assert.deepEqual(
    defaultSections({ ...c, series: [...c.series].reverse() }, ["r1"]),
    sections,
  );
  assert.deepEqual(defaultSections(c, []), []);
  assert.deepEqual(newWorkspace("e1", "Empty", [], c).selectedRunIds, []);
});
test("selected sources have distinct metrics per run, escaped IDs and readable labels", () => {
  const c = catalog(),
    card = newChart("timeseries", ["train/loss", "train/accuracy"]);
  const resolved = resolveSources(card, ["r1", "r1", "r2"], c);
  assert.equal(resolved.length, 3);
  assert.equal(new Set(resolved.map((s) => s.id)).size, 3);
  assert.ok(
    resolved.every((s) => s.label.includes("Run") && s.label.includes(s.key)),
  );
  assert.notEqual(
    seriesId({ runId: "a/b", key: "c", kind: "metric" }),
    seriesId({ runId: "a", key: "b/c", kind: "metric" }),
  );
  assert.notEqual(
    seriesId({ runId: "a", key: "b", kind: "metric" }),
    seriesId({ runId: "a", key: "b", kind: "image" }),
  );
});
test("explicit cross-experiment bindings ignore selection and preserve unavailable references", () => {
  const card = newChart("timeseries", []);
  card.source = {
    mode: "explicit",
    series: [
      { runId: "r2", key: "train/loss", kind: "metric" },
      { runId: "missing", key: "train/loss", kind: "metric" },
      { runId: "r1", key: "train/sample", kind: "image" },
    ],
  };
  assert.deepEqual(
    resolveSources(card, ["r1"], catalog()).map((s) => s.runId),
    ["r2"],
  );
  assert.equal(card.source.series.length, 3);
});
test("new charts have unique IDs, safe dark defaults and no implicit selection", () => {
  const a = newChart("timeseries", []),
    b = newChart("timeseries", []);
  assert.notEqual(a.id, b.id);
  assert.equal(a.config.height, 280);
  assert.equal(a.config.style.color, palette[0]);
  assert.equal(a.outliers, "all");
  assert.equal(a.config.smoothing, false);
  assert.deepEqual(a.source, { mode: "selected", keys: [] });
  assert.deepEqual(validateChart(a), a);
});
test("workspace/library round trip retains only config and references", () => {
  const view = newWorkspace("e1", "Named view", ["r1"], catalog());
  assert.deepEqual(importWorkspace(exportWorkspace(view)), view);
  const library: WorkspaceLibrary = {
    version: 2,
    views: [view],
    activeByExperiment: { e1: view.id },
  };
  const target = storage();
  saveLibrary(library, target);
  assert.deepEqual(loadLibrary(target), library);
  assert.equal(
    target.getItem("nset.workspaces.v2")?.includes("last_value"),
    false,
  );
  assert.equal(target.getItem("nset.workspaces.v2")?.includes("params"), false);
});
test("unsafe imports reject unknown fields/modes, duplicate IDs and prototype pollution", () => {
  const view = newWorkspace("e1", "Named", ["r1"], catalog());
  for (const field of ["token", "credentials", "points", "rawValues"])
    assert.throws(() => validateWorkspace({ ...view, [field]: "secret" }));
  assert.throws(() => importWorkspace('{"__proto__":{"polluted":true}}'));
  assert.throws(() => importWorkspace('{"constructor":{}}'));
  assert.throws(
    () =>
      validateWorkspace({
        ...view,
        sections: [view.sections[0], view.sections[0]],
      }),
    /Duplicate/,
  );
  const duplicate = structuredClone(view);
  duplicate.sections[1].cards.push(duplicate.sections[0].cards[0]);
  assert.throws(() => validateWorkspace(duplicate), /Duplicate/);
  assert.throws(
    () =>
      validateChart({ ...newChart("timeseries", []), source: { mode: "all" } }),
    /mode/,
  );
  assert.throws(() =>
    validateChart({ ...newChart("timeseries", []), size: "huge" }),
  );
  assert.throws(() =>
    validateChart({ ...newChart("timeseries", []), outliers: "hidden" }),
  );
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});
test("validation rejects duplicate references, malformed values, oversized inputs and executable objects", () => {
  const card = newChart("timeseries", []),
    ref = { runId: "r1", key: "loss", kind: "metric" };
  assert.throws(
    () =>
      validateChart({
        ...card,
        source: { mode: "explicit", series: [ref, ref] },
      }),
    /Duplicate/,
  );
  assert.throws(() =>
    validateChart({
      ...card,
      config: { ...card.config, advanced: { hooks: {} } },
    }),
  );
  assert.throws(() =>
    validateChart({ ...card, config: { ...card.config, height: Infinity } }),
  );
  assert.throws(() => importWorkspace(" ".repeat(300000)));
  const accessor = Object.defineProperty({}, "id", {
    enumerable: true,
    get() {
      throw new Error("getter was called");
    },
  });
  assert.throws(() => validateWorkspace(accessor), /accessors/);
});
test("unavailable/corrupt storage loads safely; write failures and invalid libraries are reported", () => {
  const target = storage();
  target.setItem("nset.workspaces.v2", "{invalid");
  assert.deepEqual(loadLibrary(target), {
    version: 2,
    views: [],
    activeByExperiment: {},
  });
  const view = newWorkspace("e1", "Named", [], catalog());
  assert.throws(
    () =>
      saveLibrary(
        { version: 2, views: [view, view], activeByExperiment: {} },
        target,
      ),
    /Duplicate/,
  );
  assert.throws(
    () =>
      saveLibrary(
        { version: 2, views: [view], activeByExperiment: { e2: view.id } },
        target,
      ),
    /reference/,
  );
  const denied = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("quota");
    },
  } as unknown as Storage;
  assert.deepEqual(loadLibrary(denied).views, []);
  assert.throws(
    () =>
      saveLibrary({ version: 2, views: [], activeByExperiment: {} }, denied),
    /quota/,
  );
});

test("card geometry round trips without changing legacy views", () => {
  const legacy = newChart("timeseries", ["loss"]);
  assert.equal(Object.hasOwn(validateChart(legacy), "layout"), false);
  for (const layout of [
    { width: 300, height: 240 },
    { width: 713, height: 507 },
    { width: 4096, height: 2160 },
  ]) {
    const chart = { ...legacy, layout };
    assert.deepEqual(validateChart(chart), chart);
    const view = newWorkspace("e1", "Sized", ["r1"], catalog());
    view.sections[0].cards[0] = chart;
    assert.deepEqual(importWorkspace(exportWorkspace(view)), view);
  }
});
test("card geometry rejects malformed dimensions instead of silently clipping saved intent", () => {
  const chart = newChart("timeseries", []);
  for (const layout of [
    null,
    {},
    { width: 300 },
    { width: 299, height: 300 },
    { width: 500, height: 239 },
    { width: 4097, height: 500 },
    { width: 500, height: 2161 },
    { width: 400.5, height: 500 },
    { width: "400", height: 500 },
    { width: Infinity, height: 500 },
    { width: 400, height: NaN },
    { width: 400, height: 500, extra: 1 },
  ]) {
    assert.throws(() => validateChart({ ...chart, layout }));
  }
});
test("Reset chart restores default settings but keeps data, title, identity and size", () => {
  const card = newChart("timeseries", ["train/loss"], "Loss");
  card.x = { mode: "key", key: "train/learning_rate" };
  card.config.axis = "relative";
  card.config.yScale = "log";
  card.config.smoothing = true;
  card.config.style.width = 7;
  card.config.style.markers = { show: true };
  card.config.runs.r = { color: "#123456" };
  card.config.height = 500;
  card.outliers = "robust";
  card.size = "wide";
  card.layout = { width: 600, height: 400 };
  const reset = resetChart(card);
  const fresh = newChart("timeseries", [], "Loss");
  assert.equal(reset.id, card.id);
  assert.equal(reset.title, "Loss");
  assert.deepEqual(reset.source, card.source);
  assert.deepEqual(reset.x, card.x);
  assert.equal(reset.size, "wide");
  assert.deepEqual(reset.layout, card.layout);
  assert.equal(reset.outliers, "all");
  // XY keeps its join; everything else is a new chart's look.
  assert.deepEqual(reset.config, {
    ...fresh.config,
    axis: "relative",
    height: 500,
  });
  // The input is not mutated (Undo relies on the previous copy).
  assert.equal(card.config.style.width, 7);
});

test("large local workspaces and libraries preserve all counts, text and chart configs", () => {
  const view = newWorkspace("e1", "view".repeat(2100), [], catalog());
  view.id = "identity".repeat(1100);
  view.selectedRunIds = Array.from({ length: 4097 }, (_, i) => `selected-${i}`);
  view.pendingSelectedRunIds = Array.from(
    { length: 4097 },
    (_, i) => `pending-${i}`,
  );
  const largeCard = newChart(
    "timeseries",
    Array.from({ length: 513 }, (_, i) => `metric-${i}`),
  );
  largeCard.title = "chart".repeat(1800);
  largeCard.source = {
    mode: "selected",
    keys: [
      ...(largeCard.source.mode === "selected" ? largeCard.source.keys : []),
      "metric".repeat(1800),
    ],
  };
  largeCard.config.runs = Object.fromEntries(
    Array.from({ length: 4097 }, (_, i) => [
      seriesId({ kind: "metric", runId: `run-${i}`, key: "train/loss" }),
      {
        color: "#123456",
        width: 2,
        points: true,
        pointSize: 5,
        visible: true,
        alpha: 0.75,
      },
    ]),
  );
  assert.ok(JSON.stringify(largeCard.config).length > 262144);
  const explicit = newChart("timeseries", []);
  explicit.source = {
    mode: "explicit",
    series: Array.from({ length: 4097 }, (_, i) => ({
      kind: "metric",
      runId: `run-${i}`,
      key: "loss",
    })),
  };
  view.sections = Array.from({ length: 129 }, (_, i) => ({
    id: `section-${i}`,
    title: "section".repeat(1300),
    collapsed: true,
    cards:
      i < 2
        ? Array.from({ length: 257 }, (_, j) => ({
            ...newChart("timeseries", ["loss"]),
            id: `card-${i}-${j}`,
          }))
        : [],
  }));
  view.sections[0].cards.push(largeCard, explicit);
  assert.deepEqual(importWorkspace(exportWorkspace(view)), view);
  const library: WorkspaceLibrary = {
    version: 2,
    views: [
      view,
      ...Array.from({ length: 128 }, (_, i) => ({
        ...newWorkspace("e1", `view-${i}`, [], catalog()),
        id: `view-${i}`,
      })),
    ],
    activeByExperiment: { e1: view.id },
  };
  const target = storage();
  saveLibrary(library, target);
  assert.deepEqual(loadLibrary(target), library);
  assert.throws(
    () =>
      validateWorkspace({
        ...view,
        selectedRunIds: [...view.selectedRunIds, view.selectedRunIds[0]],
      }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      validateWorkspace({
        ...view,
        sections: [...view.sections, view.sections[0]],
      }),
    /Duplicate/,
  );
});

test("quota exceptions propagate unchanged and leave the last saved library intact", () => {
  const target = storage();
  const library: WorkspaceLibrary = {
    version: 2,
    views: [newWorkspace("e1", "Saved", [], catalog())],
    activeByExperiment: {},
  };
  saveLibrary(library, target);
  const saved = target.getItem("nset.workspaces.v2");
  const quota = new DOMException(
    "Browser storage is full",
    "QuotaExceededError",
  );
  target.setItem = () => {
    throw quota;
  };
  assert.throws(
    () => saveLibrary({ ...library, views: [] }, target),
    (error) => error === quota,
  );
  assert.equal(target.getItem("nset.workspaces.v2"), saved);
  assert.deepEqual(loadLibrary(target), library);
});

test("section reorder preserves identities, collapse states and intervening filtered sections", () => {
  const sections = ["first", "hidden", "last"].map((id, i) => ({
    id,
    title: id,
    collapsed: i === 1,
    cards: [newChart("timeseries", ["loss"], id)],
  }));
  const before = JSON.stringify(sections);
  const top = reorderSections(sections, "last", "first");
  assert.deepEqual(
    top.map((s) => s.id),
    ["last", "first", "hidden"],
  );
  assert.equal(top[0], sections[2]);
  assert.equal(top[1].cards[0], sections[0].cards[0]);
  assert.equal(top[2].collapsed, true);
  assert.equal(JSON.stringify(sections), before);
  const bottom = reorderSections(top, "last", "hidden", true);
  assert.deepEqual(bottom, sections);
  assert.equal(reorderSections(sections, "first", "first"), sections);
  assert.equal(reorderSections(sections, "first", "hidden"), sections);
  assert.equal(reorderSections(sections, "last", "hidden", true), sections);
  assert.equal(reorderSections(sections, "missing", "first"), sections);
  assert.equal(reorderSections(sections, "first", "missing"), sections);
});

const detailsSchema = JSON.parse(
  readFileSync(
    new URL("../../tests/fixtures/chart_details_schema.json", import.meta.url),
    "utf8",
  ),
) as Record<
  "validDetails" | "invalidDetails" | "validRunLabels" | "invalidRunLabels",
  unknown[]
>;

test("chart details and semantic labels share the backend acceptance fixture", () => {
  const card = newChart("timeseries", ["loss"]);
  for (const details of detailsSchema.validDetails)
    assert.deepEqual(validateChart({ ...card, details }).details, details);
  for (const details of detailsSchema.invalidDetails)
    assert.throws(
      () => validateChart({ ...card, details }),
      JSON.stringify(details),
    );
  const workspace = newWorkspace("e1", "Named", [], catalog());
  for (const runLabels of detailsSchema.validRunLabels)
    assert.deepEqual(
      validateWorkspace({ ...workspace, runLabels }).runLabels,
      runLabels,
    );
  for (const runLabels of detailsSchema.invalidRunLabels)
    assert.throws(
      () => validateWorkspace({ ...workspace, runLabels }),
      JSON.stringify(runLabels),
    );
  assert.equal(Object.hasOwn(validateChart(card), "details"), false);
  assert.equal(Object.hasOwn(validateWorkspace(workspace), "runLabels"), false);
});

test("details reject nonfinite coordinates and non-JSON objects without invoking getters", () => {
  const card = newChart("timeseries", []);
  for (const coordinate of [NaN, Infinity, -Infinity, undefined]) {
    for (const key of ["a", "b"]) {
      const sample = { axis: "x", a: 1, [key]: coordinate };
      assert.throws(() =>
        validateChart({ ...card, details: { measurements: { sample } } }),
      );
    }
  }
  let invoked = false;
  const accessor = Object.defineProperty({}, "markdown", {
    enumerable: true,
    get() {
      invoked = true;
      return "unsafe";
    },
  });
  for (const details of [
    accessor,
    Object.create({ markdown: "inherited" }),
    { configFields: [{ path: ["safe", , "sparse"] }] },
    { configFields: [{ path: ["safe", () => "callback"] }] },
    { markdown: undefined },
  ])
    assert.throws(() => validateChart({ ...card, details }));
  assert.equal(invoked, false);
  const workspace = newWorkspace("e1", "Named", [], catalog());
  assert.throws(() =>
    validateWorkspace({
      ...workspace,
      runLabels: Object.create({ r1: "Inherited" }),
    }),
  );
});

test("image charts retain prose and selected configuration but reject native measurements", () => {
  const card = newChart("image", ["sample"]);
  const details = {
    markdown: "",
    configFields: [{ path: ["optimizer", "lr"] }],
    measurements: {},
  };
  assert.deepEqual(validateChart({ ...card, details }).details, details);
  assert.throws(
    () =>
      validateChart({
        ...card,
        details: { measurements: { sample: { axis: "y", a: 0 } } },
      }),
    /Image/,
  );
});

test("authored details and aliases survive import, export, reset, clone and local storage", () => {
  const view = newWorkspace("e1", "Annotated", ["r1"], catalog());
  view.runLabels = { r1: "Semantic name", missing: "Portable unavailable run" };
  const card = view.sections[0].cards[0];
  card.details = {
    markdown: "### Why this chart\n\n[Inspect](measurement:window)",
    configFields: [
      { path: ["optimizer", "lr"] },
      { path: ["optimizer.lr"], label: "Literal dotted key" },
    ],
    measurements: {
      window: { axis: "x", a: 1, b: 2 },
      single: { axis: "y", a: 3, b: null },
    },
  };
  const roundTrip = importWorkspace(exportWorkspace(view));
  assert.deepEqual(roundTrip, view);
  const reset = resetChart(card);
  assert.deepEqual(reset.details, card.details);
  assert.notEqual(reset.details, card.details);
  const duplicate = validateChart({
    ...structuredClone(card),
    id: "duplicate",
  });
  assert.deepEqual(duplicate.details, card.details);
  const copied = validateWorkspace({
    ...structuredClone(view),
    id: "view:copy",
    name: "Copy",
  });
  assert.deepEqual(copied.runLabels, view.runLabels);
  assert.deepEqual(copied.sections, view.sections);
  const library: WorkspaceLibrary = {
    version: 2,
    views: [view],
    activeByExperiment: { e1: view.id },
  };
  const target = storage();
  saveLibrary(library, target);
  assert.deepEqual(loadLibrary(target), library);
});

test("annotation content has no arbitrary size or field-count quotas", () => {
  const details = {
    markdown: "x".repeat(262145),
    configFields: Array.from({ length: 513 }, (_, i) => ({
      path: [`field${i}`],
    })),
    measurements: Object.fromEntries(
      Array.from({ length: 513 }, (_, i) => [`m${i}`, { axis: "x", a: i }]),
    ),
  };
  const view = newWorkspace("e1", "Large annotations", ["r1"], catalog());
  view.runLabels = Object.fromEntries(
    Array.from({ length: 4097 }, (_, i) => [`run${i}`, `Label ${i}`]),
  );
  view.sections[0].cards[0] = validateChart({
    ...view.sections[0].cards[0],
    details,
  });
  assert.deepEqual(importWorkspace(exportWorkspace(view)), view);
});
