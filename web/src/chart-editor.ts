import type { Api, ImageFrame } from "./api";
import { plotType, setPlotType, type PlotType } from "./plot-types";
import { withRunColors } from "./series-colors";
import {
  applyDashboardControls,
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
} from "./workspace-types";
import { resolveSources, seriesId, validateChart } from "./workspace";
import type { PlotPanel, PlotRun } from "./plot";
import type { ImagePanel } from "./images";

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
  if (axis === "x")
    return card.config.axis === "relative"
      ? "Elapsed time"
      : card.config.axis === "timestamp"
        ? "Time"
        : "Step";
  const keys = [
    ...new Set(
      card.source.mode === "selected"
        ? card.source.keys
        : card.source.series
            .filter((source) => source.kind === "metric")
            .map((source) => source.key),
    ),
  ];
  return keys.length === 1
    ? keys[0]
    : keys.length > 1
      ? "Metric value (mixed metrics)"
      : "Metric value";
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

export interface ChartEditorOptions {
  card: ChartSpec;
  catalog: Catalog;
  selectedRunIds: string[];
  onSave: (card: ChartSpec) => void | Promise<void>;
  /** Called once after removal and fallback focus restoration; hosts may focus rebuilt controls. */
  onClose?: () => void;
  api?: Api;
  store?: MetricLoader;
  /** Optional host copy for new cards; existing callers need only the contract fields. */
  isNew?: boolean;
}
let editorSequence = 0;
export function openChartEditor(options: ChartEditorOptions): {
  close: () => void;
} {
  // Keep pure helpers importable by Node tests without a CSS loader or browser globals.
  void import("./chart-editor.css");
  const draft = clone(options.card);
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
  let images: ImagePanel | undefined;
  let imageToken = "";
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
  const panels = new Map<string, HTMLElement>();
  const advancedOpen = new Map<string, boolean>();
  for (const name of ["Data", "Axes", "Appearance"]) {
    const panel = el("section", "ce-panel");
    panel.id = `${prefix}-panel-${name}`;
    panel.setAttribute("aria-labelledby", `${panel.id}-heading`);
    panels.set(name, panel);
  }
  settings.append(...panels.values());
  const preview = el("aside", "ce-preview");
  preview.setAttribute("aria-label", "Chart preview");
  const previewTitle = el("h3", "", draft.title || "Untitled chart");
  const previewStatus = el("p", "ce-muted");
  previewStatus.setAttribute("role", "status");
  const previewHost = el("div", "ce-preview-plot");
  previewHost.dataset.role = "preview";
  const previewWarnings = el("p", "ce-help");
  const previewDetails = el("details", "ce-more");
  previewDetails.append(el("summary", "", "Preview details"), previewWarnings);
  const retry = button("Retry preview", () => {
    sourceToken = "";
    schedulePreview();
  });
  retry.hidden = true;
  preview.append(
    el("div", "ce-eyebrow", "LIVE PREVIEW"),
    previewTitle,
    previewStatus,
    previewHost,
    retry,
    previewDetails,
    el("p", "ce-muted ce-preview-note", "Changes stay here until you save."),
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
    const heading = el("h3", "", name);
    heading.id = `${panel.id}-heading`;
    panel.replaceChildren(heading);
    return panel;
  }

  let pickerPage = 0;
  let pickerSearch = "";
  let selectedOnly = false;
  let renderChoices = () => {};
  function renderData() {
    const panel = clearPanel("Data");
    input(panel, "title", "Chart title", draft.title, (value) => {
      draft.title = value;
      setError("title", value.trim() ? "" : "Give this chart a title.");
      removeOverride(draft.config, ["title"]);
      previewTitle.textContent = value || "Untitled chart";
    });
    select(
      panel,
      "kind",
      "Plot type",
      plotType(draft),
      [
        ["line", "Line plot"],
        ["scatter", "Scatter plot"],
        ["area", "Area plot"],
        ["step", "Step plot"],
        ["image", "Image panel"],
      ],
      (value) => {
        sourceMemory.set(
          `${draft.kind}/${draft.source.mode}`,
          clone(draft.source),
        );
        setPlotType(draft, value as PlotType);
        draft.source = clone(
          sourceMemory.get(`${draft.kind}/${draft.source.mode}`) ??
            (draft.source.mode === "selected"
              ? { mode: "selected", keys: [] }
              : { mode: "explicit", series: [] }),
        );
        pickerPage = 0;
        pickerSearch = "";
        renderData();
        renderAxes();
        renderAppearance();
        fields.get("kind")?.control.focus({ preventScroll: true });
      },
    );
    select(
      panel,
      "source-mode",
      "Data sources",
      draft.source.mode,
      [
        ["selected", `Follow selected runs (${options.selectedRunIds.length})`],
        [
          "explicit",
          draft.kind === "image"
            ? "Choose any run and image"
            : "Choose any run and metric",
        ],
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
        pickerPage = 0;
        pickerSearch = "";
        renderData();
        refreshAxisTitles();
        renderAppearance();
        fields.get("source-mode")?.control.focus({ preventScroll: true });
      },
      draft.source.mode === "selected"
        ? "These keys follow the run selection in your saved view."
        : "Pick exact sources across all experiments.",
    );
    const summary = el("p", "ce-selection-summary");
    panel.append(summary);
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
        ? "Experiment, run, or metric…"
        : "Metric name…";
    toggle(
      panel,
      "selected-only",
      "Show chosen sources only",
      selectedOnly,
      (value) => {
        selectedOnly = value;
        pickerPage = 0;
        renderChoices();
      },
    );
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
    renderChoices = () => {
      const choices = editorSourceChoices(
        draft,
        options.catalog,
        options.selectedRunIds,
      );
      const selected = choices.filter((choice) => choice.selected);
      const unavailable = selected.filter((choice) => !choice.available).length;
      summary.textContent = `${selected.length} chosen${unavailable ? ` · ${unavailable} unavailable (kept)` : ""}`;
      const result = choicePage(
        choices,
        pickerSearch,
        pickerPage,
        selectedOnly,
      );
      pickerPage = result.page;
      list.replaceChildren();
      if (!result.rows.length)
        list.append(
          el(
            "p",
            "ce-empty",
            selectedOnly
              ? "No chosen sources match. Turn off this filter to add sources."
              : "No matches. Try another search or choose runs first.",
          ),
        );
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
          if (draft.source.mode === "selected")
            draft.source.keys = checkbox.checked
              ? [...new Set([...draft.source.keys, choice.key])]
              : draft.source.keys.filter((key) => key !== choice.key);
          else if (choice.ref)
            draft.source.series = checkbox.checked
              ? [
                  ...draft.source.series.filter(
                    (ref) => seriesId(ref) !== choice.id,
                  ),
                  clone(choice.ref),
                ]
              : draft.source.series.filter(
                  (ref) => seriesId(ref) !== choice.id,
                );
          setError("source", "");
          const scrollTop = list.scrollTop;
          renderChoices();
          list.scrollTop = scrollTop;
          refreshAxisTitles();
          renderAppearance();
          change();
          (
            list.querySelector<HTMLInputElement>(
              `input[data-source-id="${CSS.escape(choice.id)}"]`,
            ) ?? list
          ).focus({ preventScroll: true });
        };
      }
      previous.disabled = pickerPage === 0;
      next.disabled = pickerPage >= result.pages - 1;
      pageInfo.textContent = `${result.total} results · ${pickerPage + 1} / ${result.pages}`;
      setError("source", errors.get("source") ?? "");
    };
    renderChoices();
  }

  function renderAxes() {
    const panel = clearPanel("Axes");
    panel.hidden = draft.kind === "image";
    if (draft.kind === "image") return;
    const advanced = more(panel, "Advanced axes");
    advanced.open = advancedOpen.get("Axes") ?? false;
    select(
      panel,
      "axis",
      "X values",
      draft.config.axis,
      [
        ["step", "Step"],
        ["timestamp", "Wall time"],
        ["relative", "Relative time (run start)"],
      ],
      (value) => {
        draft.config = applyDashboardControls(draft.config, {
          axis: value as ViewConfig["axis"],
        });
        renderAxes();
        fields.get("axis")?.control.focus({ preventScroll: true });
      },
      "Relative time starts at each run’s creation time.",
    );
    for (const axis of ["x", "y"] as const) {
      const name = axis.toUpperCase();
      const group = el("fieldset", "ce-group");
      group.append(el("legend", "", `${name} axis`));
      panel.append(group);
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
        "Blank = automatic",
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
        "Blank = automatic",
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
      }
      const labels = el("fieldset", "ce-group");
      labels.append(el("legend", "", `${name} axis details`));
      advanced.append(labels);
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
        "Used only for logarithmic axes.",
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
        "Used only for asinh axes; larger values widen the linear region.",
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
      panel,
      "outliers",
      "Y auto range",
      draft.outliers,
      [
        ["all", "All values"],
        ["robust", "Central 98%"],
      ],
      (value) => {
        draft.outliers = value as ChartSpec["outliers"];
      },
      "Display only: Central 98% fits the 1st–99th percentiles. No observations are removed. Set limits take precedence.",
    );
    panel.append(advanced);
    refreshAxisTitles();
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
        savedEmpty
          ? "Saved empty title is kept. Type a title to replace it."
          : `Automatic: ${title}. Leave blank to follow the data.`;
    }
  }

  function renderAppearance() {
    const panel = clearPanel("Appearance");
    if (draft.kind === "image") {
      panel.append(
        el(
          "p",
          "ce-help",
          "Image zoom and frame navigation are available in the preview and on the card.",
        ),
      );
      return;
    }
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
    strength.setAttribute("aria-valuetext", strengthHint());
    strength.oninput = () => {
      Object.assign(draft.config, strengthToSmoothing(Number(strength.value)));
      strength.setAttribute("aria-valuetext", strengthHint());
      change();
    };
    select(
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
      },
      "Used for the matching curve and numerical readouts. Step and spline styles are display-only.",
    );
    const legend = record(draft.config.advanced.legend).show;
    toggle(
      panel,
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
      panel,
      "grid",
      "Show grid",
      grids.every(Boolean),
      (value) => setEditorToggle(draft.config, "grid", value),
      grids[0] !== grids[1]
        ? "Mixed saved settings. Changing this sets both axes."
        : "",
    );
    grid.indeterminate = grids[0] !== grids[1];
    const styleDetails = el("fieldset", "ce-group ce-default-style");
    styleDetails.append(el("legend", "", "Default curve style"));
    panel.append(styleDetails);
    const extra = more(panel, "Advanced appearance");
    extra.open = advancedOpen.get("Appearance") ?? false;
    const strokeDetails = el("fieldset", "ce-group");
    strokeDetails.append(el("legend", "", "Default line & marker details"));
    extra.append(strokeDetails);
    styleDetails.append(
      el("p", "ce-help", "Applies unless a curve has its own style below."),
    );
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
      draft.config.style,
      "default",
      draft.config.style,
      draft.config.palette,
      () => {},
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
      const resolved = resolveSources(
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
          el("p", "ce-help", "Choose available sources in Data first."),
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
      "Leave blank to fit the card.",
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
    commit = () => {},
    extra: HTMLElement = parent,
  ) {
    const shapeFor = (style: RunStyle) =>
      style.width === 0 && (style.markers?.show ?? style.points)
        ? "points"
        : style.fill > 0
          ? "area"
          : style.path.startsWith("stepped-") && style.pathOptions?.align
            ? style.pathOptions.align === -1
              ? "stepped-before"
              : "stepped-after"
            : style.path;
    const changed = () => {
      effective = deepMerge(effective, patch);
      commit();
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
        points: String(effective.markers?.show ?? effective.points),
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
      change();
    };
    const shape = shapeFor(effective);
    select(
      parent,
      `${key}:shape`,
      "Curve style",
      shape,
      [
        ["matched", "Line (matches interpolation)"],
        ["linear", "Straight line"],
        ["stepped-after", "Step after"],
        ["stepped-before", "Step before"],
        ["spline", "Spline (display only)"],
        ["points", "Points only"],
        ["area", "Area"],
      ],
      (value) => {
        patch.path =
          value === "area" || value === "points"
            ? "matched"
            : (value as RunStyle["path"]);
        patch.width = value === "points" ? 0 : effective.width || 2;
        patch.fill = value === "area" ? effective.fill || 0.15 : 0;
        if (value === "points") {
          patch.points = true;
          patch.markers = { ...effective.markers, show: true };
        }
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
      palette
        ? "Turn off shared run colors above to choose one default color."
        : "Hex, named, rgb, or hsl color.",
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
    const points = effective.markers?.show ?? effective.points;
    select(
      parent,
      `${key}:points`,
      "Observation points",
      String(points),
      [
        ["false", "Hidden"],
        ["true", "Shown"],
        ["auto", "Automatic spacing"],
      ],
      (value) => {
        patch.points = value !== "false";
        patch.markers = {
          ...effective.markers,
          ...patch.markers,
          show: value === "auto" ? "auto" : value === "true",
        };
        changed();
      },
    );
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
  function clearPreview() {
    plot?.destroy();
    plot = undefined;
    images?.destroy();
    images = undefined;
    imageToken = "";
    previewHost.replaceChildren();
    delete previewHost.dataset.observationCount;
  }
  async function updatePreview(version: number) {
    if (closed || version !== previewVersion) return;
    retry.hidden = true;
    previewTitle.textContent = draft.title || "Untitled chart";
    const sources = resolveSources(
      draft,
      options.selectedRunIds,
      options.catalog,
    );
    const token = JSON.stringify([
      draft.kind,
      sources.map((source) => source.id),
    ]);
    if (token !== sourceToken) {
      loadAbort?.abort();
      loadAbort = undefined;
      pendingLoad = undefined;
      sourceToken = token;
      clearPreview();
    }
    const unavailable = editorSourceChoices(
      draft,
      options.catalog,
      options.selectedRunIds,
    ).filter((choice) => choice.selected && !choice.available).length;
    previewWarnings.textContent = unavailable
      ? `${unavailable} chosen source(s) unavailable. References are kept.`
      : "";
    if (!sources.length) {
      clearPreview();
      previewStatus.textContent = "Choose a source in Data to see a preview.";
      return;
    }
    if (errors.size) {
      clearPreview();
      previewStatus.textContent =
        "Correct the highlighted fields to update the preview.";
      return;
    }
    let valid: ChartSpec;
    try {
      valid = validateChart(clone(draft));
    } catch (error) {
      clearPreview();
      previewStatus.textContent = `Preview paused: ${textError(error)}`;
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
        images.setActive(true);
        imageToken = token;
        previewStatus.textContent = `${sources.length} image source(s) · preview only`;
        return;
      }
      if (!options.store) {
        previewStatus.textContent = `${sources.length} curve(s) chosen. Preview is available when connected.`;
        return;
      }
      if (!pendingLoad) {
        loadAbort = new AbortController();
        const signal = loadAbort.signal;
        pendingLoad = Promise.all(
          sources.map(async (source) => ({
            run: { ...source.run, id: source.id, name: source.label },
            raw: await options.store!.load(source, signal),
          })),
        );
      }
      previewStatus.textContent = "Loading complete histories…";
      const [data, module] = await Promise.all([pendingLoad, import("./plot")]);
      if (closed || version !== previewVersion) return;
      const config = withRunColors(
        clone(valid.config),
        sources,
        options.catalog,
      );
      config.xLabel = editorAxisTitle(valid, "x");
      config.yLabel = editorAxisTitle(valid, "y");
      // Preview fits its pane; saved dimensions remain untouched.
      config.width = null;
      config.height = Math.min(
        config.height,
        window.matchMedia("(max-width: 760px)").matches ? 180 : 440,
      );
      const analyzed = module.analyze(data, config);
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
          if (values.length && percentile(0.01) < percentile(0.99))
            setEditorBounds(config, "y", percentile(0.01), percentile(0.99));
        }
      }
      plot ??= new module.PlotPanel(
        previewHost,
        () => {},
        (warnings) => {
          if (!closed)
            previewWarnings.textContent = [
              unavailable ? `${unavailable} source(s) unavailable.` : "",
              ...warnings,
            ]
              .filter(Boolean)
              .join(" ");
        },
      );
      plot.render(analyzed, config, { a: null, b: null, threshold: null });
      const count = data.reduce((sum, series) => sum + series.raw.length, 0);
      previewStatus.textContent = `${sources.length} curve(s) · ${count.toLocaleString()} observations${valid.outliers === "robust" ? " · Central 98% display" : ""}`;
      previewHost.dataset.observationCount = String(count);
    } catch (error) {
      if (closed || version !== previewVersion) return;
      clearPreview();
      pendingLoad = undefined;
      previewStatus.textContent = `Preview unavailable: ${textError(error)}`;
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
    const sourceCount =
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
      await options.onSave(result);
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
  renderData();
  renderAxes();
  renderAppearance();
  window.addEventListener("nset:run-colors-changed", schedulePreview);
  window.addEventListener("resize", schedulePreview);
  document.body.append(dialog);
  dialog.showModal();
  fields.get("title")?.control.focus();
  schedulePreview();
  return { close };
}
