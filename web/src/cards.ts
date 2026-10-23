import { analyze, PlotPanel, type Analyzed, type Pins } from "./plot";
import { ImagePanel } from "./images";
import { formatValue, styleFor, type ViewConfig } from "./config";
import { resolveSources } from "./workspace";
import { element, isAbort, message } from "./utils";
import type {
  CardActions,
  CardContext,
  ChartSpec,
  InteractionMode,
  NavigationAxis,
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
  private mode: InteractionMode = "pan";
  private axis: NavigationAxis = "both";
  private activePin: "a" | "b" = "a";
  private pins: Pins = { a: null, b: null, threshold: null };
  private inputs = new Map<keyof Pins, HTMLInputElement>();
  private modes = new Map<InteractionMode, HTMLButtonElement>();
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
          if (this.full) this.setMaximized(false);
        }
      },
      { signal: this.lifetime.signal },
    );
    this.build();
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

  private setMaximized(value: boolean) {
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
    item(this.spec.size === "wide" ? "Normal width" : "Wide", () =>
      this.actions.onResize(
        this.spec.id,
        this.spec.size === "wide" ? "normal" : "wide",
      ),
    );
    item("Move up", () => this.actions.onMove(this.spec.id, -1));
    item("Move down", () => this.actions.onMove(this.spec.id, 1));
    item("Remove", () => this.actions.onRemove(this.spec.id));
    this.menu.append(summary, items);
    this.content.replaceChildren();
    this.inputs.clear();
    this.modes.clear();
    if (this.spec.kind === "image") {
      this.images = new ImagePanel(this.content, this.context.api, {
        compact: true,
      });
      return;
    }
    const toolbar = element("div", "card-chart-toolbar");
    for (const [mode, label, hint] of [
      ["pan", "Pan", "Drag to pan; Alt + scroll to zoom"],
      ["zoom", "Zoom", "Drag a box to zoom"],
      ["inspect", "Inspect", "Place or drag A and B to compare values"],
      [
        "threshold",
        "Threshold",
        "Place or drag a value to find every crossing",
      ],
    ] as const) {
      const control = button(label, hint, () => {
        this.mode = mode;
        this.configure();
      });
      control.setAttribute("aria-label", label);
      this.modes.set(mode, control);
      toolbar.append(control);
    }
    const axis = element("select", "card-axis");
    axis.setAttribute("aria-label", "Navigation axes");
    axis.title = "Axes to zoom";
    for (const [value, label] of [
      ["both", "X + Y"],
      ["x", "X"],
      ["y", "Y"],
    ]) {
      const option = element("option", "", label);
      option.value = value;
      axis.append(option);
    }
    axis.value = this.axis;
    axis.onchange = () => {
      this.axis = axis.value as NavigationAxis;
      this.configure();
    };
    this.backButton = button("Back", "Previous view", () => this.plot?.back());
    toolbar.append(
      axis,
      button("−", "Zoom out", () => this.plot?.zoom(1 / 1.5, this.axis)),
      button("+", "Zoom in", () => this.plot?.zoom(1.5, this.axis)),
      button("Fit", "Fit configured range", () => this.plot?.reset()),
      this.backButton,
    );
    const plotHost = element("div", "card-plot");
    plotHost.dataset.role = "plot";
    this.inspection = element("div", "card-inspection");
    this.results = element("div", "card-results");
    this.hover = element("div", "card-hover");
    this.legend = element("div", "card-legend");
    this.legend.setAttribute("role", "list");
    this.legend.setAttribute("aria-label", "Chart series");
    this.clipping = element("div", "card-clipping");
    this.content.append(
      toolbar,
      this.clipping,
      plotHost,
      this.legend,
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
    );
    this.configure();
  }

  private configure() {
    if (!this.plot) return;
    this.plot.configureInteraction({
      mode: this.mode,
      axis: this.axis,
      activePin: this.activePin,
      onPin: (pin, value) => this.setPin(pin, value),
      onHover: (x) => {
        this.hover.textContent =
          x === null
            ? ""
            : this.data
                .map(
                  (series) =>
                    `${series.run.name}: ${this.number(series.fn.at(x))}`,
                )
                .join(" · ");
      },
      onViewChange: () => {
        if (this.backButton) this.backButton.disabled = !this.plot?.canGoBack();
      },
    });
    for (const [mode, control] of this.modes)
      control.setAttribute("aria-pressed", String(mode === this.mode));
    if (this.backButton) this.backButton.disabled = !this.plot.canGoBack();
    this.inspection.replaceChildren();
    this.inputs.clear();
    this.inspection.hidden =
      this.mode !== "inspect" && this.mode !== "threshold";
    if (this.inspection.hidden) return;
    const fields = element("div", "card-pin-fields");
    const names: (keyof Pins)[] =
      this.mode === "inspect" ? ["a", "b"] : ["threshold"];
    for (const name of names) {
      const label = element("label", "card-pin-label");
      if (name !== "threshold") {
        const choice = button(
          name.toUpperCase(),
          `Select cursor ${name.toUpperCase()}`,
          () => {
            this.activePin = name;
            this.configure();
          },
        );
        choice.setAttribute("aria-pressed", String(name === this.activePin));
        label.append(choice);
      } else label.append(element("span", "", "Value"));
      const input = element("input", "card-coordinate");
      input.type = "number";
      input.step = "any";
      input.setAttribute(
        "aria-label",
        name === "threshold"
          ? "Threshold value"
          : `Cursor ${name.toUpperCase()} coordinate`,
      );
      input.value = this.pins[name] === null ? "" : String(this.pins[name]);
      input.onchange = () => {
        if (input.value === "") this.setPin(name, null);
        else if (Number.isFinite(input.valueAsNumber))
          this.setPin(name, input.valueAsNumber);
      };
      this.inputs.set(name, input);
      label.append(input);
      fields.append(label);
    }
    fields.append(
      button("Clear", "Clear cursors", () => {
        this.pins = { a: null, b: null, threshold: null };
        this.plot?.setPins(this.pins);
        this.configure();
      }),
    );
    this.inspection.append(fields, this.results);
    this.renderResults();
  }

  private renderLegend() {
    this.legend.replaceChildren();
    const config = this.spec.config;
    const advanced = config.advanced.legend as { show?: boolean } | undefined;
    if (!(advanced?.show ?? config.legend)) return;
    this.data.forEach((series, index) => {
      const style = styleFor(config, series.run.id, index);
      const item = element("span", "card-legend-item");
      item.setAttribute("role", "listitem");
      const swatch = element("span", "card-legend-swatch");
      swatch.style.backgroundColor = style.color;
      item.append(swatch, document.createTextNode(series.run.name));
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
    if (this.mode === "inspect") {
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
    } else if (this.mode === "threshold" && this.pins.threshold !== null) {
      for (const series of this.data) {
        const crossings = series.fn.crossings(this.pins.threshold);
        const details = element("details", "card-crossings");
        details.append(
          element(
            "summary",
            "",
            `${series.run.name} · ${crossings.points.length} crossings${crossings.plateaus.length ? ` · ${crossings.plateaus.length} intervals` : ""}`,
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
    const sources = resolveSources(
      this.spec,
      this.context.selectedRunIds,
      this.context.catalog,
    );
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
      const config =
        this.spec.outliers === "robust"
          ? robustConfig(this.data, this.spec.config)
          : this.spec.config;
      this.plot?.render(this.data, config, this.pins);
      this.renderLegend();
      if (config !== this.spec.config) {
        this.clipping.append(
          element("span", "", "Central 98% · display clipped"),
          button("Fit all", "Show all values in this view", () => {
            this.plot?.render(this.data, this.spec.config, this.pins);
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
