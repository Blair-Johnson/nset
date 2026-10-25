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
  status: "running" | "finished" | "failed";
  params: Record<string, unknown>;
  tags: Record<string, unknown>;
  created_at: number;
  updated_at: number;
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
      throw new Error(detail);
    }
    return response;
  }
  async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    return (await this.response(path, signal)).json();
  }
  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(`/api${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal, cache: "no-store",
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error ?? `HTTP ${response.status}`);
    }
    return response.json();
  }
  /** Merge tags into a run; a null value removes that tag. */
  async patchRun(
    id: string,
    patch: { tags?: Record<string, unknown> },
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
      throw new Error(detail);
    }
    return response.json();
  }
  async metrics(
    run: string,
    key: string,
    signal: AbortSignal,
    onProgress: (loaded: number, total: number) => void = () => {},
  ): Promise<Point[]> {
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
      snapshot = page.snapshot;
      total = page.total;
      for (const point of page.points) points.push(point);
      onProgress(points.length, page.total);
      if (page.next_after === null) break;
      if (
        !Number.isSafeInteger(page.next_after) ||
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
    return points;
  }
}
