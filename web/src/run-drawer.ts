import "./run-drawer.css";
import type { Catalog } from "./workspace-types";
import type { Run } from "./api";
import { element } from "./utils";
import { runColorButton } from "./run-color-picker";
import { RunFilterMenu } from "./run-filter-menu";
import {
  activeConditions,
  emptyFilter,
  runMatchesFilter,
  type RunFilter,
} from "./run-filter";

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
      state.width = Math.max(MIN_WIDTH, Math.min(600, saved.width));
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
  private readonly search = element("input");
  private readonly status = element("select");
  private readonly count = element("button", "drawer-selection-count");
  private readonly outside = element("span", "drawer-outside-count");
  private readonly clearFilters = this.button("Clear filters", () => {
    this.state.query = this.search.value = "";
    this.state.status = this.status.value = "all";
    this.state.filter = emptyFilter();
    this.filterMenu = this.makeFilterMenu();
    this.filter();
    this.search.focus({ preventScroll: true });
  });
  private filterMenu?: RunFilterMenu;
  private readonly filterSlot = element("span", "run-filter-slot");
  private readonly empty = element("p", "drawer-empty muted");
  private readonly matching = element("span", "muted");
  private readonly rows = new Map<
    string,
    { root: HTMLElement; check: HTMLInputElement; run: Run }
  >();
  private readonly narrow = matchMedia("(max-width: 760px)");
  private catalog?: Catalog;
  private selected = new Set<string>();
  private previousFocus?: HTMLElement;
  private drag?: { pointerId: number; startX: number; width: number };
  private readonly observer = new ResizeObserver(() => this.measure());
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
    private readonly onSelection: (ids: string[]) => void,
    onTable: () => void,
    private readonly onDetails: (run: Run) => void,
  ) {
    this.root.id = `runs-${crypto.randomUUID()}`;
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
      if (event.target !== this.divider || !state.open) return;
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
    const searchTools = element("div", "run-drawer-search");
    this.clearFilters.className = "drawer-clear-filters";
    this.clearFilters.title =
      "Clear text and status filters; keep Selected mode";
    searchTools.append(this.search, this.filterSlot, this.status);
    this.filterMenu = this.makeFilterMenu();
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
      this.filter();
    };
    this.status.setAttribute("aria-label", "Filter chart runs by status");
    for (const value of ["all", "running", "finished", "failed"]) {
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
      this.filter();
    };
    const actions = element("div", "run-drawer-actions");
    actions.append(
      this.button("Select matching", () =>
        this.onSelection([
          ...new Set([...this.selected, ...this.matches().map((r) => r.id)]),
        ]),
      ),
      this.button("Clear selection", () => this.onSelection([])),
      this.clearFilters,
    );
    this.list.onscroll = () => {
      if (this.list.isConnected && !this.root.hidden)
        state.scrollTop = this.list.scrollTop;
    };
    const footer = element("div", "run-drawer-footer");
    footer.append(this.matching, this.button("Open run table", onTable));
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
  private makeFilterMenu() {
    const menu = new RunFilterMenu(
      this.state.filter ?? emptyFilter(),
      (filter) => {
        this.state.filter = filter;
        this.filter();
      },
      (filter) =>
        [...this.rows.values()].filter((row) =>
          runMatchesFilter(row.run, filter),
        ).length,
    );
    menu.setRuns([...this.rows.values()].map((row) => row.run));
    this.filterSlot.replaceChildren(menu.root);
    return menu;
  }
  private button(label: string, action: () => void) {
    const button = element("button", "", label);
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.onclick = action;
    return button;
  }
  private matches() {
    const query = this.state.query.trim().toLowerCase();
    return [...this.rows.values()]
      .map((row) => row.run)
      .filter(
        (run) =>
          (this.state.status === "all" || run.status === this.state.status) &&
          runMatchesFilter(run, this.state.filter) &&
          (!query ||
            `${run.name} ${JSON.stringify(run.params)} ${JSON.stringify(run.tags)}`
              .toLowerCase()
              .includes(query)),
      );
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
      !activeConditions(this.state.filter).length;
    this.matching.textContent = this.state.selectedOnly
      ? `${visible} of ${this.selected.size} selected shown`
      : `${matches.size} matching`;
    this.empty.hidden = visible > 0;
    this.empty.textContent = this.state.selectedOnly
      ? this.selected.size
        ? "No selected runs match these filters. Clear filters or turn off Selected."
        : "No runs selected. Turn off Selected to browse runs."
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
  }
  /** Called after mounting; charts and list nodes never move during resizing. */
  mount() {
    if (this.pane.parentElement) this.observer.observe(this.pane.parentElement);
    this.measure();
    this.restoreScroll();
  }
  private maxWidth() {
    if (this.narrow.matches) return 600;
    return Math.max(
      MIN_WIDTH,
      Math.min(600, (this.pane.parentElement?.clientWidth ?? 1020) - 420),
    );
  }
  private measure() {
    if (!this.pane.isConnected) return;
    const top = Math.max(
      46,
      this.pane.parentElement?.getBoundingClientRect().top ?? 46,
    );
    this.pane.style.setProperty(
      "--run-pane-height",
      `${Math.max(120, window.innerHeight - top - 12)}px`,
    );
    this.resize(this.state.width);
  }
  private resize(width: number) {
    this.state.width = Math.max(MIN_WIDTH, Math.min(this.maxWidth(), width));
    this.pane.style.setProperty("--run-pane-width", `${this.state.width}px`);
    this.divider.setAttribute("aria-valuemin", String(MIN_WIDTH));
    this.divider.setAttribute("aria-valuemax", String(this.maxWidth()));
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
        JSON.stringify({ open: this.state.open, width: this.state.width }),
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
        (this.previousFocus?.isConnected
          ? this.previousFocus
          : this.search
        ).focus({ preventScroll: true });
    } else if (focus) this.toggle.focus({ preventScroll: true });
  }
  update(catalog: Catalog, selectedIds: string[]) {
    this.selected = new Set(selectedIds);
    if (catalog !== this.catalog) {
      this.catalog = catalog;
      const runs = catalog.runs.filter(
        (run) => run.experiment_id === this.experimentId,
      );
      const keep = new Set(runs.map((run) => run.id));
      for (const [id, row] of this.rows)
        if (!keep.has(id)) {
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
          row = { root, check, run };
          this.rows.set(run.id, row);
        }
        row.run = run;
        row.check.setAttribute("aria-label", `Show ${run.name}`);
        const name = this.button(run.name, () => this.onDetails(run));
        name.className = "text-link drawer-run-name";
        name.title = run.name;
        const status = element(
          "span",
          `drawer-run-status status-${run.status}`,
          run.rx?.state ?? run.status,
        );
        status.title = run.rx?.state ?? run.status;
        row.root.replaceChildren(
          runSwatch(catalog, run.id),
          row.check,
          name,
          status,
        );
        this.list.append(row.root);
      }
      this.filterMenu?.setRuns(runs);
      this.list.scrollTop = this.state.scrollTop;
    }
    for (const [id, row] of this.rows)
      row.check.checked = this.selected.has(id);
    this.filter();
  }
  restoreScroll() {
    this.list.scrollTop = this.state.scrollTop;
  }
  destroy() {
    this.finishResize(true);
    this.observer.disconnect();
    this.narrow.removeEventListener("change", this.onViewport);
    window.removeEventListener("resize", this.onGeometry);
    window.removeEventListener("scroll", this.onGeometry);
    window.removeEventListener("keydown", this.onCancel);
  }
}
