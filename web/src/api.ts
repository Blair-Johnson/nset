import type { Point } from "./math";
export interface Experiment {
  id: string;
  name: string;
  created_at: number;
}
export interface Run {
  rx?: { sourceId: string; uid: string; state: string };
  id: string;
  experiment_id: string;
  name: string;
  status: "running" | "finished" | "failed" | "canceled";
  params: Record<string, unknown>;
  tags: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}
/** Relative-time origin in backend milliseconds, shared by every metric of a run.
 * MLflow imports preserve original timestamps and start time, while created_at
 * records the import itself. Never infer the origin from a series' first point.
 * Keep created_at unchanged for catalog ordering and creation-time filters.
 */
export function runStartTime(run: Pick<Run, "created_at" | "tags">): number {
  const imported = run.tags?.["mlflow_import.start_time"];
  return typeof imported === "number" &&
    Number.isSafeInteger(imported) &&
    imported >= 0
    ? imported
    : run.created_at;
}

export interface ImageFrame {
  id: string;
  run_id: string;
  key: string;
  step: number;
  timestamp: number;
  content_type: string;
  byte_length: number;
}
export interface MetricPage {
  points: Point[];
  next_after: number | null;
  snapshot: number;
  total: number;
}
export interface MetricTailRequest {
  runId: string;
  key: string;
  after: number;
  snapshot?: number;
}
export interface MetricSnapshot {
  points: Point[];
  snapshot: number;
}
export interface MetricTailSnapshot extends MetricSnapshot {
  runId: string;
  key: string;
}
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export class MetricProtocolError extends Error {}
const safeCursor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function validatePoints(
  points: unknown,
  after: number,
  snapshot: number,
): asserts points is Point[] {
  if (!Array.isArray(points))
    throw new MetricProtocolError("Invalid metric points.");
  for (const point of points) {
    if (
      !point ||
      !safeCursor(point.seq) ||
      point.seq <= after ||
      point.seq > snapshot ||
      ![point.step, point.timestamp, point.value].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    )
      throw new MetricProtocolError(
        "Invalid metric pagination cursor or point.",
      );
    after = point.seq;
  }
}
export class Api {
  constructor(
    private token: () => string,
    private fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}
  async response(path: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetcher(`/api${path}`, {
      headers: { Authorization: `Bearer ${this.token()}` },
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body.error === "string") detail = body.error;
      } catch {}
      throw new HttpError(detail, response.status);
    }
    return response;
  }
  async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    return (await this.response(path, signal)).json();
  }
  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`/api${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new HttpError(
        detail.error ?? `HTTP ${response.status}`,
        response.status,
      );
    }
    return response.json();
  }
  async put<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`/api${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(
        response.status === 409
          ? "This server view has changed (409). Your draft is retained. Revert to saved to load the latest version, or Save view as to keep a local copy."
          : (detail.error ?? `HTTP ${response.status}`),
      );
    }
    return response.json();
  }
  /** Update status and/or merge tags; a null tag value removes that tag. */
  async patchRun(
    id: string,
    patch: { status?: Run["status"]; tags?: Record<string, unknown> },
  ): Promise<Run> {
    const response = await this.fetcher(`/api/runs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
      cache: "no-store",
    });
    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body.error === "string") detail = body.error;
      } catch {}
      throw new HttpError(detail, response.status);
    }
    return response.json();
  }
  async metrics(
    run: string,
    key: string,
    signal: AbortSignal,
    onProgress: (loaded: number, total: number) => void = () => {},
  ): Promise<Point[]> {
    return (await this.metricsSnapshot(run, key, signal, onProgress)).points;
  }
  async metricsSnapshot(
    run: string,
    key: string,
    signal: AbortSignal,
    onProgress: (loaded: number, total: number) => void = () => {},
  ): Promise<MetricSnapshot> {
    const points: Point[] = [];
    let after: number | undefined,
      snapshot: number | undefined,
      total: number | undefined;
    do {
      const query = new URLSearchParams({ key, limit: "50000" });
      if (after !== undefined) query.set("after", String(after));
      if (snapshot !== undefined) query.set("snapshot", String(snapshot));
      const page = await this.json<MetricPage>(
        `/runs/${encodeURIComponent(run)}/metrics?${query}`,
        signal,
      );
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (
        snapshot !== undefined &&
        (snapshot !== page.snapshot || total !== page.total)
      )
        throw new Error(
          "Metric snapshot changed during pagination; refresh to retry.",
        );
      if (!safeCursor(page.snapshot) || !safeCursor(page.total))
        throw new MetricProtocolError("Invalid metric snapshot metadata.");
      validatePoints(page.points, after ?? 0, page.snapshot);
      snapshot = page.snapshot;
      total = page.total;
      for (const point of page.points) points.push(point);
      onProgress(points.length, page.total);
      if (page.next_after === null) break;
      if (
        !safeCursor(page.next_after) ||
        page.next_after !== page.points.at(-1)?.seq ||
        (after !== undefined && page.next_after <= after) ||
        page.points.length === 0
      )
        throw new Error(
          "Invalid pagination cursor; refused incomplete metric data.",
        );
      after = page.next_after;
    } while (true);
    if (points.length !== total)
      throw new Error(
        `Incomplete metric snapshot: ${points.length} of ${total}.`,
      );
    return { points, snapshot: snapshot! };
  }
  /** Read complete, individually pinned tails. No partial page is published. */
  async metricTails(
    series: MetricTailRequest[],
    signal?: AbortSignal,
    limit = 1000,
  ): Promise<MetricTailSnapshot[]> {
    if (
      !Array.isArray(series) ||
      series.length < 1 ||
      series.length > 64 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new MetricProtocolError("Invalid metric tail batch limits.");
    const id = (ref: { runId: string; key: string }) =>
      JSON.stringify([ref.runId, ref.key]);
    const seen = new Set<string>();
    const result = series.map((ref) => {
      if (
        !ref ||
        typeof ref.runId !== "string" ||
        !ref.runId.trim() ||
        ref.runId.length > 8192 ||
        typeof ref.key !== "string" ||
        !ref.key.trim() ||
        ref.key.length > 8192 ||
        !safeCursor(ref.after) ||
        (ref.snapshot !== undefined &&
          (!safeCursor(ref.snapshot) || ref.snapshot < ref.after)) ||
        seen.has(id(ref))
      )
        throw new MetricProtocolError(
          "Invalid or duplicate metric tail request.",
        );
      seen.add(id(ref));
      return {
        runId: ref.runId,
        key: ref.key,
        points: [] as Point[],
        snapshot: ref.snapshot ?? ref.after,
      };
    });
    let pending = series.map((ref, index) => ({ ...ref, index }));
    while (pending.length) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const body = await this.post<unknown>(
        "/metrics/tail",
        {
          series: pending.map(({ index: _index, ...ref }) => ref),
          limit,
        },
        signal,
      );
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (
        !body ||
        typeof body !== "object" ||
        !Array.isArray((body as { series?: unknown }).series)
      )
        throw new MetricProtocolError("Invalid metric tail response.");
      const pages = (body as { series: unknown[] }).series;
      if (pages.length !== pending.length)
        throw new MetricProtocolError("Missing metric tail stream.");
      const expected = new Map(pending.map((ref) => [id(ref), ref]));
      const next: typeof pending = [];
      for (const value of pages) {
        if (!value || typeof value !== "object")
          throw new MetricProtocolError("Invalid metric tail page.");
        const page = value as MetricTailSnapshot & {
          next_after: number | null;
        };
        const request = expected.get(id(page));
        if (!request)
          throw new MetricProtocolError(
            "Unexpected or duplicate metric tail stream.",
          );
        expected.delete(id(page));
        if (
          !safeCursor(page.snapshot) ||
          page.snapshot < request.after ||
          (request.snapshot !== undefined && page.snapshot !== request.snapshot)
        )
          throw new MetricProtocolError(
            "Metric tail snapshot changed or regressed.",
          );
        validatePoints(page.points, request.after, page.snapshot);
        if (
          page.points.length > limit ||
          (page.next_after !== null &&
            (!safeCursor(page.next_after) ||
              !page.points.length ||
              page.next_after <= request.after ||
              page.next_after !== page.points.at(-1)?.seq ||
              page.next_after >= page.snapshot))
        )
          throw new MetricProtocolError(
            "Invalid metric tail pagination cursor.",
          );
        const output = result[request.index];
        output.snapshot = page.snapshot;
        for (const point of page.points) output.points.push(point);
        if (page.next_after !== null)
          next.push({
            ...request,
            after: page.next_after,
            snapshot: page.snapshot,
          });
      }
      pending = next;
    }
    return result;
  }
}
