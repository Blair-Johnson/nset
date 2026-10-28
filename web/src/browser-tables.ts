import type { Catalog } from "./workspace-types";
import type { Experiment, Run } from "./api";
import { element } from "./utils";
import { runSwatch } from "./run-drawer";
import { runColor } from "./series-colors";
import { RunFilterControl, RunFilterSession } from "./run-filter-session";
import { parameterLabel } from "./run-table-fields";
import { createRunOrder, runSortState, type RunSortState } from "./run-order";

export interface TableState extends RunSortState {
  query: string;
  status: string;
  page: number;
  metrics: string[] | null;
  parameters?: string[];
  columnQuery?: string;
}
export const tableState = (): TableState => ({
  query: "",
  status: "all",
  ...runSortState(),
  page: 0,
  metrics: null,
});
export const timeLabel = (time: number) =>
  !Number.isFinite(new Date(time).getTime())
    ? "Unknown"
    : new Date(time).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
export const numberLabel = (value: number | null | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(
        value,
      );
export const textValue = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);
const button = (text: string, action: () => void, className = "") => {
  const node = element("button", className, text);
  node.type = "button";
  node.onclick = action;
  return node;
};
const input = (label: string, value: string) => {
  const node = element("input");
  node.type = "search";
  node.placeholder = label;
  node.setAttribute("aria-label", label);
  node.value = value;
  return node;
};
const cell = (text: string, className = "") => element("td", className, text);
const pageSize = 50;
const setText = (node: HTMLElement, text: string) => {
  if (node.textContent !== text) node.textContent = text;
};

export function experimentTable(
  catalog: Catalog,
  onOpen: (id: string) => void,
  state = tableState(),
): HTMLElement & { updateCatalog(next: Catalog): void } {
  const host = element("section", "browser-panel");
  const tools = element("div", "table-toolbar");
  const search = input("Search experiments", state.query);
  const count = element("span", "muted");
  tools.append(search, count);
  const wrap = element("div", "table-scroll");
  const table = element("table", "data-table");
  const head = element("thead");
  const row = element("tr");
  const headers = [
    ["name", "Experiment"],
    ["runs", "Runs"],
    ["created_at", "Created"],
  ];
  for (const [key, label] of headers) {
    const th = element("th");
    th.append(
      button(
        label,
        () => {
          state.descending = state.sort === key ? !state.descending : false;
          state.sort = key;
          render();
        },
        "sort-button",
      ),
    );
    row.append(th);
  }
  head.append(row);
  const body = element("tbody");
  table.append(head, body);
  wrap.append(table);
  const pager = element("div", "table-pager");
  host.append(tools, wrap, pager);
  const counts = new Map<string, number>();
  let renderedBody = "";
  function refreshCounts() {
    counts.clear();
    for (const run of catalog.runs)
      counts.set(run.experiment_id, (counts.get(run.experiment_id) ?? 0) + 1);
  }
  function render() {
    const q = state.query.trim().toLowerCase();
    const rows = catalog.experiments
      .filter((e) => e.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const result =
          state.sort === "name"
            ? a.name.localeCompare(b.name)
            : state.sort === "runs"
              ? (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0)
              : a.created_at - b.created_at;
        return (state.descending ? -1 : 1) * result;
      });
    state.page = Math.min(
      state.page,
      Math.max(0, Math.ceil(rows.length / pageSize) - 1),
    );
    setText(
      count,
      `${rows.length} ${rows.length === 1 ? "experiment" : "experiments"}`,
    );
    const pageRows = rows.slice(
      state.page * pageSize,
      (state.page + 1) * pageSize,
    );
    const signature = JSON.stringify([
      pageRows.map((experiment) => [
        experiment,
        counts.get(experiment.id) ?? 0,
      ]),
      !!catalog.experiments.length,
    ]);
    if (signature !== renderedBody) {
      renderedBody = signature;
      const active = document.activeElement;
      const focusedId =
        active instanceof HTMLButtonElement && body.contains(active)
          ? active.dataset.experimentId
          : undefined;
      const { scrollTop, scrollLeft } = wrap;
      body.replaceChildren();
      for (const experiment of pageRows) {
        const tr = element("tr");
        const name = cell("");
        const link = button(
          experiment.name,
          () => onOpen(experiment.id),
          "text-link experiment-link",
        );
        link.dataset.experimentId = experiment.id;
        name.append(link);
        tr.append(
          name,
          cell(String(counts.get(experiment.id) ?? 0)),
          cell(timeLabel(experiment.created_at), "muted"),
        );
        body.append(tr);
      }
      if (!rows.length) {
        const tr = element("tr");
        const td = cell(
          catalog.experiments.length
            ? "No experiments match your search."
            : "No experiments yet. Log a run to get started.",
          "empty-table",
        );
        td.colSpan = 3;
        tr.append(td);
        body.append(tr);
      }
      if (focusedId)
        Array.from(
          body.querySelectorAll<HTMLButtonElement>("[data-experiment-id]"),
        )
          .find((link) => link.dataset.experimentId === focusedId)
          ?.focus({ preventScroll: true });
      wrap.scrollTop = scrollTop;
      wrap.scrollLeft = scrollLeft;
    }
    pagination(pager, rows.length, state, render);
  }
  search.oninput = () => {
    state.query = search.value;
    state.page = 0;
    render();
  };
  refreshCounts();
  render();
  return Object.assign(host, {
    updateCatalog(next: Catalog) {
      catalog = next;
      refreshCounts();
      render();
    },
  });
}
function pagination(
  host: HTMLElement,
  total: number,
  state: TableState,
  render: () => void,
) {
  const signature = `${total}:${state.page}`;
  if (host.dataset.pagination === signature) return;
  host.dataset.pagination = signature;
  const active = document.activeElement;
  const focusedAction =
    active instanceof HTMLButtonElement && host.contains(active)
      ? active.dataset.pageAction
      : undefined;
  host.replaceChildren();
  if (total <= pageSize) return;
  const previous = button("Previous", () => {
    state.page--;
    render();
  });
  previous.dataset.pageAction = "previous";
  previous.disabled = state.page === 0;
  const next = button("Next", () => {
    state.page++;
    render();
  });
  next.dataset.pageAction = "next";
  next.disabled = (state.page + 1) * pageSize >= total;
  host.append(
    element(
      "span",
      "muted",
      `${state.page * pageSize + 1}–${Math.min(total, (state.page + 1) * pageSize)} of ${total}`,
    ),
    previous,
    next,
  );
  if (focusedAction) {
    const target = focusedAction === "next" ? next : previous;
    (target.disabled ? (target === next ? previous : next) : target).focus({
      preventScroll: true,
    });
  }
}

export function runTable(
  catalog: Catalog,
  experiment: Experiment,
  selectedIds: string[],
  onSelection: (ids: string[], clearPending?: boolean) => boolean | void,
  onCharts: () => void,
  onDetails: (run: Run) => void,
  state = tableState(),
  session?: RunFilterSession,
  getSelection?: () => string[],
  hasPendingSelection?: () => boolean,
): HTMLElement & { updateCatalog(next: Catalog): void; destroy(): void } {
  const host = element("section", "browser-panel");
  const filterSession = session ?? new RunFilterSession();
  if (!session) filterSession.setSearch(state.query, state.status);
  state.query = filterSession.query;
  state.status = filterSession.status;
  let destroyed = false;
  let renderedRows: Run[] = [];
  let renderedPending = false;
  let renderedError = "";
  let selection = new Set(selectedIds);
  let runs = catalog.runs.filter((r) => r.experiment_id === experiment.id);
  let runRevision = JSON.stringify(runs);
  filterSession.setRuns(
    runs,
    catalog,
    catalog.rx?.id === experiment.id ? catalog.rx : undefined,
  );
  let { summaries, parameters, sort } = createRunOrder(runs, catalog.series);
  let keys = [
    ...new Set([...summaries.values()].flatMap((m) => [...m.keys()])),
  ].sort();
  if (state.metrics === null) state.metrics = keys.slice(0, 3);
  state.parameters ??= [];
  let parameterFields = new Map(
    [...parameters.values()].flatMap((fields) => [...fields]),
  );
  // Friendly dotted labels, except where a literal-dot key would make two fields
  // read identically; those keep their exact JSONPath so they stay distinguishable.
  const labelCounts = new Map<string, number>();
  function refreshLabels() {
    labelCounts.clear();
    for (const field of parameterFields.values())
      labelCounts.set(field.label, (labelCounts.get(field.label) ?? 0) + 1);
  }
  refreshLabels();
  const parameterName = (key: string) => {
    const label = parameterFields.get(key)?.label;
    return label && labelCounts.get(label) === 1 ? label : key;
  };
  const tools = element("div", "table-toolbar");
  const search = input("Search runs, parameters or tags", state.query);
  const status = element("select");
  status.setAttribute("aria-label", "Run status");
  for (const [value, label] of [
    ["all", "All statuses"],
    ["running", "Running"],
    ["finished", "Finished"],
    ["failed", "Failed"],
  ]) {
    const option = element("option", "", label);
    option.value = value;
    status.append(option);
  }
  status.value = state.status;
  const columns = element("details", "menu");
  const columnsSummary = element("summary", "", "Columns");
  columns.append(columnsSummary);
  const columnMenu = element("div", "menu-popover column-picker");
  const columnSearch = input("Search columns", state.columnQuery ?? "");
  const choices = element("div", "column-choices");
  const empty = element("span", "muted", "No matching columns");
  empty.setAttribute("role", "status");
  const groups: {
    group: HTMLElement;
    options: { label: HTMLElement; search: string }[];
  }[] = [];
  let renderedColumns = "";
  function renderColumns() {
    const signature = JSON.stringify([
      keys,
      [...parameterFields].map(([key, field]) => [
        key,
        field.label,
        field.search,
      ]),
    ]);
    if (signature === renderedColumns) return;
    renderedColumns = signature;
    const active = document.activeElement;
    const focused =
      active instanceof HTMLInputElement && choices.contains(active)
        ? { kind: active.dataset.columnKind, key: active.dataset.columnKey }
        : undefined;
    const scrollTop = choices.scrollTop;
    groups.length = 0;
    choices.replaceChildren();
    for (const [kind, title, fields] of [
      [
        "metrics",
        "Metrics · latest",
        keys.map((key) => [key, key.toLowerCase()]),
      ],
      [
        "parameters",
        "Parameters",
        [...parameterFields]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, field]) => [key, field.search]),
      ],
    ] as const) {
      const group = element("fieldset", "column-group");
      group.append(element("legend", "", title));
      const options: { label: HTMLElement; search: string }[] = [];
      for (const [key, searchable] of fields) {
        const label = element("label", "check-option");
        const check = element("input");
        check.type = "checkbox";
        check.dataset.columnKind = kind;
        check.dataset.columnKey = key;
        check.checked = state[kind]!.includes(key);
        check.onchange = () => {
          state[kind] = check.checked
            ? [...state[kind]!, key]
            : state[kind]!.filter((k) => k !== key);
          render();
        };
        label.append(
          check,
          element("span", "", kind === "parameters" ? parameterName(key) : key),
        );
        label.title = kind === "metrics" ? `${key} · latest logged value` : key;
        group.append(label);
        options.push({ label, search: searchable });
      }
      groups.push({ group, options });
      choices.append(group);
    }

    filterColumns(false);
    if (focused)
      Array.from(choices.querySelectorAll<HTMLInputElement>("input"))
        .find(
          (check) =>
            check.dataset.columnKind === focused.kind &&
            check.dataset.columnKey === focused.key,
        )
        ?.focus({ preventScroll: true });
    choices.scrollTop = scrollTop;
  }
  function filterColumns(resetScroll = true) {
    const query = columnSearch.value.trim().toLowerCase();
    state.columnQuery = columnSearch.value;
    let matches = 0;
    for (const { group, options } of groups) {
      let count = 0;
      for (const option of options) {
        option.label.hidden = !option.search.includes(query);
        if (!option.label.hidden) count++;
      }
      group.hidden = count === 0;
      matches += count;
    }
    empty.hidden = matches > 0;
    if (resetScroll) choices.scrollTop = 0;
  }
  columnSearch.oninput = () => filterColumns();
  columns.onkeydown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    columns.open = false;
    columnsSummary.focus();
  };
  columnMenu.append(columnSearch, choices, empty);
  renderColumns();
  columns.append(columnMenu);
  const chartButton = button("View charts", onCharts, "primary");
  const selected = element("span", "selection-count");
  const clear = button(
    "Clear",
    () => {
      selection.clear();
      changed(true);
    },
    "text-link",
  );
  const filterSlot = element("span", "run-filter-slot");
  tools.append(
    search,
    filterSlot,
    status,
    columns,
    selected,
    clear,
    chartButton,
  );
  const wrap = element("div", "table-scroll run-table-scroll");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Scrollable runs table");
  const table = element("table", "data-table run-table");
  table.setAttribute("aria-label", "Runs");
  const head = element("thead");
  const body = element("tbody");
  table.append(head, body);
  wrap.append(table);
  const pager = element("div", "table-pager");
  const footer = element("div", "table-footer");
  const summary = element("span", "table-summary");
  summary.setAttribute("aria-live", "polite");
  const below = element("span", "table-more-below");
  below.hidden = true;
  footer.append(summary, below, pager);
  host.classList.add("run-browser");
  host.append(tools, wrap, footer);
  // "More below" tracks the native scroll viewport, not the page.
  let belowFrame = 0;
  const updateBelow = () => {
    if (destroyed) return;
    const hiddenPx = wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop;
    const rowHeight =
      body.querySelector("tr")?.getBoundingClientRect().height || 35;
    const rows = Math.ceil(Math.max(0, hiddenPx - 1) / rowHeight);
    below.hidden = rows <= 0;
    setText(below, `↓ ${rows} more below`);
  };
  wrap.addEventListener("scroll", updateBelow, { passive: true });
  const observer = new ResizeObserver(updateBelow);
  observer.observe(wrap);
  // Fill exactly to the bottom of the viewport from wherever the panel starts.
  const fit = () => {
    if (!host.isConnected) {
      window.removeEventListener("resize", fit);
      return;
    }
    const top = host.getBoundingClientRect().top + window.scrollY;
    host.style.setProperty("--run-browser-top", `${Math.max(0, top)}px`);
  };
  window.addEventListener("resize", fit);
  const fitFrame = requestAnimationFrame(fit);
  function changed(clearPending = false) {
    if (onSelection([...selection], clearPending) === false)
      selection = new Set(selectedIds);
    else {
      selectedIds = getSelection?.() ?? [...selection];
      selection = new Set(selectedIds);
    }
    render();
  }
  function visible() {
    return sort(
      runs.filter((run) => filterSession.matches(run)),
      state,
    );
  }
  let renderedHeader = "";
  let renderedBody = "";
  function render() {
    if (destroyed) return;
    const { scrollTop, scrollLeft } = wrap;
    // When filtering/sorting or live data rebuild controls, retain identity, not a detached
    // element or row index (names may repeat and sorting may change).
    const active = document.activeElement;
    const focused =
      active instanceof HTMLInputElement && table.contains(active)
        ? active
        : null;
    const focusedRunId = focused?.dataset.runId;
    const focusedAll = focused?.dataset.selectAll !== undefined;
    const focusedSort =
      active instanceof HTMLButtonElement && head.contains(active)
        ? active.dataset.sortKey
        : undefined;
    const focusedButton =
      active instanceof HTMLButtonElement && body.contains(active)
        ? {
            runId: active.closest<HTMLTableRowElement>("tr")?.dataset.runId,
            color: active.classList.contains("run-color-button"),
          }
        : undefined;
    let restoreFocus: HTMLElement | undefined;
    const rows = visible();
    renderedRows = rows;
    renderedPending = filterSession.pending > 0;
    renderedError = filterSession.error;
    state.page = Math.min(
      state.page,
      Math.max(0, Math.ceil(rows.length / pageSize) - 1),
    );
    setText(selected, `${selection.size} selected`);
    clear.hidden = !selection.size && !hasPendingSelection?.();
    chartButton.disabled = !selection.size;
    const headerFields = [
      ["name", "Run"],
      ["status", "Status"],
      ["created_at", "Created"],
      ...state.metrics!.map((k) => [`metric:${k}`, `${k} · latest`]),
      ...state.parameters!.map((k) => [`parameter:${k}`, parameterName(k)]),
    ];
    const headerSignature = JSON.stringify([
      headerFields,
      state.sort,
      state.descending,
    ]);
    if (headerSignature !== renderedHeader) {
      renderedHeader = headerSignature;
      head.replaceChildren();
      const header = element("tr");
      const choose = element("th");
      const all = element("input");
      all.type = "checkbox";
      all.dataset.selectAll = "";
      if (focusedAll) restoreFocus = all;
      all.setAttribute("aria-label", "Select all matching runs");
      all.onchange = () => {
        for (const r of visible()) {
          if (all.checked) selection.add(r.id);
          else selection.delete(r.id);
        }
        changed();
      };
      choose.append(all);
      header.append(choose);
      for (const [key, label] of headerFields) {
        const th = element("th");
        th.setAttribute(
          "aria-sort",
          state.sort === key
            ? state.descending
              ? "descending"
              : "ascending"
            : "none",
        );
        const control = button(
          label + (state.sort === key ? (state.descending ? " ↓" : " ↑") : ""),
          () => {
            state.descending = state.sort === key ? !state.descending : false;
            state.sort = key;
            render();
          },
          "sort-button",
        );
        control.dataset.sortKey = key;
        if (focusedSort === key) restoreFocus = control;
        control.title = key.startsWith("metric:")
          ? "Latest logged value"
          : label;
        if (key.startsWith("metric:")) th.classList.add("number-header");
        if (key.startsWith("parameter:")) {
          th.classList.add("parameter-header");
          control.title = `Parameter ${label}`;
        }
        th.append(control);
        header.append(th);
      }
      head.append(header);
    }
    const all = head.querySelector<HTMLInputElement>("[data-select-all]")!;
    if (focusedAll) restoreFocus = all;
    all.checked = rows.length > 0 && rows.every((r) => selection.has(r.id));
    all.indeterminate = !all.checked && rows.some((r) => selection.has(r.id));
    const pageRows = rows.slice(
      state.page * pageSize,
      (state.page + 1) * pageSize,
    );
    const bodySignature = JSON.stringify([
      headerFields,
      pageRows.map((run) => [
        run,
        selection.has(run.id),
        runColor(catalog, run.id),
        state.metrics!.map((key) => summaries.get(run.id)?.get(key)),
        state.parameters!.map((key) => parameters.get(run.id)?.get(key)?.value),
      ]),
      !!runs.length,
      renderedPending,
      renderedError,
    ]);
    if (bodySignature !== renderedBody) {
      renderedBody = bodySignature;
      body.replaceChildren();
      for (const run of pageRows) {
        const tr = element("tr");
        tr.dataset.runId = run.id;
        const td = cell("");
        const check = element("input");
        check.type = "checkbox";
        check.checked = selection.has(run.id);
        check.dataset.runId = run.id;
        if (focusedRunId === run.id) restoreFocus = check;
        check.setAttribute("aria-label", `Select ${run.name}`);
        check.onchange = () => {
          if (check.checked) selection.add(run.id);
          else selection.delete(run.id);
          changed();
        };
        td.append(check);
        const name = cell("");
        const identity = element("div", "run-identity");
        const link = button(
          run.name,
          () => {
            const current = runs.find((candidate) => candidate.id === run.id);
            if (current) onDetails(current);
          },
          "text-link run-link",
        );
        link.title = run.name;
        const swatch = runSwatch(catalog, run.id);
        identity.append(link, swatch);
        if (focusedButton?.runId === run.id)
          restoreFocus = focusedButton.color
            ? (swatch.querySelector<HTMLButtonElement>("button") ?? undefined)
            : link;
        name.append(identity);
        const stateCell = cell("");
        stateCell.append(
          element(
            "span",
            `status status-${run.status}`,
            run.status[0].toUpperCase() + run.status.slice(1),
          ),
        );
        tr.append(
          td,
          name,
          stateCell,
          cell(timeLabel(run.created_at), "muted"),
        );
        for (const key of state.metrics!) {
          const summary = summaries.get(run.id)?.get(key);
          const metric = cell(numberLabel(summary?.last_value), "number-cell");
          if (summary)
            metric.title = `Latest logged value · Step ${summary.last_step} · ${summary.count.toLocaleString()} logged values`;
          tr.append(metric);
        }
        for (const key of state.parameters!) {
          const value = parameters.get(run.id)?.get(key)?.value;
          const parameter = cell(parameterLabel(value), "parameter-cell");
          parameter.title = `${parameterName(key)}: ${value === undefined ? "Missing parameter" : parameterLabel(value)}`;
          tr.append(parameter);
        }
        body.append(tr);
      }
      if (!rows.length && !filterSession.error) {
        const tr = element("tr");
        const td = cell(
          runs.length
            ? filterSession.pending
              ? ""
              : "No runs match your filters."
            : "No runs in this experiment yet.",
          "empty-table",
        );
        td.colSpan = 4 + state.metrics!.length + state.parameters!.length;
        tr.append(td);
        body.append(tr);
      }
    }
    pagination(pager, rows.length, state, render);
    const shown = Math.min(pageSize, rows.length - state.page * pageSize);
    const summaryText = [
      `${runs.length} run${runs.length === 1 ? "" : "s"}`,
      rows.length !== runs.length ? `${rows.length} matching` : "",
      rows.length > pageSize ? `${Math.max(0, shown)} on this page` : "",
      selection.size ? `${selection.size} selected` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    setText(summary, summaryText);
    cancelAnimationFrame(belowFrame);
    belowFrame = requestAnimationFrame(updateBelow);
    restoreFocus?.focus({ preventScroll: true });
    wrap.scrollTop = scrollTop;
    wrap.scrollLeft = scrollLeft;
  }
  search.oninput = () => {
    state.query = search.value;
    state.page = 0;
    filterSession.setSearch(state.query, state.status);
  };
  status.onchange = () => {
    state.status = status.value;
    state.page = 0;
    filterSession.setSearch(state.query, state.status);
  };
  const filterControl = new RunFilterControl(filterSession, () => {
    if (destroyed) return;
    state.query = search.value = filterSession.query;
    state.status = status.value = filterSession.status;
    const ids = getSelection?.() ?? [...selection];
    const selectionChanged =
      ids.length !== selection.size || ids.some((id) => !selection.has(id));
    selectedIds = ids;
    selection = new Set(ids);
    clear.hidden = !selection.size && !hasPendingSelection?.();
    selected.title = hasPendingSelection?.()
      ? "Some selected runs await filter evidence and are not plotted. Clear cancels them too."
      : "";
    // Scan progress may change without changing any verified matches. Keep the
    // table (and keyboard focus) intact until its actual row set changes.
    const rows = visible();
    if (
      selectionChanged ||
      filterSession.error !== renderedError ||
      filterSession.pending > 0 !== renderedPending ||
      rows.length !== renderedRows.length ||
      rows.some((run, index) => run !== renderedRows[index])
    )
      render();
  });
  filterSlot.append(filterControl.root);
  render();
  return Object.assign(host, {
    updateCatalog(next: Catalog) {
      if (destroyed) return;
      catalog = next;
      runs = catalog.runs.filter((run) => run.experiment_id === experiment.id);
      ({ summaries, parameters, sort } = createRunOrder(runs, catalog.series));
      keys = [
        ...new Set(
          [...summaries.values()].flatMap((fields) => [...fields.keys()]),
        ),
      ].sort();
      parameterFields = new Map(
        [...parameters.values()].flatMap((fields) => [...fields]),
      );
      refreshLabels();
      renderColumns();
      // Shared sessions are refreshed by the caller on metadata changes only.
      // A metric tick must not reset filter proofs or reconcile workspace selection.
      const nextRunRevision = JSON.stringify(runs);
      if (!session && nextRunRevision !== runRevision)
        filterSession.setRuns(
          runs,
          catalog,
          catalog.rx?.id === experiment.id ? catalog.rx : undefined,
        );
      runRevision = nextRunRevision;
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      filterControl.destroy();
      if (!session) filterSession.destroy();
      observer.disconnect();
      wrap.removeEventListener("scroll", updateBelow);
      window.removeEventListener("resize", fit);
      cancelAnimationFrame(fitFrame);
      cancelAnimationFrame(belowFrame);
    },
  });
}
