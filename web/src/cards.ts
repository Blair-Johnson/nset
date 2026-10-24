import { loadRecordPlot, recordConfig } from "./records";
import {
  analyze,
  PlotPanel,
  type Analyzed,
  type Pins,
  type PlotRun,
} from "./plot";
import { ImagePanel } from "./images";
import type { EditorCamera } from "./chart-editor";
import { formatValue, styleFor, type ViewConfig } from "./config";
import { resolveSources } from "./workspace";
import { withRunColors } from "./series-colors";
import { loadPlotRuns, withMetricLabel } from "./card-label";
import { nextCursorPlacement } from "./cursor-placement";
import { plotIcon, type PlotIconName } from "./plot-icons";
import {
  formatDuration,
  formatXValue,
  type XQuantity,
} from "./options";
import { cameraAxis } from "./workspace";
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

function iconButton(icon: PlotIconName, label: string, action: () => void) {
  const control = button("", label, action);
  control.append(plotIcon(icon));
  return control;
}
export class ChartCard {
  private root = element("article", "chart-card");
  private header = element("header", "card-header");
  private foldObserver?: ResizeObserver;
  private title = element("h3", "card-title");
  private content = element("div", "card-content");
  private status = element("div", "card-status");
  private notice = element("div", "card-notice");
  private inspection = element("div", "card-inspection");
  private results = element("div", "card-results");
  private hover = element("div", "card-hover");
  private legend = element("div", "card-legend");
  private lastHoverX: number | null = null;
  private legendCoordinate = element("div", "card-legend-coordinate");
  private legendValues: [HTMLElement, Analyzed][] = [];
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
  /** Last fetched raw histories, kept so transform-only edits need no refetch. */
  private raw: PlotRun[] = [];
  /** Camera handed back by the editor; applied on the next data render. */
  private pendingCamera?: EditorCamera;
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
    /** Page scroll at gesture start: auto-scroll extends the drag distance. */
    scrollY: number;
    clientX: number;
    clientY: number;
    frame?: number;
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
    const header = this.header;
    this.maximize = iconButton("maximize", "Maximize chart", () =>
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
    // Register before PlotPanel so fold growth is compensated before its size observer.
    this.foldObserver = new ResizeObserver(() => this.measureFolds());
    this.build();
    this.installResize();
    for (const node of [this.root, this.legend, this.inspection])
      this.foldObserver.observe(node);
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
    this.root.addEventListener("toggle", () => this.measureFolds(), {
      capture: true,
      signal: this.lifetime.signal,
    });
    this.updateActive();
  }

  private displayConfig(): ViewConfig {
    if (this.spec.records) return recordConfig(withRunColors(this.spec.config, this.sources, this.context.catalog), this.spec.records);
    return withMetricLabel(
      withRunColors(this.spec.config, this.sources, this.context.catalog),
      this.spec.source,
      this.spec.kind === "timeseries" ? this.spec.x : undefined,
    );
  }
  /** What the X axis shows; XY charts read X in metric units. */
  private xAxis(): XQuantity {
    return this.spec.kind === "timeseries" && (this.spec.x || this.spec.records)
      ? "metric"
      : this.spec.config.axis;
  }
  private xText(value: number): string {
    return formatXValue(value, this.xAxis(), this.spec.config.xFormat);
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
    if (!this.resizeGesture) this.host.style.setProperty("--card-width", width);
    this.root.style.height = `calc(${this.baseHeight(layout)}px + var(--card-fold-height, 0px))`;
  }

  /** layout.height is the closed card height, never the transient inspector height. */
  private baseHeight(layout = this.spec.layout) {
    return (
      layout?.height ??
      (this.spec.kind === "image" ? 410 : this.spec.config.height + 112)
    );
  }

  private measureFolds() {
    const legend =
      !this.legendDetails.hidden && this.legendDetails.open
        ? this.legend.getBoundingClientRect().height
        : 0;
    const inspection =
      this.inspection.hidden || !this.inspection.isConnected
        ? 0
        : this.inspection.getBoundingClientRect().height + 4;
    this.root.style.setProperty(
      "--card-fold-height",
      `${legend + inspection}px`,
    );
    if (this.full && this.plot) {
      const summary = this.legendDetails.hidden
        ? 0
        : this.legendDetails.querySelector("summary")!.getBoundingClientRect()
            .height + 4;
      const style = getComputedStyle(this.content);
      this.root.style.setProperty(
        "--card-full-plot-height",
        `${Math.max(
          100,
          this.content.clientHeight -
            parseFloat(style.paddingTop) -
            parseFloat(style.paddingBottom) -
            summary -
            this.clipping.getBoundingClientRect().height,
        )}px`,
      );
    }
  }

  private releaseResizeSlot() {
    this.host.classList.remove("card-resizing-slot");
    this.host.style.removeProperty("--resize-slot-width");
    this.host.style.removeProperty("--resize-slot-height");
    this.host.style.removeProperty("--resize-slot-extra");
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
    if (gesture.frame) cancelAnimationFrame(gesture.frame);
    if (this.resizeHandle?.hasPointerCapture(gesture.pointer))
      this.resizeHandle.releasePointerCapture(gesture.pointer);
    this.releaseResizeSlot();
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
      const start = { width: rect.width, height: this.baseHeight() };
      // Keep the original flex/grid footprint until release; only the child previews.
      this.host.style.setProperty("--resize-slot-width", `${rect.width}px`);
      this.host.style.setProperty("--resize-slot-height", `${rect.height}px`);
      this.host.classList.add("card-resizing-slot");
      this.resizeGesture = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        start,
        next: start,
        scrollY: window.scrollY,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      handle.setPointerCapture(event.pointerId);
      handle.focus({ preventScroll: true });
    };
    // Height follows the pointer in page coordinates, so scrolling while
    // dragging grows the card past the visible area.
    const track = (g: NonNullable<typeof this.resizeGesture>) => {
      g.next = bounded(
        g.start.width + g.clientX - g.x,
        g.start.height + g.clientY - g.y + window.scrollY - g.scrollY,
      );
      this.applyDimensions(g.next);
      // Reserve page height for the overflowing preview so scrolling can follow.
      const grow = Math.max(0, g.next.height - g.start.height);
      this.host.style.setProperty("--resize-slot-extra", `${grow}px`);
    };
    // Near the bottom (or top) edge, scroll the page while the pointer rests.
    const EDGE = 48;
    const autoScroll = () => {
      const g = this.resizeGesture;
      if (!g) return;
      g.frame = undefined;
      const fromBottom = window.innerHeight - g.clientY;
      const speed =
        fromBottom < EDGE
          ? Math.ceil(((EDGE - Math.max(0, fromBottom)) / EDGE) * 18)
          : g.clientY < EDGE
            ? -Math.ceil(((EDGE - Math.max(0, g.clientY)) / EDGE) * 18)
            : 0;
      if (!speed) return;
      const before = window.scrollY;
      // The page may need room to scroll into: the card's preview grows first.
      track(g);
      window.scrollBy(0, speed);
      if (window.scrollY !== before) track(g);
      g.frame = requestAnimationFrame(autoScroll);
    };
    handle.onpointermove = (event) => {
      const g = this.resizeGesture;
      if (!g || g.pointer !== event.pointerId) return;
      g.clientX = event.clientX;
      g.clientY = event.clientY;
      track(g);
      if (!g.frame) g.frame = requestAnimationFrame(autoScroll);
    };
    handle.onpointerup = (event) => {
      const g = this.resizeGesture;
      if (!g || g.pointer !== event.pointerId) return;
      this.resizeGesture = undefined;
      if (g.frame) cancelAnimationFrame(g.frame);
      handle.releasePointerCapture(event.pointerId);
      this.releaseResizeSlot();
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
        height: this.baseHeight(),
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
    this.maximize.replaceChildren(plotIcon(value ? "restore" : "maximize"));
    this.maximize.setAttribute("aria-pressed", String(value));
    this.updateActive();
    this.measureFolds();
    this.maximize.focus({ preventScroll: true });
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
    // The toolbar's home button already resets the camera; this resets the
    // chart's settings (undoable from the dashboard's Undo).
    if (this.actions.onReset)
      item("Reset chart", () => this.actions.onReset!(this.spec.id));
    item("Edit chart", () => this.actions.onEdit(this.spec.id));
    item("Duplicate", () => this.actions.onDuplicate(this.spec.id));
    item("Move up", () => this.actions.onMove(this.spec.id, -1));
    item("Move down", () => this.actions.onMove(this.spec.id, 1));
    item("Remove", () => this.actions.onRemove(this.spec.id));
    this.menu.append(summary, items);
    this.header.querySelector(".card-chart-toolbar")?.remove();
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
    this.backButton = iconButton("back", "Previous view", () =>
      this.plot?.back(),
    );
    toolbar.append(
      iconButton("zoom-out", "Zoom out", () =>
        this.plot?.zoom(1 / 1.5, "both"),
      ),
      iconButton("zoom-in", "Zoom in", () => this.plot?.zoom(1.5, "both")),
      iconButton("fit", "Fit configured range", () => this.plot?.reset()),
      this.backButton,
    );
    for (const [axis, icon, label] of [
      ["x", "vertical-cursor", "Add vertical cursor"],
      ["y", "horizontal-cursor", "Add horizontal cursor"],
    ] as const) {
      const control = iconButton(icon, label, () => {
        this.cursorAxis = axis;
        this.activePin = "a";
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
    this.header.insertBefore(toolbar, this.maximize);
    this.legendDetails.addEventListener("toggle", () => this.measureFolds());
    this.content.append(
      this.clipping,
      plotHost,
      this.legendDetails,
      this.hover,
      this.inspection,
    );
    this.plot = new PlotPanel(
      plotHost,
      () => {},
      // Editor diagnostics remain available; never make the plot a native tooltip.
      () => {},
      true,
    );
    this.configure();
    if (this.foldObserver) {
      this.foldObserver.disconnect();
      for (const node of [this.root, this.legend, this.inspection])
        this.foldObserver.observe(node);
    }
  }

  private configure(rebuild = true) {
    if (!this.plot) return;
    this.plot.configureInteraction({
      mode: this.mode,
      axis: "both",
      inferZoomAxes: true,
      directGestures: true,
      cursorAxis: this.cursorAxis,
      activePin: this.activePin,
      onPin: (pin, value) => this.setPin(pin, value),
      onHorizontalPin: (pin, value) =>
        this.setPin(pin === "a" ? "yA" : "yB", value),
      onCursorModeCycle: () => {
        const next = nextCursorPlacement({
          mode: this.mode,
          cursorAxis: this.cursorAxis,
        });
        this.mode = next.mode;
        this.cursorAxis = next.cursorAxis;
        this.activePin = next.activePin;
        if (next.mode === "inspect") this.inspectOpen = true;
        this.configure();
      },
      onPlacementComplete: (pin) => {
        const first = pin === "a" || pin === "yA";
        this.activePin = first ? "b" : this.activePin;
        this.mode = first ? "inspect" : "zoom";
        this.configure(false);
      },
      onHover: (x) => {
        this.hover.replaceChildren();
        if (x === null) return;
        this.lastHoverX = x;
        this.updateLegendReadout();
        for (const [index, series] of this.data.slice(0, 3).entries()) {
          const row = element("div", "card-hover-row");
          const name = element("span", "", this.seriesLabel(index));
          name.title = name.textContent ?? "";
          row.append(name, element("span", "", this.number(series.fn.at(x))));
          this.hover.append(row);
        }
        if (this.data.length > 3)
          this.hover.append(
            element(
              "div",
              "card-hover-more",
              `${this.data.length - 3} more in legend`,
            ),
          );
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
    const positionsOpen =
      this.inspection.querySelector<HTMLDetailsElement>(".card-position-editor")
        ?.open ?? false;
    this.inspection.replaceChildren();
    this.inputs.clear();
    this.inspection.hidden = !this.inspectOpen && this.mode !== "threshold";
    if (this.inspection.hidden) {
      this.measureFolds();
      return;
    }
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
    const editor = element("details", "card-position-editor");
    editor.open = positionsOpen;
    editor.append(element("summary", "", "Edit positions"), fields);
    this.inspection.append(this.results, editor);
    this.renderResults();
  }

  private updateLegendReadout() {
    const x = this.lastHoverX;
    this.legendCoordinate.hidden = x === null;
    this.legendCoordinate.textContent =
      x === null
        ? ""
        : `At ${this.xAxis() === "step" ? "step " : ""}${this.xText(x)}`;
    for (const [cell, series] of this.legendValues) {
      cell.textContent = x === null ? "" : this.number(series.fn.at(x));
      cell.title = cell.textContent;
    }
    this.measureFolds();
  }

  private renderLegend() {
    this.legend.replaceChildren(this.legendCoordinate);
    this.legendValues = [];
    this.legend.tabIndex = 0;
    const config = this.displayConfig();
    const advanced = config.advanced.legend as { show?: boolean } | undefined;
    this.legendDetails.hidden = !(advanced?.show ?? config.legend);
    if (this.legendDetails.hidden) return;
    const mixed = new Set(this.sources.map((source) => source.key)).size > 1;
    this.legend.classList.toggle("card-legend-mixed", mixed);
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
      const value = element("span", "card-legend-value");
      this.legendValues.push([value, series]);
      item.append(swatch, name);
      if (mixed) item.append(key);
      item.append(value);
      if (!style.visible) {
        item.classList.add("card-series-hidden");
        item.title = "Hidden in chart settings";
      }
      this.legend.append(item);
    });
    if (config.smoothing)
      this.legend.append(element("span", "card-series-note", "Smoothed"));
    this.updateLegendReadout();
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
  private seriesLabel(index: number) {
    if (this.spec.records) return this.data[index].run.name;
    const source = this.sources[index];
    if (!source) return this.data[index].run.name;
    const mixed = new Set(this.sources.map((item) => item.key)).size > 1;
    return mixed ? `${source.run.name} · ${source.key}` : source.run.name;
  }

  private renderResults() {
    const open =
      this.results.querySelector<HTMLDetailsElement>(".card-series-details")
        ?.open ?? false;
    this.results.replaceChildren();
    const secondary = element("details", "card-series-details");
    secondary.open = open;
    secondary.append(element("summary", "", "Per-run values / crossings"));
    const body = element("div", "card-series-results");
    secondary.append(body);
    if (this.inspectOpen && this.mode !== "threshold") {
      // Primary row follows the armed axis; the other axis's pair is appended
      // inline when it also has cursors, so ΔX and ΔY read together like a scope.
      const readout = element("div", "card-position-readout");
      const primaryVertical = this.cursorAxis === "x";
      readout.setAttribute(
        "aria-label",
        `Cursor ${primaryVertical ? "positions" : "levels"}`,
      );
      const otherA = primaryVertical ? this.pins.yA : this.pins.a;
      const otherB = primaryVertical ? this.pins.yB : this.pins.b;
      const axes =
        otherA != null || otherB != null
          ? [primaryVertical, !primaryVertical]
          : [primaryVertical];
      for (const vertical of axes) {
        const a = vertical ? this.pins.a : this.pins.yA;
        const b = vertical ? this.pins.b : this.pins.yB;
        const delta = a == null || b == null ? null : b - a;
        const quantity = this.xAxis();
        const position = (value: number | null | undefined) =>
          value == null
            ? "—"
            : vertical
              ? this.xText(value)
              : this.number(value);
        const difference =
          delta === null
            ? "—"
            : vertical &&
                (quantity === "timestamp" || quantity === "relative")
              ? formatDuration(delta)
              : vertical
                ? formatValue(
                    delta,
                    this.spec.config.xFormat === "iso-time"
                      ? "number"
                      : this.spec.config.xFormat,
                  )
                : this.number(delta);
        const group = element("span", "card-position-group");
        if (vertical !== primaryVertical) group.dataset.secondary = "true";
        group.append(
          element(
            "strong",
            "",
            vertical
              ? quantity === "metric"
                ? this.displayConfig().xLabel || "X"
                : quantity === "step"
                  ? "Step"
                  : quantity === "timestamp"
                    ? "Time (UTC)"
                    : "Elapsed time"
              : "Value",
          ),
        );
        for (const [label, value] of [
          ["A", position(a)],
          ["B", position(b)],
          [vertical ? "ΔX" : "ΔY", difference],
        ]) {
          const cell = element("span", "card-position-value");
          cell.append(element("span", "", label), element("output", "", value));
          group.append(cell);
        }
        readout.append(group);
      }
      readout.append(
        button("Hide", "Hide cursor details", () => {
          this.inspectOpen = false;
          this.mode = "zoom";
          this.configure();
        }),
      );
      this.results.append(readout);
    }
    if (
      this.inspectOpen &&
      this.cursorAxis === "x" &&
      this.mode !== "threshold"
    ) {
      const table = element("table", "card-value-table");
      const head = element("tr");
      for (const name of ["Series value", "At A", "At B", "Δ value"])
        head.append(element("th", "", name));
      table.append(head);
      for (const [index, series] of this.data.entries()) {
        const a = this.pins.a === null ? null : series.fn.at(this.pins.a);
        const b = this.pins.b === null ? null : series.fn.at(this.pins.b);
        const row = element("tr");
        row.append(element("th", "", this.seriesLabel(index)));
        for (const value of [a, b, a === null || b === null ? null : b - a])
          row.append(element("td", "", this.number(value)));
        table.append(row);
      }
      body.append(table);
    } else if (this.inspectOpen || this.mode === "threshold") {
      const levels: [string, number | null | undefined][] =
        this.mode === "threshold"
          ? [["Threshold", this.pins.threshold]]
          : [
              ["A", this.pins.yA],
              ["B", this.pins.yB],
            ];
      for (const [label, level] of levels) {
        if (level == null) continue;
        for (const [index, series] of this.data.entries()) {
          const crossings = series.fn.crossings(level);
          const details = element("details", "card-crossings");
          details.append(
            element(
              "summary",
              "",
              `${label} · ${this.seriesLabel(index)} · ${crossings.points.length} crossings${crossings.plateaus.length ? ` · ${crossings.plateaus.length} intervals` : ""}`,
            ),
          );
          const list = element("div");
          list.textContent =
            [
              ...crossings.points.map((x) => this.xText(x)),
              ...crossings.plateaus.map(
                ([a, b]) => `${this.xText(a)} – ${this.xText(b)}`,
              ),
            ].join(", ") || "No crossings";
          details.append(list);
          body.append(details);
        }
      }
    }
    if (body.childElementCount) this.results.append(secondary);
    this.measureFolds();
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
    this.raw = [];
    this.legend.replaceChildren();
    this.plot?.clear();
    this.hover.textContent = "";
    this.lastHoverX = null;
    this.legendValues = [];
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
      this.images.setCamera(this.pendingCamera?.image);
      this.pendingCamera = undefined;
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
      const recordResult = this.spec.records ? await loadRecordPlot(this.context.api, this.spec.records, this.context.catalog, this.context.selectedRunIds, controller.signal) : undefined;
      const data = recordResult?.data ?? await loadPlotRuns(sources, this.context.store, controller.signal);
      if (
        this.destroyed ||
        generation !== this.generation ||
        controller.signal.aborted
      )
        return;
      if (recordResult) { this.notice.textContent = recordResult.warning; this.sources = recordResult.sources; }
      this.raw = data;
      this.data = analyze(data, this.spec.config);
      const display = this.displayConfig();
      const config =
        this.spec.outliers === "robust"
          ? robustConfig(this.data, display)
          : display;
      this.renderLegend();
      if (config !== display) {
        this.clipping.append(
          element("span", "", "Central 98% · display clipped"),
          button("Fit all", "Show all values in this view", () => {
            this.clipping.replaceChildren();
            this.plot?.render(this.data, this.displayConfig(), this.pins);
          }),
          button("Edit", "Edit chart range", () =>
            this.actions.onEdit(this.spec.id),
          ),
        );
      }
      this.status.textContent = this.data.some((series) => series.points.length)
        ? ""
        : "No measurements yet";
      const handed = this.pendingCamera?.scalar;
      this.pendingCamera = undefined;
      this.plot?.render(this.data, config, this.pins, {
        initialView:
          handed &&
          handed.axis === cameraAxis(this.spec) &&
          handed.xScale === config.xScale &&
          handed.yScale === config.yScale
            ? handed.view
            : null,
      });
      this.renderResults();
    } catch (error) {
      if (this.destroyed || generation !== this.generation || isAbort(error))
        return;
      controller.abort();
      this.data = [];
      this.raw = [];
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
  /** Current camera, for handing to the editor preview. */
  camera(): EditorCamera | undefined {
    if (this.images) {
      const image = this.images.camera();
      return image ? { image } : undefined;
    }
    const view = this.plot?.zoomed() ? this.plot.viewport() : null;
    return view
      ? {
          scalar: {
            view,
            axis: cameraAxis(this.spec),
            xScale: this.spec.config.xScale,
            yScale: this.spec.config.yScale,
          },
        }
      : undefined;
  }
  /** Adopt a camera (from the editor) on the next render of this card. */
  setCamera(camera: EditorCamera | undefined): void {
    if (!camera) return;
    if (camera.image && this.images && this.loaded && !this.abort) {
      this.images.setCamera(camera.image);
      return;
    }
    if (
      camera.scalar &&
      this.plot &&
      this.loaded &&
      !this.abort &&
      this.raw.length
    ) {
      const s = camera.scalar;
      const c = this.spec.config;
      if (
        s.axis === cameraAxis(this.spec) &&
        s.xScale === c.xScale &&
        s.yScale === c.yScale
      ) {
        this.plot.showView(s.view);
        return;
      }
    }
    this.pendingCamera = camera;
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
      // Unchanged shell renders must not interrupt an active pointer preview.
      if (
        JSON.stringify(spec.layout) !== JSON.stringify(this.spec.layout) ||
        spec.size !== this.spec.size
      )
        this.cancelResize();
      this.spec = spec;
      this.title.textContent = spec.title;
      this.root.classList.toggle("card-wide", spec.size === "wide");
      this.applyDimensions(this.resizeGesture?.next);
      return;
    }
    this.cancelResize();
    // Data-transform-only edits (smoothing, interpolation): re-analyze cached raw
    // observations in place so zoom, back-history, cursors and scroll survive.
    const transformKey = (s: ChartSpec) =>
      contentKey({
        ...s,
        config: {
          ...s.config,
          smoothing: false,
          alpha: 0,
          interpolation: "linear",
        },
      });
    if (
      this.plot &&
      this.loaded &&
      !this.abort &&
      this.raw.length &&
      spec.kind === this.spec.kind &&
      transformKey(spec) === transformKey(this.spec)
    ) {
      this.spec = spec;
      this.title.textContent = spec.title;
      this.applyDimensions();
      this.data = analyze(this.raw, spec.config);
      this.renderLegend();
      const display = this.displayConfig();
      this.plot.render(
        this.data,
        spec.outliers === "robust" ? robustConfig(this.data, display) : display,
        this.pins,
        { preserveView: true },
      );
      this.renderResults();
      return;
    }
    if (cameraAxis(spec) !== cameraAxis(this.spec))
      this.pins = { a: null, b: null, threshold: null };
    this.cancel();
    this.plot?.destroy();
    this.images?.destroy();
    this.plot = undefined;
    this.images = undefined;
    this.spec = spec;
    this.data = [];
    this.raw = [];
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
    this.raw = [];
    this.legend.replaceChildren();
    this.plot?.clear();
    this.images?.clear();
    this.status.textContent = "";
    this.notice.textContent = "";
    this.hover.textContent = "";
    this.lastHoverX = null;
    this.legendValues = [];
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
    this.foldObserver?.disconnect();
    this.lifetime.abort();
    this.plot?.destroy();
    this.images?.destroy();
    this.root.remove();
    delete this.host.dataset.cardId;
    delete this.host.dataset.cardKind;
  }
}
