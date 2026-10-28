import type { Point } from "./math";

export type LiveChange =
  | {
      kind: "metric";
      runId: string;
      key: string;
      high: number;
      count: number;
      last: Point;
    }
  | { kind: "image"; runId: string; key: string }
  | { kind: "catalog" }
  | { kind: "rx" };
export type LiveStatus =
  | "connecting"
  | "live"
  | "paused"
  | "reconnecting"
  | "unsupported"
  | "unauthorized"
  | "stopped";
interface LiveReply {
  cursor: string;
  reset: boolean;
  changes: LiveChange[];
}
interface LiveCallbacks {
  changes(changes: LiveChange[], signal: AbortSignal): Promise<void>;
  reset(signal: AbortSignal): Promise<void>;
  status(state: LiveStatus, detail?: string): void;
}
class LiveHttpError extends Error {
  constructor(readonly status: number) {
    super(`Live updates: HTTP ${status}`);
  }
}
const safe = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
function cursor(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256)
    throw new Error("Invalid live cursor");
  return value;
}
export function liveReply(value: unknown): LiveReply {
  const v = value as LiveReply;
  if (!v || typeof v.reset !== "boolean" || !Array.isArray(v.changes))
    throw new Error("Invalid live response");
  cursor(v.cursor);
  for (const c of v.changes) {
    if (!c || !["metric", "image", "catalog", "rx"].includes(c.kind))
      throw new Error("Invalid live change");
    if (c.kind === "metric" || c.kind === "image") {
      if (
        typeof c.runId !== "string" ||
        !c.runId ||
        typeof c.key !== "string" ||
        !c.key
      )
        throw new Error("Invalid live series");
    }
    if (
      c.kind === "metric" &&
      (!safe(c.high) ||
        !safe(c.count) ||
        c.count < 1 ||
        !c.last ||
        c.last.seq !== c.high ||
        !Number.isFinite(c.last.value) ||
        !Number.isFinite(c.last.step) ||
        !Number.isFinite(c.last.timestamp))
    )
      throw new Error("Invalid live metric");
  }
  return v;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** One authenticated, resumable long poll per tab. Hints are acknowledged only
 * after their consumer has retained the work; SQLite remains authoritative. */
export class LiveUpdates {
  private controller?: AbortController;
  private position?: string;
  private enabled = false;
  private visible = true;
  constructor(
    private token: () => string,
    private callbacks: LiveCallbacks,
    private fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** Capture before loading the catalog: writes during bootstrap must replay. */
  async prepare(signal: AbortSignal): Promise<string | null | undefined> {
    this.stop();
    try {
      const value = (await this.request(undefined, signal)) as {
        cursor: unknown;
      };
      return cursor(value.cursor);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof LiveHttpError && [404, 405].includes(error.status))
        return null;
      return undefined;
    }
  }
  start(position?: string | null) {
    this.stop();
    if (position === null) {
      this.callbacks.status("unsupported");
      return;
    }
    this.position = position;
    this.enabled = true;
    this.launch();
  }
  stop() {
    this.enabled = false;
    this.controller?.abort();
    this.controller = undefined;
    this.position = undefined;
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) {
      this.controller?.abort();
      this.controller = undefined;
      if (this.enabled) this.callbacks.status("paused");
    } else this.launch();
  }
  private launch() {
    if (!this.enabled || !this.visible || this.controller) return;
    const controller = (this.controller = new AbortController());
    void this.loop(controller);
  }
  private async loop(controller: AbortController) {
    const signal = controller.signal;
    let failures = 0;
    let healthTimer: ReturnType<typeof setTimeout> | undefined;
    this.callbacks.status("connecting");
    while (!signal.aborted) {
      const started = Date.now();
      try {
        if (!this.position) {
          const checkpoint = (await this.request(undefined, signal)) as {
            cursor: unknown;
          };
          const next = cursor(checkpoint.cursor);
          if (signal.aborted) break;
          await this.callbacks.reset(signal);
          if (signal.aborted) break;
          this.position = next;
        }
        const reply = liveReply(
          await this.request({ cursor: this.position }, signal),
        );
        if (signal.aborted) break;
        if (reply.reset) await this.callbacks.reset(signal);
        else if (reply.changes.length)
          await this.callbacks.changes(reply.changes, signal);
        if (signal.aborted) break;
        this.position = reply.cursor;
        failures = 0;
        clearTimeout(healthTimer);
        healthTimer = undefined;
        this.callbacks.status("live");
        await wait(Math.max(0, 100 - (Date.now() - started)), signal);
      } catch (error) {
        if (signal.aborted) break;
        if (
          error instanceof LiveHttpError &&
          [401, 403, 404, 405].includes(error.status)
        ) {
          this.callbacks.status(
            error.status === 401 || error.status === 403
              ? "unauthorized"
              : "unsupported",
          );
          this.enabled = false;
          break;
        }
        if (healthTimer === undefined) {
          healthTimer = setTimeout(() => {
            if (!signal.aborted)
              this.callbacks.status(
                "reconnecting",
                error instanceof Error ? error.message : String(error),
              );
          }, 3000);
        }
        await wait(
          Math.min(10000, 500 * 2 ** Math.min(failures++, 5)) *
            (0.8 + Math.random() * 0.4),
          signal,
        );
      }
    }
    clearTimeout(healthTimer);
    if (this.controller === controller) this.controller = undefined;
  }

  private async request(
    body: unknown | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 25000);
    try {
      const response = await this.fetcher("/api/live", {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.token()}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new LiveHttpError(response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
