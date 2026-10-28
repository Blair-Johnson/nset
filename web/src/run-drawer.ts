import { touchPrimary } from "./input-capabilities";
import { uuid } from "./uuid";
import "./run-drawer.css";
import type { Catalog } from "./workspace-types";
import type { Run } from "./api";
import { runStatus, type RunStatusChange } from "./run-status";
import { createRunOrder, runSortState, type RunSortState } from "./run-order";
import { element } from "./utils";
import { runColorButton } from "./run-color-picker";
import { runColor } from "./series-colors";
import { RunFilterControl, RunFilterSession } from "./run-filter-session";
import { activeConditions, emptyFilter, type RunFilter } from "./run-filter";

export interface RunDrawerState {
  open: boolean;
  width: number;
  query: string;
  status: string;
  scrollTop: number;
  selectedOnly?: boolean;
  /** Structured config/tag conditions (filter menu). */
  filter?: RunFilter;
}
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 250;
// Pane preferences belong to the experiment, not a saved chart view.
const preferenceKey = (experimentId: string) => `nset.run-pane.${experimentId}`;
export function runDrawerState(experimentId: string): RunDrawerState {
  const state = {
    open: !matchMedia("(max-width: 760px)").matches,
    width: DEFAULT_WIDTH,
    query: "",
    status: "all",
    scrollTop: 0,
  };
  try {
    const saved = JSON.parse(
      localStorage.getItem(preferenceKey(experimentId)) ?? "null",
    );
    if (typeof saved?.open === "boolean") state.open = saved.open;
    if (typeof saved?.width === "number" && Number.isFinite(saved.width))
      state.width = Math.max(MIN_WIDTH, saved.width);
  } catch {
    /* Storage is optional; malformed or blocked preferences are ignored. */
  }
  return state;
}

/** Refresh only color controls: no selection, chart or history mutation. */
export function refreshRunSwatches(root: ParentNode, catalog: Catalog) {
  for (const host of root.querySelectorAll<HTMLElement>(
    "[data-run-swatch-id]",
  )) {
    const focused = host.contains(document.activeElement);
    host.replaceChildren(runColorButton(catalog, host.dataset.runSwatchId!));
    if (focused)
      host.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }
}
export function runSwatch(catalog: Catalog, runId: string) {
  const host = element("span", "run-swatch");
  host.dataset.runSwatchId = runId;
  host.append(runColorButton(catalog, runId));
  return host;
}

/** Rows are keyed and remain mounted while filtering and selecting. */
export class RunDrawer {
  readonly pane = element("div", "run-pane");
  readonly root = element("aside", "run-drawer");
  readonly divider = element("div", "run-pane-divider");
  readonly backdrop = element("div", "run-drawer-backdrop");
  readonly toggle = element("button", "run-pane-toggle");
  private readonly list = element("div", "run-drawer-list");
  private readonly searchTools = element("div", "run-drawer-search");
  private readonly actions = element("div", "run-drawer-actions");
  private readonly search = element("input");
  private readonly status = element("select");
  private readonly count = element("button", "drawer-selection-count");
  private readonly outside = element("span", "drawer-outside-count");
  private readonly clearFilters = this.button("Clear filters", () => {
    this.state.query = this.search.value = "";
    this.state.status = this.status.value = "all";
    this.session.setSearch("", "all");
    this.session.setFilter(emptyFilter());
    this.filter();
    if (!touchPrimary()) this.search.focus({ preventScroll: true });
  });
  private readonly session: RunFilterSession;
  private readonly ownsSession: boolean;
  private readonly filterControl: RunFilterControl;
  private readonly filterSlot = element("span", "run-filter-slot");
  private readonly empty = element("p", "drawer-empty muted");
  private readonly matching = element("span", "muted");
  private readonly rows = new Map<
    string,
    {
      root: HTMLElement;
      check: HTMLInputElement;
      name: HTMLButtonElement;
      swatch: HTMLElement;
      color: string;
      status: ReturnType<typeof runStatus>;
      run: Run;
    }
  >();
  private readonly narrow = matchMedia("(max-width: 760px)");
  private destroyed = false;
  private catalog?: Catalog;
  private order?: ReturnType<typeof createRunOrder>;
  private runs: Run[] = [];
  private selected = new Set<string>();
  private previousFocus?: HTMLElement;
  private drag?: { pointerId: number; startX: number; width: number };
  private readonly observer = new ResizeObserver(() => this.measure());
  private readonly toolbarObserver = new MutationObserver(() => this.measure());
  private readonly onViewport = () => {
    if (this.narrow.matches) this.setOpen(false, false, false);
    else this.setOpen(this.state.open, false, false);
    this.measure();
  };
  private readonly onGeometry = () => this.measure();
  private readonly onCancel = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.drag) {
      event.preventDefault();
      this.finishResize(true);
    }
  };

  constructor(
    private readonly experimentId: string,
    private readonly state: RunDrawerState,
    private readonly onSelection: (
      ids: string[],
      clearPending?: boolean,
    ) => void,
    private readonly onDetails: (run: Run) => void,
    session?: RunFilterSession,
    private readonly sortState: RunSortState = runSortState(),
    private readonly onStatus?: RunStatusChange,
  ) {
    this.ownsSession = !session;
    this.session = session ?? new RunFilterSession(state.filter);
    if (!session) this.session.setSearch(state.query, state.status);
    state.query = this.session.query;
    state.status = this.session.status;
    this.filterControl = new RunFilterControl(this.session, () => {
      this.state.filter = this.session.filter;
      this.state.query = this.search.value = this.session.query;
      this.state.status = this.status.value = this.session.status;
      this.filter();
    });
    this.state.filter = this.session.filter;
    this.filterSlot.append(this.filterControl.root);
    this.root.id = `runs-${uuid()}`;
    this.root.setAttribute("aria-label", "Chart runs");
    this.toggle.type = "button";
    this.toggle.setAttribute("aria-controls", this.root.id);
    this.toggle.onclick = () => this.setOpen(!state.open);
    this.divider.setAttribute("role", "separator");
    this.divider.setAttribute("aria-label", "Resize run list");
    this.divider.setAttribute("aria-orientation", "vertical");
    this.divider.setAttribute("aria-controls", this.root.id);
    this.divider.title = "Drag to resize run list, or use arrow keys";
    this.divider.onkeydown = (event) => {
      if (event.target !== this.divider || !state.open || this.narrow.matches)
        return;
      const step = event.shiftKey ? 50 : 10;
      const width =
        event.key === "ArrowLeft"
          ? state.width - step
          : event.key === "ArrowRight"
            ? state.width + step
            : event.key === "Home"
              ? MIN_WIDTH
              : event.key === "End"
                ? this.maxWidth()
                : undefined;
      if (width === undefined) return;
      event.preventDefault();
      this.resize(width);
      this.persist();
    };
    this.divider.onpointerdown = (event) => {
      if (
        event.target !== this.divider ||
        !state.open ||
        this.narrow.matches ||
        event.button !== 0
      )
        return;
      event.preventDefault();
      this.divider.focus({ preventScroll: true });
      this.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        width: state.width,
      };
      this.divider.setPointerCapture(event.pointerId);
      document.body.classList.add("resizing-run-pane");
    };
    this.divider.onpointermove = (event) => {
      if (this.drag?.pointerId === event.pointerId)
        this.resize(this.drag.width + event.clientX - this.drag.startX);
    };
    this.divider.onpointerup = () => this.finishResize(false);
    this.divider.onpointercancel = () => this.finishResize(true);
    this.divider.onlostpointercapture = () => this.finishResize(true);
    this.pane.append(this.root, this.divider, this.toggle);
    const heading = element("div", "run-drawer-heading");
    this.list.id = `${this.root.id}-list`;
    this.count.type = "button";
    this.count.setAttribute("aria-controls", this.list.id);
    this.count.title =
      "Show only selected runs; text and status filters still apply";
    this.count.onclick = () => {
      state.selectedOnly = !state.selectedOnly;
      this.filter();
    };
    this.outside.id = `${this.root.id}-outside`;
    this.outside.setAttribute("role", "status");
    this.count.setAttribute("aria-describedby", this.outside.id);
    heading.append(element("strong", "", "Runs"), this.count, this.outside);
    const searchTools = this.searchTools;
    this.clearFilters.className = "drawer-clear-filters";
    this.clearFilters.title =
      "Clear text, status and structured filters; keep Selected mode";
    searchTools.append(this.search, this.filterSlot, this.status);
    this.list.append(this.empty);
    this.root.addEventListener("focusin", (event) => {
      this.previousFocus = event.target as HTMLElement;
    });
    this.search.type = "search";
    this.search.placeholder = "Find runs";
    this.search.setAttribute("aria-label", "Find runs");
    this.search.value = state.query;
    this.search.oninput = () => {
      state.query = this.search.value;
      this.session.setSearch(state.query, state.status);
    };
    this.status.setAttribute("aria-label", "Filter chart runs by status");
    for (const value of ["all", "running", "finished", "failed", "canceled"]) {
      const option = element(
        "option",
        "",
        value === "all" ? "Status" : value[0].toUpperCase() + value.slice(1),
      );
      option.value = value;
      this.status.append(option);
    }
    this.status.value = state.status;
    this.status.onchange = () => {
      state.status = this.status.value;
      this.session.setSearch(state.query, state.status);
    };
    const actions = this.actions;
    actions.append(
      this.button("Select matching", () =>
        this.onSelection([
          ...new Set([
            ...this.selected,
            ...this.matches()
              .filter(
                (run) => !this.state.selectedOnly || this.selected.has(run.id),
              )
              .map((run) => run.id),
          ]),
        ]),
      ),
      this.button("Clear selection", () => this.onSelection([], true)),
      this.clearFilters,
    );
    this.list.onscroll = () => {
      if (this.list.isConnected && !this.root.hidden)
        state.scrollTop = this.list.scrollTop;
    };
    const footer = element("div", "run-drawer-footer");
    footer.append(this.matching);
    this.root.append(heading, searchTools, actions, this.list, footer);
    this.backdrop.onclick = () => this.setOpen(false);
    this.pane.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (this.drag) this.finishResize(true);
        else this.setOpen(false);
      }
      if (event.key !== "Tab" || !this.narrow.matches) return;
      const controls = [
        ...this.pane.querySelectorAll<HTMLElement>(
          "button,input,select,a[href]",
        ),
      ].filter(
        (node) =>
          node.getClientRects().length && !node.hasAttribute("disabled"),
      );
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    this.narrow.addEventListener("change", this.onViewport);
    window.addEventListener("resize", this.onGeometry);
    window.addEventListener("scroll", this.onGeometry, { passive: true });
    window.addEventListener("keydown", this.onCancel);
    this.setOpen(state.open, false, false);
  }
  private button(label: string, action: () => void) {
    const button = element("button", "", label);
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.onclick = action;
    return button;
  }
  private matches() {
    return [...this.rows.values()]
      .map((row) => row.run)
      .filter((run) => this.session.matches(run));
  }
  private filter() {
    const matches = new Set(this.matches().map((run) => run.id));
    const rows = [...this.rows.entries()];
    const focusedIndex = rows.findIndex(([, row]) =>
      row.root.contains(document.activeElement),
    );
    let visible = 0;
    for (const [id, row] of rows) {
      row.root.hidden =
        !matches.has(id) ||
        (!!this.state.selectedOnly && !this.selected.has(id));
      if (!row.root.hidden) visible++;
      else row.status.closeMenu();
    }
    const outside = [...this.selected].filter((id) => !matches.has(id)).length;
    this.count.textContent = `Selected (${this.selected.size})`;
    this.count.setAttribute("aria-pressed", String(!!this.state.selectedOnly));
    this.outside.hidden = outside === 0;
    this.outside.textContent = outside ? `· ${outside} outside filters` : "";
    this.outside.setAttribute(
      "aria-label",
      `${this.selected.size} selected · ${outside} outside filters`,
    );
    this.clearFilters.hidden =
      !this.state.query &&
      this.state.status === "all" &&
      !activeConditions(this.session.filter).length;
    this.matching.textContent = this.state.selectedOnly
      ? `${visible} of ${this.selected.size} selected shown`
      : `${matches.size} matching`;
    this.empty.hidden = visible > 0 || !!this.session.error;
    this.empty.textContent = this.state.selectedOnly
      ? this.selected.size
        ? "No selected runs match these filters. Clear filters or turn off Selected."
        : "No runs selected. Turn off Selected to browse runs."
      : this.session.error || this.session.pending
        ? ""
        : "No runs match these filters. Clear filters to browse runs.";
    // Only move focus when its keyed row actually disappears. Rollback leaves
    // the accepted selection unchanged, so failed writes keep the same checkbox.
    if (focusedIndex >= 0 && rows[focusedIndex][1].root.hidden) {
      const next =
        rows.slice(focusedIndex + 1).find(([, row]) => !row.root.hidden) ??
        rows
          .slice(0, focusedIndex)
          .reverse()
          .find(([, row]) => !row.root.hidden);
      (next?.[1].check ?? this.count).focus({ preventScroll: true });
    }
    this.measure();
  }
  /** Called after mounting; charts and list nodes never move during resizing. */
  mount() {
    if (this.pane.parentElement) this.observer.observe(this.pane.parentElement);
    const toolbar = this.pane.parentElement?.previousElementSibling;
    if (toolbar?.matches(".workspace-toolbar")) this.observer.observe(toolbar);
    for (const row of [this.searchTools, this.actions]) {
      this.observer.observe(row);
      this.toolbarObserver.observe(row, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["hidden", "class", "style"],
      });
    }
    this.measure();
    this.restoreScroll();
  }
  private minWidth() {
    if (this.root.hidden) return MIN_WIDTH;
    const px = (value: string) => Number.parseFloat(value) || 0;
    const horizontalInsets = (style: CSSStyleDeclaration) =>
      px(style.paddingLeft) +
      px(style.paddingRight) +
      px(style.borderLeftWidth) +
      px(style.borderRightWidth);
    const rowWidth = (row: HTMLElement, controls: Element[]) => {
      const visible = controls.filter(
        (control) => control.getClientRects().length,
      );
      const style = getComputedStyle(row);
      return (
        horizontalInsets(style) +
        Math.max(0, visible.length - 1) * px(style.columnGap) +
        visible.reduce((width, control) => {
          // Observe intrinsic control changes too (fonts, labels and filter UI).
          this.observer.observe(control);
          const controlStyle = getComputedStyle(control);
          return (
            width +
            (control === this.search
              ? px(controlStyle.minWidth)
              : control.getBoundingClientRect().width)
          );
        }, 0)
      );
    };
    return Math.max(
      MIN_WIDTH,
      Math.ceil(
        horizontalInsets(getComputedStyle(this.root)) +
          Math.max(
            rowWidth(this.searchTools, [
              this.search,
              this.filterControl.root,
              this.status,
            ]),
            rowWidth(this.actions, [...this.actions.children]),
          ),
      ),
    );
  }
  private maxWidth() {
    if (this.narrow.matches) return Math.min(600, Math.max(0, innerWidth - 40));
    return Math.max(
      MIN_WIDTH,
      (this.pane.parentElement?.clientWidth ?? innerWidth) / 2,
    );
  }
  private measure() {
    if (!this.pane.isConnected) return;
    const toolbar = this.pane.parentElement?.previousElementSibling;
    const inset = Math.max(
      46,
      toolbar?.matches(".workspace-toolbar")
        ? toolbar.getBoundingClientRect().bottom
        : 46,
    );
    this.pane.style.setProperty("--run-pane-top", `${inset}px`);
    const top = Math.max(
      inset,
      this.pane.parentElement?.getBoundingClientRect().top ?? inset,
    );
    this.pane.style.setProperty(
      "--run-pane-height",
      `${Math.max(120, window.innerHeight - top - 12)}px`,
    );
    this.resize(this.state.width);
  }
  private resize(width: number) {
    const max = this.maxWidth();
    // A constrained viewport wins over the single-line minimum; CSS wraps rows.
    const min = Math.min(max, this.minWidth());
    this.state.width = Math.max(min, Math.min(max, width));
    this.pane.style.setProperty("--run-pane-width", `${this.state.width}px`);
    this.divider.setAttribute("aria-valuemin", String(min));
    this.divider.setAttribute("aria-valuemax", String(max));
    this.divider.setAttribute(
      "aria-valuenow",
      String(Math.round(this.state.width)),
    );
    this.divider.setAttribute(
      "aria-valuetext",
      `${Math.round(this.state.width)} pixels`,
    );
  }
  private finishResize(cancel: boolean) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    if (cancel) this.resize(drag.width);
    else this.persist();
    if (this.divider.hasPointerCapture(drag.pointerId))
      this.divider.releasePointerCapture(drag.pointerId);
    document.body.classList.remove("resizing-run-pane");
  }
  private persist() {
    try {
      localStorage.setItem(
        preferenceKey(this.experimentId),
        JSON.stringify({
          ...JSON.parse(
            localStorage.getItem(preferenceKey(this.experimentId)) ?? "{}",
          ),
          open: this.state.open,
          width: this.state.width,
          filter: this.session.filter,
        }),
      );
    } catch {
      /* Browser preferences must not block chart interactions. */
    }
  }
  setOpen(open: boolean, focus = true, persist = true) {
    this.finishResize(true);
    if (!open && this.root.contains(document.activeElement))
      this.previousFocus = document.activeElement as HTMLElement;
    if (!open && this.root.isConnected && !this.root.hidden)
      this.state.scrollTop = this.list.scrollTop;
    if (!open) for (const row of this.rows.values()) row.status.closeMenu();
    this.state.open = open;
    this.root.hidden = !open;
    this.pane.classList.toggle("is-collapsed", !open);
    this.backdrop.hidden = !open || !this.narrow.matches;
    this.toggle.setAttribute("aria-expanded", String(open));
    this.toggle.setAttribute(
      "aria-label",
      open ? "Collapse run list" : "Expand run list",
    );
    this.toggle.title = open ? "Collapse run list" : "Expand run list";
    this.toggle.textContent = open ? "\u2039" : "\u203a";
    this.divider.tabIndex = open && !this.narrow.matches ? 0 : -1;
    this.divider.setAttribute(
      "aria-disabled",
      String(!open || this.narrow.matches),
    );
    if (this.narrow.matches && open) {
      this.pane.setAttribute("role", "dialog");
      this.pane.setAttribute("aria-label", "Chart runs");
      this.pane.setAttribute("aria-modal", "true");
    } else {
      this.pane.removeAttribute("role");
      this.pane.removeAttribute("aria-modal");
      this.pane.removeAttribute("aria-label");
    }
    this.measure();
    if (persist) this.persist();
    if (open) {
      this.list.scrollTop = this.state.scrollTop;
      if (focus)
        (touchPrimary()
          ? this.toggle
          : this.previousFocus?.isConnected
            ? this.previousFocus
            : this.search
        ).focus({ preventScroll: true });
    } else if (focus) this.toggle.focus({ preventScroll: true });
  }
  update(catalog: Catalog, selectedIds: string[]) {
    if (this.destroyed) return;
    this.selected = new Set(selectedIds);
    if (catalog !== this.catalog) {
      this.catalog = catalog;
      const runs = catalog.runs.filter(
        (run) => run.experiment_id === this.experimentId,
      );
      this.runs = runs;
      this.order = createRunOrder(runs, catalog.series);
      const keep = new Set(runs.map((run) => run.id));
      for (const [id, row] of this.rows)
        if (!keep.has(id)) {
          row.status.destroy();
          row.root.remove();
          this.rows.delete(id);
        }
      for (const run of runs) {
        let row = this.rows.get(run.id);
        if (!row) {
          const root = element("div", "run-drawer-row");
          root.dataset.runId = run.id;
          const check = element("input");
          check.type = "checkbox";
          check.onchange = () =>
            this.onSelection(
              check.checked
                ? [...this.selected, run.id]
                : [...this.selected].filter((id) => id !== run.id),
            );
          const name = this.button(run.name, () => {
            const current = this.rows.get(run.id)?.run;
            if (current) this.onDetails(current);
          });
          name.className = "text-link drawer-run-name";
          const swatch = runSwatch(catalog, run.id);
          const status = runStatus(
            run,
            this.onStatus
              ? async (current, status) => {
                  const saved = await this.onStatus!(current, status);
                  if (!this.destroyed && this.catalog)
                    this.update(
                      {
                        ...this.catalog,
                        runs: this.catalog.runs.map((candidate) =>
                          candidate.id === saved.id ? saved : candidate,
                        ),
                      },
                      [...this.selected],
                    );
                  return saved;
                }
              : undefined,
            true,
          );
          status
            .querySelector(".run-status-label")
            ?.classList.add("drawer-run-status");
          row = {
            root,
            check,
            name,
            swatch,
            color: runColor(catalog, run.id),
            status,
            run,
          };
          root.append(swatch, check, name, status);
          this.rows.set(run.id, row);
          this.list.append(root);
        }
        const color = runColor(catalog, run.id);
        if (row.color !== color) {
          const focused = row.swatch.contains(document.activeElement);
          const swatch = runSwatch(catalog, run.id);
          row.swatch.replaceWith(swatch);
          row.swatch = swatch;
          row.color = color;
          if (focused)
            swatch.querySelector("button")?.focus({ preventScroll: true });
        }
        row.run = run;
        row.check.setAttribute("aria-label", `Show ${run.name}`);
        row.name.textContent = run.name;
        row.name.title = run.name;
        row.status.updateRun(run);
      }
      this.session.setRuns(
        runs,
        catalog,
        catalog.rx?.id === this.experimentId ? catalog.rx : undefined,
      );
      this.list.scrollTop = this.state.scrollTop;
    }
    // Always start from catalog order so ties never inherit a previous sort.
    // Reuse keyed rows, including when a suspended dashboard resumes with the
    // same catalog but a different table sort.
    const ordered = (this.order?.sort(this.runs, this.sortState) ?? []).map(
      (run) => [run.id, this.rows.get(run.id)!] as const,
    );
    const focused = this.list.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : undefined;
    this.rows.clear();
    let next = this.list.firstElementChild;
    for (const [id, row] of ordered) {
      this.rows.set(id, row);
      if (row.root !== next) this.list.insertBefore(row.root, next);
      next = row.root.nextElementSibling;
      row.check.checked = this.selected.has(id);
    }
    if (focused && document.activeElement !== focused)
      focused.focus({ preventScroll: true });
    this.filter();
  }
  /** Scalar summaries can change ordering without rebuilding controls or filters. */
  updateMetrics(catalog: Catalog) {
    if (!this.catalog) return;
    this.order = createRunOrder(this.runs, catalog.series);
    this.update(this.catalog, [...this.selected]);
  }
  restoreScroll() {
    this.list.scrollTop = this.state.scrollTop;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const row of this.rows.values()) row.status.destroy();
    this.filterControl.destroy();
    if (this.ownsSession) this.session.destroy();
    this.finishResize(true);
    this.observer.disconnect();
    this.toolbarObserver.disconnect();
    this.narrow.removeEventListener("change", this.onViewport);
    window.removeEventListener("resize", this.onGeometry);
    window.removeEventListener("scroll", this.onGeometry);
    window.removeEventListener("keydown", this.onCancel);
  }
}
