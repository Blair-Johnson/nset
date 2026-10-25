import { touchPrimary } from "./input-capabilities";
import { NAVIGATE_LABEL, plotIcon } from "./plot-icons";
import { mountRecordControls } from "./record-controls";
import { newRecordBinding, loadRecordPlot } from "./records";
import type { Api, ImageFrame } from "./api";
import { plotType, setPlotType, type PlotType } from "./plot-types";
import { withRunColors } from "./series-colors";
import { loadPlotRuns, metricAxisLabel, xMetricLabel } from "./card-label";
import {
  applyDashboardControls,
  resetXAxis,
  strengthToSmoothing,
  smoothingToStrength,
} from "./dashboard-controls";
import {
  deepMerge,
  effectiveRange,
  explicitRangeBounds,
  isSafeColor,
  styleFor,
  type Formatter,
  type RunStyle,
  type ViewConfig,
} from "./config";
import type {
  Catalog,
  ChartSource,
  ChartSpec,
  MetricLoader,
  ResolvedSeries,
  SeriesRef,
  XBinding,
} from "./workspace-types";
import {
  cameraAxis,
  resolveSources,
  seriesId,
  validateChart,
} from "./workspace";
import type { PlotPanel, PlotRun } from "./plot";
import type { ImageCamera, ImagePanel } from "./images";

type RecordValue = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);
const record = (value: unknown): RecordValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const textError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const PAGE_SIZE = 20;

/** Only remove the literal that conflicts with the control being edited. */
export function removeOverride(
  config: ViewConfig,
  path: (string | number)[],
): void {
  let current: unknown = config.advanced;
  for (const key of path.slice(0, -1)) {
    if (!current || typeof current !== "object") return;
    current = (current as RecordValue)[key];
  }
  if (current && typeof current === "object")
    delete (current as RecordValue)[path.at(-1)!];
}
function override(
  config: ViewConfig,
  path: (string | number)[],
  value: unknown,
): void {
  let current: RecordValue = config.advanced;
  path.slice(0, -1).forEach((key, index) => {
    if (!current[key] || typeof current[key] !== "object")
      current[key] = typeof path[index + 1] === "number" ? [] : {};
    current = current[key] as RecordValue;
  });
  current[path.at(-1)!] = value;
  // The literal schema requires dense positional axis arrays.
  const axes = config.advanced.axes as RecordValue[] | undefined;
  if (axes) for (let i = 0; i < axes.length; i++) axes[i] ??= {};
}
function axisOverride(config: ViewConfig, axis: "x" | "y"): RecordValue {
  return (
    (config.advanced.axes as RecordValue[] | undefined)?.[
      axis === "x" ? 0 : 1
    ] ?? {}
  );
}
function scaleOverride(config: ViewConfig, axis: "x" | "y"): RecordValue {
  return record(record(config.advanced.scales)[axis]);
}
/** Bound edits replace advanced range/auto together, while retaining log base, direction, etc. */
export function setEditorBounds(
  config: ViewConfig,
  axis: "x" | "y",
  min: number | null,
  max: number | null,
): void {
  config[`${axis}Min`] = min;
  config[`${axis}Max`] = max;
  removeOverride(config, ["scales", axis, "range"]);
  removeOverride(config, ["scales", axis, "auto"]);
}
/** Explain the effective range without changing the saved auto-range preference. */
export function editorAutoRangeHelp(config: ViewConfig): string {
  const range = effectiveRange(config, "y");
  if (!Array.isArray(range))
    return "Saved for automatic bounds; custom range rules are active.";
  const [lo, hi] = explicitRangeBounds(range);
  if (lo !== null || hi !== null)
    return "Saved for automatic bounds; manual limits are active.";
  return "Display only: Central 98% fits the 1st–99th percentiles. No observations are removed.";
}
export function setEditorAxis(
  config: ViewConfig,
  axis: "x" | "y",
  key: "label" | "values",
  value: string,
): void {
  if (key === "label") config[`${axis}Label`] = value;
  else config[`${axis}Format`] = value as Formatter;
  removeOverride(config, ["axes", axis === "x" ? 0 : 1, key]);
  // Static split positions are independent of a number formatter and are preserved.
}
/** Automatic display titles never become saved overrides. Explicit literals remain authoritative. */
export function editorAxisTitle(card: ChartSpec, axis: "x" | "y"): string {
  const literal = axisOverride(card.config, axis).label;
  if (typeof literal === "string") return literal;
  const saved = card.config[`${axis}Label`];
  if (saved) return saved;
  if (card.records) return axis === "x" ? card.records.x : card.records.ys.length === 1 ? card.records.ys[0] : "Record values";
  if (axis === "x")
    return card.kind === "timeseries" && card.x
      ? xMetricLabel(card.x)
      : card.config.axis === "relative"
        ? "Elapsed time"
        : card.config.axis === "timestamp"
          ? "Time"
          : "Step";
  return metricAxisLabel(card.source);
}

export function setEditorToggle(
  config: ViewConfig,
  key: "grid" | "ticks" | "legend",
  value: boolean,
): void {
  config[key] = value;
  if (key === "legend") removeOverride(config, ["legend", "show"]);
  else for (const i of [0, 1]) removeOverride(config, ["axes", i, key, "show"]);
}
/** Compatibility wrapper for the shared dashboard/editor strength mapping. */
export function smoothingAlpha(strength: number): number {
  return strengthToSmoothing(strength).alpha;
}

export interface SourceChoice {
  id: string;
  key: string;
  label: string;
  detail: string;
  ref?: SeriesRef;
  available: boolean;
  selected: boolean;
}
/** Metadata only: does not fetch histories, and includes unavailable saved selections. */
export function editorSourceChoices(
  card: ChartSpec,
  catalog: Catalog,
  selectedRunIds: string[],
): SourceChoice[] {
  const kind = card.kind === "image" ? "image" : "metric";
  const selectedRuns = new Set(selectedRunIds);
  const runs = new Map(catalog.runs.map((run) => [run.id, run]));
  const experiments = new Map(
    catalog.experiments.map((experiment) => [experiment.id, experiment.name]),
  );
  if (card.source.mode === "selected") {
    const selected = new Set(card.source.keys);
    const counts = new Map<string, Set<string>>();
    for (const series of catalog.series) {
      if (series.kind !== kind || !selectedRuns.has(series.run_id)) continue;
      if (!counts.has(series.key)) counts.set(series.key, new Set());
      counts.get(series.key)!.add(series.run_id);
    }
    return [...new Set([...counts.keys(), ...selected])].sort().map((key) => ({
      id: key,
      key,
      label: key,
      detail: counts.has(key)
        ? `${counts.get(key)!.size} selected run(s)`
        : "Unavailable in selected runs",
      available: counts.has(key),
      selected: selected.has(key),
    }));
  }
  const selected = new Set(card.source.series.map(seriesId));
  const choices = new Map<string, SourceChoice>();
  for (const series of catalog.series) {
    if (series.kind !== kind) continue;
    const ref: SeriesRef = { runId: series.run_id, key: series.key, kind };
    const run = runs.get(series.run_id);
    const id = seriesId(ref);
    choices.set(id, {
      id,
      key: series.key,
      ref,
      label: series.key,
      detail: `${experiments.get(run?.experiment_id ?? "") ?? "Unknown experiment"} / ${run?.name ?? series.run_id}`,
      available: !!run,
      selected: selected.has(id),
    });
  }
  for (const ref of card.source.series) {
    const id = seriesId(ref);
    if (choices.has(id)) continue;
    const run = runs.get(ref.runId);
    choices.set(id, {
      id,
      key: ref.key,
      ref: clone(ref),
      label: ref.key,
      detail: `${experiments.get(run?.experiment_id ?? "") ?? "Unknown experiment"} / ${run?.name ?? ref.runId} · Unavailable`,
      available: false,
      selected: true,
    });
  }
  return [...choices.values()].sort(
    (a, b) => a.detail.localeCompare(b.detail) || a.key.localeCompare(b.key),
  );
}
export interface XChoice {
  value: string;
  label: string;
  available: boolean;
}
/** X metric choices from catalog metadata only. Key mode lists metric keys
 * (preferring those logged by the Y traces' runs); series mode lists every
 * metric series across experiments. A saved but missing choice is kept. */
export function editorXChoices(
  card: ChartSpec,
  catalog: Catalog,
  selectedRunIds: string[],
  mode: XBinding["mode"],
): XChoice[] {
  const runs = new Map(catalog.runs.map((run) => [run.id, run]));
  const experiments = new Map(
    catalog.experiments.map((experiment) => [experiment.id, experiment.name]),
  );
  const metrics = catalog.series.filter((series) => series.kind === "metric");
  if (mode === "key") {
    const yRuns = new Set(
      card.source.mode === "selected"
        ? selectedRunIds
        : card.source.series.map((ref) => ref.runId),
    );
    const counts = new Map<string, number>();
    for (const series of metrics)
      if (!yRuns.size || yRuns.has(series.run_id))
        counts.set(series.key, (counts.get(series.key) ?? 0) + 1);
    const saved = card.x?.mode === "key" ? card.x.key : undefined;
    const keys = [...new Set([...counts.keys(), ...(saved ? [saved] : [])])];
    return keys.sort().map((key) => ({
      value: key,
      label: counts.has(key)
        ? `${key} (${counts.get(key)} run${counts.get(key) === 1 ? "" : "s"})`
        : `${key} · unavailable`,
      available: counts.has(key),
    }));
  }
  const choices = new Map<string, XChoice>();
  const describe = (runId: string, key: string) => {
    const run = runs.get(runId);
    return `${experiments.get(run?.experiment_id ?? "") ?? "Unknown experiment"} / ${run?.name ?? runId} · ${key}`;
  };
  for (const series of metrics) {
    const ref: SeriesRef = { runId: series.run_id, key: series.key, kind: "metric" };
    choices.set(seriesId(ref), {
      value: seriesId(ref),
      label: describe(series.run_id, series.key),
      available: runs.has(series.run_id),
    });
  }
  if (card.x?.mode === "series" && !choices.has(seriesId(card.x.series)))
    choices.set(seriesId(card.x.series), {
      value: seriesId(card.x.series),
      label: `${describe(card.x.series.runId, card.x.series.key)} · unavailable`,
      available: false,
    });
  return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label));
}
/** Default X binding when switching to "Another metric": prefer a key all Y
 * runs share, otherwise the first available series. */
export function defaultXBinding(
  card: ChartSpec,
  catalog: Catalog,
  selectedRunIds: string[],
  mode: XBinding["mode"],
): XBinding | undefined {
  const choices = editorXChoices(card, catalog, selectedRunIds, mode).filter(
    (choice) => choice.available,
  );
  const yKeys = new Set(
    card.source.mode === "selected"
      ? card.source.keys
      : card.source.series.map((ref) => ref.key),
  );
  if (mode === "key") {
    const key =
      choices.find((choice) => !yKeys.has(choice.value))?.value ??
      choices[0]?.value;
    return key ? { mode: "key", key } : undefined;
  }
  const value =
    choices.find((choice) => !yKeys.has(JSON.parse(choice.value)[2]))?.value ??
    choices[0]?.value;
  if (!value) return undefined;
  const [, runId, key] = JSON.parse(value) as [string, string, string];
  return { mode: "series", series: { runId, key, kind: "metric" } };
}
export function choicePage(
  choices: SourceChoice[],
  search: string,
  page: number,
  selectedOnly = false,
) {
  const tokens = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = choices.filter(
    (choice) =>
      (!selectedOnly || choice.selected) &&
      tokens.every((token) =>
        `${choice.label} ${choice.detail}`.toLocaleLowerCase().includes(token),
      ),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const index = Math.max(0, Math.min(pages - 1, page));
  return {
    rows: filtered.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE),
    total: filtered.length,
    pages,
    page: index,
  };
}

export interface EditorCamera {
  /** Scalar camera in data coordinates, with the axis config it was taken in. */
  scalar?: {
    view: { x: [number, number]; y: [number, number] };
    axis: string;
    xScale: string;
    yScale: string;
  };
  image?: ImageCamera;
}
export interface ChartEditorOptions {
  card: ChartSpec;
  catalog: Catalog;
  selectedRunIds: string[];
  /** The second argument is the preview camera to hand back to the card. */
  onSave: (card: ChartSpec, camera?: EditorCamera) => void | Promise<void>;
  /** Called once after removal and fallback focus restoration; hosts may focus rebuilt controls. */
  onClose?: () => void;
  api?: Api;
  store?: MetricLoader;
  /** Optional host copy for new cards; existing callers need only the contract fields. */
  isNew?: boolean;
  /** The card's current camera; the preview opens on it instead of "home". */
  camera?: EditorCamera;
}
let editorSequence = 0;
export function openChartEditor(options: ChartEditorOptions): {
  close: () => void;
} {
  // Keep pure helpers importable by Node tests without a CSS loader or browser globals.
  void import("./chart-editor.css");
  const draft = clone(options.card);
  if (options.isNew && draft.kind !== "image" && options.catalog.rx && options.catalog.runs.some(r => r.rx && options.selectedRunIds.includes(r.id))) draft.records ??= newRecordBinding(options.catalog);
  let recordControls: ReturnType<typeof mountRecordControls> | undefined;
  let recordPreviewNotes = "";
  let recordPreviewSources: ResolvedSeries[] = [];
  let renderedRecordStyles = "";
  const originalFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const prefix = `chart-editor-${++editorSequence}`;
  let sequence = 0;
  let closed = false;
  let saving = false;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewVersion = 0;
  let sourceToken = "";
  let pendingLoad: Promise<PlotRun[]> | undefined;
  let loadAbort: AbortController | undefined;
  let plot: PlotPanel | undefined;
  let previewInteractive = false;
  let previewNavigate = false;
  let renderedScalarKind: ChartSpec["kind"] | undefined;
  let renderedUnavailable = 0;
  let images: ImagePanel | undefined;
  let imageToken = "";
  // Camera handoff: the first preview opens on the card's view; later renders
  // keep whatever view the preview is on (unless the axes themselves change).
  let pendingScalarView = options.camera?.scalar;
  let pendingImageCamera = options.camera?.image;
  const errors = new Map<string, string>();
  const fields = new Map<
    string,
    { control: HTMLElement; error: HTMLElement; section: string }
  >();
  const sourceMemory = new Map<string, ChartSource>();

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text = "",
  ) => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const button = (label: string, action: () => void, className = "") => {
    const node = el("button", className, label);
    node.type = "button";
    node.onclick = action;
    return node;
  };
  const dialog = el("dialog", "chart-editor");
  dialog.dataset.role = "chart-editor";
  dialog.setAttribute("aria-labelledby", `${prefix}-title`);
  const header = el("header", "ce-header");
  const heading = el("h2", "", options.isNew ? "Add chart" : "Edit chart");
  heading.id = `${prefix}-title`;
  header.append(
    heading,
    button("Close editor", () => close(), "ce-close"),
  );
  const form = el("form", "ce-form");
  form.noValidate = true;
  const body = el("div", "ce-body");
  const settings = el("div", "ce-settings");
  settings.setAttribute("aria-label", "Chart settings");
  // `panels` maps a name to its content body; roots carry the heading. Folds
  // start closed and show a one-line summary of their state in the header.
  const panels = new Map<string, HTMLElement>();
  const panelRoots = new Map<string, HTMLElement>();
  const panelHeadings = new Map<string, HTMLElement>();
  const foldStates = new Map<string, HTMLElement>();
  const advancedOpen = new Map<string, boolean>();
  for (const [name, title, fold] of [
    ["Chart", "Chart", false],
    ["Data", "Y axis", false],
    ["X", "X axis", false],
    ["Smoothing", "Smoothing", true],
    ["Appearance", "Appearance", true],
  ] as const) {
    const id = `${prefix}-panel-${name}`;
    const heading = el("h3", "", title);
    heading.id = `${id}-heading`;
    const body = el("div", "ce-panel-body");
    let root: HTMLElement;
    if (fold) {
      root = el("details", "ce-panel ce-fold");
      const summary = el("summary");
      const state = el("span", "ce-fold-state");
      summary.append(heading, state);
      root.append(summary, body);
      foldStates.set(name, state);
    } else {
      root = el("section", "ce-panel");
      root.setAttribute("aria-labelledby", heading.id);
      root.append(heading, body);
    }
    root.id = id;
    panels.set(name, body);
    panelRoots.set(name, root);
    panelHeadings.set(name, heading);
  }
  settings.append(...panelRoots.values());
  // Each axis section ends with its own options fold (title, scale, bounds,
  // ticks). It is a separate panel so it re-renders without the source list.
  const axisPanel = { x: "XAxis", y: "YAxis" } as const;
  const axisDetails = new Map<"x" | "y", HTMLDetailsElement>();
  for (const [axis, host] of [
    ["x", "X"],
    ["y", "Data"],
  ] as const) {
    const details = el("details", "ce-more ce-axis-options");
    const summary = el("summary");
    const state = el("span", "ce-fold-state");
    summary.append(el("span", "", `${axis.toUpperCase()} axis options`), state);
    const body = el("div", "ce-panel-body");
    details.append(summary, body);
    panelRoots.get(host)!.append(details);
    panels.set(axisPanel[axis], body);
    foldStates.set(axisPanel[axis], state);
    axisDetails.set(axis, details);
  }
  const preview = el("aside", "ce-preview");
  preview.setAttribute("aria-label", "Chart preview");
  const previewTitle = el("h3", "", draft.title || "Untitled chart");
  const previewToolbar = el("div", "ce-preview-toolbar");
  const previewNavigation = button("", () => {
    if (!touchPrimary()) return;
    previewNavigate = !previewNavigate;
    configurePreviewNavigation();
  }, "card-button");
  previewNavigation.title = NAVIGATE_LABEL;
  previewNavigation.setAttribute("aria-label", NAVIGATE_LABEL);
  previewNavigation.setAttribute("aria-pressed", "false");
  previewNavigation.append(plotIcon("navigate"));
  previewNavigation.hidden = draft.kind === "image" || !touchPrimary();
  previewToolbar.append(previewTitle, previewNavigation);
  function configurePreviewNavigation() {
    previewNavigation.setAttribute("aria-pressed", String(previewNavigate));
    plot?.configureInteraction({
      mode: previewNavigate ? "navigate" : "zoom",
      axis: "both",
      inferZoomAxes: true,
      directGestures: true,
      activePin: "a",
    });
  }
  const previewStatus = el("p", "ce-muted");
  previewStatus.setAttribute("role", "status");
  const previewHost = el("div", "ce-preview-plot");
  previewHost.dataset.role = "preview";
  const previewWarnings = el("p", "ce-help");
  const previewDetails = el("details", "ce-more");
  previewDetails.append(el("summary", "", "Preview notes"), previewWarnings);
  previewDetails.hidden = true;
  // Only offer the fold when there is something to read in it.
  new MutationObserver(() => {
    previewDetails.hidden = !previewWarnings.textContent;
  }).observe(previewWarnings, { childList: true, characterData: true, subtree: true });
  const retry = button("Retry preview", () => {
    sourceToken = "";
    schedulePreview();
  });
  retry.hidden = true;
  preview.append(
    previewToolbar,
    previewStatus,
    previewHost,
    retry,
    previewDetails,
  );
  body.append(settings, preview);
  const footer = el("footer", "ce-footer");
  const saveError = el("p", "ce-error ce-save-error");
  saveError.setAttribute("role", "alert");
  const save = el(
    "button",
    "ce-primary",
    options.isNew ? "Add chart" : "Save changes",
  );
  save.type = "submit";
  footer.append(
    saveError,
    button("Cancel", () => close()),
    save,
  );
  form.append(body, footer);
  dialog.append(header, form);

  function setError(key: string, message: string) {
    if (message) errors.set(key, message);
    else errors.delete(key);
    const field = fields.get(key);
    if (field) {
      field.error.textContent = message;
      field.control.setAttribute("aria-invalid", String(!!message));
    }
  }
  function field(
    parent: HTMLElement,
    key: string,
    label: string,
    control: HTMLElement,
    help = "",
  ) {
    const box = el("div", "ce-field");
    control.id = `${prefix}-field-${++sequence}`;
    const caption = el("label", "", label);
    caption.htmlFor = control.id;
    const error = el("p", "ce-error");
    error.id = `${control.id}-error`;
    error.setAttribute("aria-live", "polite");
    const hint = el("p", "ce-help", help);
    hint.id = `${control.id}-help`;
    control.setAttribute("aria-describedby", `${hint.id} ${error.id}`);
    box.append(caption, control, hint, error);
    parent.append(box);
    const section =
      [...panels].find(
        ([, panel]) => panel === parent || panel.contains(parent),
      )?.[0] ?? "Appearance";
    fields.set(key, { control, error, section });
    setError(key, errors.get(key) ?? "");
    return box;
  }
  function change() {
    saveError.textContent = "";
    refreshAutoRangeHelp();
    schedulePreview();
  }
  function input(
    parent: HTMLElement,
    key: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    help = "",
  ) {
    const control = el("input");
    control.type = "text";
    control.value = value;
    field(parent, key, label, control, help);
    control.oninput = () => {
      onChange(control.value);
      change();
    };
    return control;
  }
  function select(
    parent: HTMLElement,
    key: string,
    label: string,
    value: string,
    choices: [string, string][],
    onChange: (value: string) => void,
    help = "",
  ) {
    const control = el("select");
    choices.forEach(([value, label]) => {
      const option = el("option", "", label);
      option.value = value;
      control.append(option);
    });
    control.value = value;
    field(parent, key, label, control, help);
    control.onchange = () => {
      setError(key, "");
      onChange(control.value);
      change();
    };
    return control;
  }
  function toggle(
    parent: HTMLElement,
    key: string,
    label: string,
    value: boolean,
    onChange: (value: boolean) => void,
    help = "",
  ) {
    const control = el("input");
    control.type = "checkbox";
    control.checked = value;
    const box = field(parent, key, label, control, help);
    box.classList.add("ce-toggle");
    control.onchange = () => {
      control.indeterminate = false;
      onChange(control.checked);
      change();
    };
    return control;
  }
  function number(
    parent: HTMLElement,
    key: string,
    label: string,
    value: number | null,
    onChange: (value: number | null) => void,
    min = -Infinity,
    max = Infinity,
    optional = false,
    help = "",
  ) {
    const control = el("input");
    control.type = "number";
    control.step = "any";
    control.value = value === null ? "" : String(value);
    if (Number.isFinite(min)) control.min = String(min);
    if (Number.isFinite(max)) control.max = String(max);
    field(parent, key, label, control, help);
    control.oninput = () => {
      const value =
        control.value === "" && !control.validity.badInput
          ? null
          : control.valueAsNumber;
      const invalid =
        value === null
          ? !optional
          : !Number.isFinite(value) || value < min || value > max;
      setError(
        key,
        invalid
          ? `Enter ${optional ? "a number or leave blank" : "a number"}${Number.isFinite(min) ? ` ≥ ${min}` : ""}${Number.isFinite(max) ? ` and ≤ ${max}` : ""}.`
          : "",
      );
      if (!invalid) onChange(value);
      change();
    };
    return control;
  }
  function more(parent: HTMLElement, label: string) {
    const details = el("details", "ce-more");
    details.append(el("summary", "", label));
    parent.append(details);
    return details;
  }
  function clearPanel(name: string) {
    const panel = panels.get(name)!;
    for (const [key, value] of fields)
      if (value.section === name) {
        fields.delete(key);
        errors.delete(key);
      }
    const advanced =
      panel.querySelector<HTMLDetailsElement>(":scope > details");
    if (advanced) advancedOpen.set(name, advanced.open);
    panel.replaceChildren();
    return panel;
  }
  /** Show a panel only for scalar charts (image panels have no axes/styles). */
  function scalarOnly(name: string) {
    panelRoots.get(name)!.hidden = draft.kind === "image";
    return draft.kind === "image";
  }
  function foldState(name: string, text: string) {
    const state = foldStates.get(name);
    if (state) state.textContent = text;
  }

  let pickerPage = 0;
  let pickerSearch = "";
  let renderChoices = () => {};
  function renderAll() {
    previewNavigation.hidden = draft.kind === "image" || !touchPrimary();
    recordControls?.destroy(); recordControls = undefined;
    renderChart();
    renderData();
    renderX();
    renderAxes();
    renderSmoothing();
    renderAppearance();
    if (draft.records) recordControls = mountRecordControls(panels.get("Data")!, panels.get("X")!, {
      binding: draft.records, catalog: options.catalog, selected: options.selectedRunIds, api: options.api,
      changed: change, error: message => { if (message) errors.set("records", message); else errors.delete("records"); },
    });
  }
  function renderChart() {
    const panel = clearPanel("Chart");
    input(panel, "title", "Chart title", draft.title, (value) => {
      draft.title = value;
      setError("title", value.trim() ? "" : "Give this chart a title.");
      removeOverride(draft.config, ["title"]);
    });
    const row = el("div", "ce-pair");
    panel.append(row);
    select(
      row,
      "kind",
      "Plot type",
      plotType(draft),
      [
        ["line", "Line"],
        ["scatter", "Scatter"],
        ["area", "Area"],
        ["step", "Step"],
        ["image", "Image panel"],
      ],
      (value) => {
        sourceMemory.set(
          `${draft.kind}/${draft.source.mode}`,
          clone(draft.source),
        );
        setPlotType(draft, value as PlotType);
        if (draft.kind === "image") { delete draft.x; delete draft.records; }
        draft.source = clone(
          sourceMemory.get(`${draft.kind}/${draft.source.mode}`) ??
            (draft.source.mode === "selected"
              ? { mode: "selected", keys: [] }
              : { mode: "explicit", series: [] }),
        );
        pickerPage = 0;
        pickerSearch = "";
        renderAll();
        fields.get("kind")?.control.focus({ preventScroll: true });
      },
    );
    if (draft.kind !== "image" && (options.catalog.rx || draft.records)) {
      select(panel, "data-source", "Data source", draft.records ? "records" : "metrics", [["metrics", "Metrics"], ["records", "rx records"]], value => {
        if (value === "records") { draft.records = newRecordBinding(options.catalog); delete draft.x; }
        else delete draft.records;
        renderAll();
      });
    }
    if (draft.records) {
      panel.append(el("p", "ce-help", "Runs: selected rx runs in this workspace. This source is read-only."));
      return;
    }
    select(
      row,
      "source-mode",
      "Runs",
      draft.source.mode,
      [
        ["selected", `Selected runs (${options.selectedRunIds.length})`],
        ["explicit", "Specific series"],
      ],
      (value) => {
        sourceMemory.set(
          `${draft.kind}/${draft.source.mode}`,
          clone(draft.source),
        );
        draft.source = clone(
          sourceMemory.get(`${draft.kind}/${value}`) ??
            (value === "selected"
              ? { mode: "selected", keys: [] }
              : { mode: "explicit", series: [] }),
        );
        // A per-run X key needs runs to follow; specific Y series pair with
        // one specific X series instead, and vice versa.
        if (draft.x) {
          const key =
            draft.x.mode === "key" ? draft.x.key : draft.x.series.key;
          const next = xBindingFor(key);
          if (next) draft.x = next;
        }
        pickerPage = 0;
        pickerSearch = "";
        renderAll();
        fields.get("source-mode")?.control.focus({ preventScroll: true });
      },
    );
  }
  function renderData() {
    const panel = clearPanel("Data");
    if (draft.records) { panelHeadings.get("Data")!.textContent = "Record fields"; return; }
    panelHeadings.get("Data")!.textContent =
      draft.kind === "image" ? "Images" : "Y axis";
    // What is on the axis now, at a glance: one removable chip per choice.
    const chips = el("div", "ce-chips");
    chips.setAttribute("aria-label", "Chosen");
    const summary = el("p", "ce-selection-summary");
    panel.append(chips, summary);
    const search = input(
      panel,
      "source-search",
      draft.kind === "image" ? "Find images" : "Find metrics",
      pickerSearch,
      (value) => {
        pickerSearch = value;
        pickerPage = 0;
        renderChoices();
      },
    );
    search.type = "search";
    search.placeholder =
      draft.source.mode === "explicit"
        ? draft.kind === "image"
          ? "Add images: search experiment, run, key…"
          : "Add metrics: search experiment, run, key…"
        : draft.kind === "image"
          ? "Add images…"
          : "Add metrics…";
    // The chips already show what is chosen; the placeholder names the box.
    search.closest(".ce-field")!.classList.add("ce-search");
    const list = el("div", "ce-source-list");
    list.setAttribute("role", "group");
    list.setAttribute(
      "aria-label",
      draft.kind === "image" ? "Image sources" : "Metric sources",
    );
    const sourceError = el("p", "ce-error");
    sourceError.setAttribute("role", "alert");
    sourceError.id = `${prefix}-source-error`;
    list.setAttribute("aria-describedby", sourceError.id);
    list.tabIndex = -1;
    fields.set("source", {
      control: list,
      error: sourceError,
      section: "Data",
    });
    const paging = el("div", "ce-paging");
    const previous = button("Previous sources", () => {
      pickerPage--;
      renderChoices();
    });
    const next = button("Next sources", () => {
      pickerPage++;
      renderChoices();
    });
    const pageInfo = el("span");
    pageInfo.setAttribute("role", "status");
    paging.append(previous, pageInfo, next);
    panel.append(list, sourceError, paging);
    const toggleChoice = (choice: SourceChoice, on: boolean) => {
      if (draft.source.mode === "selected")
        draft.source.keys = on
          ? [...new Set([...draft.source.keys, choice.key])]
          : draft.source.keys.filter((key) => key !== choice.key);
      else if (choice.ref)
        draft.source.series = on
          ? [
              ...draft.source.series.filter(
                (ref) => seriesId(ref) !== choice.id,
              ),
              clone(choice.ref),
            ]
          : draft.source.series.filter((ref) => seriesId(ref) !== choice.id);
      setError("source", "");
      refreshAxisTitles();
      renderX();
      renderAppearance();
      change();
    };
    renderChoices = () => {
      const choices = editorSourceChoices(
        draft,
        options.catalog,
        options.selectedRunIds,
      );
      const selected = choices.filter((choice) => choice.selected);
      const unavailable = selected.filter((choice) => !choice.available).length;
      summary.textContent = unavailable
        ? `${selected.length} chosen · ${unavailable} unavailable (kept)`
        : "";
      chips.replaceChildren();
      for (const choice of selected) {
        const chip = button(
          "",
          () => {
            toggleChoice(choice, false);
            renderChoices();
            (chips.querySelector("button") ?? search).focus({
              preventScroll: true,
            });
          },
          `ce-chip${choice.available ? "" : " ce-unavailable"}`,
        );
        chip.setAttribute("aria-label", `Remove ${choice.label}`);
        chip.title =
          draft.source.mode === "explicit" ? choice.detail : choice.label;
        chip.append(el("span", "", choice.label), el("span", "ce-chip-x", "×"));
        chips.append(chip);
      }
      if (!selected.length)
        chips.append(
          el(
            "span",
            "ce-chip-empty",
            draft.kind === "image" ? "No images chosen" : "No metrics chosen",
          ),
        );
      const result = choicePage(choices, pickerSearch, pickerPage);
      pickerPage = result.page;
      list.replaceChildren();
      if (!result.rows.length)
        list.append(el("p", "ce-empty", "No matches."));
      for (const choice of result.rows) {
        const row = el(
          "label",
          `ce-source${choice.available ? "" : " ce-unavailable"}`,
        );
        const checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.checked = choice.selected;
        checkbox.setAttribute(
          "aria-label",
          `${choice.label} — ${choice.detail}`,
        );
        checkbox.dataset.sourceId = choice.id;
        const copy = el("span");
        copy.append(
          el("strong", "", choice.label),
          el("small", "", choice.detail),
        );
        row.append(checkbox, copy);
        list.append(row);
        checkbox.onchange = () => {
          toggleChoice(choice, checkbox.checked);
          const scrollTop = list.scrollTop;
          renderChoices();
          list.scrollTop = scrollTop;
          (
            list.querySelector<HTMLInputElement>(
              `input[data-source-id="${CSS.escape(choice.id)}"]`,
            ) ?? list
          ).focus({ preventScroll: true });
        };
      }
      previous.disabled = pickerPage === 0;
      next.disabled = pickerPage >= result.pages - 1;
      paging.hidden = result.pages <= 1;
      pageInfo.textContent = `${result.total} results · ${pickerPage + 1} / ${result.pages}`;
      setError("source", errors.get("source") ?? "");
    };
    renderChoices();
  }

  /** Changing what X means invalidates X bounds/format/ticks, not labels. */
  function setXBinding(binding: XBinding | undefined) {
    const before = cameraAxis(draft);
    if (binding) draft.x = binding;
    else delete draft.x;
    if (cameraAxis(draft) !== before) resetXAxis(draft.config);
    refreshAxisTitles();
  }
  /** The natural binding for an X metric key given how Y picks runs:
   * followed runs pair per run; specific series pair with one exact series
   * (the first run that logged the key, preferring Y's own runs). */
  function xBindingFor(key: string): XBinding | undefined {
    if (draft.source.mode === "selected") return { mode: "key", key };
    const yRuns = draft.source.series.map((ref) => ref.runId);
    const runs = new Set(
      options.catalog.series
        .filter((series) => series.kind === "metric" && series.key === key)
        .map((series) => series.run_id),
    );
    const runId = yRuns.find((id) => runs.has(id)) ?? [...runs][0];
    return runId
      ? { mode: "series", series: { runId, key, kind: "metric" } }
      : undefined;
  }
  /** Encodes X as one select value: a parameter, a per-run key, or a series. */
  function xValue(): string {
    if (!draft.x) return `param:${draft.config.axis}`;
    return draft.x.mode === "key"
      ? `key:${draft.x.key}`
      : `series:${seriesId(draft.x.series)}`;
  }
  function renderX() {
    const panel = clearPanel("X");
    if (scalarOnly("X") || draft.records) return;
    const control = el("select");
    const group = (label: string, entries: [string, string][]) => {
      if (!entries.length) return;
      const node = el("optgroup");
      node.label = label;
      for (const [value, text] of entries) {
        const option = el("option", "", text);
        option.value = value;
        node.append(option);
      }
      control.append(node);
    };
    group("Parameter", [
      ["param:step", "Step"],
      ["param:timestamp", "Wall time"],
      ["param:relative", "Relative time"],
    ]);
    const yKeys = new Set(
      draft.source.mode === "selected"
        ? draft.source.keys
        : draft.source.series.map((ref) => ref.key),
    );
    if (draft.source.mode === "selected")
      group(
        "Metric (from each run)",
        editorXChoices(draft, options.catalog, options.selectedRunIds, "key")
          .filter(
            (choice) =>
              (choice.available && !yKeys.has(choice.value)) ||
              xValue() === `key:${choice.value}`,
          )
          .map((choice) => [`key:${choice.value}`, choice.value]),
      );
    else
      group(
        "Metric (specific series)",
        editorXChoices(draft, options.catalog, options.selectedRunIds, "series")
          .filter((choice) => choice.available || xValue() === `series:${choice.value}`)
          .map((choice) => [`series:${choice.value}`, choice.label]),
      );
    // Keep a saved binding that no longer fits the lists above selectable.
    if (![...control.options].some((option) => option.value === xValue())) {
      const option = el(
        "option",
        "",
        `${draft.x ? xMetricLabel(draft.x) : draft.config.axis} (saved)`,
      );
      option.value = xValue();
      control.append(option);
    }
    control.value = xValue();
    const row = el("div", draft.x ? "ce-pair ce-x-row" : "");
    panel.append(row);
    field(row, "axis", "X", control);
    control.onchange = () => {
      setError("axis", "");
      const [kind, ...rest] = control.value.split(":");
      const value = rest.join(":");
      if (kind === "param") {
        const changed = !!draft.x || value !== draft.config.axis;
        setXBinding(undefined);
        draft.config = applyDashboardControls(draft.config, {
          axis: value as ViewConfig["axis"],
        });
        if (changed) resetXAxis(draft.config);
      } else if (kind === "key") setXBinding({ mode: "key", key: value });
      else {
        const [, runId, key] = JSON.parse(value) as string[];
        setXBinding({ mode: "series", series: { runId, key, kind: "metric" } });
      }
      renderX();
      renderAxes();
      change();
      fields.get("axis")?.control.focus({ preventScroll: true });
    };
    if (draft.x)
      select(
        row,
        "x-join",
        "Matched at",
        draft.config.axis,
        [
          ["step", "Same step"],
          ["timestamp", "Same wall time"],
          ["relative", "Same relative time"],
        ],
        (value) => {
          // The join parameter is hidden; X bounds stay meaningful.
          draft.config.axis = value as ViewConfig["axis"];
        },
      );
  }
  function renderAxes() {
    for (const axis of ["x", "y"] as const) clearPanel(axisPanel[axis]);
    for (const details of axisDetails.values())
      details.hidden = draft.kind === "image";
    if (draft.kind === "image") return;
    for (const axis of ["x", "y"] as const) {
      const name = axis.toUpperCase();
      const group = panels.get(axisPanel[axis])!;
      const patch = axisOverride(draft.config, axis);
      input(
        group,
        `${axis}Label`,
        `${name} axis title`,
        String(patch.label ?? draft.config[`${axis}Label`]),
        (value) => {
          setEditorAxis(draft.config, axis, "label", value);
          refreshAxisTitles();
        },
      );
      const scaleBounds = el("div", "ce-pair");
      group.append(scaleBounds);
      select(
        scaleBounds,
        `${axis}Scale`,
        `${name} scale`,
        draft.config[`${axis}Scale`],
        [
          ["linear", "Linear"],
          ["log", "Logarithmic"],
          ["asinh", "Asinh (includes zero and negatives)"],
        ],
        (value) => {
          draft.config[`${axis}Scale`] = value as ViewConfig["xScale"];
          refreshScaleOptions();
          checkBounds();
        },
      );
      let [lo, hi] = explicitRangeBounds(effectiveRange(draft.config, axis));
      const initialRange = effectiveRange(draft.config, axis);
      const custom = !Array.isArray(initialRange);
      const manual = lo !== null || hi !== null;
      const boundsBox = el("div", "ce-pair");
      const rangeSelect = select(
        scaleBounds,
        `${axis}-range`,
        `${name} bounds`,
        custom ? "custom" : manual ? "manual" : "auto",
        [
          ["auto", "Automatic"],
          ["manual", "Set limits"],
          ...(custom
            ? [["custom", "Saved range rules (kept)"] as [string, string]]
            : []),
        ],
        (value) => {
          boundsBox.hidden = value !== "manual";
          if (value !== "custom") {
            setEditorBounds(
              draft.config,
              axis,
              value === "auto" ? null : lo,
              value === "auto" ? null : hi,
            );
          }
          if (value !== "custom") {
            for (const [suffix, bound] of [
              ["Min", lo],
              ["Max", hi],
            ] as const) {
              const control = fields.get(`${axis}${suffix}`)?.control as
                HTMLInputElement | undefined;
              if (control) control.value = bound === null ? "" : String(bound);
              setError(`${axis}${suffix}`, "");
            }
          }
          checkBounds();
        },
      );
      group.append(boundsBox);
      boundsBox.hidden = !manual || custom;
      number(
        boundsBox,
        `${axis}Min`,
        `${name} minimum`,
        lo,
        (value) => {
          lo = value;
          setEditorBounds(draft.config, axis, lo, hi);
          checkBounds();
        },
        -Infinity,
        Infinity,
        true,
      );
      number(
        boundsBox,
        `${axis}Max`,
        `${name} maximum`,
        hi,
        (value) => {
          hi = value;
          setEditorBounds(draft.config, axis, lo, hi);
          checkBounds();
        },
        -Infinity,
        Infinity,
        true,
      );
      function checkBounds() {
        const [min, max] = explicitRangeBounds(
          effectiveRange(draft.config, axis),
        );
        let error =
          min !== null && max !== null && min >= max
            ? "Minimum must be less than maximum."
            : "";
        if (
          draft.config[`${axis}Scale`] === "log" &&
          [min, max].some((value) => value !== null && value <= 0)
        )
          error = "Logarithmic bounds must be greater than zero.";
        setError(`${axis}-range`, error);
        refreshAxesState();
      }
      const labels = group;
      const staticValues = Array.isArray(patch.values);
      select(
        labels,
        `${axis}Format`,
        `${name} number format`,
        staticValues
          ? "custom"
          : String(patch.values ?? draft.config[`${axis}Format`]),
        [
          ["number", "Automatic"],
          ["fixed-2", "Two decimals"],
          ["scientific", "Scientific"],
          ["iso-time", "UTC date & time"],
          ...(staticValues
            ? [["custom", "Saved tick labels (kept)"] as [string, string]]
            : []),
        ],
        (value) => {
          if (value !== "custom")
            setEditorAxis(draft.config, axis, "values", value);
        },
      );
      toggle(
        labels,
        `${axis}-reverse`,
        `Reverse ${name} direction`,
        scaleOverride(draft.config, axis).dir === -1,
        (value) =>
          override(draft.config, ["scales", axis, "dir"], value ? -1 : 1),
      );
      const logBase = select(
        labels,
        `${axis}-log-base`,
        `${name} log base`,
        String(scaleOverride(draft.config, axis).log ?? 10),
        [
          ["10", "10"],
          ["2", "2"],
        ],
        (value) =>
          override(draft.config, ["scales", axis, "log"], Number(value)),
      );
      const asinh = number(
        labels,
        `${axis}-asinh`,
        `${name} asinh transition`,
        Number(scaleOverride(draft.config, axis).asinh ?? 1),
        (value) => override(draft.config, ["scales", axis, "asinh"], value),
        Number.MIN_VALUE,
        Infinity,
        false,
      );
      function refreshScaleOptions() {
        logBase.closest<HTMLElement>(".ce-field")!.hidden =
          draft.config[`${axis}Scale`] !== "log";
        asinh.closest<HTMLElement>(".ce-field")!.hidden =
          draft.config[`${axis}Scale`] !== "asinh";
        if (draft.config[`${axis}Scale`] !== "asinh") {
          setError(`${axis}-asinh`, "");
          asinh.value = String(scaleOverride(draft.config, axis).asinh ?? 1);
        }
      }
      refreshScaleOptions();
      // Keep the control reachable for validation even when its optional inputs are hidden.
      rangeSelect.dataset.axis = axis;
    }
    select(
      panels.get(axisPanel.y)!,
      "outliers",
      "Y auto range",
      draft.outliers,
      [
        ["all", "All values"],
        ["robust", "Central 98%"],
      ],
      (value) => {
        draft.outliers = value as ChartSpec["outliers"];
        refreshAxesState();
      },
      editorAutoRangeHelp(draft.config),
    );
    refreshAxisTitles();
    refreshAxesState();
  }
  /** Fold header: a glanceable summary so closed folds still say something. */
  function refreshAxesState() {
    const scale = { linear: "linear", log: "log", asinh: "asinh" } as const;
    for (const axis of ["x", "y"] as const) {
      const [lo, hi] = explicitRangeBounds(effectiveRange(draft.config, axis));
      foldState(
        axisPanel[axis],
        [
          scale[draft.config[`${axis}Scale`]],
          lo !== null || hi !== null ? "limits" : "",
          axis === "y" && draft.outliers === "robust" ? "98%" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
    }
  }

  function refreshAutoRangeHelp() {
    const hint = fields
      .get("outliers")
      ?.control.closest(".ce-field")
      ?.querySelector(".ce-help");
    if (hint) hint.textContent = editorAutoRangeHelp(draft.config);
  }

  function refreshAxisTitles() {
    for (const axis of ["x", "y"] as const) {
      const control = fields.get(`${axis}Label`)?.control as
        HTMLInputElement | undefined;
      if (!control) continue;
      const automatic = clone(draft);
      setEditorAxis(automatic.config, axis, "label", "");
      const title = editorAxisTitle(automatic, axis);
      const savedEmpty = axisOverride(draft.config, axis).label === "";
      control.placeholder = savedEmpty ? "Saved empty title" : title;
      control.closest(".ce-field")!.querySelector(".ce-help")!.textContent =
        savedEmpty ? "Saved empty title is kept. Type to replace it." : "";
    }
  }

  function renderSmoothing() {
    const panel = clearPanel("Smoothing");
    if (scalarOnly("Smoothing")) return;
    const strengthBox = el("div", "ce-smoothing");
    panel.append(strengthBox);
    const strength = el("input");
    strength.type = "range";
    strength.min = "0";
    strength.max = "100";
    strength.step = "any";
    strength.value = String(smoothingToStrength(draft.config));
    const strengthHint = () =>
      Number(strength.value) === 0
        ? "None"
        : Number(strength.value) === 100
          ? "More"
          : `${Math.round(Number(strength.value))}%`;
    field(strengthBox, "strength", "Smoothing strength", strength);
    const endpoints = el("div", "ce-smoothing-endpoints");
    endpoints.append(el("span", "", "None"), el("span", "", "More"));
    strengthBox.append(endpoints);
    const refreshState = () =>
      foldState(
        "Smoothing",
        `${strengthHint()} · ${draft.records ? "event order" : draft.config.interpolation === "pchip" ? "smooth" : "linear"}`,
      );
    strength.setAttribute("aria-valuetext", strengthHint());
    strength.oninput = () => {
      Object.assign(draft.config, strengthToSmoothing(Number(strength.value)));
      strength.setAttribute("aria-valuetext", strengthHint());
      refreshState();
      change();
    };
    if (draft.records) panel.append(el("p", "ce-help", "Smoothing follows event order. Record observations are already paired; no independent-series interpolation is applied."));
    else select(
      panel,
      "interpolation",
      "Between observations",
      draft.config.interpolation,
      [
        ["linear", "Straight (linear)"],
        ["pchip", "Smooth (PCHIP)"],
      ],
      (value) => {
        draft.config.interpolation = value as ViewConfig["interpolation"];
        refreshState();
      },
    );
    refreshState();
  }

  function renderAppearance() {
    const panel = clearPanel("Appearance");
    if (scalarOnly("Appearance")) return;
    const legend = record(draft.config.advanced.legend).show;
    const toggles = el("div", "ce-pair");
    panel.append(toggles);
    toggle(
      toggles,
      "legend",
      "Show legend",
      typeof legend === "boolean" ? legend : draft.config.legend,
      (value) => setEditorToggle(draft.config, "legend", value),
    );
    const grids = ["x", "y"].map(
      (axis) =>
        record(axisOverride(draft.config, axis as "x" | "y").grid).show ??
        draft.config.grid,
    );
    const grid = toggle(
      toggles,
      "grid",
      "Show grid",
      grids.every(Boolean),
      (value) => setEditorToggle(draft.config, "grid", value),
    );
    grid.indeterminate = grids[0] !== grids[1];
    foldState("Appearance", plotType(draft));
    const styleDetails = el("fieldset", "ce-group ce-default-style");
    styleDetails.append(el("legend", "", "Default curve style"));
    panel.append(styleDetails);
    const extra = more(panel, "More style options");
    extra.open = advancedOpen.get("Appearance") ?? false;
    const strokeDetails = el("fieldset", "ce-group");
    strokeDetails.append(el("legend", "", "Line & marker details"));
    extra.append(strokeDetails);
    toggle(
      styleDetails,
      "palette",
      "Use shared run colors",
      draft.config.palette,
      (value) => {
        draft.config.palette = value;
        const color = fields.get("default:color")?.control as
          HTMLInputElement | undefined;
        if (color) color.disabled = value;
      },
    );
    renderStyle(
      styleDetails,
      {},
      "default",
      draft.config.style,
      draft.config.palette,
      (patch) => {
        // Axis changes replace the config; never rely on the captured style identity.
        draft.config.style = deepMerge(draft.config.style, patch);
      },
      strokeDetails,
    );
    const details = el("fieldset", "ce-group");
    details.append(el("legend", "", "Individual curves"));
    extra.append(details);
    let styleSearch = "";
    let stylePage = 0;
    let activeId = "";
    const search = input(
      details,
      "style-search",
      "Find a curve to style",
      "",
      (value) => {
        styleSearch = value;
        stylePage = 0;
        renderSeriesList();
      },
    );
    search.type = "search";
    const rows = el("div", "ce-series-list");
    const pageInfo = el("span");
    const previous = button("Previous curves", () => {
      stylePage--;
      renderSeriesList();
    });
    const next = button("Next curves", () => {
      stylePage++;
      renderSeriesList();
    });
    const paging = el("div", "ce-paging");
    paging.append(previous, pageInfo, next);
    const curveForm = el("div", "ce-curve-form");
    details.append(rows, paging, curveForm);
    function renderSeriesList() {
      const resolved = draft.records ? recordPreviewSources : resolveSources(
        draft,
        options.selectedRunIds,
        options.catalog,
      );
      const result = choicePage(
        resolved.map((ref) => ({
          id: ref.id,
          key: ref.key,
          label: ref.label,
          detail: "",
          available: true,
          selected: true,
        })),
        styleSearch,
        stylePage,
      );
      stylePage = result.page;
      rows.replaceChildren();
      if (!result.total)
        rows.append(
          el("p", "ce-help", "No curves yet."),
        );
      for (const choice of result.rows) {
        const choose = button(
          choice.label,
          () => {
            activeId = choice.id;
            renderSeriesForm(resolved, choice.id);
            renderSeriesList();
            rows
              .querySelector<HTMLButtonElement>('[aria-pressed="true"]')
              ?.focus({ preventScroll: true });
          },
          "ce-series-button",
        );
        choose.setAttribute("aria-pressed", String(choice.id === activeId));
        rows.append(choose);
      }
      previous.disabled = stylePage === 0;
      next.disabled = stylePage >= result.pages - 1;
      pageInfo.textContent = `${result.total} curves · ${stylePage + 1} / ${result.pages}`;
    }
    function renderSeriesForm(resolved: ResolvedSeries[], id: string) {
      for (const key of [...fields.keys()])
        if (key.startsWith("curve:")) {
          fields.delete(key);
          errors.delete(key);
        }
      curveForm.replaceChildren();
      const index = resolved.findIndex((ref) => ref.id === id);
      const style = styleFor(
        withRunColors(draft.config, resolved, options.catalog),
        id,
        index,
      );
      const patch: Partial<RunStyle> = clone(draft.config.runs[id] ?? {});
      const heading = el("h4", "", resolved[index].label);
      curveForm.append(heading);
      const reset = button("Use default style", () => {
        delete draft.config.runs[id];
        renderSeriesForm(resolved, id);
        change();
      });
      curveForm.append(reset);
      renderStyle(curveForm, patch, `curve:${id}`, style, false, () => {
        draft.config.runs[id] = patch;
      });
    }
    renderSeriesList();
    number(
      extra,
      "height",
      "Plot height (pixels)",
      draft.config.height,
      (value) => {
        draft.config.height = value!;
      },
      240,
      1800,
    );
    number(
      extra,
      "width",
      "Fixed plot width (pixels)",
      draft.config.width,
      (value) => {
        draft.config.width = value;
      },
      320,
      8000,
      true,
      "Blank fits the card.",
    );
    const ticks = ["x", "y"].map(
      (axis) =>
        record(axisOverride(draft.config, axis as "x" | "y").ticks).show ??
        draft.config.ticks,
    );
    const tickToggle = toggle(
      extra,
      "ticks",
      "Show axis ticks",
      ticks.every(Boolean),
      (value) => setEditorToggle(draft.config, "ticks", value),
    );
    tickToggle.indeterminate = ticks[0] !== ticks[1];
    number(
      extra,
      "focus-alpha",
      "Other curves on hover (opacity)",
      Number(record(draft.config.advanced.focus).alpha ?? 0.3),
      (value) => override(draft.config, ["focus", "alpha"], value),
      0,
      1,
    );
  }

  function renderStyle(
    parent: HTMLElement,
    patch: Partial<RunStyle>,
    key: string,
    effective: RunStyle,
    palette: boolean,
    commit: (patch: Partial<RunStyle>) => void = () => {},
    extra: HTMLElement = parent,
  ) {
    // Curve style is the line only; points are an independent overlay. "No line"
    // forces points on (or nothing is drawn) and leaving it restores the
    // points choice that was in effect before.
    const shapeFor = (style: RunStyle) =>
      style.width === 0 && style.fill === 0
        ? "none"
        : style.fill > 0
          ? "area"
          : style.path.startsWith("stepped-") && style.pathOptions?.align
            ? style.pathOptions.align === -1
              ? "stepped-before"
              : "stepped-after"
            : style.path;
    const pointsFor = (style: RunStyle) =>
      String(style.markers?.show ?? style.points);
    let pointsBeforeNone = shapeFor(effective) === "none" ? "false" : pointsFor(effective);
    const pointSync: (() => void)[] = [];
    const setPoints = (value: string) => {
      patch.points = value !== "false";
      patch.markers = {
        ...effective.markers,
        ...patch.markers,
        show: value === "auto" ? "auto" : value === "true",
      };
    };
    const changed = () => {
      effective = deepMerge(effective, patch);
      commit(patch);
      if (key === "default") {
        const type = fields.get("kind")?.control as
          HTMLSelectElement | undefined;
        if (type) type.value = plotType(draft);
      }
      // Presets change several properties; keep their existing controls in sync without
      // rebuilding the focused form or dropping unfinished input in another field.
      const values: Record<string, string> = {
        shape: shapeFor(effective),
        width: String(effective.width),
        fill: String(effective.fill),
        points: pointsFor(effective),
        "marker-size": String(effective.markers?.size ?? effective.pointSize),
      };
      for (const [name, value] of Object.entries(values)) {
        const control = fields.get(`${key}:${name}`)?.control as
          HTMLInputElement | HTMLSelectElement | undefined;
        if (
          control &&
          control !== document.activeElement &&
          !errors.has(`${key}:${name}`)
        )
          control.value = value;
      }
      for (const sync of pointSync) sync();
      change();
    };
    const shape = shapeFor(effective);
    select(
      parent,
      `${key}:shape`,
      "Curve style",
      shape,
      [
        ["matched", "Line"],
        ["linear", "Straight segments"],
        ["spline", "Spline (smooth fit)"],
        ["stepped-after", "Step (hold until next)"],
        ["stepped-before", "Step (jump at point)"],
        ["area", "Area"],
        ["none", "No line (points only)"],
      ],
      (value) => {
        const wasNone = shapeFor(effective) === "none";
        patch.path =
          value === "area" || value === "none"
            ? "matched"
            : (value as RunStyle["path"]);
        patch.width = value === "none" ? 0 : effective.width || 2;
        patch.fill = value === "area" ? effective.fill || 0.15 : 0;
        if (value === "none" && !wasNone) {
          // Remember the overlay choice, then make sure something is drawn.
          pointsBeforeNone = pointsFor(effective);
          if (pointsBeforeNone === "false") setPoints("true");
        } else if (value !== "none" && wasNone) setPoints(pointsBeforeNone);
        if (value.startsWith("stepped-"))
          patch.pathOptions = {
            ...effective.pathOptions,
            ...patch.pathOptions,
            align: value === "stepped-before" ? -1 : 1,
          };
        changed();
      },
    );
    const color = input(
      parent,
      `${key}:color`,
      "Curve color",
      effective.color,
      (value) => {
        const valid = isSafeColor(value);
        setError(
          `${key}:color`,
          valid
            ? ""
            : "Use a color such as #2563eb, navy, or rgb(37, 99, 235).",
        );
        if (valid) {
          patch.color = value;
          changed();
        }
      },
      palette ? "Uses shared run colors." : "",
    );
    color.disabled = palette;
    toggle(
      parent,
      `${key}:visible`,
      "Show this curve",
      effective.visible,
      (value) => {
        patch.visible = value;
        changed();
      },
    );
    const pointsControl = select(
      parent,
      `${key}:points`,
      "Points",
      pointsFor(effective),
      [
        ["false", "Off"],
        ["true", "On"],
        ["auto", "Only when sparse"],
      ],
      (value) => {
        setPoints(value);
        changed();
      },
    );
    // With no line, hiding points would hide the curve: use "Show this curve".
    const syncPointsOff = () => {
      const off = pointsControl.querySelector<HTMLOptionElement>('option[value="false"]');
      if (off) off.disabled = shapeFor(effective) === "none";
    };
    syncPointsOff();
    pointSync.push(syncPointsOff);
    const basic = el("div", "ce-pair");
    parent.append(basic);
    number(
      basic,
      `${key}:width`,
      "Line width",
      effective.width,
      (value) => {
        patch.width = value!;
        changed();
      },
      0,
      20,
    );
    number(
      extra,
      `${key}:opacity`,
      "Curve opacity",
      effective.alpha ?? 1,
      (value) => {
        patch.alpha = value!;
        changed();
      },
      0,
      1,
    );
    number(
      basic,
      `${key}:fill`,
      "Area opacity",
      effective.fill,
      (value) => {
        patch.fill = value!;
        changed();
      },
      0,
      1,
    );
    number(
      basic,
      `${key}:marker-size`,
      "Point size",
      effective.markers?.size ?? effective.pointSize,
      (value) => {
        patch.pointSize = value!;
        patch.markers = {
          ...effective.markers,
          ...patch.markers,
          size: value!,
        };
        changed();
      },
      1,
      100,
    );
    number(
      extra,
      `${key}:marker-space`,
      "Point spacing (pixels)",
      effective.markers?.space ?? 10,
      (value) => {
        patch.markers = {
          ...effective.markers,
          ...patch.markers,
          space: value!,
        };
        changed();
      },
      0,
      1000,
      false,
      "Used by automatic point spacing; this does not reduce the curve data.",
    );
    const dashName =
      effective.dash.length === 0
        ? "solid"
        : effective.dash.join(",") === "8,4"
          ? "dashed"
          : effective.dash.join(",") === "2,3"
            ? "dotted"
            : "custom";
    select(
      extra,
      `${key}:dash`,
      "Line pattern",
      dashName,
      [
        ["solid", "Solid"],
        ["dashed", "Dashed"],
        ["dotted", "Dotted"],
        ...(dashName === "custom"
          ? [["custom", "Saved custom pattern (kept)"] as [string, string]]
          : []),
      ],
      (value) => {
        if (value !== "custom") {
          patch.dash =
            value === "solid" ? [] : value === "dashed" ? [8, 4] : [2, 3];
          changed();
        }
      },
    );
    select(
      extra,
      `${key}:cap`,
      "Line ends",
      effective.cap ?? "butt",
      [
        ["butt", "Flat"],
        ["round", "Round"],
        ["square", "Square"],
      ],
      (value) => {
        patch.cap = value as RunStyle["cap"];
        changed();
      },
    );
  }

  function schedulePreview() {
    if (closed) return;
    ++previewVersion;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void updatePreview(previewVersion), 100);
  }
  function previewCamera(card: ChartSpec): EditorCamera | undefined {
    if (card.kind === "image") {
      const image = images?.camera?.() ?? pendingImageCamera;
      return image ? { image } : undefined;
    }
    // Only a zoomed preview is handed back; an un-zoomed one lets the card fit
    // its own (possibly differently sized) data.
    const view = plot?.zoomed() ? plot.viewport() : null;
    if (view)
      return {
        scalar: {
          view,
          axis: cameraAxis(card),
          xScale: card.config.xScale,
          yScale: card.config.yScale,
        },
      };
    return pendingScalarView ? { scalar: pendingScalarView } : undefined;
  }
  function hasPreviousScalarPreview() {
    return (
      !!plot && draft.kind !== "image" && renderedScalarKind === draft.kind
    );
  }
  function clearPreview() {
    plot?.destroy();
    plot = undefined;
    previewInteractive = false;
    renderedScalarKind = undefined;
    images?.destroy();
    images = undefined;
    imageToken = "";
    previewHost.replaceChildren();
    previewTitle.textContent = draft.title || "Untitled chart";
    delete previewHost.dataset.observationCount;
  }
  async function updatePreview(version: number) {
    if (closed || version !== previewVersion) return;
    retry.hidden = true;
    if (!draft.records) recordPreviewNotes = "";
    if (!hasPreviousScalarPreview())
      previewTitle.textContent = draft.title || "Untitled chart";
    const sources = resolveSources(
      draft,
      options.selectedRunIds,
      options.catalog,
    );
    const token = JSON.stringify([
      draft.kind,
      draft.records,
      sources.map((source) => [source.id, source.x ? seriesId(source.x.ref) : null]),
    ]);
    if (token !== sourceToken) {
      loadAbort?.abort();
      loadAbort = undefined;
      pendingLoad = undefined;
      sourceToken = token;
      if (!hasPreviousScalarPreview()) clearPreview();
    }
    const unavailable = editorSourceChoices(
      draft,
      options.catalog,
      options.selectedRunIds,
    ).filter((choice) => choice.selected && !choice.available).length;
    previewWarnings.textContent = unavailable
      ? `${unavailable} chosen source(s) unavailable. References are kept.`
      : "";
    if (!sources.length && !draft.records) {
      clearPreview();
      previewStatus.textContent = "Choose a source in Data to see a preview.";
      return;
    }
    if (errors.size) {
      const previous = hasPreviousScalarPreview();
      if (!previous) clearPreview();
      previewStatus.textContent = previous
        ? "Previous preview · fix highlighted fields"
        : "Correct the highlighted fields to update the preview.";
      return;
    }
    let valid: ChartSpec;
    try {
      valid = validateChart(clone(draft));
    } catch (error) {
      const previous = hasPreviousScalarPreview();
      if (!previous) clearPreview();
      previewStatus.textContent = previous
        ? `Previous preview · fix highlighted fields: ${textError(error)}`
        : `Preview paused: ${textError(error)}`;
      return;
    }
    try {
      if (draft.kind === "image") {
        if (!options.api) {
          previewStatus.textContent = `${sources.length} image source(s) chosen. Preview is available when connected.`;
          return;
        }
        if (imageToken === token && images) return;
        previewStatus.textContent = "Loading image preview…";
        const { ImagePanel } = await import("./images");
        if (closed || version !== previewVersion) return;
        // Changing image sources keeps the region being inspected.
        const carriedCamera = images?.camera() ?? pendingImageCamera;
        pendingImageCamera = undefined;
        clearPreview();
        // Legacy ImagePanel metadata is filtered, so preview never includes unchosen keys.
        const api = Object.create(options.api) as Api;
        api.json = async <T>(
          path: string,
          signal?: AbortSignal,
        ): Promise<T> => {
          const value = await options.api!.json<T>(path, signal);
          if (!/\/images(?:\?|$)/.test(path)) return value;
          const response = value as { images?: ImageFrame[] };
          return {
            ...response,
            images:
              response.images?.filter((frame) =>
                sources.some(
                  (source) =>
                    source.runId === frame.run_id && source.key === frame.key,
                ),
              ) ?? [],
          } as T;
        };
        const PreviewImages = ImagePanel as new (
          host: HTMLElement,
          api: Api,
          options?: { compact?: boolean },
        ) => ImagePanel;
        images = new PreviewImages(previewHost, api, { compact: true });
        previewHost.querySelectorAll("button").forEach((button) => {
          button.type = "button";
        });
        const modern = images as ImagePanel & {
          setSources?: (sources: ResolvedSeries[]) => void;
        };
        if (modern.setSources) modern.setSources(sources);
        else
          images.setRuns([
            ...new Map(
              sources.map((source) => [source.runId, source.run]),
            ).values(),
          ]);
        // Legacy panels used a global canvas ID; scope it inside this editor too.
        previewHost.querySelectorAll("[id]").forEach((node) => {
          node.id = `${prefix}-preview-${node.id}`;
        });
        images.setCamera?.(carriedCamera);
        images.setActive(true);
        imageToken = token;
        previewStatus.textContent = `${sources.length} image source(s) · preview only`;
        return;
      }
      if (!options.store && !draft.records || draft.records && !options.api) {
        previewStatus.textContent = `${sources.length} curve(s) chosen. Preview is available when connected.`;
        return;
      }
      if (!pendingLoad) {
        loadAbort = new AbortController();
        const signal = loadAbort.signal;
        pendingLoad = draft.records
          ? loadRecordPlot(options.api!, clone(draft.records), options.catalog, options.selectedRunIds, signal).then(result => { if (!signal.aborted) { recordPreviewNotes = result.notes; recordPreviewSources = result.sources; } return result.data; })
          : loadPlotRuns(sources, options.store!, signal);
      }
      previewStatus.textContent = hasPreviousScalarPreview()
        ? "Previous preview · updating sources…"
        : "Loading complete histories…";
      const [data, module] = await Promise.all([pendingLoad, import("./plot")]);
      if (closed || version !== previewVersion) return;
      const stylesKey = JSON.stringify(recordPreviewSources.map(ref => ref.id));
      if (valid.records && stylesKey !== renderedRecordStyles) { renderedRecordStyles = stylesKey; renderAppearance(); }
      const config = withRunColors(
        clone(valid.config),
        valid.records ? recordPreviewSources : sources,
        options.catalog,
      );
      config.xLabel = editorAxisTitle(valid, "x");
      config.yLabel = editorAxisTitle(valid, "y");
      // Preview fits its pane; saved dimensions remain untouched.
      config.width = null;
      config.height = Math.min(
        config.height,
        window.matchMedia("(max-width: 760px)").matches ? 240 : 440,
      );
      const analyzed = module.analyze(data, config);
      let robustRangeApplied = false;
      if (valid.outliers === "robust") {
        const [lo, hi] = explicitRangeBounds(effectiveRange(config, "y"));
        if (
          lo === null &&
          hi === null &&
          Array.isArray(effectiveRange(config, "y"))
        ) {
          const values = analyzed
            .flatMap((series, index) =>
              styleFor(config, series.run.id, index).visible &&
              styleFor(config, series.run.id, index).auto !== false
                ? series.points.map((point) => point[1])
                : [],
            )
            .filter(
              (value) =>
                Number.isFinite(value) &&
                (config.yScale !== "log" || value > 0),
            )
            .sort((a, b) => a - b);
          const percentile = (p: number) => {
            const i = (values.length - 1) * p;
            return (
              values[Math.floor(i)] * (1 - (i % 1)) +
              values[Math.ceil(i)] * (i % 1)
            );
          };
          if (values.length && percentile(0.01) < percentile(0.99)) {
            setEditorBounds(config, "y", percentile(0.01), percentile(0.99));
            robustRangeApplied = true;
          }
        }
      }
      plot ??= new module.PlotPanel(
        previewHost,
        () => {},
        (warnings) => {
          if (!closed)
            previewWarnings.textContent = [
              renderedUnavailable
                ? `${renderedUnavailable} source(s) unavailable.`
                : "",
              recordPreviewNotes,
              ...warnings,
            ]
              .filter(Boolean)
              .join(" ");
        },
      );
      renderedUnavailable = unavailable;
      // The preview navigates like a dashboard card (drag-zoom, right/Space
      // pan, Ctrl+wheel), so it can show and keep the card's camera.
      if (!previewInteractive) {
        configurePreviewNavigation();
        previewInteractive = true;
      }
      const initial =
        pendingScalarView &&
        pendingScalarView.axis === cameraAxis(valid) &&
        pendingScalarView.xScale === config.xScale &&
        pendingScalarView.yScale === config.yScale
          ? pendingScalarView.view
          : null;
      plot.render(
        analyzed,
        config,
        { a: null, b: null, threshold: null },
        { preserveView: true, initialView: initial },
      );
      pendingScalarView = undefined;
      renderedScalarKind = valid.kind;
      previewTitle.textContent = valid.title || "Untitled chart";
      const count = data.reduce((sum, series) => sum + (series.paired?.points.length ?? series.raw.length), 0);
      previewStatus.textContent = `${data.length} curve(s) · ${count.toLocaleString()} observations${robustRangeApplied ? " · Central 98% display" : ""}`;
      previewHost.dataset.observationCount = String(count);
    } catch (error) {
      if (closed || version !== previewVersion) return;
      const previous = hasPreviousScalarPreview();
      if (!previous) clearPreview();
      pendingLoad = undefined;
      previewStatus.textContent = previous
        ? `Previous preview · update unavailable: ${textError(error)}`
        : `Preview unavailable: ${textError(error)}`;
      retry.hidden = false;
    }
  }

  form.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement &&
      event.target.type === "search"
    )
      event.preventDefault();
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (saving || closed) return;
    const sourceCount = draft.records ? draft.records.ys.length :
      draft.source.mode === "selected"
        ? draft.source.keys.length
        : draft.source.series.length;
    setError(
      "source",
      sourceCount
        ? ""
        : `Choose at least one ${draft.kind === "image" ? "image source" : "metric"}.`,
    );
    if (!draft.title.trim()) setError("title", "Give this chart a title.");
    else setError("title", "");
    if (errors.size) {
      const first = fields.get(errors.keys().next().value!);
      if (first) {
        let parent = first.control.parentElement;
        while (parent && parent !== dialog) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
          parent = parent.parentElement;
        }
        first.control.focus();
      }
      saveError.textContent = "Check the highlighted fields.";
      return;
    }
    let result: ChartSpec;
    try {
      result = validateChart(clone(draft));
    } catch (error) {
      saveError.textContent = textError(error);
      return;
    }
    saving = true;
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      await options.onSave(result, previewCamera(result));
      close();
    } catch (error) {
      if (!closed)
        saveError.textContent = `Could not save: ${textError(error)}. Your changes are still here.`;
    } finally {
      saving = false;
      save.disabled = false;
      save.textContent = options.isNew ? "Add chart" : "Save changes";
    }
  };
  function close() {
    if (closed) return;
    closed = true;
    recordControls?.destroy();
    ++previewVersion;
    clearTimeout(previewTimer);
    loadAbort?.abort();
    window.removeEventListener("nset:run-colors-changed", schedulePreview);
    window.removeEventListener("resize", schedulePreview);
    clearPreview();
    dialog.close();
    dialog.remove();
    if (originalFocus?.isConnected)
      originalFocus.focus({ preventScroll: true });
    options.onClose?.();
  }
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", close);
  renderAll();
  window.addEventListener("nset:run-colors-changed", schedulePreview);
  window.addEventListener("resize", schedulePreview);
  document.body.append(dialog);
  dialog.showModal();
  fields.get("title")?.control.focus();
  schedulePreview();
  return { close };
}
