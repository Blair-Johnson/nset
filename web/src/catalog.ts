import { appendRxCatalog } from "./records";
import {
  HttpError,
  MetricProtocolError,
  type Api,
  type Experiment,
  type Run,
} from "./api";
import { assertSafe } from "./config";
import type { Point } from "./math";
import type {
  Catalog,
  CatalogSeries,
  MetricLoader,
  SeriesRef,
} from "./workspace-types";
import { seriesId } from "./workspace";

// Preserve the existing network-response protections independently of local saved views.
function assertCatalogEntry(value: unknown): void {
  const limits = {
    bytes: 262144,
    nodes: 20000,
    string: 8192,
    array: 4096,
    depth: 32,
  };
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value: current, depth } = pending.pop()!;
    if (++nodes > limits.nodes || depth > limits.depth)
      throw new Error("Catalog entry exceeds JSON value/depth limits.");
    if (typeof current === "string" && current.length > limits.string)
      throw new Error("Catalog entry exceeds JSON string limit.");
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current) && current.length > limits.array)
      throw new Error("Catalog entry exceeds JSON array limit.");
    const entries = Object.entries(current);
    if (entries.length > limits.nodes)
      throw new Error("Catalog entry exceeds JSON value limit.");
    for (const [key, child] of entries) {
      if (key.length > limits.string)
        throw new Error("Catalog entry exceeds JSON key limit.");
      pending.push({ value: child, depth: depth + 1 });
    }
  }
  assertSafe(value);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > limits.bytes)
    throw new Error("Catalog entry exceeds JSON byte limit.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid catalog object.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8192)
    throw new Error("Invalid catalog text.");
  return value;
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Invalid catalog number.");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 1000000)
    throw new Error("Invalid or oversized catalog list.");
  return value;
}
function distinct(values: string[]): void {
  if (new Set(values).size !== values.length)
    throw new Error("Duplicate catalog identity.");
}
export async function fetchCatalog(
  api: Api,
  signal?: AbortSignal,
): Promise<Catalog> {
  const response = await api.response("/catalog", signal);
  const body = await response.text();
  if (signal?.aborted) throw aborted();
  if (body.length > 32 * 1024 * 1024)
    throw new Error("Catalog exceeds 32 MiB.");
  const data = record(JSON.parse(body));
  if (
    Object.keys(data).some(
      (key) =>
        !["experiments", "runs", "series", "rx_enabled", "metric_seq"].includes(
          key,
        ),
    )
  )
    throw new Error("Unknown catalog field.");
  const experiments: Experiment[] = list(data.experiments).map((value) => {
    assertCatalogEntry(value);
    const e = record(value);
    return {
      id: text(e.id),
      name: text(e.name),
      created_at: finite(e.created_at),
    };
  });
  distinct(experiments.map((e) => e.id));
  const experimentIds = new Set(experiments.map((e) => e.id));
  const runs: Run[] = list(data.runs).map((value) => {
    assertCatalogEntry(value);
    const r = record(value);
    if (!["running", "finished", "failed"].includes(r.status as string))
      throw new Error("Invalid run status.");
    const run: Run = {
      id: text(r.id),
      experiment_id: text(r.experiment_id),
      name: text(r.name),
      status: r.status as Run["status"],
      params: record(r.params),
      tags: record(r.tags),
      created_at: finite(r.created_at),
      updated_at: finite(r.updated_at),
    };
    if (!experimentIds.has(run.experiment_id))
      throw new Error("Unknown run experiment.");
    return run;
  });
  distinct(runs.map((r) => r.id));
  const runIds = new Set(runs.map((r) => r.id));
  const series: CatalogSeries[] = list(data.series).map((value) => {
    assertCatalogEntry(value);
    const s = record(value);
    if (s.kind !== "metric" && s.kind !== "image")
      throw new Error("Unknown series kind.");
    const count = finite(s.count);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid series count.");
    if (s.kind === "image" && s.last_value !== null)
      throw new Error("Image series cannot contain scalar values.");
    const result: CatalogSeries = {
      run_id: text(s.run_id),
      key: text(s.key),
      kind: s.kind,
      count,
      last_step: finite(s.last_step),
      last_timestamp: finite(s.last_timestamp),
      last_value: s.kind === "image" ? null : finite(s.last_value),
    };
    if (!runIds.has(result.run_id)) throw new Error("Unknown series run.");
    return result;
  });
  distinct(
    series.map((s) => seriesId({ runId: s.run_id, key: s.key, kind: s.kind })),
  );
  const catalog: Catalog = { experiments, runs, series };
  if (data.metric_seq !== undefined) {
    if (
      typeof data.metric_seq !== "number" ||
      !Number.isSafeInteger(data.metric_seq) ||
      data.metric_seq < 0
    )
      throw new Error("Invalid catalog metric_seq.");
    catalog.metric_seq = data.metric_seq;
  }
  return data.rx_enabled === true
    ? appendRxCatalog(api, catalog, signal)
    : catalog;
}

const aborted = () => new DOMException("Aborted", "AbortError");
interface Subscriber {
  resolve: (points: Point[]) => void;
  reject: (error: unknown) => void;
  progress?: (done: number, total: number) => void;
  cleanup: () => void;
}
interface Watch {
  callback: () => void;
}
interface Entry {
  key: string;
  ref: SeriesRef;
  points?: Point[];
  snapshot: number;
  dirty: number;
  clean: number;
  full: boolean;
  watchers: Set<Watch>;
  subscribers: Set<Subscriber>;
  request?: Request;
  failures: number;
  retryAt: number;
}
interface Request {
  entry: Entry;
  controller: AbortController;
  generation: number;
  version: number;
  progress?: [number, number];
}
/** Only complete snapshots are published. Watched prefixes are pinned beyond the LRU budget. */
export class MetricStore implements MetricLoader {
  private readonly entries = new Map<string, Entry>();
  private queue: Request[] = [];
  private active = 0;
  private generation = 0;
  private enabled = true;
  private timer?: ReturnType<typeof setTimeout>;
  private tail?: AbortController;
  private status?: (error: string | null) => void;
  private error: string | null = null;
  constructor(
    private readonly api: Api,
    private readonly maxConcurrent = 4,
    private readonly maxEntries = 24,
  ) {
    if (
      !Number.isSafeInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      maxConcurrent > 64 ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 0 ||
      maxEntries > 4096
    )
      throw new Error("Invalid metric store limits.");
  }
  private entry(ref: SeriesRef): Entry {
    const key = seriesId(ref);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        ref: { ...ref },
        snapshot: 0,
        dirty: 0,
        clean: -1,
        full: true,
        watchers: new Set(),
        subscribers: new Set(),
        failures: 0,
        retryAt: 0,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }
  private demanded(entry: Entry): boolean {
    return entry.watchers.size > 0 || entry.subscribers.size > 0;
  }
  private dirty(entry: Entry): boolean {
    return entry.full || !entry.points || entry.clean !== entry.dirty;
  }
  load(
    ref: SeriesRef,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Point[]> {
    if (signal?.aborted) return Promise.reject(aborted());
    if (ref.kind !== "metric")
      return Promise.reject(new Error("MetricStore loads metric series only."));
    const entry = this.entry(ref);
    if (!this.dirty(entry)) {
      const generation = this.generation,
        points = entry.points!;
      this.touch(entry);
      return new Promise((resolve, reject) =>
        queueMicrotask(() => {
          if (signal?.aborted || generation !== this.generation)
            return reject(aborted());
          this.notify(onProgress, points.length, points.length);
          resolve(points);
        }),
      );
    }
    entry.failures = 0;
    entry.retryAt = 0;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        entry.subscribers.delete(subscriber);
        subscriber.cleanup();
        reject(aborted());
        if (!this.demanded(entry) && entry.request) {
          entry.request.controller.abort();
          this.queue = this.queue.filter(
            (request) => request !== entry.request,
          );
          entry.request = undefined;
        }
        this.evict();
      };
      const subscriber: Subscriber = {
        resolve,
        reject,
        progress: onProgress,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      };
      entry.subscribers.add(subscriber);
      signal?.addEventListener("abort", cancel, { once: true });
      if (entry.request?.progress)
        this.notify(onProgress, ...entry.request.progress);
      this.ensure(entry, true);
    });
  }
  watch(refs: SeriesRef[], onChange: () => void): () => void {
    const watch: Watch = { callback: onChange };
    const entries = [
      ...new Map(
        refs
          .filter((ref) => ref.kind === "metric")
          .map((ref) => [seriesId(ref), this.entry(ref)]),
      ).values(),
    ];
    for (const entry of entries) {
      entry.watchers.add(watch);
      entry.failures = 0;
      entry.retryAt = 0;
      this.ensure(entry);
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      for (const entry of entries) {
        entry.watchers.delete(watch);
        if (!this.demanded(entry) && entry.request) {
          entry.request.controller.abort();
          this.queue = this.queue.filter(
            (request) => request !== entry.request,
          );
          entry.request = undefined;
        }
      }
      this.evict();
    };
  }
  markDirty(refs?: SeriesRef[]): void {
    const entries =
      refs === undefined
        ? [...this.entries.values()]
        : [
            ...new Set(
              refs
                .filter((ref) => ref.kind === "metric")
                .map((ref) => this.entries.get(seriesId(ref)))
                .filter((entry): entry is Entry => !!entry),
            ),
          ];
    for (const entry of entries) {
      entry.dirty++;
      entry.failures = 0;
      entry.retryAt = 0;
    }
    this.schedule();
  }
  setLiveEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stopTimer();
      this.tail?.abort();
    } else {
      for (const entry of this.entries.values()) this.ensure(entry);
      this.schedule();
    }
  }
  setLiveStatusListener(callback: (error: string | null) => void): void {
    this.status = callback;
    try {
      callback(this.error);
    } catch {
      /* UI callback isolation. */
    }
  }
  /** Invalidate authoritative prefixes, not arrays already retained by cards. */
  resetLive(): void {
    this.invalidate();
    for (const entry of this.entries.values()) {
      entry.full = true;
      entry.dirty++;
      entry.failures = 0;
      entry.retryAt = 0;
      this.ensure(entry);
    }
    this.evict();
  }
  clear(): void {
    this.invalidate();
    for (const entry of this.entries.values()) {
      entry.points = undefined;
      entry.snapshot = 0;
      entry.full = true;
      entry.dirty++;
      entry.failures = 0;
      entry.retryAt = 0;
    }
    this.evict();
    // Preserve subscriptions; a coalesced revalidation allows callers to dispose old cards first.
    this.schedule();
  }
  private invalidate(): void {
    this.generation++;
    this.stopTimer();
    this.tail?.abort();
    this.queue = [];
    for (const entry of this.entries.values()) {
      entry.request?.controller.abort();
      entry.request = undefined;
      this.settle(entry, undefined, aborted());
    }
    this.report(null);
    // Initial slots and the batch flight remain occupied until transport settles.
  }
  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private report(error: string | null): void {
    if (this.error === error) return;
    this.error = error;
    try {
      this.status?.(error);
    } catch {
      /* UI callback isolation. */
    }
  }
  private notify(
    callback: Subscriber["progress"],
    done: number,
    total: number,
  ): void {
    try {
      callback?.(done, total);
    } catch {
      /* UI callback isolation. */
    }
  }
  private changed(entries: Entry[]): void {
    const watchers = new Set(entries.flatMap((entry) => [...entry.watchers]));
    for (const watch of watchers) {
      try {
        watch.callback();
      } catch {
        /* UI callback isolation. */
      }
    }
    if (
      ![...this.entries.values()].some(
        (entry) => this.demanded(entry) && entry.failures,
      )
    )
      this.report(null);
  }
  private settle(entry: Entry, points?: Point[], error?: unknown): void {
    for (const subscriber of entry.subscribers) {
      subscriber.cleanup();
      if (points) {
        this.notify(subscriber.progress, points.length, points.length);
        subscriber.resolve(points);
      } else subscriber.reject(error);
    }
    entry.subscribers.clear();
  }
  private touch(entry: Entry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }
  private evict(): void {
    let count = [...this.entries.values()].filter(
      (entry) => !!entry.points,
    ).length;
    for (const [key, entry] of this.entries) {
      if (this.demanded(entry) || entry.request) continue;
      if (!entry.points || count > this.maxEntries) {
        if (entry.points) count--;
        this.entries.delete(key);
      }
    }
  }
  private ensure(entry: Entry, explicit = false): void {
    if (
      (!this.enabled && !explicit) ||
      !this.demanded(entry) ||
      !this.dirty(entry) ||
      entry.request ||
      entry.retryAt > Date.now()
    )
      return;
    if (
      entry.full ||
      !entry.points ||
      typeof this.api.metricTails !== "function"
    ) {
      const request: Request = {
        entry,
        controller: new AbortController(),
        generation: this.generation,
        version: entry.dirty,
      };
      entry.request = request;
      this.queue.push(request);
      this.pump();
    } else this.schedule();
  }
  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const request = this.queue.shift()!;
      if (
        request.controller.signal.aborted ||
        request.entry.request !== request ||
        !this.demanded(request.entry)
      )
        continue;
      this.active++;
      void this.execute(request);
    }
  }
  private valid(request: Request): boolean {
    return (
      request.generation === this.generation &&
      !request.controller.signal.aborted &&
      request.entry.request === request
    );
  }
  private async execute(request: Request): Promise<void> {
    const entry = request.entry;
    try {
      const progress = (done: number, total: number) => {
        if (!this.valid(request)) return;
        request.progress = [done, total];
        for (const subscriber of entry.subscribers)
          this.notify(subscriber.progress, done, total);
      };
      const result =
        typeof this.api.metricsSnapshot === "function"
          ? await this.api.metricsSnapshot(
              entry.ref.runId,
              entry.ref.key,
              request.controller.signal,
              progress,
            )
          : await this.api
              .metrics(
                entry.ref.runId,
                entry.ref.key,
                request.controller.signal,
                progress,
              )
              .then((points) => ({
                points,
                snapshot: points.at(-1)?.seq ?? 0,
              }));
      if (!this.valid(request)) return;
      entry.points = result.points;
      entry.snapshot = result.snapshot;
      entry.full = false;
      entry.clean = request.version;
      entry.failures = 0;
      entry.retryAt = 0;
      this.touch(entry);
      this.settle(entry, result.points);
      this.changed([entry]);
    } catch (error) {
      if (this.valid(request)) this.failed(entry, error);
    } finally {
      if (entry.request === request) entry.request = undefined;
      this.active--;
      this.evict();
      this.pump();
      this.schedule();
    }
  }
  private failed(entry: Entry, error: unknown): void {
    entry.failures++;
    const retry =
      !(error instanceof MetricProtocolError) &&
      (!(error instanceof HttpError) ||
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500);
    entry.retryAt = retry
      ? Date.now() + Math.min(10000, 250 * 2 ** Math.min(entry.failures - 1, 6))
      : Infinity;
    this.settle(entry, undefined, error);
    if (entry.watchers.size)
      this.report(error instanceof Error ? error.message : String(error));
  }
  private schedule(): void {
    if (!this.enabled || this.timer !== undefined) return;
    const candidates = [...this.entries.values()].filter(
      (entry) =>
        this.demanded(entry) &&
        this.dirty(entry) &&
        !entry.request &&
        Number.isFinite(entry.retryAt),
    );
    if (!candidates.length) return;
    const delay = Math.max(
      100,
      Math.min(...candidates.map((entry) => entry.retryAt - Date.now())),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const entry of this.entries.values()) {
        if (
          entry.full ||
          !entry.points ||
          typeof this.api.metricTails !== "function"
        )
          this.ensure(entry);
      }
      if (!this.tail) void this.catchup();
    }, delay);
  }
  private async catchup(): Promise<void> {
    if (!this.enabled || this.tail) return;
    const entries = [...this.entries.values()]
      .filter(
        (entry) =>
          this.demanded(entry) &&
          this.dirty(entry) &&
          !entry.full &&
          entry.points &&
          !entry.request &&
          entry.retryAt <= Date.now(),
      )
      .slice(0, 64);
    if (!entries.length) {
      this.schedule();
      return;
    }
    const versions = entries.map((entry) => entry.dirty);
    const generation = this.generation;
    const controller = new AbortController();
    this.tail = controller;
    try {
      const result = await this.api.metricTails(
        entries.map((entry) => ({
          runId: entry.ref.runId,
          key: entry.ref.key,
          after: entry.snapshot,
        })),
        controller.signal,
      );
      if (controller.signal.aborted || generation !== this.generation) return;
      // Api.metricTails returns request order and has validated every page of every stream.
      for (const [index, entry] of entries.entries()) {
        if (this.entries.get(entry.key) !== entry) continue;
        entry.points = entry.points!.concat(result[index].points);
        entry.snapshot = result[index].snapshot;
        entry.clean = versions[index];
        entry.failures = 0;
        entry.retryAt = 0;
        this.touch(entry);
      }
      for (const entry of entries) {
        if (!this.dirty(entry)) this.settle(entry, entry.points);
      }
      this.changed(entries);
    } catch (error) {
      if (!controller.signal.aborted && generation === this.generation)
        for (const entry of entries)
          if (this.entries.get(entry.key) === entry) this.failed(entry, error);
    } finally {
      if (this.tail === controller) this.tail = undefined;
      this.evict();
      this.schedule();
    }
  }
}
