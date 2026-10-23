import "./style.css";
import { Api, type Run } from "./api";
import { element, message, isAbort } from "./utils";
import { fetchCatalog, MetricStore } from "./catalog";
import {
  defaultSections,
  newChart,
  newWorkspace,
  loadLibrary,
  saveLibrary,
  exportWorkspace,
  importWorkspace,
  validateWorkspace,
} from "./workspace";
import type {
  Catalog,
  Workspace,
  WorkspaceLibrary,
  Section,
  ChartSpec,
  CardContext,
} from "./workspace-types";
import { ChartCard } from "./cards";
import { addMissingCharts } from "./dashboard-layout";
import { openChartEditor } from "./chart-editor";
import {
  experimentTable,
  runTable,
  tableState,
  showRunDetails,
} from "./browser-tables";

const app = document.querySelector<HTMLDivElement>("#app")!;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
app.innerHTML = `<header class="app-header"><a class="brand" href="#/experiments"><img src="/favicon.svg" alt="" width="24" height="24">NSET</a><a class="top-nav" href="#/experiments">Experiments</a><div class="header-spacer"></div><span id="connection" class="connection">Disconnected</span><button id="refresh" title="Refresh runs and charts">Refresh</button><button id="logout">Disconnect</button></header><main id="main"><div id="global-error" class="alert" role="alert" hidden></div><div id="page"></div></main><dialog id="login-dialog" aria-labelledby="login-title"><form id="login-form" class="connect-form"><h2 id="login-title">Connect to your tracker</h2><label>Access token<input id="token" name="token" type="password" required autocomplete="off"></label><p id="login-error" class="error" role="alert"></p><button class="primary" type="submit">Connect</button></form></dialog>`;
let token = sessionStorage.getItem("nset.token") ?? "";
const api = new Api(() => token);
const store = new MetricStore(api);
let catalog: Catalog = { experiments: [], runs: [], series: [] };
let library: WorkspaceLibrary = {
  version: 2,
  views: [],
  activeByExperiment: {},
};
let catalogGeneration = 0;
let request: AbortController | undefined;
let connected = false;
let currentWorkspaceId = "";
let chartSearch = "";
let activeEditor: { close: () => void } | undefined;
const experimentState = tableState();
const runStates = new Map<string, ReturnType<typeof tableState>>();
const undo = new Map<string, Workspace[]>();
const cards = new Map<
  string,
  { view: ChartCard; host: HTMLElement; spec: string; context: string }
>();
const sectionNodes = new Map<string, HTMLElement>();
const scrollPositions = new Map<string, number>();
let previousRoute = "";
let suspendedDashboard: DocumentFragment | undefined;
const button = (label: string, fn: () => void, className = "") => {
  const b = element("button", className, label);
  b.type = "button";
  b.onclick = fn;
  return b;
};
function error(text = "") {
  $("global-error").textContent = text;
  $("global-error").hidden = !text;
}
function persist() {
  saveLibrary(library);
}
function commitLibrary(mutate: () => void): boolean {
  const before = structuredClone(library);
  try {
    mutate();
    persist();
    error();
    return true;
  } catch (e) {
    library = before;
    disposeCards();
    error(`Could not save this view in your browser: ${message(e)}`);
    renderPage();
    return false;
  }
}
function disposeCards() {
  for (const card of cards.values()) card.view.destroy();
  cards.clear();
  sectionNodes.clear();
  currentWorkspaceId = "";
  suspendedDashboard = undefined;
}
function suspendDashboard() {
  if (!currentWorkspaceId || suspendedDashboard) return;
  suspendedDashboard = document.createDocumentFragment();
  for (const card of cards.values()) card.view.setActive(false);
  suspendedDashboard.append(...$("page").childNodes);
}
function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  return {
    experimentId:
      parts[0] === "experiments" && parts[1]
        ? decodeURIComponent(parts[1])
        : "",
    view: parts[2] === "charts" ? "charts" : "runs",
  };
}
function navigate(experimentId = "", view = "runs") {
  location.hash = experimentId
    ? `/experiments/${encodeURIComponent(experimentId)}/${view}`
    : "/experiments";
}
function context(workspace: Workspace): CardContext {
  return { api, catalog, selectedRunIds: workspace.selectedRunIds, store };
}

function workspaceFor(experimentId: string): Workspace {
  let workspace = library.views.find(
    (v) =>
      v.id === library.activeByExperiment[experimentId] &&
      v.experimentId === experimentId,
  );
  if (!workspace) {
    workspace = library.views.find((v) => v.experimentId === experimentId);
  }
  if (!workspace) {
    workspace = newWorkspace(experimentId, "Overview", [], catalog);
    workspace.sections = defaultSections(
      catalog,
      catalog.runs
        .filter((r) => r.experiment_id === experimentId)
        .map((r) => r.id),
    );
    library.views.push(workspace);
  }
  library.activeByExperiment[experimentId] = workspace.id;
  return workspace;
}
function remember(workspace: Workspace) {
  const stack = undo.get(workspace.id) ?? [];
  stack.push(structuredClone(workspace));
  if (stack.length > 15) stack.shift();
  undo.set(workspace.id, stack);
}
function change(workspace: Workspace, mutate: () => void, strict = false, render = true): boolean {
  const before = structuredClone(workspace);
  try {
    mutate();
    workspace.updatedAt = Date.now();
    validateWorkspace(workspace);
    persist();
  } catch (e) {
    Object.assign(workspace, before);
    renderCharts(workspace);
    const failure = new Error(`Could not save this view in your browser: ${message(e)}`);
    if (strict) throw failure;
    error(failure.message);
    return false;
  }
  remember(before);
  error();
  if (render) renderCharts(workspace);
  return true;
}
function locate(workspace: Workspace, id: string) {
  for (const section of workspace.sections) {
    const index = section.cards.findIndex((c) => c.id === id);
    if (index >= 0) return { section, index, card: section.cards[index] };
  }
  return null;
}
function updateSelection(workspace: Workspace, ids: string[]) {
  const saved = change(workspace, () => {
    workspace.selectedRunIds = [...new Set(ids)];
  });
  if (!saved && currentRoute().view === "runs") renderPage();
}
function pageHeader(experimentId: string, view: string): HTMLElement {
  const head = element("div", "page-heading");
  const experiment = catalog.experiments.find((e) => e.id === experimentId);
  if (!experiment) {
    head.append(element("h1", "", "Experiments"));
    return head;
  }
  const crumb = element("div", "breadcrumb");
  crumb.append(
    button("Experiments", () => navigate(), "text-link"),
    element("span", "", "/"),
    element("span", "", experiment.name),
  );
  head.append(crumb, element("h1", "", experiment.name));
  const tabs = element("nav", "view-tabs");
  tabs.setAttribute("aria-label", "Experiment views");
  for (const [key, label] of [
    ["runs", "Runs"],
    ["charts", "Charts"],
  ]) {
    const tab = button(label, () => navigate(experimentId, key));
    tab.classList.toggle("active", view === key);
    if (view === key) tab.setAttribute("aria-current", "page");
    tabs.append(tab);
  }
  head.append(tabs);
  return head;
}
function renderPage() {
  if (!connected) return;
  activeEditor?.close();
  activeEditor = undefined;
  if (previousRoute) scrollPositions.set(previousRoute, window.scrollY);
  const route = currentRoute();
  const key = location.hash;
  const routeChanged = key !== previousRoute;
  previousRoute = key;
  if (!route.experimentId) {
    suspendDashboard();
    $("page").replaceChildren(
      pageHeader("", ""),
      experimentTable(catalog, (id) => navigate(id), experimentState),
    );
  } else {
    const experiment = catalog.experiments.find(
      (e) => e.id === route.experimentId,
    );
    if (!experiment) {
      disposeCards();
      $("page").replaceChildren(
        element("h1", "", "Experiment not found"),
        button("Back to experiments", () => navigate()),
      );
      return;
    }
    const workspace = workspaceFor(experiment.id);
    if (route.view === "runs") {
      if (currentWorkspaceId && currentWorkspaceId !== workspace.id) disposeCards();
      else suspendDashboard();
      let state = runStates.get(experiment.id);
      if (!state) {
        state = tableState();
        runStates.set(experiment.id, state);
      }
      $("page").replaceChildren(
        pageHeader(experiment.id, "runs"),
        runTable(
          catalog,
          experiment,
          workspace.selectedRunIds,
          (ids) => updateSelection(workspace, ids),
          () => navigate(experiment.id, "charts"),
          (run) =>
            showRunDetails(run, () => {
              updateSelection(workspace, [run.id]);
              navigate(experiment.id, "charts");
            }),
          state,
        ),
      );
    } else {
      if (currentWorkspaceId === workspace.id && suspendedDashboard) {
        $("page").replaceChildren(suspendedDashboard);
        suspendedDashboard = undefined;
      }
      if (currentWorkspaceId !== workspace.id) {
        disposeCards();
        $("page").replaceChildren(pageHeader(experiment.id, "charts"));
        const tools = element("div", "workspace-toolbar");
        tools.id = "workspace-toolbar";
        const grid = element("div", "dashboard");
        grid.id = "dashboard";
        $("page").append(tools, grid);
        currentWorkspaceId = workspace.id;
      }
      renderCharts(workspace);
    }
  }
  if (routeChanged)
    requestAnimationFrame(() =>
      window.scrollTo(0, scrollPositions.get(key) ?? 0),
    );
}
function editCard(workspace: Workspace, card: ChartSpec, add = false) {
  activeEditor?.close();
  activeEditor = openChartEditor({
    card: structuredClone(card),
    isNew: add,
    onClose: () => {
      const trigger = add ? document.querySelector<HTMLElement>("details[data-menu=add] > summary") : cards.get(card.id)?.host.querySelector<HTMLElement>(".card-menu > summary");
      trigger?.focus({ preventScroll: true });
    },
    catalog,
    selectedRunIds: workspace.selectedRunIds,
    api,
    store,
    onSave: (next) => {
      const current = library.views.find((v) => v.id === workspace.id);
      if (!current) throw new Error("This view is no longer available.");
      change(current, () => {
        const found = locate(current, card.id);
        if (found && !add) found.section.cards[found.index] = next;
        else {
          let section = current.sections.find(
            (s) => s.title === "Custom charts",
          );
          if (!section) {
            section = {
              id: crypto.randomUUID(),
              title: "Custom charts",
              collapsed: false,
              cards: [],
            };
            current.sections.push(section);
          }
          section.cards.push(next);
        }
      }, true);
    },
  });
}
function download(workspace: Workspace) {
  const blob = new Blob([exportWorkspace(workspace)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = element("a");
  a.href = url;
  a.download = `${workspace.name.replace(/[^a-z0-9_-]/gi, "-") || "view"}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function ask(
  title: string,
  label: string,
  value = "",
): Promise<string | null> {
  const previous = document.activeElement as HTMLElement | null;
  const dialog = element("dialog", "small-dialog");
  const form = element("form");
  const heading = element("h2", "", title);
  heading.id = `dialog-${crypto.randomUUID()}`;
  dialog.setAttribute("aria-labelledby", heading.id);
  const field = element("label", "field");
  const input = element("input");
  input.value = value;
  input.required = true;
  input.maxLength = 160;
  field.append(document.createTextNode(label), input);
  const actions = element("div", "dialog-actions");
  const cancel = button("Cancel", () => dialog.close());
  const apply = element("button", "primary", "Save");
  apply.type = "submit";
  actions.append(cancel, apply);
  form.append(heading, field, actions);
  dialog.append(form);
  document.body.append(dialog);
  return new Promise((resolve) => {
    let result: string | null = null;
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      result = input.value.trim();
      finish();
    };
    const finish = () => {
      dialog.close();
      dialog.remove();
      previous?.focus();
      resolve(result);
    };
    dialog.onclose = finish;
    dialog.showModal();
    input.focus();
    input.select();
  });
}
async function confirmRemoval(
  title: string,
  description: string,
): Promise<boolean> {
  const previous = document.activeElement as HTMLElement | null;
  const dialog = element("dialog", "small-dialog");
  dialog.setAttribute("aria-label", title);
  const actions = element("div", "dialog-actions");
  let accepted = false;
  actions.append(
    button("Cancel", () => dialog.close()),
    button(
      "Remove",
      () => {
        accepted = true;
        dialog.close();
      },
      "danger",
    ),
  );
  dialog.append(
    element("h2", "", title),
    element("p", "muted", description),
    actions,
  );
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.onclose = () => {
      dialog.remove();
      previous?.focus();
      resolve(accepted);
    };
    dialog.showModal();
  });
}

function workspaceToolbar(workspace: Workspace) {
  const host = $("workspace-toolbar");
  const focused = host.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") : null;
  const oldScroll = host.querySelector(".run-picker-options")?.scrollTop ?? 0;
  const openMenus = [
    ...host.querySelectorAll<HTMLDetailsElement>("details[open]"),
  ].map((d) => d.dataset.menu);
  const oldQuery =
    host.querySelector<HTMLInputElement>("[data-role=run-search]")?.value ?? "";
  host.replaceChildren();
  const views = element("select");
  views.id = "view-select";
  views.setAttribute("aria-label", "Saved view");
  for (const view of library.views.filter(
    (v) => v.experimentId === workspace.experimentId,
  )) {
    const o = element("option", "", view.name);
    o.value = view.id;
    views.append(o);
  }
  views.value = workspace.id;
  views.onchange = () => {
    scrollPositions.set(workspace.id, window.scrollY);
    if (!commitLibrary(() => { library.activeByExperiment[workspace.experimentId] = views.value; })) return;
    renderPage();
    requestAnimationFrame(() =>
      window.scrollTo(0, scrollPositions.get(views.value) ?? 0),
    );
  };
  const chooseRuns = element("details", "menu run-picker");
  chooseRuns.dataset.menu = "runs";
  const runSummary = element(
    "summary",
    "",
    `Runs (${workspace.selectedRunIds.length})`,
  );
  chooseRuns.append(runSummary);
  const runMenu = element("div", "menu-popover");
  const runSearch = element("input");
  runSearch.type = "search";
  runSearch.placeholder = "Find runs";
  runSearch.setAttribute("aria-label", "Find runs");
  runSearch.dataset.role = "run-search";
  runSearch.value = oldQuery;
  const choices = element("div", "run-picker-options");
  runMenu.append(
    runSearch,
    choices,
    button(
      "Open run table",
      () => navigate(workspace.experimentId),
      "text-link",
    ),
  );
  chooseRuns.append(runMenu);
  const renderRunChoices = () => {
    choices.replaceChildren();
    const matches = catalog.runs.filter(
      (r) =>
        r.experiment_id === workspace.experimentId &&
        r.name.toLowerCase().includes(runSearch.value.toLowerCase()),
    );
    for (const run of matches.slice(0, 100)) {
      const label = element("label", "check-option");
      const check = element("input");
      check.type = "checkbox";
      check.checked = workspace.selectedRunIds.includes(run.id);
      check.setAttribute("aria-label", `Show ${run.name}`);
      check.onchange = () =>
        updateSelection(
          workspace,
          check.checked
            ? [...workspace.selectedRunIds, run.id]
            : workspace.selectedRunIds.filter((id) => id !== run.id),
        );
      label.append(check, document.createTextNode(run.name));
      choices.append(label);
    }
    if (matches.length > 100)
      choices.append(
        element(
          "p",
          "muted",
          `Showing 100 of ${matches.length}. Refine your search.`,
        ),
      );
  };
  runSearch.oninput = renderRunChoices;
  renderRunChoices();
  const search = element("input");
  search.type = "search";
  search.id = "chart-search";
  search.placeholder = "Search charts";
  search.setAttribute("aria-label", "Search charts");
  search.value = chartSearch;
  search.oninput = () => {
    chartSearch = search.value;
    applyChartFilter(workspace);
  };
  const add = element("details", "menu");
  add.dataset.menu = "add";
  const addSummary = element("summary", "primary", "Add chart");
  add.append(addSummary);
  const addMenu = element("div", "menu-popover");
  for (const [kind, label] of [
    ["timeseries", "Line chart"],
    ["image", "Image panel"],
  ] as const)
    addMenu.append(
      button(label, () => {
        add.open = false;
        editCard(
          workspace,
          newChart(kind, [], kind === "timeseries" ? "New chart" : "Images"),
          true,
        );
      }),
    );
  add.append(addMenu);
  const more = element("details", "menu");
  more.dataset.menu = "view";
  const moreSummary = element("summary", "icon-button", "⋯");
  moreSummary.setAttribute("aria-label", "View actions");
  more.append(moreSummary);
  const menu = element("div", "menu-popover");
  const action = (label: string, fn: () => void) =>
    menu.append(
      button(label, () => {
        more.open = false;
        fn();
      }),
    );
  action(
    "Save as…",
    () =>
      void (async () => {
        const name = await ask(
          "Save view as",
          "View name",
          `${workspace.name} copy`,
        );
        if (!name) return;
        if (
          library.views.some(
            (v) => v.experimentId === workspace.experimentId && v.name === name,
          )
        ) {
          error("A view with that name already exists.");
          return;
        }
        const copy = structuredClone(workspace);
        copy.id = crypto.randomUUID();
        copy.name = name;
        copy.updatedAt = Date.now();
        if (commitLibrary(() => {
          library.views.push(copy);
          library.activeByExperiment[copy.experimentId] = copy.id;
        })) renderPage();
      })(),
  );
  action(
    "Rename view",
    () =>
      void (async () => {
        const name = await ask("Rename view", "View name", workspace.name);
        if (name) {
          change(workspace, () => {
            workspace.name = name;
          });
        }
      })(),
  );
  action(
    "Add section",
    () =>
      void (async () => {
        const title = await ask("Add section", "Section name");
        if (title)
          change(workspace, () =>
            workspace.sections.push({
              id: crypto.randomUUID(),
              title,
              collapsed: false,
              cards: [],
            }),
          );
      })(),
  );
  action("Expand all sections", () =>
    change(workspace, () =>
      workspace.sections.forEach((s) => (s.collapsed = false)),
    ),
  );
  action("Collapse all sections", () =>
    change(workspace, () =>
      workspace.sections.forEach((s) => (s.collapsed = true)),
    ),
  );
  action("Export view", () => download(workspace));
  const file = element("input");
  file.type = "file";
  file.accept = "application/json,.json";
  file.hidden = true;
  file.setAttribute("aria-label", "Import view file");
  file.onchange = async () => {
    try {
      const selected = file.files?.[0];
      if (!selected) return;
      if (selected.size > 2_000_000) throw new Error("View file is too large.");
      const imported = importWorkspace(await selected.text());
      if (!catalog.experiments.some((e) => e.id === imported.experimentId))
        throw new Error(
          "This view belongs to an experiment that is not on this server.",
        );
      imported.id = crypto.randomUUID();
      if (!commitLibrary(() => {
        library.views.push(imported);
        library.activeByExperiment[imported.experimentId] = imported.id;
      })) return;
      if (currentRoute().experimentId === imported.experimentId) {
        renderPage();
      } else navigate(imported.experimentId, "charts");
    } catch (e) {
      error(message(e));
    } finally {
      file.value = "";
    }
  };
  action("Import view…", () => file.click());
  action("Add missing metric charts", () =>
    change(workspace, () => addMissingCharts(workspace, catalog)),
  );
  action(
    "Remove view",
    () =>
      void (async () => {
        if (
          !(await confirmRemoval(
            "Remove view?",
            `Remove “${workspace.name}”? Experiment data will not be deleted.`,
          ))
        )
          return;
        if (commitLibrary(() => {
          library.views = library.views.filter((v) => v.id !== workspace.id);
          delete library.activeByExperiment[workspace.experimentId];
          workspaceFor(workspace.experimentId);
        })) renderPage();
      })(),
  );
  more.append(menu, file);
  const undoButton = button("Undo", () => {
    const stack = undo.get(workspace.id);
    const previous = stack?.at(-1);
    if (previous && change(workspace, () => Object.assign(workspace, previous), false, false)) {
      stack!.splice(-2);
      renderCharts(workspace);
    }
  });
  undoButton.disabled = !undo.get(workspace.id)?.length;
  undoButton.title = "Undo the last view edit";
  host.append(views, chooseRuns, search, undoButton, add, more);
  for (const d of host.querySelectorAll<HTMLDetailsElement>("details"))
    if (openMenus.includes(d.dataset.menu)) d.open = true;
  choices.scrollTop = oldScroll;
  if (focused) [...host.querySelectorAll<HTMLElement>("[aria-label]")].find(node => node.getAttribute("aria-label") === focused)?.focus({ preventScroll: true });
}

function renderCharts(workspace: Workspace) {
  if (currentRoute().view !== "charts" || currentWorkspaceId !== workspace.id)
    return;
  workspaceToolbar(workspace);
  const dashboard = $("dashboard");
  const keep = new Set<string>();

  for (const section of workspace.sections) {
    let node = sectionNodes.get(section.id);
    if (!node) {
      node = element("section", "chart-section");
      node.dataset.sectionId = section.id;
      const header = element("div", "section-heading");
      const body = element("div", "chart-grid");
      body.dataset.role = "section-cards";
      node.append(header, body);
      sectionNodes.set(section.id, node);
    }
    const header = node.querySelector<HTMLElement>(".section-heading")!;
    header.replaceChildren();
    const toggle = button(
      `${section.collapsed ? "▸" : "▾"} ${section.title}`,
      () => {
        change(workspace, () => { section.collapsed = !section.collapsed; });
        sectionNodes.get(section.id)?.querySelector<HTMLButtonElement>(".section-toggle")?.focus({ preventScroll: true });
      },
      "section-toggle",
    );
    toggle.setAttribute("aria-expanded", String(!section.collapsed));
    header.append(
      toggle,
      element("span", "section-count", String(section.cards.length)),
    );
    const menu = element("details", "menu section-menu");
    const summary = element("summary", "icon-button", "⋯");
    summary.setAttribute("aria-label", `${section.title} section actions`);
    const actions = element("div", "menu-popover");
    actions.append(
      button(
        "Rename section",
        () =>
          void (async () => {
            menu.open = false;
            const title = await ask(
              "Rename section",
              "Section name",
              section.title,
            );
            if (title) change(workspace, () => (section.title = title));
          })(),
      ),
      button("Move section up", () => {
        const index = workspace.sections.indexOf(section);
        if (index > 0)
          change(workspace, () => {
            workspace.sections.splice(index, 1);
            workspace.sections.splice(index - 1, 0, section);
          });
      }),
      button("Move section down", () => {
        const index = workspace.sections.indexOf(section);
        if (index < workspace.sections.length - 1)
          change(workspace, () => {
            workspace.sections.splice(index, 1);
            workspace.sections.splice(index + 1, 0, section);
          });
      }),
      button(
        "Remove section",
        () =>
          void (async () => {
            menu.open = false;
            if (
              await confirmRemoval(
                "Remove section?",
                `Remove “${section.title}” and its ${section.cards.length} charts? Logged data is not deleted.`,
              )
            )
              change(workspace, () => {
                workspace.sections = workspace.sections.filter(
                  (s) => s.id !== section.id,
                );
              });
          })(),
      ),
    );
    menu.append(summary, actions);
    header.append(menu);
    const grid = node.querySelector<HTMLElement>("[data-role=section-cards]")!;
    grid.hidden = section.collapsed;
    grid.ondragover = (e) => {
      if (e.dataTransfer?.types.includes("application/x-nset-card")) {
        e.preventDefault();
        grid.classList.add("drop-target");
      }
    };
    grid.ondragleave = () => grid.classList.remove("drop-target");
    grid.ondrop = (e) => {
      e.preventDefault();
      grid.classList.remove("drop-target");
      const id = e.dataTransfer?.getData("application/x-nset-card");
      const found = id ? locate(workspace, id) : null;
      if (found && found.section !== section)
        change(workspace, () => {
          found.section.cards.splice(found.index, 1);
          section.cards.push(found.card);
        });
    };
    for (const spec of section.cards) {
      const contextKey = `${catalogGeneration}:${spec.source.mode === "selected" ? workspace.selectedRunIds.join(",") : "explicit"}`;
      keep.add(spec.id);
      let entry = cards.get(spec.id);
      const serialized = JSON.stringify(spec);
      if (!entry) {
        const host = element("article", "dashboard-cell");
        host.dataset.cardId = spec.id;
        host.dataset.cardKind = spec.kind;
        host.setAttribute("aria-label", spec.title);
        const view = new ChartCard(host, spec, context(workspace), {
          onEdit: (id) => {
            const found = locate(workspace, id);
            if (found) editCard(workspace, found.card);
          },
          onRemove: (id) =>
            change(workspace, () => {
              const found = locate(workspace, id);
              if (found) found.section.cards.splice(found.index, 1);
            }),
          onDuplicate: (id) =>
            change(workspace, () => {
              const found = locate(workspace, id);
              if (found) {
                const copy = structuredClone(found.card);
                copy.id = crypto.randomUUID();
                copy.title += " copy";
                found.section.cards.splice(found.index + 1, 0, copy);
              }
            }),
          onMove: (id, delta) =>
            change(workspace, () => {
              const found = locate(workspace, id);
              if (found) {
                const next = found.index + delta;
                if (next >= 0 && next < found.section.cards.length) {
                  found.section.cards.splice(found.index, 1);
                  found.section.cards.splice(next, 0, found.card);
                }
              }
            }),
          onResize: (id, size) =>
            change(workspace, () => {
              const found = locate(workspace, id);
              if (found) found.card.size = size;
            }),
        });
        entry = { view, host, spec: serialized, context: contextKey };
        cards.set(spec.id, entry);
        host.addEventListener("dragstart", (e) => {
          if (
            (e.target as HTMLElement).closest(
              "button,input,select,canvas,.u-over,.image-canvas",
            )
          )
            return;
          e.dataTransfer?.setData("application/x-nset-card", spec.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        });
        const title = host.querySelector<HTMLElement>("h2,h3");
        if (title) {
          title.draggable = true;
          title.title = "Drag to another section";
        }
      } else {
        if (entry.spec !== serialized) {
          entry.view.setSpec(spec);
          entry.spec = serialized;
          entry.host.setAttribute("aria-label", spec.title);
          entry.host.dataset.cardKind = spec.kind;
        }
        if (entry.context !== contextKey) {
          entry.view.setContext(context(workspace));
          entry.context = contextKey;
        }
      }
      entry.host.classList.toggle("wide", spec.size === "wide");
      grid.append(entry.host);
    }
    for (const child of [...grid.children]) {
      const id = (child as HTMLElement).dataset.cardId;
      if (id && !section.cards.some((c) => c.id === id)) child.remove();
    }
    let empty = grid.querySelector(".empty-section");
    if (!section.cards.length) {
      if (!empty) {
        empty = element(
          "div",
          "empty-section",
          "No charts in this section. Drag a chart here to move it.",
        );
        grid.append(empty);
      }
    } else empty?.remove();
    dashboard.append(node);
  }
  for (const [id, entry] of cards)
    if (!keep.has(id)) {
      entry.view.destroy();
      entry.host.remove();
      cards.delete(id);
    }
  for (const [id, node] of sectionNodes)
    if (!workspace.sections.some((s) => s.id === id)) {
      node.remove();
      sectionNodes.delete(id);
    }
  applyChartFilter(workspace);
}
function applyChartFilter(workspace: Workspace) {
  const query = chartSearch.trim().toLowerCase();
  let visible = 0;
  for (const section of workspace.sections) {
    let matches = 0;
    for (const spec of section.cards) {
      const entry = cards.get(spec.id);
      if (!entry) continue;
      const keys =
        spec.source.mode === "selected"
          ? spec.source.keys
          : spec.source.series.map((s) => s.key);
      const match =
        (!query ||
          `${section.title} ${spec.title} ${keys.join(" ")}`
            .toLowerCase()
            .includes(query)) &&
        (spec.source.mode === "explicit" ||
          workspace.selectedRunIds.length > 0);
      entry.host.hidden = !match;
      entry.view.setActive(match && !section.collapsed);
      if (match) matches++;
    }
    const node = sectionNodes.get(section.id);
    if (node) node.hidden = section.cards.length > 0 && !matches;
    visible += matches;
  }
  let empty = $("dashboard").querySelector<HTMLElement>(".dashboard-empty");
  if (!visible) {
    if (!empty) {
      empty = element("div", "dashboard-empty");
      $("dashboard").append(empty);
    }
    empty.replaceChildren(
      element(
        "h2",
        "",
        workspace.selectedRunIds.length
          ? "No charts to show"
          : "Select runs to get started",
      ),
      element(
        "p",
        "muted",
        query
          ? "Try another chart name."
          : workspace.selectedRunIds.length
            ? "Add a chart, or add missing metric charts from View actions."
            : "Choose runs above or open the run table.",
      ),
      button("Open run table", () => navigate(workspace.experimentId)),
    );
  } else empty?.remove();
}

async function connect(refresh = false) {
  const generation = ++catalogGeneration;
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  const submit = $("login-form").querySelector<HTMLButtonElement>(
    "button[type=submit]",
  )!;
  submit.disabled = true;
  $<HTMLButtonElement>("refresh").disabled = true;
  $("login-error").textContent = "";
  error();
  try {
    const next = await fetchCatalog(api, signal);
    if (generation !== catalogGeneration || signal.aborted) return;
    store.clear();
    catalog = next;
    connected = true;
    sessionStorage.setItem("nset.token", token);
    $("connection").textContent = "Connected";
    $("connection").classList.add("connected");
    $<HTMLDialogElement>("login-dialog").close();
    $<HTMLButtonElement>("logout").disabled = false;
    if (refresh && currentRoute().view === "charts" && currentWorkspaceId) {
      const workspace = workspaceFor(currentRoute().experimentId);
      renderCharts(workspace);
    } else renderPage();
  } catch (e) {
    if (isAbort(e) || generation !== catalogGeneration) return;
    if (connected)
      error(`Could not refresh. Previous data is still shown. ${message(e)}`);
    else {
      $("login-error").textContent = message(e);
      if (!$<HTMLDialogElement>("login-dialog").open)
        $<HTMLDialogElement>("login-dialog").showModal();
    }
  } finally {
    if (generation === catalogGeneration) {
      submit.disabled = false;
      $<HTMLButtonElement>("refresh").disabled = !connected;
    }
  }
}
$("login-dialog").addEventListener("cancel", (event) => {
  if (!connected) event.preventDefault();
});
$("login-form").onsubmit = (e) => {
  e.preventDefault();
  token = $<HTMLInputElement>("token").value.trim();
  if (token) void connect();
};
$("refresh").onclick = () => void connect(true);
$("logout").onclick = () => {
  catalogGeneration++;
  request?.abort();
  activeEditor?.close();
  activeEditor = undefined;
  disposeCards();
  store.clear();
  token = "";
  connected = false;
  sessionStorage.removeItem("nset.token");
  catalog = { experiments: [], runs: [], series: [] };
  $("connection").textContent = "Disconnected";
  $("connection").classList.remove("connected");
  $("page").replaceChildren();
  error();
  $<HTMLInputElement>("token").value = "";
  $<HTMLButtonElement>("refresh").disabled = true;
  $<HTMLButtonElement>("logout").disabled = true;
  $<HTMLDialogElement>("login-dialog").showModal();
};
window.addEventListener("hashchange", () => {
  try {
    renderPage();
  } catch (e) {
    error(message(e));
  }
});
document.addEventListener("pointerdown", (event) => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(
    "details.menu[open], details.card-menu[open]",
  ))
    if (!menu.contains(event.target as Node)) menu.open = false;
});
window.addEventListener("beforeunload", () => {
  request?.abort();
  disposeCards();
  store.clear();
});
try {
  library = loadLibrary();
} catch (e) {
  error(`Saved views could not be loaded: ${message(e)}`);
}
if (!location.hash) history.replaceState(null, "", "#/experiments");
$<HTMLButtonElement>("refresh").disabled = true;
$<HTMLButtonElement>("logout").disabled = true;
if (token) void connect();
else $<HTMLDialogElement>("login-dialog").showModal();
