import type { Api, Run } from "./api";
import { RunFilterMenu } from "./run-filter-menu";
import {
  activeConditions,
  emptyFilter,
  parseFilterValue,
  runFilterResult,
  type FilterCondition,
  type FilterField,
  type RunFilter,
} from "./run-filter";
import { recordPath, validateRecordScalar, type RecordResult } from "./records";
import { element } from "./utils";

interface Batch {
  source: string;
  uids: string[];
  cursor?: string;
}
interface FilterPage {
  source_generation: string;
  runs: { uid: string; conditions: (boolean | null)[] }[];
  cursor: string | null;
  diagnostics: { scanned: number; partial: boolean };
}
export interface FieldPage {
  fields: FilterField[];
  more: boolean;
  note: string;
}
const identity = (source: string, uid: string) => JSON.stringify([source, uid]);
const conditionKey = (c: FilterCondition) => JSON.stringify(c);

/** One experiment's complete search, using bounded requests independent of chart selection. */
export class RunFilterSession {
  api?: Api;
  private current: RunFilter;
  private now = Date.now();
  private clock?: ReturnType<typeof setInterval>;
  runs: Run[] = [];
  private revision: unknown;
  private sourceSnapshot?: {
    id: string;
    sourceGeneration?: string;
    error?: string;
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = true;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private proofs = new Map<string, (boolean | null)[]>();
  private sourceGenerations = new Map<string, string>();
  private batches: Batch[] = [];
  private batch = 0;
  private clauses: FilterCondition[] = [];
  busy = false;
  refreshing = false;
  error = "";
  scanned = 0;
  private discovery?: {
    key: string;
    batch: number;
    cursor?: unknown;
    fields: Map<string, FilterField>;
    done: boolean;
  };
  private discoveryAbort?: AbortController;

  constructor(
    filter: RunFilter = emptyFilter(),
    api?: Api,
    private readonly refreshScope?: () => void,
    private readonly onFilterChange?: (filter: RunFilter) => void,
  ) {
    this.current = structuredClone(filter);
    this.api = api;
  }
  get filter() {
    return this.current;
  }
  get hasEvents() {
    return this.runs.some((r) => !!r.rx);
  }
  get pending() {
    return this.runs.filter((r) => this.result(r) === null).length;
  }
  get canContinue() {
    return this.batch < this.batches.length;
  }
  setFilter(filter: RunFilter) {
    if (JSON.stringify(filter) === JSON.stringify(this.current)) return;
    const eventClauses = (value: RunFilter) =>
      activeConditions(value).filter(
        (condition) => condition.scope === "event",
      );
    const unchangedEvents =
      JSON.stringify(eventClauses(filter)) ===
      JSON.stringify(eventClauses(this.current));
    this.current = structuredClone(filter);
    this.onFilterChange?.(this.current);
    this.now = Date.now();
    if (
      unchangedEvents &&
      !this.busy &&
      (this.error || !this.runs.some((run) => this.result(run) === null))
    )
      this.emit();
    else this.reset();
  }
  setRuns(
    runs: Run[],
    revision?: unknown,
    sourceSnapshot?: { id: string; sourceGeneration?: string; error?: string },
  ) {
    if (
      (revision !== undefined && revision === this.revision) ||
      (revision === undefined && runs === this.runs)
    ) {
      this.refreshTime();
      return;
    }
    this.runs = runs;
    this.refreshing = false;
    this.revision = revision;
    this.sourceSnapshot = sourceSnapshot;
    this.discovery = undefined;
    this.discoveryAbort?.abort();
    this.reset();
  }
  private candidates(unresolvedOnly = false): Batch[] {
    const sources = new Map<string, Set<string>>();
    for (const run of this.runs)
      if (run.rx && (!unresolvedOnly || this.result(run) === null)) {
        const uids = sources.get(run.rx.sourceId) ?? new Set<string>();
        uids.add(run.rx.uid);
        sources.set(run.rx.sourceId, uids);
      }
    return [...sources].flatMap(([source, set]) => {
      const uids = [...set];
      return Array.from({ length: Math.ceil(uids.length / 32) }, (_, i) => ({
        source,
        uids: uids.slice(i * 32, i * 32 + 32),
      }));
    });
  }
  private stop() {
    this.generation++;
    clearTimeout(this.timer);
    this.abort?.abort();
    this.busy = false;
  }
  private reset() {
    this.now = Date.now();
    this.stop();
    this.proofs.clear();
    this.sourceGenerations.clear();
    if (this.sourceSnapshot?.sourceGeneration)
      this.sourceGenerations.set(
        this.sourceSnapshot.id,
        this.sourceSnapshot.sourceGeneration,
      );
    this.clauses = activeConditions(this.current).filter(
      (c) => c.scope === "event",
    );
    this.batches = this.clauses.length ? this.candidates(true) : [];
    this.batch = 0;
    this.scanned = 0;
    this.error = this.sourceSnapshot?.error ?? "";
    this.emit();
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (
      this.active &&
      !this.refreshing &&
      this.listeners.size &&
      this.canContinue &&
      !this.error
    )
      this.timer = setTimeout(() => void this.continueScan(), 180);
  }
  subscribe(listener: () => void) {
    // Reopening a view may cross a relative boundary while no clock is running.
    if (!this.listeners.size) this.refreshTime();
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.clock = setInterval(() => this.refreshTime(), 30_000);
      this.schedule();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearInterval(this.clock);
        this.stop();
        this.discoveryAbort?.abort();
      }
    };
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  result(run: Run, filter = this.current): boolean | null {
    const evidence = run.rx
      ? this.proofs.get(identity(run.rx.sourceId, run.rx.uid))
      : undefined;
    return runFilterResult(
      run,
      filter,
      (c) => {
        const i = this.clauses.findIndex(
          (clause) => conditionKey(clause) === conditionKey(c),
        );
        return i < 0 ? null : (evidence?.[i] ?? null);
      },
      this.now,
    );
  }
  matches(run: Run) {
    return this.result(run) === true;
  }
  count(filter = this.current) {
    return this.runs.filter((r) => this.result(r, filter) === true).length;
  }

  /** A single clock snapshot shared by counts, table, drawer and event proofs. */
  refreshTime() {
    if (
      !this.active ||
      !this.current.conditions.some(
        (c) =>
          c.scope === "time" &&
          ["last", "older", "today", "yesterday"].includes(c.op),
      )
    )
      return;
    this.now = Date.now();
    // Time can make a previously excluded run need Event evidence. Keep existing
    // proofs and queue only unresolved candidates rather than re-querying all runs.
    if (!this.busy && this.clauses.length && !this.refreshing && !this.error) {
      this.batches = this.candidates(true);
      this.batch = 0;
    }
    this.emit();
    this.schedule();
  }

  async continueScan() {
    if (
      !this.active ||
      this.refreshing ||
      this.busy ||
      this.error ||
      !this.canContinue
    )
      return;
    const version = this.generation;
    const abort = (this.abort = new AbortController());
    this.busy = true;
    this.error = "";
    this.emit();
    try {
      if (!this.api)
        throw new Error("Event filters need a connected rx source.");
      const conditions = this.clauses.map((c) => {
        recordPath(c.path);
        return {
          path: c.path,
          op: c.op === "neq" ? "ne" : c.op,
          value:
            c.op === "exists" || c.op === "missing"
              ? null
              : validateRecordScalar(parseFilterValue(c.value)),
        };
      });
      if (conditions.length > 16)
        throw new Error("Use at most 16 Event conditions.");
      // Backpressure: one bounded request at a time until the pinned search finishes.
      while (this.canContinue) {
        if (version !== this.generation || abort.signal.aborted) return;
        const batch = this.batches[this.batch];
        const page = await this.api.post<FilterPage>(
          "/rx/run-filter",
          {
            source_id: batch.source,
            runs: batch.uids,
            conditions,
            ...(batch.cursor ? { cursor: batch.cursor } : {}),
          },
          abort.signal,
        );
        if (version !== this.generation || abort.signal.aborted) return;
        const pinned = this.sourceGenerations.get(batch.source);
        if (
          !page.source_generation ||
          (pinned !== undefined && pinned !== page.source_generation)
        )
          throw new Error("rx source changed; restart filtering");
        this.sourceGenerations.set(batch.source, page.source_generation);
        for (const run of page.runs)
          this.proofs.set(identity(batch.source, run.uid), run.conditions);
        this.scanned += page.diagnostics.scanned;
        if (page.cursor) {
          if (page.cursor === batch.cursor)
            throw new Error("Event search made no progress; retry filtering.");
          batch.cursor = page.cursor;
        } else {
          if (
            batch.uids.some((uid) => {
              const evidence = this.proofs.get(identity(batch.source, uid));
              return (
                !evidence ||
                evidence.length !== this.clauses.length ||
                evidence.some((v) => typeof v !== "boolean")
              );
            })
          )
            throw new Error(
              "Event search could not read all required records.",
            );
          this.batch++;
        }
        // A rolling time boundary may have admitted more runs while awaiting
        // this page. Resolve those before declaring the full search complete.
        if (!this.canContinue) {
          this.batches = this.candidates(true);
          this.batch = 0;
        }
        this.emit();
      }
    } catch (error) {
      if (version !== this.generation || abort.signal.aborted) return;
      // Api errors are untyped: conservatively revoke all Event evidence,
      // including cached false/absence proofs, before offering explicit retry.
      // Native clauses and the views' plotted selections are untouched.
      clearTimeout(this.timer);
      this.proofs.clear();
      this.sourceGenerations.clear();
      this.batches = [];
      this.batch = 0;
      this.scanned = 0;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (version === this.generation && !abort.signal.aborted) {
        this.busy = false;
        this.emit();
      }
    }
  }
  restart() {
    this.reset();
  }
  retry() {
    if (this.refreshScope) this.refreshScope();
    else this.restart();
  }
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.refreshTime();
      this.schedule();
    } else {
      this.stop();
      this.discoveryAbort?.abort();
    }
  }
  invalidate(error = "") {
    this.stop();
    this.refreshing = !error;
    this.discovery = undefined;
    this.discoveryAbort?.abort();
    this.proofs.clear();
    this.sourceGenerations.clear();
    this.batches = [];
    this.batch = 0;
    this.scanned = 0;
    this.error = error;
    this.busy = !error;
    this.emit();
  }

  /** One bounded discovery page per keystroke/action, scoped to all candidate runs. */
  async discover(
    prefix: string,
    signal: AbortSignal,
    more = false,
  ): Promise<FieldPage> {
    if (!this.api)
      return {
        fields: [],
        more: false,
        note: "Connect an rx source for Event hints.",
      };
    const batches = this.candidates();
    const key = JSON.stringify([prefix, batches]);
    if (!more || this.discovery?.key !== key)
      this.discovery = { key, batch: 0, fields: new Map(), done: false };
    const state = this.discovery!;
    const batch = batches[state.batch];
    if (!batch || state.done)
      return {
        fields: [...state.fields.values()],
        more: false,
        note: "Sampled Event fields",
      };
    this.discoveryAbort?.abort();
    const abort = (this.discoveryAbort = new AbortController());
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) abort.abort();
    try {
      const result = await this.api.post<RecordResult>(
        "/rx/fields",
        {
          source_id: batch.source,
          runs: batch.uids,
          search: prefix,
          ...(state.cursor ? { cursor: state.cursor } : {}),
        },
        abort.signal,
      );
      if (abort.signal.aborted || this.discovery !== state)
        throw new DOMException("Aborted", "AbortError");
      for (const hint of result.fields) {
        if (!state.fields.has(hint.path) && state.fields.size >= 256)
          state.fields.delete(state.fields.keys().next().value!);
        state.fields.set(hint.path, {
          scope: "event",
          path: hint.path,
          label: hint.path,
          count: 0,
          examples: hint.values.map((value) => JSON.stringify(value)),
          types: hint.types,
        });
      }
      state.cursor = result.next_cursor ?? undefined;
      if (!state.cursor) state.batch++;
      state.done = state.batch >= batches.length;
      return {
        fields: [...state.fields.values()],
        more: !state.done,
        note: "Sampled Event fields · exact paths also accepted",
      };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  destroy() {
    clearInterval(this.clock);
    this.stop();
    this.discoveryAbort?.abort();
    this.discovery = undefined;
    this.proofs.clear();
    this.sourceGenerations.clear();
    this.listeners.clear();
    this.runs = [];
  }
}

/** The same menu and honest proof-progress UI in both production run lists. */
export class RunFilterControl {
  readonly root = element("span", "run-filter-control");
  private readonly menu: RunFilterMenu;
  private readonly unsubscribe: () => void;
  private destroyed = false;
  constructor(
    private session: RunFilterSession,
    onChange: () => void,
  ) {
    this.menu = new RunFilterMenu(
      session.filter,
      (filter) => session.setFilter(filter),
      (filter) => session.count(filter),
      {
        retry: () => session.retry(),
        discover: (prefix, signal, more) =>
          session.discover(prefix, signal, more),
      },
    );
    const status = element("span", "run-filter-progress");
    status.setAttribute("role", "status");
    this.menu.root.querySelector("summary")!.append(status);
    this.root.append(this.menu.root);
    let runs: Run[] | undefined;
    const update = () => {
      if (this.destroyed) return;
      if (runs !== session.runs) {
        runs = session.runs;
        this.menu.setRuns(runs);
      }
      this.menu.setFilter(session.filter);
      this.menu.refreshCounts();
      const searching =
        session.refreshing || session.busy || session.canContinue;
      this.root.setAttribute("aria-busy", String(searching));
      status.textContent = session.error ? "!" : searching ? "…" : "";
      status.setAttribute(
        "aria-label",
        session.error
          ? "Filter failed: open filters for details"
          : searching
            ? `Searching · ${session.count()} matches`
            : "Search complete",
      );
      status.title = session.error
        ? "Filter failed: open filters for details"
        : searching
          ? `Searching · ${session.count()} matches · ${session.scanned.toLocaleString()} events checked`
          : `${session.count()} matches`;
      this.menu.setError(session.error);
      onChange();
    };
    this.unsubscribe = session.subscribe(update);
    // Construction can precede the host view's render function initialization.
    queueMicrotask(update);
  }
  destroy() {
    this.destroyed = true;
    this.unsubscribe();
    this.menu.destroy();
  }
}
