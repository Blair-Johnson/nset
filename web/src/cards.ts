import { analyze, PlotPanel, type Analyzed, type Pins } from "./plot";
import { ImagePanel } from "./images";
import { formatValue, styleFor, type ViewConfig } from "./config";
import { resolveSources } from "./workspace";
import { withRunColors } from "./series-colors";
import { withMetricLabel } from "./card-label";
import { element, isAbort, message } from "./utils";
import type {
  CardActions,
  CardContext,
  ChartSpec,
  InteractionMode,
  CardLayout,
  ResolvedSeries,
} from "./workspace-types";
import "./cards.css";

/** A display-only range: the analyzed observations/interpolators are never reduced. */
export function robustConfig(data: Analyzed[], config: ViewConfig): ViewConfig {
  const advancedY = (
    config.advanced.scales as { y?: { range?: unknown } } | undefined
  )?.y;
  if (
    config.yMin !== null ||
    config.yMax !== null ||
    advancedY?.range !== undefined
  )
    return config;
  const values = data
    .flatMap((series) => series.points.map((point) => point[1]))
    .filter(
      (value) =>
        Number.isFinite(value) && (config.yScale !== "log" || value > 0),
    )
    .sort((a, b) => a - b);
  if (values.length < 2) return config;
  const percentile = (p: number) => {
    const index = (values.length - 1) * p;
    const lower = Math.floor(index);
    return (
      values[lower] +
      (values[Math.ceil(index)] - values[lower]) * (index - lower)
    );
  };
  const yMin = percentile(0.01),
    yMax = percentile(0.99);
  return yMin < yMax ? { ...config, yMin, yMax } : config;
}

function button(
  text: string,
  label: string,
  action: () => void,
): HTMLButtonElement {
  const result = element("button", "card-button", text);
  result.type = "button";
  result.title = label;
  result.setAttribute("aria-label", label);
  result.onclick = action;
  return result;
}

export class ChartCard {
  private root = element("article", "chart-card");
  private title = element("h3", "card-title");
  private content = element("div", "card-content");
  private status = element("div", "card-status");
  private notice = element("div", "card-notice");
  private inspection = element("div", "card-inspection");
  private results = element("div", "card-results");
  private hover = element("div", "card-hover");
  private legend = element("div", "card-legend");
  private clipping = element("div", "card-clipping");
  private plot?: PlotPanel;
  private images?: ImagePanel;
  private observer?: IntersectionObserver;
  private abort?: AbortController;
  private generation = 0;
  private destroyed = false;
  private active = true;
  private visible = typeof IntersectionObserver === "undefined";
  private loaded = false;
  private data: Analyzed[] = [];
  private mode: InteractionMode = "zoom";
  private cursorAxis: "x" | "y" = "x";
  private inspectOpen = false;
  private sources: ResolvedSeries[] = [];
  private legendDetails = element("details", "card-legend-details");
  private cursorButtons = new Map<"x" | "y", HTMLButtonElement>();
  private resizeHandle?: HTMLButtonElement;
  private resizeGesture?: {
    pointer: number;
    x: number;
    y: number;
    start: CardLayout;
    next: CardLayout;
  };
  private activePin: "a" | "b" = "a";
  private pins: Pins = { a: null, b: null, threshold: null };
  private inputs = new Map<keyof Pins, HTMLInputElement>();
  private backButton?: HTMLButtonElement;
  private full = false;
  private maximize: HTMLButtonElement;
  private menu = element("details", "card-menu");
  private lifetime = new AbortController();

  constructor(
    private host: HTMLElement,
    private spec: ChartSpec,
    private context: CardContext,
    private actions: CardActions,
  ) {
    const header = element("header", "card-header");
    this.maximize = button("⛶", "Maximize chart", () =>
      this.setMaximized(!this.full),
    );
    header.append(this.title, this.maximize, this.menu);
    this.status.setAttribute("role", "status");
    this.root.append(header, this.notice, this.content, this.status);
    this.host.append(this.root);
    this.root.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          this.menu.open = false;
          this.cancelResize();
          if (this.full) this.setMaximized(false);
        }
      },
      { signal: this.lifetime.signal },
    );
    this.build();
    this.installResize();
    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver(
        (entries) => {
          const entry = entries.find((item) => item.target === this.host);
          if (!entry || this.destroyed) return;
          this.visible = entry.isIntersecting;
          this.updateActive();
        },
        { rootMargin: "300px" },
      );
      this.observer.observe(this.host);
    }
    this.updateActive();
  }

  private displayConfig(): ViewConfig {
    return withMetricLabel(
      withRunColors(this.spec.config, this.sources, this.context.catalog),
      this.spec.source,
    );
  }

  /** Derived colors only: keep observations, interpolators, pins and navigation alive. */
  refreshColors(): void {
    if (this.destroyed || !this.plot) return;
    this.plot.refreshColors(this.displayConfig());
    this.renderLegend();
  }

  private applyDimensions(layout = this.spec.layout) {
    const width = layout
      ? `${layout.width}px`
      : this.spec.size === "wide"
        ? "100%"
        : "calc(50% - 6px)";
    this.root.style.setProperty("--card-width", width);
    this.host.style.setProperty("--card-width", width);
    this.root.style.height = `${layout?.height ?? (this.spec.kind === "image" ? 410 : this.spec.config.height + 112)}px`;
  }

  private commitDimensions(layout: CardLayout) {
    try {
      if (this.actions.onDimensions?.(this.spec.id, layout) === false) {
        this.applyDimensions();
        return;
      }
      this.spec = { ...this.spec, layout };
      this.applyDimensions();
    } catch {
      this.applyDimensions();
    }
  }

  private cancelResize() {
    const gesture = this.resizeGesture;
    if (!gesture) return;
    this.resizeGesture = undefined;
    if (this.resizeHandle?.hasPointerCapture(gesture.pointer))
      this.resizeHandle.releasePointerCapture(gesture.pointer);
    this.applyDimensions();
  }

  private installResize() {
    if (!this.actions.onDimensions) return;
    const handle = (this.resizeHandle = button("◢", "Resize chart", () => {}));
    handle.classList.add("card-resize-handle");
    handle.title =
      "Drag to resize; arrow keys adjust width and height (Shift: larger steps)";
    const bounded = (width: number, height: number): CardLayout => ({
      width: Math.round(Math.min(4096, Math.max(300, width))),
      height: Math.round(Math.min(2160, Math.max(240, height))),
    });
    handle.onpointerdown = (event) => {
      if (event.button !== 0 || this.full) return;
      event.preventDefault();
      const rect = this.root.getBoundingClientRect();
      const start = { width: rect.width, height: rect.height };
      this.resizeGesture = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        start,
        next: start,
      };
      handle.setPointerCapture(event.pointerId);
      handle.focus();
    };
    handle.onpointermove = (event) => {
      const g = this.resizeGesture;
      if (!g || g.pointer !== event.pointerId) return;
      g.next = bounded(
        g.start.width + event.clientX - g.x,
        g.start.height + event.clientY - g.y,
      );
      this.applyDimensions(g.next);
    };
    handle.onpointerup = (event) => {
      const g = this.resizeGesture;
      if (!g || g.pointer !== event.pointerId) return;
      this.resizeGesture = undefined;
      handle.releasePointerCapture(event.pointerId);
      this.commitDimensions(g.next);
    };
    handle.onpointercancel = () => this.cancelResize();
    handle.onlostpointercapture = () => this.cancelResize();
    handle.onkeydown = (event) => {
      if (!event.key.startsWith("Arrow") || this.full || this.resizeGesture)
        return;
      event.preventDefault();
      const rect = this.root.getBoundingClientRect();
      const current = this.spec.layout ?? {
        width: rect.width,
        height: rect.height,
      };
      const step = event.shiftKey ? 50 : 10;
      const dx =
        event.key === "ArrowRight"
          ? step
          : event.key === "ArrowLeft"
            ? -step
            : 0;
      const dy =
        event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0;
      this.commitDimensions(bounded(current.width + dx, current.height + dy));
    };
    this.root.append(handle);
  }

  private setMaximized(value: boolean) {
    this.cancelResize();
    this.full = value;
    this.root.classList.toggle("card-maximized", value);
    this.maximize.setAttribute(
      "aria-label",
      value ? "Restore chart" : "Maximize chart",
    );
    this.maximize.title = value ? "Restore chart" : "Maximize chart";
    this.maximize.setAttribute("aria-pressed", String(value));
    this.updateActive();
    this.maximize.focus();
  }

  private build() {
    this.root.dataset.role = "chart-card";
    this.host.dataset.cardId = this.spec.id;
    this.host.dataset.cardKind = this.spec.kind;
    this.root.classList.toggle("card-wide", this.spec.size === "wide");
    this.applyDimensions();
    this.title.textContent = this.spec.title;
    this.menu.replaceChildren();
    const summary = element("summary", "card-menu-toggle", "⋯");
    summary.title = "Chart actions";
    summary.setAttribute("aria-label", "Chart actions");
    const items = element("div", "card-menu-items");
    const item = (label: string, action: () => void) =>
      items.append(
        button(label, label, () => {
          this.menu.open = false;
          action();
        }),
      );
    item("Edit chart", () => this.actions.onEdit(this.spec.id));
    item("Duplicate", () => this.actions.onDuplicate(this.spec.id));
    item("Move up", () => this.actions.onMove(this.spec.id, -1));
    item("Move down", () => this.actions.onMove(this.spec.id, 1));
    item("Remove", () => this.actions.onRemove(this.spec.id));
    this.menu.append(summary, items);
    this.content.replaceChildren();
    this.inputs.clear();
    this.cursorButtons.clear();
    if (this.spec.kind === "image") {
      this.images = new ImagePanel(this.content, this.context.api, {
        compact: true,
      });
      return;
    }
    const toolbar = element("div", "card-chart-toolbar");
    this.backButton = button("↶", "Previous view", () => this.plot?.back());
    toolbar.append(
      button("−", "Zoom out", () => this.plot?.zoom(1 / 1.5, "both")),
      button("+", "Zoom in", () => this.plot?.zoom(1.5, "both")),
      button("⛶", "Fit configured range", () => this.plot?.reset()),
      this.backButton,
    );
    for (const [axis, icon, label] of [
      ["x", "┆", "Add vertical cursor"],
      ["y", "╌", "Add horizontal cursor"],
    ] as const) {
      const control = button(icon, label, () => {
        this.cursorAxis = axis;
        this.activePin =
          (axis === "x" ? this.pins.a : this.pins.yA) == null ? "a" : "b";
        this.mode = "inspect";
        this.inspectOpen = true;
        this.configure();
      });
      this.cursorButtons.set(axis, control);
      toolbar.append(control);
    }
    const plotHost = element("div", "card-plot");
    plotHost.dataset.role = "plot";
    this.inspection = element("div", "card-inspection");
    this.results = element("div", "card-results");
    this.hover = element("div", "card-hover");
    this.legend = element("div", "card-legend");
    this.legend.setAttribute("role", "list");
    this.legend.setAttribute("aria-label", "Chart series");
    this.legendDetails = element("details", "card-legend-details");
    this.legendDetails.append(
      element("summary", "", "Show legend"),
      this.legend,
    );
    this.clipping = element("div", "card-clipping");
    this.content.append(
      toolbar,
      this.clipping,
      plotHost,
      this.legendDetails,
      this.hover,
      this.inspection,
    );
    this.plot = new PlotPanel(
      plotHost,
      () => {},
      (warnings) => {
        // Precision details belong in a tooltip, not a permanent diagnostics paragraph.
        plotHost.title = warnings.join("\n");
      },
      true,
    );
    this.configure();
  }

  private configure(rebuild = true) {
    if (!this.plot) return;
    const placed = (pin: keyof Pins, value: number) => {
      this.setPin(pin, value);
      if (this.mode === "inspect" || this.mode === "threshold") {
        this.mode = "zoom";
        this.configure(false);
      }
    };
    this.plot.configureInteraction({
      mode: this.mode,
      axis: "both",
      inferZoomAxes: true,
      directGestures: true,
      cursorAxis: this.cursorAxis,
      activePin: this.activePin,
      onPin: placed,
      onHorizontalPin: (pin, value) => placed(pin === "a" ? "yA" : "yB", value),
      onHover: (x) => {
        this.hover.replaceChildren();
        if (x === null) return;
        for (const series of this.data) {
          const row = element("div", "card-hover-row");
          const name = element("span", "", series.run.name);
          name.title = series.run.name;
          row.append(name, element("span", "", this.number(series.fn.at(x))));
          this.hover.append(row);
        }
      },
      onViewChange: () => {
        if (this.backButton) this.backButton.disabled = !this.plot?.canGoBack();
      },
    });
    for (const [axis, control] of this.cursorButtons)
      control.setAttribute(
        "aria-pressed",
        String(this.mode === "inspect" && axis === this.cursorAxis),
      );
    if (this.backButton) this.backButton.disabled = !this.plot.canGoBack();
    for (const control of this.inspection.querySelectorAll<HTMLButtonElement>(
      "[data-pin]",
    ))
      control.setAttribute(
        "aria-pressed",
        String(
          this.mode === "inspect" && control.dataset.pin === this.activePin,
        ),
      );
    if (!rebuild) return;
    this.inspection.replaceChildren();
    this.inputs.clear();
    this.inspection.hidden = !this.inspectOpen && this.mode !== "threshold";
    if (this.inspection.hidden) return;
    const fields = element("div", "card-pin-fields");
    const names: (keyof Pins)[] =
      this.mode === "threshold"
        ? ["threshold"]
        : this.cursorAxis === "x"
          ? ["a", "b"]
          : ["yA", "yB"];
    for (const name of names) {
      const label = element("label", "card-pin-label");
      const letter = name === "a" || name === "yA" ? "A" : "B";
      if (name !== "threshold") {
        const choice = button(
          letter,
          `Place ${this.cursorAxis === "x" ? "vertical" : "horizontal"} cursor ${letter}`,
          () => {
            this.activePin = letter === "A" ? "a" : "b";
            this.mode = "inspect";
            this.configure();
          },
        );
        choice.dataset.pin = letter.toLowerCase();
        choice.setAttribute(
          "aria-pressed",
          String(
            letter.toLowerCase() === this.activePin && this.mode === "inspect",
          ),
        );
        label.append(choice);
      } else label.append(element("span", "", "Value"));
      const input = element("input", "card-coordinate");
      input.type = "number";
      input.step = "any";
      input.setAttribute(
        "aria-label",
        name === "threshold"
          ? "Threshold value"
          : `Cursor ${letter} ${this.cursorAxis === "x" ? "coordinate" : "level"}`,
      );
      input.value = this.pins[name] == null ? "" : String(this.pins[name]);
      input.onchange = () => {
        if (input.value === "") this.setPin(name, null);
        else if (Number.isFinite(input.valueAsNumber))
          this.setPin(name, input.valueAsNumber);
        this.mode = "zoom";
        this.configure(false);
      };
      this.inputs.set(name, input);
      label.append(input);
      fields.append(label);
    }
    fields.append(
      button("×", "Clear cursors", () => {
        this.pins = { a: null, b: null, threshold: null, yA: null, yB: null };
        this.plot?.setPins(this.pins);
        this.mode = "zoom";
        this.inspectOpen = false;
        this.configure();
      }),
    );
    this.inspection.append(fields, this.results);
    this.renderResults();
  }

  private renderLegend() {
    this.legend.replaceChildren();
    const config = this.displayConfig();
    const advanced = config.advanced.legend as { show?: boolean } | undefined;
    this.legendDetails.hidden = !(advanced?.show ?? config.legend);
    if (this.legendDetails.hidden) return;
    this.data.forEach((series, index) => {
      const style = styleFor(config, series.run.id, index);
      const item = element("span", "card-legend-item");
      item.setAttribute("role", "listitem");
      const swatch = element("span", "card-legend-swatch");
      swatch.style.backgroundColor = style.color;
      const source = this.sources[index];
      const name = element(
        "span",
        "card-legend-name",
        source?.run.name ?? series.run.name,
      );
      const key = element("span", "card-legend-key", source?.key ?? "");
      name.title = name.textContent ?? "";
      key.title = key.textContent ?? "";
      item.append(swatch, name, key);
      if (!style.visible) {
        item.classList.add("card-series-hidden");
        item.title = "Hidden in chart settings";
      }
      this.legend.append(item);
    });
    if (config.smoothing)
      this.legend.append(element("span", "card-series-note", "Smoothed"));
  }

  private setPin(pin: keyof Pins, value: number | null) {
    this.pins = { ...this.pins, [pin]: value };
    const input = this.inputs.get(pin);
    if (input) input.value = value === null ? "" : String(value);
    this.plot?.setPins(this.pins);
    this.renderResults();
  }
  private number(value: number | null) {
    return value === null ? "—" : formatValue(value, this.spec.config.yFormat);
  }
  private renderResults() {
    this.results.replaceChildren();
    if (
      this.inspectOpen &&
      this.cursorAxis === "x" &&
      this.mode !== "threshold"
    ) {
      const table = element("table", "card-value-table");
      const head = element("tr");
      for (const name of ["Series", "A", "B", "Δ B − A"])
        head.append(element("th", "", name));
      table.append(head);
      for (const series of this.data) {
        const a = this.pins.a === null ? null : series.fn.at(this.pins.a);
        const b = this.pins.b === null ? null : series.fn.at(this.pins.b);
        const row = element("tr");
        row.append(element("th", "", series.run.name));
        for (const value of [a, b, a === null || b === null ? null : b - a])
          row.append(element("td", "", this.number(value)));
        table.append(row);
      }
      this.results.append(table);
    } else if (this.inspectOpen || this.mode === "threshold") {
      const levels: [string, number | null | undefined][] =
        this.mode === "threshold"
          ? [["Threshold", this.pins.threshold]]
          : [
              ["A", this.pins.yA],
              ["B", this.pins.yB],
            ];
      if (this.mode !== "threshold") {
        const a = this.pins.yA,
          b = this.pins.yB;
        this.results.append(
          element(
            "div",
            "card-delta-y",
            `A ${this.number(a ?? null)} · B ${this.number(b ?? null)} · Δ Y ${this.number(a == null || b == null ? null : b - a)}`,
          ),
        );
      }
      for (const [label, level] of levels) {
        if (level == null) continue;
        for (const series of this.data) {
          const crossings = series.fn.crossings(level);
          const details = element("details", "card-crossings");
          details.append(
            element(
              "summary",
              "",
              `${label} · ${series.run.name} · ${crossings.points.length} crossings${crossings.plateaus.length ? ` · ${crossings.plateaus.length} intervals` : ""}`,
            ),
          );
          const list = element("div");
          list.textContent =
            [
              ...crossings.points.map((x) =>
                formatValue(x, this.spec.config.xFormat),
              ),
              ...crossings.plateaus.map(
                ([a, b]) =>
                  `${formatValue(a, this.spec.config.xFormat)} – ${formatValue(b, this.spec.config.xFormat)}`,
              ),
            ].join(", ") || "No crossings";
          details.append(list);
          this.results.append(details);
        }
      }
    }
  }

  private cancel() {
    this.generation++;
    this.abort?.abort();
    this.abort = undefined;
  }
  private updateActive() {
    const active =
      this.active && (this.visible || this.full) && !this.destroyed;
    this.images?.setActive(active);
    if (!active) {
      if (this.abort) {
        this.cancel();
        this.loaded = false;
      }
      return;
    }
    if (!this.loaded) void this.load();
  }
  private async load() {
    if (this.destroyed) return;
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.abort = controller;
    this.loaded = true;
    this.data = [];
    this.legend.replaceChildren();
    this.plot?.clear();
    this.hover.textContent = "";
    this.clipping.replaceChildren();
    this.renderResults();
    const sources = (this.sources = resolveSources(
      this.spec,
      this.context.selectedRunIds,
      this.context.catalog,
    ));
    const expected =
      this.spec.source.mode === "explicit"
        ? new Set(
            this.spec.source.series.map((ref) =>
              JSON.stringify([ref.runId, ref.key, ref.kind]),
            ),
          ).size
        : 0;
    this.notice.textContent =
      expected > sources.length
        ? `${expected - sources.length} series unavailable`
        : "";
    if (this.images) {
      this.status.textContent = "";
      this.images.setSources(sources);
      this.abort = undefined;
      return;
    }
    if (!sources.length) {
      this.status.textContent =
        "No matching series. Select runs or edit this chart.";
      this.abort = undefined;
      return;
    }
    this.status.textContent = "Loading…";
    try {
      const data = await Promise.all(
        sources.map(async (source) => ({
          run: { ...source.run, id: source.id, name: source.label },
          raw: await this.context.store.load(source, controller.signal),
        })),
      );
      if (
        this.destroyed ||
        generation !== this.generation ||
        controller.signal.aborted
      )
        return;
      this.data = analyze(data, this.spec.config);
      const display = this.displayConfig();
      const config =
        this.spec.outliers === "robust"
          ? robustConfig(this.data, display)
          : display;
      this.plot?.render(this.data, config, this.pins);
      this.renderLegend();
      if (config !== display) {
        this.clipping.append(
          element("span", "", "Central 98% · display clipped"),
          button("Fit all", "Show all values in this view", () => {
            this.plot?.render(this.data, this.displayConfig(), this.pins);
            this.clipping.replaceChildren();
          }),
          button("Edit", "Edit chart range", () =>
            this.actions.onEdit(this.spec.id),
          ),
        );
      }
      this.status.textContent = this.data.some((series) => series.points.length)
        ? ""
        : "No measurements yet";
      this.renderResults();
    } catch (error) {
      if (this.destroyed || generation !== this.generation || isAbort(error))
        return;
      controller.abort();
      this.data = [];
      this.legend.replaceChildren();
      this.plot?.clear();
      this.renderResults();
      this.status.textContent = `Could not load chart: ${message(error)}`;
    } finally {
      if (generation === this.generation) this.abort = undefined;
    }
  }
  setContext(context: CardContext): void {
    if (this.destroyed) return;
    const apiChanged = context.api !== this.context.api;
    this.context = context;
    if (apiChanged && this.images) {
      this.images.destroy();
      this.images = undefined;
      this.build();
    }
    this.refresh();
  }
  setSpec(spec: ChartSpec): void {
    if (this.destroyed) return;
    const contentKey = ({
      layout: _layout,
      size: _size,
      title: _title,
      config,
      ...rest
    }: ChartSpec) =>
      JSON.stringify({
        ...rest,
        config: { ...config, width: null, height: 0 },
      });
    if (contentKey(spec) === contentKey(this.spec)) {
      this.cancelResize();
      this.spec = spec;
      this.title.textContent = spec.title;
      this.root.classList.toggle("card-wide", spec.size === "wide");
      this.applyDimensions();
      return;
    }
    if (spec.config.axis !== this.spec.config.axis)
      this.pins = { a: null, b: null, threshold: null };
    this.cancel();
    this.plot?.destroy();
    this.images?.destroy();
    this.plot = undefined;
    this.images = undefined;
    this.spec = spec;
    this.data = [];
    this.build();
    this.refresh();
  }
  setActive(active: boolean): void {
    this.active = active;
    this.updateActive();
  }
  refresh(): void {
    if (this.destroyed) return;
    this.cancel();
    this.loaded = false;
    this.data = [];
    this.legend.replaceChildren();
    this.plot?.clear();
    this.images?.clear();
    this.status.textContent = "";
    this.notice.textContent = "";
    this.hover.textContent = "";
    this.clipping.replaceChildren();
    this.renderResults();
    this.updateActive();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.cancelResize();
    this.destroyed = true;
    this.cancel();
    this.observer?.disconnect();
    this.lifetime.abort();
    this.plot?.destroy();
    this.images?.destroy();
    this.root.remove();
    delete this.host.dataset.cardId;
    delete this.host.dataset.cardKind;
  }
}
