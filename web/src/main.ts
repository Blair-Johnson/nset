import "./style.css";
import { Api, type Experiment, type Run } from "./api";
import { defaults, styleFor, validateConfig, type ViewConfig } from "./config";
import { ImagePanel } from "./images";
import {
  analyze,
  initialPins,
  PlotPanel,
  type Analyzed,
  type Pins,
  type PlotRun,
} from "./plot";
import { SettingsPanel } from "./settings";
import { assertSafe } from "./config";
import { readLibrary, validateView, type SavedView } from "./views";
import {
  download,
  element,
  finiteInput,
  isAbort,
  Latest,
  message,
  numberText,
} from "./utils";
const app = document.querySelector<HTMLDivElement>("#app")!;
// Static shell only. All server strings are subsequently assigned with textContent.
app.innerHTML = `
<header class="app-header"><div class="brand"><span class="brand-icon">n</span><div><strong>NSET</strong><span>EXPERIMENT WORKBENCH</span></div></div><div class="header-actions"><span class="local-badge">● LOCAL-FIRST</span><button id="refresh">Refresh snapshots</button><button id="logout">Disconnect</button></div></header>
<div id="global-error" class="global-error" role="alert" hidden></div>
<div class="workspace"><aside class="sidebar"><div class="section-head"><h2>Experiments</h2><span class="eyebrow">BROWSER</span></div><label class="field"><span>Experiment</span><select id="experiments" aria-label="Experiment"></select></label><label class="field"><span>Find runs</span><input id="search" type="search" placeholder="Name, parameter, tag…"></label><div class="run-filters"><select id="status" aria-label="Run status"><option value="">All statuses</option><option>running</option><option>finished</option><option>failed</option></select><button id="select-all" title="Select filtered runs">Select visible</button><button id="clear-runs">Clear</button></div><div class="section-head"><h3>Runs</h3><span id="selection-count" class="muted">0 selected</span></div><div id="run-list" class="run-list"></div><div class="sidebar-foot">Full observations. No hidden sampling.<br>Names and parameters rendered as text.</div></aside>
<main class="main"><div class="workspace-title"><div><div class="eyebrow">COMPARE / INSPECT / UNDERSTAND</div><h1 id="workspace-name">Experiment workbench</h1></div><span id="connection" class="connection">Disconnected</span></div>
<div class="toolbar metric-toolbar"><label class="field metric-field"><span>METRIC</span><select id="metric" aria-label="Metric"></select></label><label class="field"><span>X AXIS</span><select id="axis"><option value="step">Step</option><option value="timestamp">Time (UTC)</option></select></label><label class="field"><span>INTERPOLATION</span><select id="interpolation"><option value="linear">Linear</option><option value="pchip">PCHIP · monotone</option></select></label><label class="toggle-field"><input id="smoothing" type="checkbox"> EMA</label><label class="field alpha-field"><span>ALPHA / OBS.</span><input id="alpha" type="number" step="any" min="0" max="1" value="0.2"></label><span id="transform-label" class="badge">RAW-DERIVED</span></div>
<div class="tabs" role="tablist" aria-label="Workbench view"><button class="active" data-tab="metrics" role="tab" aria-selected="true">Timeseries</button><button data-tab="images" role="tab" aria-selected="false">Images</button><button data-tab="settings" role="tab" aria-selected="false">Plot configuration</button><button data-tab="metadata" role="tab" aria-selected="false">Run metadata</button></div>
<section id="metrics-pane" class="tab-pane"><div class="plot-card"><div class="plot-heading"><div><h2 id="plot-title">Select runs and a metric</h2><div id="load-status" class="muted" aria-live="polite">Connect to your tracker to begin.</div></div><button id="reset-zoom">Reset zoom</button></div><div id="plot-warning" class="warning" hidden></div><div id="plot-scroll"><div id="plot"></div></div><div id="plot-empty" class="empty-state"><div class="empty-icon">⌁</div><h2>Your observations, unabridged.</h2><p>Select runs from the browser to compare full-resolution series.<br>Pin A and B, then inspect exact interpolated values and every threshold crossing.</p></div><div class="plot-foot"><span id="data-note">No metric loaded</span><span>Drag to zoom · click to pin · reset to configured ranges</span></div></div>
<div class="inspector"><div class="inspector-controls"><div><div class="eyebrow">NUMERICAL INSPECTOR</div><h2>Pinned comparison</h2></div><label class="field"><span>ACTIVE PIN</span><select id="active-pin"><option value="a">A · cyan</option><option value="b">B · violet</option></select></label><label class="field"><span>CURSOR A · X</span><input id="pin-a" type="number" step="any" placeholder="Unset"></label><label class="field"><span>CURSOR B · X</span><input id="pin-b" type="number" step="any" placeholder="Unset"></label><label class="field"><span>THRESHOLD · Y</span><input id="threshold" type="number" step="any" placeholder="Enter threshold"></label></div><div id="readout" class="table-scroll"></div><div class="crossing-head"><h3>All threshold intersections</h3><span class="muted">Full transformed series · not limited to viewport</span></div><div id="crossings" class="table-scroll"></div></div></section>
<section id="images-pane" class="tab-pane" hidden></section><section id="settings-pane" class="tab-pane" hidden></section><section id="metadata-pane" class="tab-pane" hidden></section>
<div class="view-bar"><div><strong>Saved views</strong><span class="muted">Local settings, never credentials</span></div><input id="view-name" placeholder="View name" aria-label="Saved view name"><button id="save-view">Save</button><select id="saved-views" aria-label="Saved views"><option value="">Choose a view…</option></select><button id="load-view">Load</button><button id="delete-view">Delete</button><button id="export-view">Export JSON</button><label class="button">Import JSON<input id="import-view" type="file" accept=".json,application/json" hidden></label></div>
</main></div>
<dialog id="login-dialog"><form id="login-form"><div class="brand"><span class="brand-icon">n</span><strong>NSET / CONNECT</strong></div><h1>A clear view of your experiments.</h1><p>Enter this server’s bearer token. It stays in this tab’s session storage and is never added to a URL or exported view.</p><label class="field"><span>Access token</span><input id="token" type="password" autocomplete="off" required spellcheck="false"></label><p id="login-error" class="error" role="alert"></p><button class="primary" type="submit">Connect to tracker →</button><p class="hint">Remote connection? Use HTTPS or an SSH tunnel.</p></form></dialog>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let token = "";
try {
  token = sessionStorage.getItem("nset.token") ?? "";
} catch {}
const api = new Api(() => token);
let config = defaults();
let experiments: Experiment[] = [];
let runs: Run[] = [];
let selected = new Set<string>();
let raw: PlotRun[] = [];
let derived: Analyzed[] = [];
let pins: Pins = { a: null, b: null, threshold: null };
let loadedKey = "";
let snapshotsReady = false;
let library: Record<string, SavedView> = {};
let pendingView: SavedView | undefined;
const connectionGeneration = new Latest();
let connectionAbort: AbortController | undefined;
const loadGeneration = new Latest();
const browseGeneration = new Latest();
let loadAbort: AbortController | undefined,
  browseAbort: AbortController | undefined;
function error(text = "") {
  $("global-error").textContent = text;
  $("global-error").hidden = !text;
}
function persist() {
  try {
    localStorage.setItem("nset.config", JSON.stringify(config));
  } catch (e) {
    error(`Settings are active but could not be saved locally: ${message(e)}`);
  }
}
try {
  const stored = localStorage.getItem("nset.config");
  if (stored) config = validateConfig(JSON.parse(stored));
  library = readLibrary(localStorage);
} catch (e) {
  error(`Stored settings were not loaded: ${message(e)}`);
}
const plot = new PlotPanel(
  $("plot"),
  (x) => {
    pins[$<HTMLSelectElement>("active-pin").value as "a" | "b"] = x;
    syncPins();
    renderReadouts();
    plot.setPins(pins);
  },
  (warnings) => {
    $("plot-warning").replaceChildren(
      ...warnings.map((w) => element("div", "", w)),
    );
    $("plot-warning").hidden = !warnings.length;
  },
);
const images = new ImagePanel($("images-pane"), api);
const settings = new SettingsPanel($("settings-pane"), (next) =>
  applyConfig(next),
);
function selectedRuns() {
  return runs.filter((run) => selected.has(run.id));
}
function syncControls() {
  $<HTMLSelectElement>("axis").value = config.axis;
  $<HTMLSelectElement>("interpolation").value = config.interpolation;
  $<HTMLInputElement>("smoothing").checked = config.smoothing;
  $<HTMLInputElement>("alpha").value = String(config.alpha);
  $("transform-label").textContent = config.smoothing
    ? `EMA · α ${config.alpha}`
    : "RAW-DERIVED";
}
function syncPins() {
  $<HTMLInputElement>("pin-a").value = pins.a === null ? "" : String(pins.a);
  $<HTMLInputElement>("pin-b").value = pins.b === null ? "" : String(pins.b);
  $<HTMLInputElement>("threshold").value =
    pins.threshold === null ? "" : String(pins.threshold);
}
function applyConfig(next: ViewConfig) {
  try {
    const previousAxis = config.axis;
    config = validateConfig(next);
    persist();
    syncControls();
    settings.render(config, selectedRuns());
    if (previousAxis !== config.axis) {
      pins = { a: null, b: null, threshold: pins.threshold };
    }
    renderAnalysis();
  } catch (e) {
    error(message(e));
  }
}
function invalidate() {
  loadGeneration.next();
  loadAbort?.abort();
  raw = [];
  derived = [];
  snapshotsReady = false;
  plot.clear();
  $("plot-empty").hidden = false;
  $("plot-warning").hidden = true;
  $("data-note").textContent = "No authoritative snapshot loaded";
  $("load-status").textContent = "No authoritative snapshot loaded";
  renderReadouts();
}
function renderAnalysis() {
  if (!snapshotsReady) {
    plot.clear();
    return;
  }
  try {
    derived = analyze(raw, config);
    if (pins.a === null && pins.b === null) {
      const initial = initialPins(derived);
      pins.a = initial.a;
      pins.b = initial.b;
    }
    syncPins();
    plot.render(derived, config, pins);
    const observations = raw.reduce((n, r) => n + r.raw.length, 0);
    const canonical = derived.reduce((n, r) => n + r.points.length, 0);
    $("plot-empty").hidden = canonical > 0;
    $("data-note").textContent =
      `${observations.toLocaleString()} observations · ${canonical.toLocaleString()} canonical x values · ${config.smoothing ? "EMA → " : ""}${config.interpolation} · no extrapolation`;
    $("plot-title").textContent = loadedKey || "No metric selected";
    renderReadouts();
  } catch (e) {
    error(`Plot could not be rendered: ${message(e)}`);
  }
}
function table(headers: string[]) {
  const t = element("table");
  const head = element("thead");
  const tr = element("tr");
  for (const title of headers) tr.append(element("th", "", title));
  head.append(tr);
  const body = element("tbody");
  t.append(head, body);
  return { t, body };
}
function renderReadouts() {
  const { t, body } = table([
    "Run / numerical curve",
    "Observations → unique x",
    "A · y",
    "B · y",
    "Δ y (B − A)",
    "Δ x",
  ]);
  derived.forEach((d, i) => {
    const row = element("tr");
    const label = element("td");
    const swatch = element("span", "swatch");
    swatch.style.background = styleFor(config, d.run.id, i).color;
    label.append(
      swatch,
      document.createTextNode(
        `${d.run.name} · ${config.smoothing ? "EMA" : "raw-derived"} ${config.interpolation}`,
      ),
    );
    const a = pins.a === null ? null : d.fn.at(pins.a),
      b = pins.b === null ? null : d.fn.at(pins.b);
    row.append(
      label,
      element("td", "mono", `${d.count} → ${d.points.length}`),
      element("td", "mono", numberText(a)),
      element("td", "mono", numberText(b)),
      element(
        "td",
        "mono",
        numberText(a === null || b === null ? null : b - a),
      ),
      element(
        "td",
        "mono",
        numberText(pins.a === null || pins.b === null ? null : pins.b - pins.a),
      ),
    );
    body.append(row);
  });
  $("readout").replaceChildren(t);
  if (!derived.length)
    $("readout").append(
      element(
        "p",
        "table-empty",
        "Complete metric snapshots are required before values become authoritative.",
      ),
    );
  const crossing = table([
    "Run",
    "Isolated crossings · x",
    "Plateau intervals · [x start, x end]",
  ]);
  for (const d of derived) {
    const row = element("tr");
    row.append(element("td", "", d.run.name));
    const result =
      pins.threshold === null ? null : d.fn.crossings(pins.threshold);
    row.append(
      element(
        "td",
        "mono wrap",
        result
          ? result.points.map(numberText).join(", ") || "None"
          : "Set a threshold",
      ),
      element(
        "td",
        "mono wrap",
        result
          ? result.plateaus
              .map(([a, b]) => `[${numberText(a)}, ${numberText(b)}]`)
              .join("; ") || "None"
          : "—",
      ),
    );
    crossing.body.append(row);
  }
  $("crossings").replaceChildren(crossing.t);
}
function renderRuns() {
  const query = $<HTMLInputElement>("search").value.toLowerCase(),
    status = $<HTMLSelectElement>("status").value;
  const visible = runs.filter(
    (run) =>
      (!status || run.status === status) &&
      `${run.name} ${JSON.stringify(run.params)} ${JSON.stringify(run.tags)}`
        .toLowerCase()
        .includes(query),
  );
  $("run-list").replaceChildren();
  for (const run of visible) {
    const card = element(
      "label",
      `run-card ${selected.has(run.id) ? "selected" : ""}`,
    );
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(run.id);
    checkbox.setAttribute("aria-label", `Compare ${run.name}`);
    checkbox.onchange = () => {
      if (checkbox.checked) selected.add(run.id);
      else selected.delete(run.id);
      renderRuns();
      void selectionChanged();
    };
    const content = element("div", "run-content");
    const title = element("div", "run-title", run.name);
    const state = element("span", `status ${run.status}`, run.status);
    const meta = element("div", "run-meta");
    meta.append(
      state,
      document.createTextNode(new Date(run.created_at).toLocaleDateString()),
    );
    const params = element(
      "div",
      "run-params",
      Object.entries(run.params)
        .map(
          ([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`,
        )
        .join(" · ") || "No parameters",
    );
    params.title = params.textContent ?? "";
    content.append(title, meta, params);
    card.append(checkbox, content);
    $("run-list").append(card);
  }
  if (!visible.length)
    $("run-list").append(element("p", "empty-list", "No matching runs."));
  $("selection-count").textContent =
    `${selected.size} selected / ${runs.length}`;
  $("select-all").onclick = () => {
    for (const run of visible) selected.add(run.id);
    renderRuns();
    void selectionChanged();
  };
}
function renderMetadata() {
  $("metadata-pane").replaceChildren();
  for (const run of selectedRuns()) {
    const box = element("article", "metadata-card");
    box.append(
      element("h2", "", run.name),
      element("p", "muted", `${run.status} · ${run.id}`),
      element("h3", "", "Parameters"),
      element("pre", "", JSON.stringify(run.params, null, 2)),
      element("h3", "", "Tags"),
      element("pre", "", JSON.stringify(run.tags, null, 2)),
    );
    $("metadata-pane").append(box);
  }
  if (!selected.size)
    $("metadata-pane").append(
      element(
        "p",
        "empty-list",
        "Select runs to inspect their parameters and tags.",
      ),
    );
}
async function selectionChanged() {
  invalidate();
  images.setRuns(selectedRuns());
  settings.render(config, selectedRuns());
  renderMetadata();
  const generation = loadGeneration.next();
  loadAbort = new AbortController();
  const signal = loadAbort.signal;
  const chosen = selectedRuns();
  const previous = pendingView?.metric ?? $<HTMLSelectElement>("metric").value;
  $<HTMLSelectElement>("metric").replaceChildren();
  if (!chosen.length) {
    $("load-status").textContent = "Select one or more runs.";
    return;
  }
  $("load-status").textContent = "Loading metric keys…";
  try {
    const responses = await Promise.all(
      chosen.map((run) =>
        api.json<{ keys: string[] }>(`/runs/${run.id}/metric-keys`, signal),
      ),
    );
    if (!loadGeneration.current(generation)) return;
    const keys = [...new Set(responses.flatMap((r) => r.keys))].sort();
    for (const key of keys) {
      const o = element("option", "", key);
      o.value = key;
      $<HTMLSelectElement>("metric").append(o);
    }
    if (keys.includes(previous))
      $<HTMLSelectElement>("metric").value = previous;
    if (pendingView) {
      pins = { ...pendingView.pins };
      syncPins();
      pendingView = undefined;
    }
    await loadMetrics();
  } catch (e) {
    if (!isAbort(e) && loadGeneration.current(generation)) {
      error(message(e));
      $("load-status").textContent = "Metric keys could not be loaded.";
    }
  }
}
async function loadMetrics() {
  invalidate();
  const generation = loadGeneration.next();
  loadAbort = new AbortController();
  const signal = loadAbort.signal;
  const key = $<HTMLSelectElement>("metric").value;
  const chosen = selectedRuns();
  if (!chosen.length || !key) {
    $("load-status").textContent = "No metric in the current selection.";
    return;
  }
  error();
  const progress = new Map<string, [number, number]>();
  $("load-status").textContent = "Capturing full snapshots…";
  try {
    const data = await Promise.all(
      chosen.map(async (run) => ({
        run,
        raw: await api.metrics(run.id, key, signal, (done, total) => {
          if (!loadGeneration.current(generation)) return;
          progress.set(run.id, [done, total]);
          let loaded = 0,
            expected = 0;
          for (const [n, t] of progress.values()) {
            loaded += n;
            expected += t;
          }
          $("load-status").textContent =
            `Loading ${loaded.toLocaleString()} / ${expected.toLocaleString()} observations · ${progress.size}/${chosen.length} streams discovered · analysis waits for completion`;
        }),
      })),
    );
    if (!loadGeneration.current(generation)) return;
    raw = data;
    loadedKey = key;
    snapshotsReady = true;
    $("load-status").textContent =
      `Snapshot complete · ${chosen.length} runs · ${new Date().toLocaleTimeString()}`;
    renderAnalysis();
  } catch (e) {
    if (!isAbort(e) && loadGeneration.current(generation)) {
      loadAbort?.abort();
      $("load-status").textContent =
        "Snapshot failed — no partial analysis displayed.";
      error(message(e));
    }
  }
}
async function loadRuns(ids: string[] = []) {
  browseAbort?.abort();
  browseAbort = new AbortController();
  const generation = browseGeneration.next();
  invalidate();
  runs = [];
  selected.clear();
  renderRuns();
  images.setRuns([]);
  const experiment = $<HTMLSelectElement>("experiments").value;
  $("workspace-name").textContent =
    experiments.find((e) => e.id === experiment)?.name ??
    "Experiment workbench";
  if (!experiment) {
    await selectionChanged();
    return;
  }
  try {
    const result = await api.json<{ runs: Run[] }>(
      `/runs?experiment_id=${encodeURIComponent(experiment)}`,
      browseAbort.signal,
    );
    if (!browseGeneration.current(generation)) return;
    runs = result.runs;
    selected = new Set(ids.filter((id) => runs.some((r) => r.id === id)));
    renderRuns();
    await selectionChanged();
  } catch (e) {
    if (!isAbort(e) && browseGeneration.current(generation)) error(message(e));
  }
}
async function connect() {
  const generation = connectionGeneration.next();
  connectionAbort?.abort();
  connectionAbort = new AbortController();
  const result = await api.json<{ experiments: Experiment[] }>(
    "/experiments",
    connectionAbort.signal,
  );
  if (!connectionGeneration.current(generation)) return;
  experiments = result.experiments;
  const previous =
    pendingView?.experiment ?? $<HTMLSelectElement>("experiments").value;
  $<HTMLSelectElement>("experiments").replaceChildren();
  for (const experiment of experiments) {
    const option = element("option", "", experiment.name);
    option.value = experiment.id;
    $<HTMLSelectElement>("experiments").append(option);
  }
  if (experiments.some((e) => e.id === previous))
    $<HTMLSelectElement>("experiments").value = previous;
  $("connection").textContent = "Connected";
  $("connection").classList.add("connected");
  $("login-dialog").hasAttribute("open") &&
    $<HTMLDialogElement>("login-dialog").close();
  await loadRuns(pendingView?.runIds ?? [...selected]);
}
function currentView(): SavedView {
  return {
    format: "nset-view",
    version: 1,
    config: structuredClone(config),
    experiment: $<HTMLSelectElement>("experiments").value,
    runIds: [...selected],
    metric: $<HTMLSelectElement>("metric").value,
    pins: { ...pins },
  };
}
function renderLibrary() {
  const select = $<HTMLSelectElement>("saved-views");
  select.replaceChildren(element("option", "", "Choose a view…"));
  select.options[0].value = "";
  for (const name of Object.keys(library).sort()) {
    const option = element("option", "", name);
    option.value = name;
    select.append(option);
  }
}
function saveLibrary() {
  localStorage.setItem("nset.views", JSON.stringify(library));
  renderLibrary();
}
async function restore(view: SavedView) {
  pendingView = validateView(view);
  config = pendingView.config;
  persist();
  syncControls();
  pins = { ...view.pins };
  syncPins();
  if (experiments.some((e) => e.id === view.experiment))
    $<HTMLSelectElement>("experiments").value = view.experiment;
  else
    error(
      "Saved experiment is unavailable; settings loaded against the current experiment.",
    );
  await loadRuns(view.runIds);
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]"))
  button.onclick = () => {
    const tab = button.dataset.tab;
    for (const b of document.querySelectorAll<HTMLButtonElement>(
      "[data-tab]",
    )) {
      b.classList.toggle("active", b === button);
      b.setAttribute("aria-selected", String(b === button));
    }
    for (const name of ["metrics", "images", "settings", "metadata"])
      $(`${name}-pane`).hidden = name !== tab;
    images.setActive(tab === "images");
    if (tab === "settings") settings.render(config, selectedRuns());
  };
$("login-form").onsubmit = async (e) => {
  e.preventDefault();
  token = $<HTMLInputElement>("token").value.trim();
  if (!token) return;
  try {
    await connect();
    sessionStorage.setItem("nset.token", token);
    $<HTMLInputElement>("token").value = "";
    $("login-error").textContent = "";
  } catch (err) {
    $("login-error").textContent = message(err);
  }
};
$("logout").onclick = () => {
  connectionGeneration.next();
  connectionAbort?.abort();
  token = "";
  try {
    sessionStorage.removeItem("nset.token");
  } catch {}
  invalidate();
  browseGeneration.next();
  browseAbort?.abort();
  images.clear();
  selected.clear();
  runs = [];
  experiments = [];
  renderRuns();
  renderMetadata();
  $<HTMLSelectElement>("experiments").replaceChildren();
  $<HTMLSelectElement>("metric").replaceChildren();
  $("connection").textContent = "Disconnected";
  $("connection").classList.remove("connected");
  $<HTMLDialogElement>("login-dialog").showModal();
};
$("refresh").onclick = () =>
  void connect()
    .then(() => images.refresh())
    .catch((e) => error(message(e)));
$("experiments").onchange = () => {
  pendingView = undefined;
  pins = { a: null, b: null, threshold: null };
  void loadRuns();
};
$("metric").onchange = () => {
  pins = { a: null, b: null, threshold: pins.threshold };
  void loadMetrics();
};
$("search").oninput = renderRuns;
$("status").onchange = renderRuns;
$("clear-runs").onclick = () => {
  selected.clear();
  renderRuns();
  void selectionChanged();
};
$("reset-zoom").onclick = () => plot.reset();
for (const id of ["axis", "interpolation", "smoothing", "alpha"])
  $(id).onchange = () => {
    const next = structuredClone(config);
    next.axis = $<HTMLSelectElement>("axis").value as ViewConfig["axis"];
    next.interpolation = $<HTMLSelectElement>("interpolation")
      .value as ViewConfig["interpolation"];
    next.smoothing = $<HTMLInputElement>("smoothing").checked;
    next.alpha = Number($<HTMLInputElement>("alpha").value);
    applyConfig(next);
  };
for (const [id, key] of [
  ["pin-a", "a"],
  ["pin-b", "b"],
  ["threshold", "threshold"],
] as const)
  $(id).oninput = () => {
    pins[key] = finiteInput($<HTMLInputElement>(id).value);
    plot.setPins(pins);
    renderReadouts();
  };
$("save-view").onclick = () => {
  try {
    const name = $<HTMLInputElement>("view-name").value.trim();
    if (!name) throw new Error("Enter a name for the saved view.");
    assertSafe(JSON.parse(`{${JSON.stringify(name)}:null}`));
    library[name] = currentView();
    saveLibrary();
    $<HTMLSelectElement>("saved-views").value = name;
    error();
  } catch (e) {
    error(message(e));
  }
};
$("load-view").onclick = () => {
  const view = library[$<HTMLSelectElement>("saved-views").value];
  if (view) void restore(view).catch((e) => error(message(e)));
};
$("delete-view").onclick = () => {
  delete library[$<HTMLSelectElement>("saved-views").value];
  try {
    saveLibrary();
  } catch (e) {
    error(message(e));
  }
};
$("export-view").onclick = () =>
  download("nset-view.json", JSON.stringify(currentView(), null, 2));
$("import-view").onchange = async () => {
  const input = $<HTMLInputElement>("import-view");
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024)
      throw new Error("View files are limited to 1 MiB.");
    await restore(validateView(JSON.parse(await file.text())));
  } catch (e) {
    error(`View import rejected: ${message(e)}`);
  } finally {
    input.value = "";
  }
};
syncControls();
syncPins();
renderLibrary();
renderReadouts();
settings.render(config, []);
if (token)
  void connect().catch((e) => {
    $("login-error").textContent = message(e);
    $<HTMLDialogElement>("login-dialog").showModal();
  });
else $<HTMLDialogElement>("login-dialog").showModal();
window.addEventListener("beforeunload", () => {
  images.destroy();
  plot.destroy();
  loadAbort?.abort();
  browseAbort?.abort();
});
