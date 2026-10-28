import {
  loadRunFilter,
  saveRunFilter,
  loadRunSearch,
  saveRunSearch,
} from "./run-filter-state";
import { reconcileRunSelection } from "./run-selection";
import { uuid } from "./uuid";
import { appendRxCatalog } from "./records";
import "./style.css";
import "./section-drag.css";
import { SectionDrag } from "./section-drag";
import { ChartDrag } from "./chart-drag";
import { Api, type Run } from "./api";
import { LiveUpdates, type LiveChange, type LiveStatus } from "./live";
import { applyMetricHints } from "./live-catalog";
import {
  ServerWorkspace,
  fetchServerView,
  listServerViews,
  referencedRunIds,
  type ServerViewSummary,
} from "./server-workspaces";
import { element, message, isAbort } from "./utils";
import { fetchCatalog, MetricStore } from "./catalog";
import {
  defaultSections,
  newChart,
  resetChart,
  reorderSections,
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
import { ChartDetailsPanel } from "./chart-details";
import { setPlotType } from "./plot-types";
import { addMissingCharts } from "./dashboard-layout";
import { openChartEditor } from "./chart-editor";
import { experimentTable, runTable, tableState } from "./browser-tables";
import { sortedRunIds } from "./trace-order";
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
let catalogRefreshing = false;
let currentWorkspaceId = "";
let serverViews: ServerViewSummary[] = [];
let serverWorkspace: ServerWorkspace | undefined;
const serverWorkspaceObjects = new WeakSet<Workspace>();
let serverLoad: AbortController | undefined;
let serverLoadId = "";
let viewGeneration = 0;
let serverPoll: AbortController | undefined;
let serverPollTimer: ReturnType<typeof setTimeout> | undefined;
function stopServerPoll() {
  clearTimeout(serverPollTimer);
  serverPollTimer = undefined;
  serverPoll?.abort();
  serverPoll = undefined;
}
function disposeServerView() {
  viewGeneration++;
  serverLoad?.abort();
  serverLoad = undefined;
  serverLoadId = "";
  serverWorkspace?.dispose();
  serverWorkspace = undefined;
  stopServerPoll();
}
async function refreshServerCatalog(workspace: Workspace, signal: AbortSignal) {
  if (
    catalog.experiments.some((e) => e.id === workspace.experimentId) &&
    referencedRunIds(workspace).every((id) =>
      catalog.runs.some((r) => r.id === id),
    )
  )
    return;
  const generation = catalogGeneration,
    view = viewGeneration,
    route = location.hash;
  const next = await fetchCatalog(api, signal);
  if (
    signal.aborted ||
    !connected ||
    generation !== catalogGeneration ||
    view !== viewGeneration ||
    route !== location.hash
  )
    return;
  catalog = next;
  catalogGeneration++;
  store.clear();
  refreshRunFilterSessions();
  if (catalog.rx?.error) error(catalog.rx.error);
}
function scheduleServerPoll() {
  if (!connected || document.hidden || serverPoll || serverPollTimer) return;
  serverPollTimer = setTimeout(() => {
    serverPollTimer = undefined;
    void pollServerViews();
  }, 3000);
}
async function pollServerViews() {
  if (!connected || document.hidden || serverPoll) return;
  clearTimeout(serverPollTimer);
  serverPollTimer = undefined;
  const controller = (serverPoll = new AbortController());
  const generation = viewGeneration,
    active = serverWorkspace,
    route = location.hash;
  const valid = () =>
    !controller.signal.aborted &&
    connected &&
    generation === viewGeneration &&
    location.hash === route;
  try {
    const views = await listServerViews(api, controller.signal);
    if (!valid()) return;
    const changed = JSON.stringify(views) !== JSON.stringify(serverViews);
    serverViews = views;
    let adopted = false;
    const previousCatalog = catalogGeneration;
    const previousExperiment = active?.workspace.experimentId;
    if (active) {
      adopted = await active.poll(controller.signal, () => !activeEditor);
      if (!valid()) return;
      // Retry missing catalog references even after a transient catalog failure.
      await refreshServerCatalog(active.workspace, controller.signal);
      if (!valid()) return;
    }
    if ((adopted || previousCatalog !== catalogGeneration) && active) {
      if (adopted) undo.delete(active.workspace.id);
      reconcileSelections(
        active.workspace.experimentId,
        filterSessionFor(active.workspace.experimentId),
      );
      if (previousExperiment !== active.workspace.experimentId) {
        disposeCards();
        renderPage();
      } else renderCharts(active.workspace);
    } else if (
      changed &&
      currentWorkspaceId &&
      currentRoute().view === "charts"
    ) {
      // A direct-link load may finish while the list request is in flight.
      // Refresh the current toolbar, not the workspace captured before awaiting.
      const workspace =
        serverWorkspace?.workspace ??
        library.views.find((v) => v.id === currentWorkspaceId);
      if (workspace) workspaceToolbar(workspace);
    }
  } catch (e) {
    if (valid() && !isAbort(e)) {
      if (active) renderCharts(active.workspace);
      error(`Could not refresh server views: ${message(e)}`);
    }
  } finally {
    if (serverPoll === controller) {
      serverPoll = undefined;
      scheduleServerPoll();
    }
  }
}
function loadServerRoute(id: string) {
  if (serverLoadId === id) return;
  serverLoad?.abort();
  const controller = (serverLoad = new AbortController());
  serverLoadId = id;
  const generation = viewGeneration;
  void (async () => {
    try {
      const latest = await fetchServerView(api, id, controller.signal);
      if (
        controller.signal.aborted ||
        generation !== viewGeneration ||
        !connected ||
        currentRoute().serverId !== id
      )
        return;
      if (!latest) throw new Error("Server did not return this view.");
      const state = new ServerWorkspace(
        api,
        latest,
        localStorage,
        () =>
          connected &&
          generation === viewGeneration &&
          currentRoute().serverId === id,
      );
      await refreshServerCatalog(state.workspace, controller.signal);
      if (
        controller.signal.aborted ||
        generation !== viewGeneration ||
        !connected ||
        currentRoute().serverId !== id
      ) {
        state.dispose();
        return;
      }
      serverWorkspace = state;
      serverWorkspaceObjects.add(state.workspace);
      renderPage();
    } catch (e) {
      if (
        !controller.signal.aborted &&
        generation === viewGeneration &&
        currentRoute().serverId === id &&
        !isAbort(e)
      ) {
        error(`Could not open server view: ${message(e)}`);
        $("page").replaceChildren(
          button("Retry server view", () => {
            serverLoadId = "";
            renderPage();
          }),
        );
      }
    } finally {
      if (serverLoad === controller) serverLoad = undefined;
    }
  })();
}
async function serverAction(
  state: ServerWorkspace,
  operation: () => Promise<unknown>,
) {
  const generation = viewGeneration,
    route = location.hash;
  const previousExperiment = state.workspace.experimentId;
  const valid = () =>
    connected &&
    generation === viewGeneration &&
    state === serverWorkspace &&
    route === location.hash;
  try {
    const result = operation();
    workspaceToolbar(state.workspace);
    await result;
    if (!valid()) return;
    error();
    if (!state.dirty) undo.delete(state.workspace.id);
    await refreshServerCatalog(state.workspace, new AbortController().signal);
  } catch (e) {
    if (valid() && !isAbort(e)) error(message(e));
  } finally {
    if (valid()) {
      reconcileSelections(
        state.workspace.experimentId,
        filterSessionFor(state.workspace.experimentId),
      );
      if (previousExperiment !== state.workspace.experimentId) {
        disposeCards();
        renderPage();
      } else renderCharts(state.workspace);
    }
  }
}
function saveView(workspace: Workspace) {
  if (serverWorkspace?.workspace === workspace) {
    const state = serverWorkspace;
    void serverAction(state, () => state.save());
  } else {
    markSaved(workspace);
    workspaceToolbar(workspace);
  }
}
let chartSearch = "";
let activeEditor: { close: () => void } | undefined;
const experimentState = tableState();
const drawerStates = new Map<string, ReturnType<typeof runDrawerState>>();
const runFilterSessions = new Map<string, RunFilterSession>();
let cleanupRunTable: (() => void) | undefined;
let liveTable: { updateCatalog(next: Catalog): void } | undefined;
let runDrawer: RunDrawer | undefined;
function filterSessionFor(experimentId: string) {
  let session = runFilterSessions.get(experimentId);
  if (!session) {
    session = new RunFilterSession(
      loadRunFilter(experimentId),
      api,
      () => void connect(true),
      (filter) => saveRunFilter(experimentId, filter),
      loadRunSearch(experimentId),
      (search) => saveRunSearch(experimentId, search),
    );
    runFilterSessions.set(experimentId, session);
    // Subscribe before list controls: they always observe the reconciled IDs.
    const shared = session;
    session.subscribe(() => reconcileSelections(experimentId, shared));
  }
  session.setRuns(
    catalog.runs.filter((run) => run.experiment_id === experimentId),
    catalog,
    catalog.rx?.id === experimentId ? catalog.rx : undefined,
  );
  if (catalogRefreshing && !session.refreshing) session.invalidate();
  return session;
}
let selectionRenderQueued = false;
function reconcileSelections(experimentId: string, session: RunFilterSession) {
  let changed = false;
  let localChanged = false;
  const shared = serverWorkspace;
  const workspaces = shared
    ? [...library.views, shared.workspace]
    : library.views;
  for (const workspace of workspaces) {
    if (
      workspace.experimentId === experimentId &&
      reconcileRunSelection(workspace, session)
    ) {
      workspace.updatedAt = Date.now();
      changed = true;
      if (shared?.workspace === workspace) {
        try {
          shared.edited();
        } catch (e) {
          error(`Could not save filtered selection: ${message(e)}`);
        }
      } else localChanged = true;
    }
  }
  if (!changed) return;
  try {
    if (localChanged) persist();
  } catch (e) {
    error(`Could not save filtered selection: ${message(e)}`);
  }
  // Do not rebuild a table or a filter input from inside its own input handler.
  if (selectionRenderQueued) return;
  selectionRenderQueued = true;
  queueMicrotask(() => {
    selectionRenderQueued = false;
    const workspace =
      serverWorkspace?.workspace.id === currentWorkspaceId
        ? serverWorkspace.workspace
        : library.views.find((view) => view.id === currentWorkspaceId);
    if (workspace) renderCharts(workspace);
  });
}
function refreshRunFilterSessions() {
  for (const experimentId of runFilterSessions.keys())
    filterSessionFor(experimentId);
}
function disposeRunTable() {
  liveTable = undefined;
  cleanupRunTable?.();
  cleanupRunTable = undefined;
}
function disposeRunFilterSessions() {
  for (const session of runFilterSessions.values()) session.destroy();
  runFilterSessions.clear();
}
const runStates = new Map<string, ReturnType<typeof tableState>>();
function runStateFor(experimentId: string) {
  let state = runStates.get(experimentId);
  if (!state) {
    state = tableState();
    runStates.set(experimentId, state);
  }
  return state;
}
const undo = new Map<string, Workspace[]>();
const cards = new Map<
  string,
  { view: ChartCard; host: HTMLElement; spec: string; context: string }
>();
const sectionNodes = new Map<string, HTMLElement>();
const sectionDrag = new SectionDrag();
const chartDrag = new ChartDrag();
const scrollPositions = new Map<string, number>();
function pageScrollTop(): number {
  return document.getElementById("dashboard")?.scrollTop ?? window.scrollY;
}
function scrollPageTo(top: number): void {
  const dashboard = document.getElementById("dashboard");
  if (dashboard) dashboard.scrollTo(0, top);
  else window.scrollTo(0, top);
}
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
  if (serverWorkspace?.workspace === workspace) return serverWorkspace.dirty;
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
  sectionDrag.cancel();
  chartDrag.cancel();
  chartDetails.close(false);
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
  sectionDrag.cancel();
  chartDrag.cancel();
  chartDetails.close(false);
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
  const serverId =
    parts[0] === "views" && parts[1] ? decodeURIComponent(parts[1]) : "";
  if (serverId)
    return {
      serverId,
      experimentId:
        serverWorkspace?.workspace.id === serverId
          ? serverWorkspace.workspace.experimentId
          : "",
      view: "charts",
      runId: "",
    };
  return {
    serverId: "",
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
function changeRunStatus(run: Run, status: Run["status"]): Promise<Run> {
  return saveRunPatch(run, { status });
}
async function saveRunPatch(
  run: Run,
  patch: Parameters<Api["patchRun"]>[1],
): Promise<Run> {
  if (run.rx) throw new Error("External runs are read-only.");
  const generation = catalogGeneration;
  const before = catalog.runs.find((r) => r.id === run.id);
  const updated = await api.patchRun(run.id, patch);
  if (generation !== catalogGeneration || !connected)
    throw new DOMException("Connection changed", "AbortError");
  const current = catalog.runs.find((r) => r.id === run.id);
  // A later live update may have arrived before this request's response.
  const resolved =
    current &&
    (current.updated_at > updated.updated_at ||
      (current.updated_at === updated.updated_at && current !== before))
      ? current
      : updated;
  liveCatalogInstalled(
    {
      ...catalog,
      runs: catalog.runs.map((r) => (r.id === run.id ? resolved : r)),
    },
    true,
  );
  return resolved;
}
function chartFollowsSelection(spec: ChartSpec): boolean {
  return spec.records
    ? !spec.records.runUids.length
    : spec.source.mode === "selected";
}
const labelModes = new Map<string, "semantic" | "original">();
function labelMode(workspace: Workspace): "semantic" | "original" {
  if (!labelModes.has(workspace.id)) {
    let mode: "semantic" | "original" = "semantic";
    try {
      if (
        localStorage.getItem(
          `nset:chart-label-mode:v1:${encodeURIComponent(workspace.id)}`,
        ) === "original"
      )
        mode = "original";
    } catch {
      /* Presentation preferences must not block charts. */
    }
    labelModes.set(workspace.id, mode);
  }
  return labelModes.get(workspace.id)!;
}
function context(workspace: Workspace): CardContext {
  return {
    api,
    catalog,
    selectedRunIds: workspace.selectedRunIds,
    store,
    runLabels: workspace.runLabels,
    labelMode: labelMode(workspace),
  };
}
function activeChartWorkspace(id = currentWorkspaceId): Workspace | undefined {
  if (
    !connected ||
    currentRoute().view !== "charts" ||
    id !== currentWorkspaceId
  )
    return;
  if (serverWorkspace?.workspace.id === id) return serverWorkspace.workspace;
  return library.views.find((view) => view.id === id);
}
function updateDetailsButtons() {
  const selected = chartDetails.active;
  for (const [id, entry] of cards)
    entry.view.setDetailsOpen(
      selected?.workspaceId === currentWorkspaceId && selected.cardId === id,
    );
}
const chartDetails = new ChartDetailsPanel({
  onClose: updateDetailsButtons,
  onMeasure: async (workspaceId, id, measurement, signal) => {
    const workspace = activeChartWorkspace(workspaceId);
    const found = workspace && locate(workspace, id);
    const entry = cards.get(id);
    if (
      !found ||
      !entry ||
      entry.host.hidden ||
      found.section.collapsed ||
      chartDetails.active?.workspaceId !== workspaceId ||
      chartDetails.active.cardId !== id
    )
      return false;
    return entry.view.showMeasurement(measurement, signal);
  },
});
function openChartDetails(workspaceId: string, id: string) {
  const workspace = activeChartWorkspace(workspaceId);
  const found = workspace && locate(workspace, id);
  const entry = cards.get(id);
  if (
    !workspace ||
    !found ||
    !entry ||
    !found.card.details ||
    entry.host.hidden ||
    found.section.collapsed
  )
    return;
  chartDetails.open(
    { workspaceId, chart: found.card, context: context(workspace) },
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined,
  );
  updateDetailsButtons();
}
function syncChartDetails(workspace: Workspace) {
  const selected = chartDetails.active;
  if (!selected) return;
  const found = locate(workspace, selected.cardId);
  const entry = cards.get(selected.cardId);
  if (
    selected.workspaceId !== workspace.id ||
    !found?.card.details ||
    !entry ||
    entry.host.hidden ||
    found.section.collapsed
  ) {
    chartDetails.close(false);
    return;
  }
  chartDetails.update({
    workspaceId: workspace.id,
    chart: found.card,
    context: context(workspace),
  });
  updateDetailsButtons();
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
  if (
    serverWorkspaceObjects.has(workspace) &&
    serverWorkspace?.workspace !== workspace
  ) {
    if (strict) throw new Error("This server view is no longer active.");
    return false;
  }
  const before = structuredClone(workspace);
  try {
    mutate();
    const filters = runFilterSessions.get(workspace.experimentId);
    if (filters) reconcileRunSelection(workspace, filters);
    workspace.updatedAt = Date.now();
    validateWorkspace(workspace);
    if (serverWorkspace?.workspace === workspace) serverWorkspace.edited();
    else persist();
  } catch (e) {
    delete workspace.pendingSelectedRunIds;
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
function updateSelection(
  workspace: Workspace,
  ids: string[],
  clearPending = false,
) {
  const saved = change(workspace, () => {
    workspace.selectedRunIds = [...new Set(ids)];
    // Only an explicit reset cancels intent whose evidence is still unresolved.
    if (clearPending) delete workspace.pendingSelectedRunIds;
    reconcileRunSelection(workspace, filterSessionFor(workspace.experimentId));
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
  sectionDrag.cancel();
  detailRequest?.abort();
  detailRequest = undefined;
  if (!connected) return;
  disposeRunTable();
  activeEditor?.close();
  activeEditor = undefined;
  if (previousRoute) scrollPositions.set(previousRoute, pageScrollTop());
  const route = currentRoute();
  scheduleServerPoll();
  if (route.serverId && serverWorkspace?.workspace.id !== route.serverId) {
    disposeCards();
    pageHeader("", "");
    $("page").replaceChildren(element("p", "muted", "Loading server view…"));
    loadServerRoute(route.serverId);
    return;
  }
  for (const [id, session] of runFilterSessions) {
    session.setActive(false);
    if (id === route.experimentId && route.view !== "detail")
      session.setActive(true);
  }
  const key = location.hash;
  const routeChanged = key !== previousRoute;
  previousRoute = key;
  if (!route.experimentId) {
    suspendDashboard();
    pageHeader("", "");
    const table = experimentTable(
      catalog,
      (id) => navigate(id),
      experimentState,
    );
    liveTable = table;
    $("page").replaceChildren(table);
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
    const workspace = route.serverId
      ? serverWorkspace!.workspace
      : workspaceFor(experiment.id);
    const filters = filterSessionFor(experiment.id);
    reconcileSelections(experiment.id, filters);
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
            onStatus: changeRunStatus,
            onCharts: () => {
              if (updateSelection(workspace, [run.id], true))
                navigate(experiment.id, "charts");
            },
            onTags: (patch) => saveRunPatch(run, { tags: patch }),
          })
        : element("p", "", "Run not found");
      if (run) {
        const handle = detail as ReturnType<typeof renderRunDetail>;
        liveTable = handle;
        cleanupRunTable = () => handle.destroy();
      }
      // Same switcher as the other experiment pages; neither view is current.
      const switcher = viewSwitch(experiment.id, null);
      if (run) detail.querySelector(".run-detail-header")?.prepend(switcher);
      $("page").replaceChildren(...(run ? [detail] : [switcher, detail]));
    } else if (route.view === "runs") {
      if (currentWorkspaceId && currentWorkspaceId !== workspace.id)
        disposeCards();
      else suspendDashboard();
      pageHeader(experiment.id, "runs");
      const table = runTable(
        catalog,
        experiment,
        workspace.selectedRunIds,
        (ids, clearPending) => updateSelection(workspace, ids, clearPending),
        () => navigate(experiment.id, "charts"),
        openRun,
        runStateFor(experiment.id),
        filters,
        () => workspace.selectedRunIds,
        () => !!workspace.pendingSelectedRunIds?.length,
        changeRunStatus,
      );
      cleanupRunTable = () => table.destroy();
      liveTable = table;
      table
        .querySelector(".table-toolbar")
        ?.prepend(viewSwitch(experiment.id, "runs"));
      if (
        catalog.rx?.id === experiment.id &&
        (catalog.rx.error || catalog.rx.nextAfter != null)
      ) {
        const note = element("div", "table-toolbar");
        if (catalog.rx.error)
          note.append(element("span", "muted", catalog.rx.error));
        if (catalog.rx.nextAfter != null) {
          const more = button("Load more rx runs", async () => {
            more.disabled = true;
            const generation = catalogGeneration;
            try {
              const next = await appendRxCatalog(
                api,
                structuredClone(catalog),
                undefined,
                catalog.rx!.nextAfter!,
              );
              if (generation !== catalogGeneration || !connected) return;
              catalog = next;
              refreshRunFilterSessions();
              renderPage();
            } catch (e) {
              error(`Could not load rx runs: ${message(e)}`);
              more.disabled = false;
            }
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
          (ids, clearPending) => updateSelection(workspace, ids, clearPending),
          openRun,
          filterSessionFor(experiment.id),
          runStateFor(experiment.id),
          changeRunStatus,
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
    requestAnimationFrame(() => scrollPageTo(scrollPositions.get(key) ?? 0));
}
function editCard(workspace: Workspace, card: ChartSpec, add = false) {
  activeEditor?.close();
  activeEditor = openChartEditor({
    card: structuredClone(card),
    isNew: add,
    camera: add ? undefined : cards.get(card.id)?.view.camera(),
    onClose: () => {
      activeEditor = undefined;
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
      const current =
        serverWorkspace?.workspace === workspace
          ? workspace
          : library.views.find((v) => v.id === workspace.id);
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
                id: uuid(),
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
  heading.id = `dialog-${uuid()}`;
  dialog.setAttribute("aria-labelledby", heading.id);
  const field = element("label", "field");
  const input = element("input");
  input.value = value;
  input.required = true;
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
  const settings = dashboardSettings(workspace);
  const signature = settings.smoothingSignature ?? "mixed";
  const smoothingMax =
    host.dataset.smoothingSignature === signature
      ? Number(
          host.querySelector<HTMLInputElement>(
            '[aria-label="Dashboard smoothing"]',
          )?.max ?? 0,
        )
      : undefined;
  host.dataset.smoothingSignature = signature;
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
  const shared = serverWorkspace?.workspace === workspace;
  const availableViews = [
    ...library.views.map((v) => ({ ...v, server: false })),
    ...serverViews
      .filter((v) => !shared || v.id !== workspace.id)
      .map((v) => ({ ...v, server: true })),
  ];
  // Use the active draft's name and experiment, not a potentially newer summary.
  if (shared)
    availableViews.push({
      ...workspace,
      revision: serverWorkspace!.revision,
      server: true,
    });
  for (const view of availableViews.filter(
    (v) => v.experimentId === workspace.experimentId,
  )) {
    const name =
      view.id === workspace.id && view.server === shared
        ? workspace.name
        : view.name;
    const o = element("option", "", `${name}${view.server ? " · Server" : ""}`);
    o.value = view.id;
    views.append(o);
  }
  if (
    shared &&
    !library.views.some((v) => v.experimentId === workspace.experimentId)
  ) {
    // A direct link need not have a local view yet. Create the ordinary
    // experiment Overview only if the user chooses to leave the shared view.
    const overview = element("option", "", "Overview");
    overview.value = "";
    views.prepend(overview);
  }
  views.value = workspace.id;
  views.onchange = () => {
    scrollPositions.set(workspace.id, pageScrollTop());
    if (shared && !views.value) {
      navigate(workspace.experimentId, "charts");
      return;
    }
    if (
      serverViews.some((v) => v.id === views.value) ||
      (shared && views.value === workspace.id)
    ) {
      location.hash = `/views/${encodeURIComponent(views.value)}`;
      return;
    }
    if (
      !commitLibrary(() => {
        library.activeByExperiment[workspace.experimentId] = views.value;
      })
    )
      return;
    if (shared) navigate(workspace.experimentId, "charts");
    else renderPage();
    requestAnimationFrame(() =>
      scrollPageTo(scrollPositions.get(views.value) ?? 0),
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
  action("Save changes", () => saveView(workspace));
  action(
    "Save view as…",
    () =>
      void (async () => {
        const generation = viewGeneration;
        const state = shared ? serverWorkspace : undefined;
        const name = await ask(
          "Save view as",
          "View name",
          `${workspace.name} copy`,
        );
        if (!name || generation !== viewGeneration || !connected) return;
        if (
          library.views.some(
            (v) => v.experimentId === workspace.experimentId && v.name === name,
          )
        ) {
          error("A view with that name already exists.");
          return;
        }
        if (state) {
          let copied = false;
          await serverAction(state, () =>
            state.saveAsLocal(name, (copy) => {
              if (generation !== viewGeneration || state !== serverWorkspace)
                return false;
              copied = commitLibrary(() => {
                library.views.push(copy);
                library.activeByExperiment[copy.experimentId] = copy.id;
              });
              if (copied) markSaved(copy);
              return copied;
            }),
          );
          if (copied && generation === viewGeneration)
            navigate(workspace.experimentId, "charts");
          return;
        }
        // The new view takes the current (possibly modified) layout; the
        // original goes back to its last saved layout instead of keeping edits.
        const copy = structuredClone(workspace);
        copy.id = uuid();
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
    if (shared) {
      const state = serverWorkspace!;
      void serverAction(state, () => state.revert());
      return;
    }
    const saved = baselineFor(workspace);
    change(workspace, () => {
      workspace.sections = JSON.parse(saved);
    });
  });
  const modified = isModified(workspace);
  for (const b of menu.querySelectorAll<HTMLButtonElement>("button"))
    if (b.textContent === "Save changes" || b.textContent === "Revert to saved")
      b.disabled = !modified || (shared && serverWorkspace!.busy);
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
              id: uuid(),
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
      const imported = importWorkspace(await selected.text());
      if (!catalog.experiments.some((e) => e.id === imported.experimentId))
        throw new Error(
          "This view belongs to an experiment that is not on this server.",
        );
      imported.id = uuid();
      if (
        !commitLibrary(() => {
          library.views.push(imported);
          library.activeByExperiment[imported.experimentId] = imported.id;
        })
      )
        return;
      if (
        !currentRoute().serverId &&
        currentRoute().experimentId === imported.experimentId
      ) {
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
  if (!shared)
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
              library.views = library.views.filter(
                (v) => v.id !== workspace.id,
              );
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
      change(
        workspace,
        () => {
          delete workspace.pendingSelectedRunIds;
          Object.assign(workspace, previous);
        },
        false,
        false,
      )
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
    const name = element(
      "span",
      "workspace-view-name",
      `${workspace.name}${shared ? " · Server" : ""}`,
    );
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
    "This view differs from its saved version. Save, revert (⋯), or save as a new view.";
  const saveNow = button("Save", () => saveView(workspace), "text-link");
  saveNow.setAttribute("aria-label", "Save view changes");
  saveNow.disabled = shared && serverWorkspace!.busy;
  marker.append(element("span", "view-modified-dot", "Modified"), saveNow);
  marker.hidden = !isModified(workspace);
  viewControl.append(marker);
  host.append(viewControl);
  if (Object.keys(workspace.runLabels ?? {}).length) {
    const group = element("label", "workspace-label-mode", "Run labels ");
    const naming = element("select");
    naming.setAttribute("aria-label", "Run labels");
    for (const [value, text] of [
      ["semantic", "Semantic"],
      ["original", "Original"],
    ]) {
      const option = element("option", "", text);
      option.value = value;
      naming.append(option);
    }
    naming.value = labelMode(workspace);
    naming.onchange = () => {
      const mode = naming.value === "original" ? "original" : "semantic";
      labelModes.set(workspace.id, mode);
      try {
        localStorage.setItem(
          `nset:chart-label-mode:v1:${encodeURIComponent(workspace.id)}`,
          mode,
        );
      } catch {}
      renderCharts(workspace);
    };
    group.append(naming);
    host.append(group);
  }
  if (settings.count) {
    const apply = (controls: DashboardControls) =>
      change(workspace, () => {
        workspace.sections = withDashboardSettings(workspace, controls);
      });
    host.append(
      createDashboardControls({
        axis: settings.axis,
        smoothing: settings.smoothing,
        smoothingMax,
        smoothingUnit: settings.smoothingUnit,
        smoothingSignature: settings.smoothingSignature,
        onAxis: (axis) => apply({ axis }),
        onSmoothing: (smoothingSigma) => apply({ smoothingSigma }),
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
function beginCardDrag(
  event: PointerEvent,
  header: HTMLElement,
  workspace: Workspace,
  id: string,
) {
  if (!event.isPrimary || event.button !== 0) return;
  if (
    event.target instanceof Element &&
    event.target.closest(
      "button,input,select,textarea,a,summary,.card-menu,[contenteditable],[role=button]",
    )
  )
    return;
  sectionDrag.cancel();
  const dashboard = $("dashboard");
  const snapshot = JSON.stringify(workspace),
    search = chartSearch;
  chartDrag.begin(event, header, {
    valid: () =>
      activeChartWorkspace(workspace.id) === workspace &&
      JSON.stringify(workspace) === snapshot &&
      chartSearch === search,
    target: (x, y) => {
      const grid = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>(".chart-grid");
      if (!grid || !dashboard.contains(grid) || grid.hidden) return;
      const sectionId =
        grid.closest<HTMLElement>(".chart-section")?.dataset.sectionId;
      if (!sectionId) return;
      return { ...sectionDropSlot(grid, x, y), sectionId };
    },
    drop: (slot) => {
      const found = locate(workspace, id);
      const section = workspace.sections.find((s) => s.id === slot.sectionId);
      if (!found || !section) return;
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
    },
  });
}

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

function moveSection(
  workspace: Workspace,
  id: string,
  targetId: string,
  after: boolean,
) {
  if (currentRoute().view !== "charts" || currentWorkspaceId !== workspace.id)
    return;
  const next = reorderSections(workspace.sections, id, targetId, after);
  if (next !== workspace.sections)
    change(workspace, () => {
      workspace.sections = next;
    });
}
/** Presentation-only: table and drawer share runStateFor; selections and drafts
 * deliberately stay in their authored order. Recompute from catalog order for ties. */
function chartRunOrder(experimentId: string): string[] {
  return sortedRunIds(
    catalog.runs.filter((run) => run.experiment_id === experimentId),
    catalog.series,
    runStateFor(experimentId),
  );
}
function refreshChartRunOrder(workspace: Workspace) {
  const order = chartRunOrder(workspace.experimentId);
  for (const entry of cards.values()) entry.view.setRunOrder(order);
}
function renderCharts(workspace: Workspace) {
  if (currentRoute().view !== "charts" || currentWorkspaceId !== workspace.id)
    return;
  sectionDrag.cancel();
  const focused = document.activeElement;
  const focusedSection = focused?.closest<HTMLElement>(".chart-section");
  const focusedHeader = focused?.closest(".section-heading");
  const focusToggle = focused?.classList.contains("section-toggle");
  // An unchanged refresh keeps the gesture; changed workspace state cancels it.
  chartDrag.validate();
  runDrawer?.update(catalog, workspace.selectedRunIds);
  workspaceToolbar(workspace);
  const dashboard = $("dashboard");
  const keep = new Set<string>();
  const runOrder = chartRunOrder(workspace.experimentId);

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
      button("Move to top", () => {
        summary.focus({ preventScroll: true });
        menu.open = false;
        moveSection(workspace, section.id, workspace.sections[0].id, false);
      }),
      button("Move to bottom", () => {
        summary.focus({ preventScroll: true });
        menu.open = false;
        moveSection(workspace, section.id, workspace.sections.at(-1)!.id, true);
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
    for (const [cardIndex, spec] of section.cards.entries()) {
      const contextKey = `${catalogGeneration}:${chartFollowsSelection(spec) ? workspace.selectedRunIds.join(",") : "explicit"}:${labelMode(workspace)}:${JSON.stringify(workspace.runLabels ?? {})}`;
      keep.add(spec.id);
      let entry = cards.get(spec.id);
      const serialized = JSON.stringify(spec);
      if (!entry) {
        const host = element("article", "dashboard-cell");
        host.dataset.cardId = spec.id;
        host.dataset.cardKind = spec.kind;
        host.setAttribute("aria-label", spec.title);
        const view = new ChartCard(host, spec, context(workspace), {
          onDetails: (id) => openChartDetails(workspace.id, id),
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
                copy.id = uuid();
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
      entry.view.setRunOrder(runOrder);
      // The header (including its title) is the handle, not the plot or controls.
      const cardHeader = entry.host.querySelector<HTMLElement>(".card-header");
      if (cardHeader) {
        cardHeader.classList.add("card-reorder-handle");
        cardHeader.draggable = false;
        cardHeader.ondragstart = (event) => event.preventDefault();
        cardHeader.onpointerdown = (event) =>
          beginCardDrag(event, cardHeader, workspace, spec.id);
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
  sectionDrag.bind(dashboard, (id, targetId, after) =>
    moveSection(workspace, id, targetId, after),
  );
  if (focusedHeader && focusedSection?.dataset.sectionId)
    sectionNodes
      .get(focusedSection.dataset.sectionId)
      ?.querySelector<HTMLElement>(
        focusToggle ? ".section-toggle" : ".section-menu > summary",
      )
      ?.focus({ preventScroll: true });
}
function applyChartFilter(workspace: Workspace) {
  sectionDrag.cancel();
  chartDrag.validate();
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
        (!chartFollowsSelection(spec) || workspace.selectedRunIds.length > 0);
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
  syncChartDetails(workspace);
}

let liveState: LiveStatus = "stopped";
let liveCacheError: string | null = null;
let liveCacheErrorTimer: ReturnType<typeof setTimeout> | undefined;
let liveCacheErrorVisible = false;
let liveModelTimer: ReturnType<typeof setTimeout> | undefined;
let liveMetadataPending = false;
function paintLiveHealth() {
  if (!connected) return;
  const unhealthy =
    liveState === "reconnecting" ||
    liveState === "unauthorized" ||
    liveCacheErrorVisible;
  const text =
    liveState === "unauthorized"
      ? "Authentication required"
      : unhealthy
        ? "Reconnecting…"
        : "Connected";
  if ($("connection").textContent !== text) $("connection").textContent = text;
  $("connection").classList.toggle("connected", !unhealthy);
  if ($("connection").dataset.live !== liveState)
    $("connection").dataset.live = liveState;
}
store.setLiveStatusListener((error) => {
  liveCacheError = error;
  if (!error) {
    clearTimeout(liveCacheErrorTimer);
    liveCacheErrorTimer = undefined;
    liveCacheErrorVisible = false;
  } else if (!liveCacheErrorTimer && !liveCacheErrorVisible) {
    liveCacheErrorTimer = setTimeout(() => {
      liveCacheErrorTimer = undefined;
      liveCacheErrorVisible = !!liveCacheError;
      paintLiveHealth();
    }, 3000);
  }
  paintLiveHealth();
});
function scheduleLiveModel(metadata: boolean) {
  liveMetadataPending ||= metadata;
  if (liveModelTimer || document.hidden) return;
  liveModelTimer = setTimeout(() => {
    liveModelTimer = undefined;
    if (!connected || document.hidden) return;
    const metadata = liveMetadataPending;
    liveMetadataPending = false;
    if (metadata) refreshRunFilterSessions();
    liveTable?.updateCatalog(catalog);
    const workspace = activeChartWorkspace();
    if (workspace) {
      if (metadata) {
        runDrawer?.update(catalog, workspace.selectedRunIds);
        syncChartDetails(workspace);
      } else runDrawer?.updateMetrics(catalog);
      refreshChartRunOrder(workspace);
    }
  }, 500);
}
function liveCatalogInstalled(next: Catalog, metadata: boolean) {
  catalog = next;
  for (const entry of cards.values()) entry.view.updateCatalog(catalog);
  scheduleLiveModel(metadata);
}
async function repairLiveCatalog(signal: AbortSignal, rxOnly = false) {
  const generation = catalogGeneration;
  let next: Catalog;
  if (rxOnly && catalog.rx) {
    const id = catalog.rx.id;
    next = await appendRxCatalog(
      api,
      {
        ...catalog,
        rx: undefined,
        experiments: catalog.experiments.filter((e) => e.id !== id),
        runs: catalog.runs.filter((r) => !r.rx),
        series: catalog.series.filter(
          (s) => !catalog.runs.some((r) => r.id === s.run_id && r.rx),
        ),
      },
      signal,
    );
  } else next = await fetchCatalog(api, signal);
  if (signal.aborted || !connected || generation !== catalogGeneration)
    throw new DOMException("Aborted", "AbortError");
  // A transient external-source error is not an authoritative empty catalog.
  // Leave the hint unacknowledged so quiet runs recover without another write.
  if (next.rx?.error) throw new Error(next.rx.error);
  liveCatalogInstalled(next, true);
}
async function applyLiveChanges(changes: LiveChange[], signal: AbortSignal) {
  const metadata = changes.some(
    (c) =>
      c.kind === "catalog" ||
      c.kind === "image" ||
      (c.kind === "metric" && !catalog.runs.some((r) => r.id === c.runId)),
  );
  const rx = changes.some((c) => c.kind === "rx");
  if (metadata || rx) await repairLiveCatalog(signal, !metadata && rx);
  if (signal.aborted) return;
  const next = applyMetricHints(catalog, changes);
  if (next !== catalog) liveCatalogInstalled(next, false);
  store.markDirty(
    changes
      .filter((c) => c.kind === "metric")
      .map((c) => ({ runId: c.runId, key: c.key, kind: "metric" as const })),
  );
  for (const entry of cards.values()) {
    if (rx) entry.view.refreshLiveRecords();
    for (const change of changes)
      if (change.kind === "image")
        entry.view.refreshLiveImages(change.runId, change.key);
  }
}
const live = new LiveUpdates(() => token, {
  changes: applyLiveChanges,
  reset: async (signal) => {
    await repairLiveCatalog(signal);
    if (signal.aborted) return;
    store.resetLive();
    for (const entry of cards.values()) {
      entry.view.refreshLiveRecords();
      entry.view.refreshLiveImages();
    }
  },
  status: (state) => {
    liveState = state;
    paintLiveHealth();
  },
});
function stopLive() {
  live.stop();
  store.setLiveEnabled(false);
  clearTimeout(liveModelTimer);
  clearTimeout(liveCacheErrorTimer);
  liveModelTimer = liveCacheErrorTimer = undefined;
  liveMetadataPending = false;
  liveCacheErrorVisible = false;
  liveCacheError = null;
  liveState = "stopped";
}
async function connect(refresh = false) {
  stopServerPoll();
  stopLive();
  catalogRefreshing = true;
  for (const session of runFilterSessions.values()) session.invalidate();
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
    const liveCursor = await live.prepare(signal);
    const next = await fetchCatalog(api, signal);
    if (generation !== catalogGeneration || signal.aborted) return;
    store.clear();
    catalog = next;
    catalogRefreshing = false;
    refreshRunFilterSessions();
    connected = true;
    sessionStorage.setItem("nset.token", token);
    $("connection").textContent = "Connected";
    $("connection").classList.add("connected");
    $<HTMLDialogElement>("login-dialog").close();
    $<HTMLButtonElement>("logout").disabled = false;
    if (refresh && currentRoute().view === "charts" && currentWorkspaceId) {
      const workspace =
        currentRoute().serverId && serverWorkspace
          ? serverWorkspace.workspace
          : workspaceFor(currentRoute().experimentId);
      renderCharts(workspace);
    } else renderPage();
    store.setLiveEnabled(!document.hidden);
    live.setVisible(!document.hidden);
    live.start(liveCursor);
    void pollServerViews();
    if (catalog.rx?.error) error(catalog.rx.error);
  } catch (e) {
    if (isAbort(e) || generation !== catalogGeneration) return;
    catalogRefreshing = false;
    for (const session of runFilterSessions.values())
      session.invalidate(message(e));
    if (connected) {
      error(`Could not refresh. Previous data is still shown. ${message(e)}`);
      store.setLiveEnabled(!document.hidden);
      live.setVisible(!document.hidden);
      live.start();
    } else {
      $("login-error").textContent = message(e);
      if (!$<HTMLDialogElement>("login-dialog").open)
        $<HTMLDialogElement>("login-dialog").showModal();
    }
  } finally {
    if (generation === catalogGeneration) {
      submit.disabled = false;
      $<HTMLButtonElement>("refresh").disabled = !connected;
      scheduleServerPoll();
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
  stopLive();
  disposeServerView();
  serverViews = [];
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
  catalogRefreshing = false;
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
  const workspace = activeChartWorkspace();
  if (workspace) syncChartDetails(workspace);
});
window.addEventListener("hashchange", () => {
  disposeServerView();
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
document.addEventListener("visibilitychange", () => {
  live.setVisible(!document.hidden);
  store.setLiveEnabled(connected && !document.hidden);
  if (document.hidden) stopServerPoll();
  else if (connected) {
    void pollServerViews();
    scheduleLiveModel(liveMetadataPending);
  }
});
window.addEventListener("beforeunload", () => {
  stopLive();
  disposeServerView();
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
