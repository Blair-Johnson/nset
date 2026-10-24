import { appendRxCatalog } from "./records";
import "./style.css";
import { Api, type Run } from "./api";
import { element, message, isAbort } from "./utils";
import { fetchCatalog, MetricStore } from "./catalog";
import {
  defaultSections,
  newChart,
  resetChart,
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
import { setPlotType } from "./plot-types";
import { addMissingCharts } from "./dashboard-layout";
import { openChartEditor } from "./chart-editor";
import { experimentTable, runTable, tableState } from "./browser-tables";
import { renderRunDetail } from "./run-detail";
import { RunDrawer, runDrawerState, refreshRunSwatches } from "./run-drawer";
import { RunFilterSession } from "./run-filter-session";
import { createDashboardControls } from "./workspace-controls";
import { dashboardSettings, withDashboardSettings } from "./workspace-settings";
import type { DashboardControls } from "./dashboard-controls";
import { plotIcon } from "./plot-icons";

const app = document.querySelector<HTMLDivElement>("#app")!;
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
app.innerHTML = `<header class="app-header"><a class="brand" href="#/experiments" title="Experiments" aria-label="NSET home"><span class="brand-mark" aria-hidden="true">{<i>n</i>}</span></a><nav id="header-context" class="header-context" aria-label="Location"></nav><div class="header-spacer"></div><span id="connection" class="connection">Disconnected</span><button id="refresh" title="Refresh runs and charts">Refresh</button><button id="logout">Disconnect</button></header><main id="main"><div id="global-error" class="alert" role="alert" hidden></div><div id="page"></div></main><dialog id="login-dialog" aria-labelledby="login-title"><form id="login-form" class="connect-form"><h2 id="login-title">Connect to your tracker</h2><label>Access token<input id="token" name="token" type="password" required autocomplete="off"></label><p id="login-error" class="error" role="alert"></p><button class="primary" type="submit">Connect</button></form></dialog>`;
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
const drawerStates = new Map<string, ReturnType<typeof runDrawerState>>();
const runFilterSessions = new Map<string, RunFilterSession>();
let cleanupRunTable: (() => void) | undefined;
let runDrawer: RunDrawer | undefined;
function filterSessionFor(experimentId: string) {
  let session = runFilterSessions.get(experimentId);
  if (!session) {
    session = new RunFilterSession(undefined, api);
    runFilterSessions.set(experimentId, session);
  }
  session.setRuns(
    catalog.runs.filter((run) => run.experiment_id === experimentId),
    catalog,
  );
  return session;
}
function refreshRunFilterSessions() {
  for (const experimentId of runFilterSessions.keys())
    filterSessionFor(experimentId);
}
function disposeRunTable() {
  cleanupRunTable?.();
  cleanupRunTable = undefined;
}
function disposeRunFilterSessions() {
  for (const session of runFilterSessions.values()) session.destroy();
  runFilterSessions.clear();
}
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
let suspendedFocus: HTMLElement | undefined;
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
/*
 * Saved-view baselines. Edits always autosave as the view's working state (so
 * nothing is lost on reload), but each view also remembers its last *saved*
 * layout (sections, charts, settings). A view whose layout differs is marked
 * Modified and can be saved, reverted, or saved as a new view — which leaves
 * the original at its saved layout. Run selection is live state, not layout.
 */
const BASELINE_KEY = "nset.view-baselines.v1";
let baselines: Record<string, string> = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(BASELINE_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
})();
function saveBaselines() {
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify(baselines));
  } catch {
    /* Baselines are a convenience; the working view is already saved. */
  }
}
const layoutKey = (workspace: Workspace) => JSON.stringify(workspace.sections);
function baselineFor(workspace: Workspace): string {
  if (typeof baselines[workspace.id] !== "string") {
    baselines[workspace.id] = layoutKey(workspace);
    saveBaselines();
  }
  return baselines[workspace.id];
}
function isModified(workspace: Workspace) {
  return baselineFor(workspace) !== layoutKey(workspace);
}
function markSaved(workspace: Workspace) {
  baselines[workspace.id] = layoutKey(workspace);
  saveBaselines();
}
function updateModified(workspace: Workspace) {
  const marker = document.getElementById("view-modified");
  if (!marker || marker.dataset.viewId !== workspace.id) return;
  marker.hidden = !isModified(workspace);
}
function commitLibrary(mutate: () => void): boolean {
  const focused = document.activeElement?.getAttribute("aria-label");
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
    if (focused)
      [...$("page").querySelectorAll<HTMLElement>("[aria-label]")]
        .find((node) => node.getAttribute("aria-label") === focused)
        ?.focus({ preventScroll: true });
    return false;
  }
}
function disposeCards() {
  runDrawer?.destroy();
  runDrawer = undefined;
  for (const card of cards.values()) card.view.destroy();
  cards.clear();
  sectionNodes.clear();
  currentWorkspaceId = "";
  suspendedDashboard = undefined;
  suspendedFocus = undefined;
}
function suspendDashboard() {
  if (!currentWorkspaceId || suspendedDashboard) return;
  suspendedFocus = $("page").contains(document.activeElement)
    ? (document.activeElement as HTMLElement)
    : undefined;
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
    view:
      parts[2] === "charts"
        ? "charts"
        : parts[2] === "runs" && parts[3]
          ? "detail"
          : "runs",
    runId: parts[2] === "runs" && parts[3] ? decodeURIComponent(parts[3]) : "",
  };
}
function navigate(experimentId = "", view = "runs") {
  location.hash = experimentId
    ? `/experiments/${encodeURIComponent(experimentId)}/${view}`
    : "/experiments";
}
function openRun(run: Run) {
  navigate(run.experiment_id, `runs/${encodeURIComponent(run.id)}`);
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
function change(
  workspace: Workspace,
  mutate: () => void,
  strict = false,
  render = true,
): boolean {
  const before = structuredClone(workspace);
  try {
    mutate();
    workspace.updatedAt = Date.now();
    validateWorkspace(workspace);
    persist();
  } catch (e) {
    Object.assign(workspace, before);
    renderCharts(workspace);
    const failure = new Error(
      `Could not save this view in your browser: ${message(e)}`,
    );
    if (strict) throw failure;
    error(failure.message);
    return false;
  }
  remember(before);
  error();
  if (render) renderCharts(workspace);
  else updateModified(workspace);
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
  return saved;
}
/** Location (breadcrumb) lives in the app header so the page body is all content. */
function pageHeader(experimentId: string, _view: string): void {
  const head = $("header-context");
  const experiment = catalog.experiments.find((e) => e.id === experimentId);
  if (!experiment) {
    head.replaceChildren(element("h1", "header-title", "Experiments"));
    return;
  }
  const crumb = element("div", "breadcrumb");
  crumb.append(
    button("Experiments", () => navigate(), "text-link"),
    element("span", "breadcrumb-separator", "/"),
    element("span", "breadcrumb-current", experiment.name),
  );
  crumb.lastElementChild?.setAttribute("title", experiment.name);
  head.replaceChildren(crumb);
}
/**
 * Mutually exclusive view toggle (runs table | charts) that sits at the far
 * left of each experiment page's own toolbar, where the eye already is.
 */
function viewSwitch(experimentId: string, view: "runs" | "charts" | null) {
  const group = element("nav", "view-switch");
  group.setAttribute("aria-label", "Experiment views");
  for (const [key, label, icon] of [
    ["runs", "Runs", "view-runs"],
    ["charts", "Charts", "view-charts"],
  ] as const) {
    const active = view === key;
    const item = element("button", "view-switch-button");
    item.type = "button";
    item.title = key === "runs" ? "Runs table" : "Charts";
    item.setAttribute("aria-label", label);
    item.setAttribute("aria-pressed", String(active));
    if (active) item.setAttribute("aria-current", "page");
    item.classList.toggle("active", active);
    item.append(plotIcon(icon));
    item.onclick = () => {
      if (!active) navigate(experimentId, key);
    };
    group.append(item);
  }
  return group;
}
let detailRequest: AbortController | undefined;
function renderPage() {
  detailRequest?.abort();
  detailRequest = undefined;
  if (!connected) return;
  disposeRunTable();
  activeEditor?.close();
  activeEditor = undefined;
  if (previousRoute) scrollPositions.set(previousRoute, window.scrollY);
  const route = currentRoute();
  const key = location.hash;
  const routeChanged = key !== previousRoute;
  previousRoute = key;
  if (!route.experimentId) {
    suspendDashboard();
    pageHeader("", "");
    $("page").replaceChildren(
      experimentTable(catalog, (id) => navigate(id), experimentState),
    );
  } else {
    const experiment = catalog.experiments.find(
      (e) => e.id === route.experimentId,
    );
    if (!experiment) {
      disposeCards();
      pageHeader("", "");
      $("page").replaceChildren(
        element("h1", "", "Experiment not found"),
        button("Back to experiments", () => navigate()),
      );
      return;
    }
    const workspace = workspaceFor(experiment.id);
    if (route.view === "detail") {
      if (currentWorkspaceId && currentWorkspaceId !== workspace.id)
        disposeCards();
      else suspendDashboard();
      const run = catalog.runs.find(
        (r) => r.id === route.runId && r.experiment_id === experiment.id,
      );
      pageHeader(experiment.id, "runs");
      detailRequest = new AbortController();
      const detail = run
        ? renderRunDetail(run, {
            catalog,
            api,
            signal: detailRequest.signal,
            onBack: () => navigate(experiment.id),
            onCharts: () => {
              if (updateSelection(workspace, [run.id]))
                navigate(experiment.id, "charts");
            },
            onTags: async (patch) => {
              const generation = catalogGeneration;
              const updated = await api.patchRun(run.id, { tags: patch });
              if (generation !== catalogGeneration || !connected) return updated;
              catalog = {
                ...catalog,
                runs: catalog.runs.map((r) => (r.id === run.id ? updated : r)),
              };
              refreshRunFilterSessions();
              return updated;
            },
          })
        : element("p", "", "Run not found");
      // Same switcher as the other experiment pages; neither view is current.
      const switcher = viewSwitch(experiment.id, null);
      if (run) detail.querySelector(".run-detail-header")?.prepend(switcher);
      $("page").replaceChildren(...(run ? [detail] : [switcher, detail]));
    } else if (route.view === "runs") {
      if (currentWorkspaceId && currentWorkspaceId !== workspace.id)
        disposeCards();
      else suspendDashboard();
      let state = runStates.get(experiment.id);
      if (!state) {
        state = tableState();
        runStates.set(experiment.id, state);
      }
      pageHeader(experiment.id, "runs");
      const table = runTable(
        catalog,
        experiment,
        workspace.selectedRunIds,
        (ids) => updateSelection(workspace, ids),
        () => navigate(experiment.id, "charts"),
        openRun,
        state,
        filterSessionFor(experiment.id),
      );
      cleanupRunTable = () => table.destroy();
      table
        .querySelector(".table-toolbar")
        ?.prepend(viewSwitch(experiment.id, "runs"));
      if (catalog.rx?.id === experiment.id) {
        const note = element("div", "table-toolbar");
        note.append(element("span", "muted", catalog.rx.error || "Read-only rx records. Select runs, open Charts, and add a record chart."));
        if (catalog.rx.nextAfter != null) {
          const more = button("Load more rx runs", async () => {
            more.disabled = true;
            const generation = catalogGeneration;
            try {
              const next = await appendRxCatalog(api, structuredClone(catalog), undefined, catalog.rx!.nextAfter!);
              if (generation !== catalogGeneration || !connected) return;
              catalog = next;
              refreshRunFilterSessions();
              renderPage();
            } catch (e) { error(`Could not load rx runs: ${message(e)}`); more.disabled = false; }
          });
          note.append(more);
        }
        table.prepend(note);
      }
      $("page").replaceChildren(table);
    } else {
      pageHeader(experiment.id, "charts");
      if (currentWorkspaceId === workspace.id && suspendedDashboard) {
        $("page").replaceChildren(suspendedDashboard);
        suspendedDashboard = undefined;
        const focus = suspendedFocus;
        suspendedFocus = undefined;
        requestAnimationFrame(() => {
          if (focus?.isConnected && focus.getClientRects().length)
            focus.focus({ preventScroll: true });
        });
      }
      if (currentWorkspaceId !== workspace.id) {
        disposeCards();
        $("page").replaceChildren();
        const tools = element("div", "workspace-toolbar");
        tools.id = "workspace-toolbar";
        const grid = element("div", "dashboard");
        grid.id = "dashboard";
        const layout = element("div", "workspace-layout");
        let drawerState = drawerStates.get(experiment.id);
        if (!drawerState) {
          drawerState = runDrawerState(experiment.id);
          drawerStates.set(experiment.id, drawerState);
        }
        runDrawer = new RunDrawer(
          experiment.id,
          drawerState,
          (ids) => updateSelection(workspace, ids),
          () => navigate(experiment.id),
          openRun,
          filterSessionFor(experiment.id),
        );
        layout.append(runDrawer.backdrop, runDrawer.pane, grid);
        $("page").append(tools, layout);
        runDrawer.mount();
        currentWorkspaceId = workspace.id;
      }
      renderCharts(workspace);
      runDrawer?.restoreScroll();
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
    camera: add ? undefined : cards.get(card.id)?.view.camera(),
    onClose: () => {
      const trigger = add
        ? document.querySelector<HTMLElement>(
            "details[data-menu=add] > summary",
          )
        : cards
            .get(card.id)
            ?.host.querySelector<HTMLElement>(".card-menu > summary");
      trigger?.focus({ preventScroll: true });
    },
    catalog,
    selectedRunIds: workspace.selectedRunIds,
    api,
    store,
    onSave: (next, camera) => {
      const current = library.views.find((v) => v.id === workspace.id);
      if (!current) throw new Error("This view is no longer available.");
      change(
        current,
        () => {
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
        },
        true,
      );
      // The card (rebuilt or updated in place) adopts the preview's camera.
      if (!add) cards.get(next.id)?.view.setCamera(camera);
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
  const focused = host.contains(document.activeElement)
    ? document.activeElement?.getAttribute("aria-label")
    : null;
  const openMenus = [
    ...host.querySelectorAll<HTMLDetailsElement>("details[open]"),
  ].map((d) => d.dataset.menu);
  host.replaceChildren(viewSwitch(workspace.experimentId, "charts"));
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
    if (
      !commitLibrary(() => {
        library.activeByExperiment[workspace.experimentId] = views.value;
      })
    )
      return;
    renderPage();
    requestAnimationFrame(() =>
      window.scrollTo(0, scrollPositions.get(views.value) ?? 0),
    );
  };
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
  for (const [type, label] of [
    ["line", "Line plot"],
    ["scatter", "Scatter plot"],
    ["area", "Area plot"],
    ["step", "Step plot"],
    ["image", "Image panel"],
  ] as const)
    addMenu.append(
      button(label, () => {
        add.open = false;
        const card = newChart(
          type === "image" ? "image" : "timeseries",
          [],
          type === "image" ? "Images" : "New plot",
        );
        setPlotType(card, type);
        editCard(workspace, card, true);
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
        moreSummary.focus({ preventScroll: true });
        fn();
      }),
    );
  action("Save changes", () => {
    markSaved(workspace);
    workspaceToolbar(workspace);
  });
  action(
    "Save view as…",
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
        // The new view takes the current (possibly modified) layout; the
        // original goes back to its last saved layout instead of keeping edits.
        const copy = structuredClone(workspace);
        copy.id = crypto.randomUUID();
        copy.name = name;
        copy.updatedAt = Date.now();
        const saved = baselineFor(workspace);
        if (
          commitLibrary(() => {
            library.views.push(copy);
            library.activeByExperiment[copy.experimentId] = copy.id;
            workspace.sections = JSON.parse(saved);
          })
        ) {
          markSaved(copy);
          undo.delete(workspace.id);
          renderPage();
        }
      })(),
  );
  action("Revert to saved", () => {
    const saved = baselineFor(workspace);
    change(workspace, () => {
      workspace.sections = JSON.parse(saved);
    });
  });
  const modified = isModified(workspace);
  for (const b of menu.querySelectorAll<HTMLButtonElement>("button"))
    if (b.textContent === "Save changes" || b.textContent === "Revert to saved")
      b.disabled = !modified;
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
      if (
        !commitLibrary(() => {
          library.views.push(imported);
          library.activeByExperiment[imported.experimentId] = imported.id;
        })
      )
        return;
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
        if (
          commitLibrary(() => {
            library.views = library.views.filter((v) => v.id !== workspace.id);
            delete library.activeByExperiment[workspace.experimentId];
            workspaceFor(workspace.experimentId);
          })
        ) {
          delete baselines[workspace.id];
          saveBaselines();
          renderPage();
        }
      })(),
  );
  more.append(menu, file);
  const undoButton = button("Undo", () => {
    const stack = undo.get(workspace.id);
    const previous = stack?.at(-1);
    if (
      previous &&
      change(workspace, () => Object.assign(workspace, previous), false, false)
    ) {
      stack!.splice(-2);
      renderCharts(workspace);
    }
  });
  undoButton.setAttribute("aria-label", "Undo");
  undoButton.disabled = !undo.get(workspace.id)?.length;
  undoButton.title = "Undo the last view edit";
  const viewControl = element("div", "workspace-view-control");
  const viewLabel = element("label", "workspace-view-label", "View");
  const description = "A view stores charts, run selection, and settings.";
  if (views.options.length > 1) {
    viewLabel.htmlFor = views.id;
    views.setAttribute("aria-description", description);
    viewControl.append(viewLabel, views);
  } else {
    const name = element("span", "workspace-view-name", workspace.name);
    name.title = workspace.name;
    name.setAttribute("aria-description", description);
    viewControl.append(viewLabel, name);
  }
  viewControl.append(more);
  // Unsaved-layout marker with a one-click save; revert lives in the ⋯ menu.
  const marker = element("span", "view-modified");
  marker.id = "view-modified";
  marker.dataset.viewId = workspace.id;
  marker.title =
    "This view's layout differs from its saved version. Save, revert (⋯), or save as a new view.";
  const saveNow = button(
    "Save",
    () => {
      markSaved(workspace);
      workspaceToolbar(workspace);
    },
    "text-link",
  );
  saveNow.setAttribute("aria-label", "Save view changes");
  marker.append(element("span", "view-modified-dot", "Modified"), saveNow);
  marker.hidden = !isModified(workspace);
  viewControl.append(marker);
  host.append(viewControl);
  const settings = dashboardSettings(workspace);
  if (settings.count) {
    const apply = (controls: DashboardControls) =>
      change(workspace, () => {
        workspace.sections = withDashboardSettings(workspace, controls);
      });
    host.append(
      createDashboardControls({
        axis: settings.axis,
        smoothing: settings.smoothing,
        onAxis: (axis) => apply({ axis }),
        onSmoothing: (smoothingStrength) => apply({ smoothingStrength }),
      }),
    );
  }
  host.append(search, undoButton, add);
  for (const d of host.querySelectorAll<HTMLDetailsElement>("details"))
    if (openMenus.includes(d.dataset.menu)) d.open = true;
  if (focused)
    [...host.querySelectorAll<HTMLElement>("[aria-label]")]
      .find((node) => node.getAttribute("aria-label") === focused)
      ?.focus({ preventScroll: true });
}

// Preview only: the model and grid stay untouched until a valid drop commits.
let draggedCard: { id: string; workspaceId: string } | undefined;
const dropIndicator = element("div", "card-drop-indicator");
dropIndicator.setAttribute("aria-hidden", "true");
function clearCardDrag() {
  draggedCard = undefined;
  dropIndicator.remove();
}
document.addEventListener("dragend", clearCardDrag);
document.addEventListener("drop", clearCardDrag);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") clearCardDrag();
});
document.addEventListener("dragover", (event) => {
  if (
    !(event.target instanceof Element) ||
    !event.target.closest(".chart-grid")
  )
    dropIndicator.remove();
});
window.addEventListener("blur", clearCardDrag);
window.addEventListener("scroll", () => dropIndicator.remove(), true);

function sectionDropSlot(grid: HTMLElement, x: number, y: number) {
  const cells = [
    ...grid.querySelectorAll<HTMLElement>(":scope > .dashboard-cell"),
  ]
    .filter((cell) => !cell.hidden && cell.getClientRects().length)
    .map((cell) => ({
      id: cell.dataset.cardId!,
      rect: cell.getBoundingClientRect(),
    }));
  if (!cells.length) {
    const rect = grid.getBoundingClientRect();
    return {
      id: undefined,
      after: false,
      left: rect.left + 4,
      top: rect.top + 4,
      width: Math.max(0, rect.width - 8),
      height: 3,
    };
  }
  // Flex rows can have unequal card heights. Group by top, not by a global
  // midpoint: a wrapped row's first/last slot must not land in its neighbor.
  const rows: (typeof cells)[] = [];
  for (const cell of cells) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].rect.top - cell.rect.top) < 2) row.push(cell);
    else rows.push([cell]);
  }
  const distance = (row: typeof cells) =>
    Math.max(
      row[0].rect.top - y,
      y - Math.max(...row.map((cell) => cell.rect.bottom)),
      0,
    );
  const row = rows.reduce((best, next) =>
    distance(next) < distance(best) ? next : best,
  );
  const horizontal = row.length === 1;
  const cell = horizontal
    ? row[0]
    : (row.find(({ rect }) => x < rect.left + rect.width / 2) ?? row.at(-1)!);
  const after =
    y < rows[0][0].rect.top
      ? false
      : y > Math.max(...rows.at(-1)!.map((item) => item.rect.bottom))
        ? true
        : horizontal
          ? y >= cell.rect.top + cell.rect.height / 2
          : x >= cell.rect.left + cell.rect.width / 2;
  // Beyond the outer rows, always select the true first/last position.
  const target =
    y < rows[0][0].rect.top
      ? cells[0]
      : y > Math.max(...rows.at(-1)!.map((item) => item.rect.bottom))
        ? cells.at(-1)!
        : cell;
  const rect = target.rect;
  return {
    id: target.id,
    after,
    left: horizontal ? rect.left : (after ? rect.right : rect.left) - 2,
    top: horizontal ? (after ? rect.bottom : rect.top) - 2 : rect.top,
    width: horizontal ? rect.width : 3,
    height: horizontal ? 3 : rect.height,
  };
}

function renderCharts(workspace: Workspace) {
  if (currentRoute().view !== "charts" || currentWorkspaceId !== workspace.id)
    return;
  const focused = document.activeElement;
  const focusedSection = focused?.closest<HTMLElement>(".chart-section");
  const focusedHeader = focused?.closest(".section-heading");
  const focusToggle = focused?.classList.contains("section-toggle");
  clearCardDrag();
  runDrawer?.update(catalog, workspace.selectedRunIds);
  workspaceToolbar(workspace);
  const dashboard = $("dashboard");
  const keep = new Set<string>();

  for (const [sectionIndex, section] of workspace.sections.entries()) {
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
        change(workspace, () => {
          section.collapsed = !section.collapsed;
        });
        sectionNodes
          .get(section.id)
          ?.querySelector<HTMLButtonElement>(".section-toggle")
          ?.focus({ preventScroll: true });
      },
      "section-toggle",
    );
    toggle.title = section.title;
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
    const acceptsDrag = (e: DragEvent) =>
      draggedCard?.workspaceId === workspace.id &&
      !!locate(workspace, draggedCard.id) &&
      !!e.dataTransfer?.types.includes("application/x-nset-card");
    grid.ondragover = (e) => {
      if (!acceptsDrag(e)) {
        dropIndicator.remove();
        return;
      }
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      const slot = sectionDropSlot(grid, e.clientX, e.clientY);
      Object.assign(dropIndicator.style, {
        left: `${slot.left}px`,
        top: `${slot.top}px`,
        width: `${slot.width}px`,
        height: `${slot.height}px`,
      });
      document.body.append(dropIndicator);
    };
    grid.ondragleave = (e) => {
      if (!(e.relatedTarget instanceof Node) || !grid.contains(e.relatedTarget))
        dropIndicator.remove();
    };
    grid.ondrop = (e) => {
      if (!acceptsDrag(e)) {
        clearCardDrag();
        return;
      }
      e.preventDefault();
      const id = e.dataTransfer!.getData("application/x-nset-card");
      const found = id === draggedCard!.id ? locate(workspace, id) : null;
      const slot = sectionDropSlot(grid, e.clientX, e.clientY);
      clearCardDrag();
      if (!found) return;
      const target = slot.id
        ? section.cards.findIndex((card) => card.id === slot.id)
        : 0;
      if (target < 0) return;
      let index = target + Number(slot.after);
      if (found.section === section && found.index < index) index--;
      if (found.section === section && found.index === index) return;
      change(workspace, () => {
        found.section.cards.splice(found.index, 1);
        section.cards.splice(index, 0, found.card);
      });
    };
    for (const [cardIndex, spec] of section.cards.entries()) {
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
          onReset: (id) =>
            change(workspace, () => {
              const found = locate(workspace, id);
              if (found)
                found.section.cards[found.index] = resetChart(found.card);
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
          onDimensions: (id, layout) =>
            change(workspace, () => {
              const found = locate(workspace, id);
              if (!found) throw new Error("Chart no longer exists.");
              found.section.cards[found.index] = {
                ...found.card,
                layout: { ...layout },
              };
            }),
          onResize: (id, size) =>
            change(workspace, () => {
              const found = locate(workspace, id);
              if (found) found.card.size = size;
            }),
        });
        entry = { view, host, spec: serialized, context: contextKey };
        cards.set(spec.id, entry);
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
      // Bind to the title itself, never to image/native pan or card controls.
      // Refresh this after setSpec too, since edits can rebuild the title.
      const title = entry.host.querySelector<HTMLElement>("h2,h3");
      if (title) {
        title.draggable = true;
        title.title = "Drag to reorder plots or move to another section";
        title.ondragstart = (e) => {
          if (
            (e.target as Element).closest(
              "button,input,select,textarea,a,[contenteditable]",
            )
          )
            return;
          clearCardDrag();
          draggedCard = { id: spec.id, workspaceId: workspace.id };
          e.dataTransfer?.setData("application/x-nset-card", spec.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        };
      }
      entry.host.classList.toggle("wide", spec.size === "wide");
      entry.host.toggleAttribute("data-dimensions", !!spec.layout);
      if (spec.layout)
        entry.host.style.setProperty("--card-width", `${spec.layout.width}px`);
      else entry.host.style.removeProperty("--card-width");
      // Keep unchanged cards connected: even appending an existing node loses
      // focus and can dislodge the browser's scroll anchor on geometry commits.
      if (grid.children[cardIndex] !== entry.host)
        grid.insertBefore(entry.host, grid.children[cardIndex] ?? null);
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
    if (dashboard.children[sectionIndex] !== node)
      dashboard.insertBefore(node, dashboard.children[sectionIndex] ?? null);
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
  if (focusedHeader && focusedSection?.dataset.sectionId)
    sectionNodes
      .get(focusedSection.dataset.sectionId)
      ?.querySelector<HTMLElement>(
        focusToggle ? ".section-toggle" : ".section-menu > summary",
      )
      ?.focus({ preventScroll: true });
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
            : "Choose runs in the left drawer or open the run table.",
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
    refreshRunFilterSessions();
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
    if (catalog.rx?.error) error(catalog.rx.error);
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
  detailRequest?.abort();
  detailRequest = undefined;
  catalogGeneration++;
  request?.abort();
  activeEditor?.close();
  activeEditor = undefined;
  disposeRunTable();
  disposeCards();
  disposeRunFilterSessions();
  drawerStates.clear();
  runStates.clear();
  store.clear();
  token = "";
  connected = false;
  sessionStorage.removeItem("nset.token");
  catalog = { experiments: [], runs: [], series: [] };
  $("connection").textContent = "Disconnected";
  $("connection").classList.remove("connected");
  $("page").replaceChildren();
  $("header-context").replaceChildren();
  error();
  $<HTMLInputElement>("token").value = "";
  $<HTMLButtonElement>("refresh").disabled = true;
  $<HTMLButtonElement>("logout").disabled = true;
  $<HTMLDialogElement>("login-dialog").showModal();
};
window.addEventListener("nset:run-colors-changed", () => {
  refreshRunSwatches($("page"), catalog);
  if (suspendedDashboard) refreshRunSwatches(suspendedDashboard, catalog);
  for (const card of cards.values()) card.view.refreshColors();
});
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
// Popovers default to right-anchored; flip to left-anchored when that would leave the viewport.
document.addEventListener(
  "toggle",
  (event) => {
    const menu = event.target;
    if (!(menu instanceof HTMLDetailsElement) || !menu.open) return;
    const popover = menu.querySelector<HTMLElement>(
      ":scope > .menu-popover, :scope > .card-menu-items",
    );
    if (!popover) return;
    popover.classList.remove("align-start");
    if (popover.getBoundingClientRect().left < 8)
      popover.classList.add("align-start");
  },
  true,
);
window.addEventListener("beforeunload", () => {
  detailRequest?.abort();
  detailRequest = undefined;
  request?.abort();
  disposeRunTable();
  disposeCards();
  disposeRunFilterSessions();
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
