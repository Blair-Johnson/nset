import "./run-drawer.css";
import type { Catalog } from "./workspace-types";
import type { Run } from "./api";
import { element } from "./utils";
import { runColorButton } from "./run-color-picker";

export interface RunDrawerState {
  open: boolean;
  query: string;
  status: string;
  scrollTop: number;
}
export const runDrawerState = (): RunDrawerState => ({
  open: !matchMedia("(max-width: 760px)").matches,
  query: "",
  status: "all",
  scrollTop: 0,
});

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
  readonly root = element("aside", "run-drawer");
  readonly backdrop = element("div", "run-drawer-backdrop");
  readonly toggle = element("button", "run-drawer-toggle", "Runs");
  private readonly list = element("div", "run-drawer-list");
  private readonly search = element("input");
  private readonly status = element("select");
  private readonly count = element("span", "drawer-selection-count");
  private readonly matching = element("span", "muted");
  private readonly rows = new Map<
    string,
    { root: HTMLElement; check: HTMLInputElement; run: Run }
  >();
  private readonly narrow = matchMedia("(max-width: 760px)");
  private catalog?: Catalog;
  private selected = new Set<string>();
  private readonly onViewport = () => this.setOpen(!this.narrow.matches, false);

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
    this.toggle.setAttribute("aria-label", "Toggle runs drawer");
    this.toggle.onclick = () => this.setOpen(!state.open);
    const heading = element("div", "run-drawer-heading");
    const close = this.button("Close runs drawer", () => this.setOpen(false));
    close.textContent = "×";
    close.title = "Close runs drawer";
    heading.append(element("strong", "", "Runs"), this.count, close);
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
        value === "all"
          ? "All statuses"
          : value[0].toUpperCase() + value.slice(1),
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
    );
    this.list.onscroll = () => {
      if (this.list.isConnected && !this.root.hidden)
        state.scrollTop = this.list.scrollTop;
    };
    const footer = element("div", "run-drawer-footer");
    footer.append(this.matching, this.button("Open run table", onTable));
    this.root.append(
      heading,
      this.search,
      this.status,
      actions,
      this.list,
      footer,
    );
    this.backdrop.onclick = () => this.setOpen(false);
    this.root.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.setOpen(false);
      }
      if (event.key !== "Tab" || !this.narrow.matches) return;
      const controls = [
        ...this.root.querySelectorAll<HTMLElement>(
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
    this.setOpen(state.open, false);
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
          (!query ||
            `${run.name} ${JSON.stringify(run.params)} ${JSON.stringify(run.tags)}`
              .toLowerCase()
              .includes(query)),
      );
  }
  private filter() {
    const matches = new Set(this.matches().map((run) => run.id));
    for (const [id, row] of this.rows) row.root.hidden = !matches.has(id);
    this.matching.textContent = `${matches.size} matching`;
  }
  setOpen(open: boolean, focus = true) {
    this.state.open = open;
    this.root.hidden = !open;
    this.backdrop.hidden = !open || !this.narrow.matches;
    this.toggle.setAttribute("aria-expanded", String(open));
    if (this.narrow.matches && open) {
      this.root.setAttribute("role", "dialog");
      this.root.setAttribute("aria-modal", "true");
    } else {
      this.root.removeAttribute("role");
      this.root.removeAttribute("aria-modal");
    }
    if (open) {
      this.list.scrollTop = this.state.scrollTop;
      if (focus) this.search.focus({ preventScroll: true });
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
          run.status,
        );
        status.title = run.status;
        row.root.replaceChildren(
          runSwatch(catalog, run.id),
          row.check,
          name,
          status,
        );
        this.list.append(row.root);
      }
      this.filter();
      this.list.scrollTop = this.state.scrollTop;
    }
    for (const [id, row] of this.rows)
      row.check.checked = this.selected.has(id);
    this.count.textContent = `${this.selected.size} selected`;
    this.toggle.textContent = `Runs (${this.selected.size})`;
  }
  restoreScroll() {
    this.list.scrollTop = this.state.scrollTop;
  }
  destroy() {
    this.narrow.removeEventListener("change", this.onViewport);
  }
}
