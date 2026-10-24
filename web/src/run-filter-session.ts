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

/** One experiment's clauses and bounded proof state, independent of chart selection. */
export class RunFilterSession {
  api?: Api;
  private current: RunFilter;
  runs: Run[] = [];
  private revision: unknown;
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private proofs = new Map<string, (boolean | null)[]>();
  private batches: Batch[] = [];
  private batch = 0;
  private clauses: FilterCondition[] = [];
  busy = false;
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

  constructor(filter: RunFilter = emptyFilter(), api?: Api) {
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
    if (unchangedEvents) this.emit();
    else this.reset();
  }
  setRuns(runs: Run[], revision?: unknown) {
    if (revision !== undefined && revision === this.revision) return;
    if (revision === undefined && runs === this.runs) return;
    this.runs = runs;
    this.revision = revision;
    this.discovery = undefined;
    this.discoveryAbort?.abort();
    this.reset();
  }
  private candidates(): Batch[] {
    const sources = new Map<string, Set<string>>();
    for (const run of this.runs)
      if (run.rx) {
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
    this.stop();
    this.proofs.clear();
    this.clauses = activeConditions(this.current).filter(
      (c) => c.scope === "event",
    );
    this.batches = this.clauses.length ? this.candidates() : [];
    this.batch = 0;
    this.scanned = 0;
    this.error = "";
    this.emit();
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.listeners.size && this.canContinue)
      this.timer = setTimeout(() => void this.continueScan(), 180);
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
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
    return runFilterResult(run, filter, (c) => {
      const i = this.clauses.findIndex(
        (clause) => conditionKey(clause) === conditionKey(c),
      );
      return i < 0 ? null : (evidence?.[i] ?? null);
    });
  }
  matches(run: Run) {
    return this.result(run) === true;
  }
  count(filter = this.current) {
    return this.runs.filter((r) => this.result(r, filter) === true).length;
  }

  async continueScan() {
    if (this.busy || !this.canContinue) return;
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
      // A user action has a fixed request budget; continuation never caps the catalog.
      for (let pages = 0; pages < 4 && this.canContinue; pages++) {
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
        for (const run of page.runs)
          this.proofs.set(identity(batch.source, run.uid), run.conditions);
        this.scanned += page.diagnostics.scanned;
        if (page.cursor) batch.cursor = page.cursor;
        else this.batch++;
        this.emit();
      }
    } catch (error) {
      if (version !== this.generation || abort.signal.aborted) return;
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
    this.stop();
    this.discoveryAbort?.abort();
    this.discovery = undefined;
    this.proofs.clear();
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
        discover: (prefix, signal, more) =>
          session.discover(prefix, signal, more),
      },
    );
    const status = element("span", "run-filter-progress muted");
    status.setAttribute("role", "status");
    const next = element("button", "text-link", "Continue scan");
    next.type = "button";
    next.onclick = () =>
      session.error ? session.restart() : void session.continueScan();
    this.root.append(this.menu.root, status, next);
    let runs: Run[] | undefined;
    const update = () => {
      if (this.destroyed) return;
      if (runs !== session.runs) {
        runs = session.runs;
        this.menu.setRuns(runs);
      }
      this.menu.setFilter(session.filter);
      this.menu.refreshCounts();
      const pending = session.pending;
      status.textContent = session.error
        ? `Event scan: ${session.error}`
        : session.busy
          ? `${pending} unchecked · scanning…`
          : pending
            ? `${pending} unchecked${session.canContinue ? "" : " · unreadable events"}`
            : "";
      status.title = session.scanned
        ? `${session.scanned.toLocaleString()} events checked`
        : "";
      next.hidden = !session.error && (!session.canContinue || session.busy);
      next.textContent = session.error ? "Retry scan" : "Continue scan";
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
