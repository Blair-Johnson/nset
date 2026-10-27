import type {
  CardContext,
  ChartMeasurement,
  ChartSpec,
} from "./workspace-types";
import { renderChartMarkdown } from "./chart-markdown";
import { chartDetailsData } from "./chart-details-data";
import { RUN_COLORS_EVENT } from "./series-colors";
import "katex/dist/katex.min.css";
import "./chart-details.css";

export interface ChartDetailsInput {
  workspaceId: string;
  chart: ChartSpec;
  context: CardContext;
}

interface PanelOptions {
  onClose: () => void;
  onMeasure: (
    workspaceId: string,
    cardId: string,
    measurement: ChartMeasurement,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

const WIDTH_KEY = "nset:chart-details-width:v1";
let nextPanelId = 0;
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A native, read-only chart companion. The owner remains responsible for card actions. */
export class ChartDetailsPanel {
  private readonly root = element("aside", "chart-details");
  private readonly scroll = element("div", "chart-details-scroll");
  private readonly heading = element(
    "h2",
    "chart-details-heading",
    "Chart details",
  );
  private readonly title = element("h3", "chart-details-title");
  private readonly closeButton = element("button", "chart-details-close", "×");
  private readonly separator = element("div", "chart-details-resizer");
  private readonly report = element("section", "chart-details-report");
  private readonly configuration = element(
    "section",
    "chart-details-configuration",
  );
  private readonly status = element("p", "chart-details-status");
  private input: ChartDetailsInput | null = null;
  private returnFocus?: HTMLElement;
  private listeners: AbortController | null = null;
  private destroyed = false;
  private generation = 0;
  private measurementAction: AbortController | null = null;
  private width = 340;
  private signature = "";
  private reportSignature = "";
  private configSignature = "";
  private drag: { pointerId: number; x: number; width: number } | null = null;

  constructor(private readonly options: PanelOptions) {
    const id = `chart-details-${++nextPanelId}`;
    this.root.id = id;
    this.heading.id = `${id}-heading`;
    this.root.setAttribute("aria-labelledby", this.heading.id);
    this.closeButton.type = "button";
    this.closeButton.setAttribute("aria-label", "Close chart details");
    this.closeButton.title = "Close chart details (Escape)";
    this.separator.tabIndex = 0;
    this.separator.setAttribute("role", "separator");
    this.separator.setAttribute("aria-orientation", "vertical");
    this.separator.setAttribute("aria-label", "Resize chart details");
    this.separator.setAttribute("aria-controls", id);
    this.separator.title =
      "Drag to resize; Left/Right arrows resize, Home/End set limits";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.setAttribute("aria-atomic", "true");
    const header = element("header", "chart-details-header");
    const titles = element("div", "chart-details-titles");
    titles.append(this.heading, this.title);
    header.append(titles, this.closeButton);
    this.scroll.append(header, this.report, this.configuration);
    this.root.append(this.separator, this.scroll);
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(saved) && saved >= 280) this.width = saved;
    } catch {
      /* Local preferences are optional. */
    }
  }

  get active(): { workspaceId: string; cardId: string } | null {
    return this.input
      ? { workspaceId: this.input.workspaceId, cardId: this.input.chart.id }
      : null;
  }

  open(input: ChartDetailsInput, returnFocus?: HTMLElement): void {
    if (this.destroyed) return;
    const changed =
      !this.input ||
      this.input.workspaceId !== input.workspaceId ||
      this.input.chart.id !== input.chart.id;
    if (!this.input) {
      const main = document.getElementById("main");
      if (main) main.after(this.root);
      else document.body.append(this.root);
      document.body.classList.add("has-chart-details");
      this.listen();
    }
    this.returnFocus =
      returnFocus ??
      (document.activeElement instanceof HTMLElement &&
      !this.root.contains(document.activeElement)
        ? document.activeElement
        : this.returnFocus);
    this.applyWidth(this.width);
    this.refresh(input);
    if (changed) {
      this.scroll.scrollTop = 0;
      this.scroll.scrollLeft = 0;
    }
    this.closeButton.focus({ preventScroll: window.innerWidth > 950 });
  }

  /** Refresh only an already-open panel. A caller may replace its active chart/view. */
  update(input: ChartDetailsInput): void {
    if (!this.input || this.destroyed) return;
    this.refresh(input);
  }

  close(restoreFocus = true): void {
    if (!this.input) return;
    this.invalidateMeasurement();
    this.finishDrag(true);
    this.input = null;
    this.listeners?.abort();
    this.listeners = null;
    this.root.remove();
    document.body.classList.remove(
      "has-chart-details",
      "chart-details-resizing",
    );
    document.body.style.removeProperty("--chart-details-width");
    this.status.textContent = "";
    this.signature = "";
    const focus = this.returnFocus;
    this.returnFocus = undefined;
    if (restoreFocus && focus?.isConnected)
      focus.focus({ preventScroll: true });
    this.options.onClose();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.close(false);
    this.listeners?.abort();
    this.root.remove();
  }

  private refresh(input: ChartDetailsInput): void {
    const data = chartDetailsData(input.chart, input.context);
    const reportSignature = JSON.stringify([
      input.chart.details?.markdown ?? "",
      input.chart.kind === "image"
        ? {}
        : (input.chart.details?.measurements ?? {}),
    ]);
    const configSignature = JSON.stringify([data.fields, data.columns]);
    const signature = JSON.stringify([
      input.workspaceId,
      input.chart.id,
      input.chart.title,
      input.chart.kind,
      input.chart.source,
      input.chart.records,
      input.chart.x,
      input.chart.config,
      input.context.catalog.rx?.id,
      input.context.catalog.rx?.sourceGeneration,
      (
        input.chart.records
          ? !input.chart.records.runUids.length
          : input.chart.source.mode === "selected"
      )
        ? input.context.selectedRunIds
        : null,
      data.sources,
      reportSignature,
      configSignature,
    ]);
    const contextChanged =
      this.input &&
      (this.input.context.api !== input.context.api ||
        this.input.context.store !== input.context.store);
    this.input = input;
    if (signature === this.signature && !contextChanged) return;
    this.invalidateMeasurement();
    this.finishDrag(true);
    this.signature = signature;
    this.status.textContent = "";
    const top = this.scroll.scrollTop,
      left = this.scroll.scrollLeft;
    const focused =
      document.activeElement instanceof HTMLElement &&
      this.report.contains(document.activeElement)
        ? document.activeElement
        : null;
    const focusedMeasurement = focused?.closest<HTMLElement>(
      ".chart-measurement-link",
    )?.dataset.measurement;
    const focusedHref = focused?.closest("a")?.getAttribute("href");
    this.title.textContent = input.chart.title || "Untitled chart";
    if (reportSignature !== this.reportSignature) {
      this.reportSignature = reportSignature;
      const markdown = input.chart.details?.markdown ?? "";
      this.report.innerHTML = renderChartMarkdown(
        markdown,
        input.chart.kind === "image"
          ? {}
          : (input.chart.details?.measurements ?? {}),
      );
      for (const table of this.report.querySelectorAll("table")) {
        const wrapper = element("div", "chart-details-report-table-wrap");
        wrapper.tabIndex = 0;
        wrapper.setAttribute("role", "region");
        wrapper.setAttribute("aria-label", "Report table");
        table.before(wrapper);
        wrapper.append(table);
      }
      this.report.append(this.status);
      this.report.hidden = !markdown.trim();
      if (focused) {
        const replacement = [
          ...this.report.querySelectorAll<HTMLElement>(
            ".chart-measurement-link, a",
          ),
        ].find((node) =>
          focusedMeasurement
            ? node.dataset.measurement === focusedMeasurement
            : focusedHref != null && node.getAttribute("href") === focusedHref,
        );
        (replacement ?? this.closeButton).focus({ preventScroll: true });
      }
    }
    if (configSignature !== this.configSignature) {
      this.configSignature = configSignature;
      this.renderConfiguration(data);
    }
    this.scroll.scrollTop = top;
    this.scroll.scrollLeft = left;
  }

  private renderConfiguration(data: ReturnType<typeof chartDetailsData>): void {
    const oldScroll =
      this.configuration.querySelector(".chart-details-table-wrap")
        ?.scrollLeft ?? 0;
    const hadFocus = this.configuration.contains(document.activeElement);
    this.configuration.replaceChildren();
    this.configuration.hidden = !data.fields.length;
    if (!data.fields.length) {
      if (hadFocus) this.closeButton.focus({ preventScroll: true });
      return;
    }
    const heading = element("h4", "", "Configuration");
    this.configuration.append(heading);
    if (!data.columns.length) {
      this.configuration.append(
        element(
          "p",
          "chart-details-empty",
          "No plotted runs are available for these fields.",
        ),
      );
      if (hadFocus) this.closeButton.focus({ preventScroll: true });
      return;
    }
    const wrapper = element("div", "chart-details-table-wrap");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute(
      "aria-label",
      "Selected configuration parameters by run",
    );
    const table = element("table", "chart-details-table");
    const caption = element(
      "caption",
      "chart-details-sr-only",
      "Selected configuration parameters by plotted run",
    );
    const head = table.createTHead().insertRow();
    const first = element("th", "", "Setting");
    first.scope = "col";
    head.append(first);
    for (const column of data.columns) {
      const cell = element("th", "");
      cell.scope = "col";
      cell.dataset.runId = column.id;
      cell.title = column.original;
      cell.style.color = column.color;
      cell.textContent = column.name;
      head.append(cell);
    }
    const body = table.createTBody();
    data.fields.forEach((field, index) => {
      const row = body.insertRow();
      row.classList.toggle("chart-details-difference", field.differs);
      const name = element("th", "", field.label);
      name.scope = "row";
      name.title = JSON.stringify(field.path);
      row.append(name);
      for (const column of data.columns)
        row.append(element("td", "", column.values[index]));
    });
    table.prepend(caption);
    wrapper.append(table);
    this.configuration.append(wrapper);
    if (hadFocus) wrapper.focus({ preventScroll: true });
    wrapper.scrollLeft = oldScroll;
  }

  private listen(): void {
    this.listeners = new AbortController();
    const signal = this.listeners.signal;
    this.closeButton.addEventListener("click", () => this.close(), { signal });
    this.report.addEventListener(
      "click",
      (event) => {
        const link =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>(".chart-measurement-link")
            : null;
        if (!link || !this.report.contains(link)) return;
        event.preventDefault();
        void this.measure(link.dataset.measurement);
      },
      { signal },
    );
    this.root.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (this.drag) this.finishDrag(true);
        else this.close();
      },
      { signal },
    );
    // Pointer capture may retain focus outside the panel; Escape still cancels.
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && this.drag) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.finishDrag(true);
        }
      },
      { signal, capture: true },
    );
    window.addEventListener(
      "resize",
      () => {
        this.finishDrag(true);
        this.applyWidth(this.width);
      },
      { signal },
    );
    window.addEventListener("blur", () => this.finishDrag(true), { signal });
    window.addEventListener(
      RUN_COLORS_EVENT,
      () => {
        if (this.input) this.refresh(this.input);
      },
      { signal },
    );
    this.separator.addEventListener("blur", () => this.finishDrag(true), {
      signal,
    });
    this.separator.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || this.drag || window.innerWidth <= 950) return;
        event.preventDefault();
        this.separator.focus({ preventScroll: true });
        this.drag = {
          pointerId: event.pointerId,
          x: event.clientX,
          width: this.width,
        };
        try {
          this.separator.setPointerCapture(event.pointerId);
        } catch {
          this.drag = null;
          return;
        }
        document.body.classList.add("chart-details-resizing");
      },
      { signal },
    );
    this.separator.addEventListener(
      "pointermove",
      (event) => {
        if (this.drag?.pointerId === event.pointerId)
          this.applyWidth(this.drag.width + this.drag.x - event.clientX);
      },
      { signal },
    );
    this.separator.addEventListener(
      "pointerup",
      (event) => {
        if (this.drag?.pointerId === event.pointerId) this.finishDrag(false);
      },
      { signal },
    );
    for (const name of ["pointercancel", "lostpointercapture"] as const) {
      this.separator.addEventListener(
        name,
        (event) => {
          if (this.drag?.pointerId === event.pointerId) this.finishDrag(true);
        },
        { signal },
      );
    }
    this.separator.addEventListener(
      "keydown",
      (event) => {
        const step = event.shiftKey ? 80 : 20;
        const values: Record<string, number> = {
          ArrowLeft: this.width + step,
          ArrowRight: this.width - step,
          Home: 280,
          End: this.maximumWidth(),
        };
        if (!Object.hasOwn(values, event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        this.finishDrag(true);
        this.applyWidth(values[event.key]);
        this.persistWidth();
      },
      { signal },
    );
  }

  private async measure(name?: string): Promise<void> {
    const input = this.input;
    const measurements = input?.chart.details?.measurements;
    if (
      !input ||
      input.chart.kind === "image" ||
      !name ||
      !measurements ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) ||
      ["__proto__", "prototype", "constructor"].includes(name) ||
      !Object.hasOwn(measurements, name)
    )
      return;
    const value = measurements[name];
    if (
      !value ||
      !["x", "y"].includes(value.axis) ||
      !Number.isFinite(value.a) ||
      (value.b != null && !Number.isFinite(value.b))
    )
      return;
    const measurement = { ...value };
    this.invalidateMeasurement();
    const generation = this.generation;
    const action = new AbortController();
    this.measurementAction = action;
    this.status.textContent = "Placing measurement…";
    try {
      // Let synchronous navigation/source changes invalidate the action before dispatch.
      await Promise.resolve();
      if (
        this.destroyed ||
        !this.input ||
        action.signal.aborted ||
        generation !== this.generation
      )
        return;
      const applied = await this.options.onMeasure(
        input.workspaceId,
        input.chart.id,
        measurement,
        action.signal,
      );
      if (
        this.destroyed ||
        !this.input ||
        action.signal.aborted ||
        generation !== this.generation
      )
        return;
      const isStep =
        measurement.axis === "x" &&
        (input.chart.records
          ? input.chart.records.x === "step"
          : !input.chart.x && input.chart.config.axis === "step");
      const position = isStep
        ? measurement.b == null
          ? "step"
          : "steps"
        : `${measurement.axis.toUpperCase()} =`;
      this.status.textContent = applied
        ? measurement.b == null
          ? `Cursor placed at ${position} ${measurement.a}.`
          : `Cursors placed at ${position} ${measurement.a} and ${measurement.b}.`
        : "This measurement is not available for the current chart.";
    } catch {
      if (
        !this.destroyed &&
        this.input &&
        !action.signal.aborted &&
        generation === this.generation
      )
        this.status.textContent =
          "The measurement could not be shown. Try again.";
    } finally {
      if (this.measurementAction === action) this.measurementAction = null;
    }
  }

  private invalidateMeasurement(): void {
    ++this.generation;
    const action = this.measurementAction;
    this.measurementAction = null;
    action?.abort();
  }

  private maximumWidth(): number {
    return Math.max(280, Math.min(800, window.innerWidth - 500));
  }

  private applyWidth(value: number): void {
    this.width = Math.round(
      Math.max(280, Math.min(this.maximumWidth(), value)),
    );
    document.body.style.setProperty("--chart-details-width", `${this.width}px`);
    this.separator.setAttribute("aria-valuemin", "280");
    this.separator.setAttribute("aria-valuemax", String(this.maximumWidth()));
    this.separator.setAttribute("aria-valuenow", String(this.width));
    this.separator.setAttribute("aria-valuetext", `${this.width} pixels`);
  }

  private persistWidth(): void {
    try {
      localStorage.setItem(WIDTH_KEY, String(this.width));
    } catch {
      /* Resizing does not depend on storage access. */
    }
  }

  private finishDrag(cancel: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (this.separator.hasPointerCapture(drag.pointerId))
      this.separator.releasePointerCapture(drag.pointerId);
    document.body.classList.remove("chart-details-resizing");
    this.applyWidth(cancel ? drag.width : this.width);
    if (!cancel) this.persistWidth();
  }
}
