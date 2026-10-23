import type { Catalog, CatalogSeries } from "./workspace-types";
import type { Experiment, Run } from "./api";
import { element } from "./utils";
import { runSwatch } from "./run-drawer";
import {
  scalarParameters,
  parameterLabel,
  compareParameters,
} from "./run-table-fields";

export interface TableState {
  query: string;
  status: string;
  sort: string;
  descending: boolean;
  page: number;
  metrics: string[] | null;
  parameters?: string[];
  columnQuery?: string;
}
export const tableState = (): TableState => ({
  query: "",
  status: "all",
  sort: "created_at",
  descending: true,
  page: 0,
  metrics: null,
});
export const timeLabel = (time: number) =>
  new Date(time).toLocaleString(undefined, {
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

export function experimentTable(
  catalog: Catalog,
  onOpen: (id: string) => void,
  state = tableState(),
): HTMLElement {
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
  for (const run of catalog.runs)
    counts.set(run.experiment_id, (counts.get(run.experiment_id) ?? 0) + 1);
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
    count.textContent = `${rows.length} ${rows.length === 1 ? "experiment" : "experiments"}`;
    body.replaceChildren();
    for (const experiment of rows.slice(
      state.page * pageSize,
      (state.page + 1) * pageSize,
    )) {
      const tr = element("tr");
      const name = cell("");
      name.append(
        button(
          experiment.name,
          () => onOpen(experiment.id),
          "text-link experiment-link",
        ),
      );
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
    pagination(pager, rows.length, state, render);
  }
  search.oninput = () => {
    state.query = search.value;
    state.page = 0;
    render();
  };
  render();
  return host;
}
function pagination(
  host: HTMLElement,
  total: number,
  state: TableState,
  render: () => void,
) {
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
  onSelection: (ids: string[]) => boolean | void,
  onCharts: () => void,
  onDetails: (run: Run) => void,
  state = tableState(),
): HTMLElement {
  const host = element("section", "browser-panel");
  let selection = new Set(selectedIds);
  const runs = catalog.runs.filter((r) => r.experiment_id === experiment.id);
  const runIds = new Set(runs.map((r) => r.id));
  const summaries = new Map<string, Map<string, CatalogSeries>>();
  for (const series of catalog.series) {
    if (series.kind !== "metric" || !runIds.has(series.run_id)) continue;
    let map = summaries.get(series.run_id);
    if (!map) {
      map = new Map();
      summaries.set(series.run_id, map);
    }
    map.set(series.key, series);
  }
  const keys = [
    ...new Set([...summaries.values()].flatMap((m) => [...m.keys()])),
  ].sort();
  if (state.metrics === null) state.metrics = keys.slice(0, 3);
  state.parameters ??= [];
  const parameters = new Map(
    runs.map((run) => [
      run.id,
      new Map(
        scalarParameters(run.params).map((field) => [field.sourcePath, field]),
      ),
    ]),
  );
  const parameterFields = new Map(
    [...parameters.values()].flatMap((fields) => [...fields]),
  );
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
      check.checked = state[kind]!.includes(key);
      check.onchange = () => {
        state[kind] = check.checked
          ? [...state[kind]!, key]
          : state[kind]!.filter((k) => k !== key);
        render();
      };
      label.append(check, element("span", "", key));
      label.title = kind === "metrics" ? `${key} · latest logged value` : key;
      group.append(label);
      options.push({ label, search: searchable });
    }
    groups.push({ group, options });
    choices.append(group);
  }
  function filterColumns() {
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
    choices.scrollTop = 0;
  }
  columnSearch.oninput = filterColumns;
  columns.onkeydown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    columns.open = false;
    columnsSummary.focus();
  };
  columnMenu.append(columnSearch, choices, empty);
  filterColumns();
  columns.append(columnMenu);
  const chartButton = button("View charts", onCharts, "primary");
  const selected = element("span", "selection-count");
  const clear = button(
    "Clear",
    () => {
      selection.clear();
      changed();
    },
    "text-link",
  );
  tools.append(search, status, columns, selected, clear, chartButton);
  const wrap = element("div", "table-scroll");
  const table = element("table", "data-table run-table");
  table.setAttribute("aria-label", "Runs");
  const head = element("thead");
  const body = element("tbody");
  table.append(head, body);
  wrap.append(table);
  const pager = element("div", "table-pager");
  host.append(tools, wrap, pager);
  function changed() {
    if (onSelection([...selection]) === false) selection = new Set(selectedIds);
    else selectedIds = [...selection];
    render();
  }
  function visible() {
    const q = state.query.trim().toLowerCase();
    return runs
      .filter(
        (r) =>
          (state.status === "all" || r.status === state.status) &&
          (!q ||
            `${r.name} ${JSON.stringify(r.params)} ${JSON.stringify(r.tags)}`
              .toLowerCase()
              .includes(q)),
      )
      .sort((a, b) => {
        let result = 0;
        if (state.sort === "name") result = a.name.localeCompare(b.name);
        else if (state.sort === "status")
          result = a.status.localeCompare(b.status);
        else if (state.sort.startsWith("metric:")) {
          const key = state.sort.slice(7),
            av = summaries.get(a.id)?.get(key)?.last_value,
            bv = summaries.get(b.id)?.get(key)?.last_value;
          if (av == null) return bv == null ? 0 : 1;
          if (bv == null) return -1;
          result = av - bv;
        } else if (state.sort.startsWith("parameter:")) {
          const key = state.sort.slice(10);
          return compareParameters(
            parameters.get(a.id)?.get(key)?.value,
            parameters.get(b.id)?.get(key)?.value,
            state.descending,
          );
        } else result = a.created_at - b.created_at;
        return (state.descending ? -1 : 1) * result;
      });
  }
  function render() {
    // Filtering/sorting rebuilds the header and rows. Retain identity, not a detached
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
    let restoreFocus: HTMLElement | undefined;
    const rows = visible();
    state.page = Math.min(
      state.page,
      Math.max(0, Math.ceil(rows.length / pageSize) - 1),
    );
    selected.textContent = `${selection.size} selected`;
    clear.hidden = !selection.size;
    chartButton.disabled = !selection.size;
    head.replaceChildren();
    body.replaceChildren();
    const header = element("tr");
    const choose = element("th");
    const all = element("input");
    all.type = "checkbox";
    all.dataset.selectAll = "";
    if (focusedAll) restoreFocus = all;
    all.setAttribute("aria-label", "Select all matching runs");
    all.checked = rows.length > 0 && rows.every((r) => selection.has(r.id));
    all.indeterminate = !all.checked && rows.some((r) => selection.has(r.id));
    all.onchange = () => {
      for (const r of rows) {
        if (all.checked) selection.add(r.id);
        else selection.delete(r.id);
      }
      changed();
    };
    choose.append(all);
    header.append(choose);
    for (const [key, label] of [
      ["name", "Run"],
      ["status", "Status"],
      ["created_at", "Created"],
      ...state.metrics!.map((k) => [`metric:${k}`, `${k} · latest`]),
      ...state.parameters!.map((k) => [`parameter:${k}`, k]),
    ]) {
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
      control.title = key.startsWith("metric:") ? "Latest logged value" : label;
      if (key.startsWith("parameter:")) {
        th.classList.add("parameter-header");
        control.title = `Parameter ${label}`;
      }
      th.append(control);
      header.append(th);
    }
    head.append(header);
    for (const run of rows.slice(
      state.page * pageSize,
      (state.page + 1) * pageSize,
    )) {
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
      const link = button(run.name, () => onDetails(run), "text-link run-link");
      link.title = run.name;
      identity.append(link, runSwatch(catalog, run.id));
      name.append(identity);
      const stateCell = cell("");
      stateCell.append(
        element(
          "span",
          `status status-${run.status}`,
          run.status[0].toUpperCase() + run.status.slice(1),
        ),
      );
      tr.append(td, name, stateCell, cell(timeLabel(run.created_at), "muted"));
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
        parameter.title = `${key}: ${value === undefined ? "Missing parameter" : parameterLabel(value)}`;
        tr.append(parameter);
      }
      body.append(tr);
    }
    if (!rows.length) {
      const tr = element("tr");
      const td = cell(
        runs.length
          ? "No runs match your filters."
          : "No runs in this experiment yet.",
        "empty-table",
      );
      td.colSpan = 4 + state.metrics!.length + state.parameters!.length;
      tr.append(td);
      body.append(tr);
    }
    pagination(pager, rows.length, state, render);
    restoreFocus?.focus({ preventScroll: true });
  }
  search.oninput = () => {
    state.query = search.value;
    state.page = 0;
    render();
  };
  status.onchange = () => {
    state.status = status.value;
    state.page = 0;
    render();
  };
  render();
  return host;
}
