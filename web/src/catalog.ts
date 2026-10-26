import { appendRxCatalog } from "./records";
import type { Api, Experiment, Run } from "./api";
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
      (key) => !["experiments", "runs", "series", "rx_enabled"].includes(key),
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
  const catalog = { experiments, runs, series };
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
interface Request {
  key: string;
  ref: SeriesRef;
  controller: AbortController;
  subscribers: Set<Subscriber>;
  generation: number;
  progress?: [number, number];
}
/** Cache contains only complete Api.metrics snapshots; pending entries are never published. */
export class MetricStore implements MetricLoader {
  private readonly cache = new Map<string, Point[]>();
  private readonly requests = new Map<string, Request>();
  private queue: Request[] = [];
  private active = 0;
  private generation = 0;
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
  load(
    ref: SeriesRef,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Point[]> {
    if (signal?.aborted) return Promise.reject(aborted());
    if (ref.kind !== "metric")
      return Promise.reject(new Error("MetricStore loads metric series only."));
    const key = seriesId(ref);
    const cached = this.cache.get(key);
    if (cached) {
      const generation = this.generation;
      this.cache.delete(key);
      this.cache.set(key, cached);
      return new Promise((resolve, reject) =>
        queueMicrotask(() => {
          if (signal?.aborted || generation !== this.generation) {
            reject(aborted());
            return;
          }
          this.notify(onProgress, cached.length, cached.length);
          resolve(cached);
        }),
      );
    }
    let request = this.requests.get(key);
    if (!request) {
      request = {
        key,
        ref: { ...ref },
        controller: new AbortController(),
        subscribers: new Set(),
        generation: this.generation,
      };
      this.requests.set(key, request);
      this.queue.push(request);
    }
    const entry = request;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        entry.subscribers.delete(subscriber);
        subscriber.cleanup();
        reject(aborted());
        if (!entry.subscribers.size) {
          entry.controller.abort();
          if (this.requests.get(key) === entry) this.requests.delete(key);
          this.queue = this.queue.filter((item) => item !== entry);
        }
      };
      const subscriber: Subscriber = {
        resolve,
        reject,
        progress: onProgress,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      };
      entry.subscribers.add(subscriber);
      signal?.addEventListener("abort", cancel, { once: true });
      if (entry.progress) this.notify(onProgress, ...entry.progress);
      this.pump();
    });
  }
  clear(): void {
    this.generation++;
    this.cache.clear();
    this.queue = [];
    for (const entry of this.requests.values()) {
      entry.controller.abort();
      this.settle(entry, undefined, aborted());
    }
    this.requests.clear();
    // Active slots remain occupied until aborted transports actually settle.
  }
  private notify(
    callback: Subscriber["progress"],
    done: number,
    total: number,
  ): void {
    try {
      callback?.(done, total);
    } catch {
      /* A UI callback cannot corrupt shared loading. */
    }
  }
  private settle(entry: Request, points?: Point[], error?: unknown): void {
    for (const subscriber of entry.subscribers) {
      subscriber.cleanup();
      if (points) subscriber.resolve(points);
      else subscriber.reject(error);
    }
    entry.subscribers.clear();
  }
  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const entry = this.queue.shift()!;
      if (entry.controller.signal.aborted || !entry.subscribers.size) continue;
      this.active++;
      void this.execute(entry);
    }
  }
  private async execute(entry: Request): Promise<void> {
    try {
      const points = await this.api.metrics(
        entry.ref.runId,
        entry.ref.key,
        entry.controller.signal,
        (done, total) => {
          if (
            entry.generation !== this.generation ||
            entry.controller.signal.aborted
          )
            return;
          entry.progress = [done, total];
          for (const subscriber of entry.subscribers)
            this.notify(subscriber.progress, done, total);
        },
      );
      if (
        entry.generation !== this.generation ||
        entry.controller.signal.aborted
      )
        throw aborted();
      if (this.maxEntries > 0) {
        this.cache.set(entry.key, points);
        while (this.cache.size > this.maxEntries)
          this.cache.delete(this.cache.keys().next().value!);
      }
      this.settle(entry, points);
    } catch (error) {
      this.settle(entry, undefined, error);
    } finally {
      if (this.requests.get(entry.key) === entry)
        this.requests.delete(entry.key);
      this.active--;
      this.pump();
    }
  }
}
