import {
  expect,
  test as base,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Opt in with NSET_LIVE_BINARY=/absolute/path/to/nset, built with the latest
// embedded frontend/backend. This owns a new native server and database: no
// Vite baseURL, intercepted requests, browser source imports, or existing server.
type Server = { url: string; token: string; api: APIRequestContext };
const test = base.extend<{ server: Server }>({
  server: [
    async ({ playwright }, use, testInfo) => {
      const binary = process.env.NSET_LIVE_BINARY;
      test.skip(
        !binary,
        "Set NSET_LIVE_BINARY to a binary with embedded frontend assets",
      );
      const root = await mkdtemp(join(tmpdir(), "nset-status-browser-"));
      const token = randomBytes(32).toString("hex");
      // In particular, do not inherit paused ingest, external sources or storage.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("NSET_")),
      );
      const child = spawn(
        resolve(binary!),
        [
          "serve",
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--db-path",
          join(root, "db"),
        ],
        {
          cwd: root,
          env: { ...env, NSET_TOKEN: token, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let spawnError: Error | undefined;
      let closed = false;
      let forced = false;
      const exited = new Promise<void>((done) =>
        child.once("close", () => {
          closed = true;
          done();
        }),
      );
      child.on("error", (error) => {
        spawnError = error;
      });
      const capture = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-64_000);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      let api: APIRequestContext | undefined;
      const waitForExit = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exited,
          new Promise<void>((done) => {
            timer = setTimeout(done, ms);
          }),
        ]);
        clearTimeout(timer);
        return closed;
      };
      try {
        let port = "";
        await expect
          .poll(
            () => {
              if (spawnError) throw spawnError;
              if (closed)
                throw new Error(`nset exited during startup:\n${output}`);
              const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
              port = plain.match(/\b127\.0\.0\.1:(\d+)\b/)?.[1] ?? "";
              return Number(port) > 0;
            },
            {
              timeout: 15_000,
              message: "private backend publishes its ephemeral port",
            },
          )
          .toBe(true);
        const url = `http://127.0.0.1:${port}`;
        api = await playwright.request.newContext({
          baseURL: url,
          extraHTTPHeaders: { Authorization: `Bearer ${token}` },
          timeout: 5_000,
        });
        const unauthorized = await api.get("/api/health", {
          headers: { Authorization: "Bearer incorrect" },
        });
        expect(unauthorized.status()).toBe(401);
        const health = await api.get("/api/health");
        expect(health.status()).toBe(200);
        expect(await health.json()).toEqual({ status: "ok" });
        await use({ url, token, api });
      } finally {
        try {
          await api?.dispose();
        } finally {
          if (!closed) {
            child.kill("SIGTERM");
            if (!(await waitForExit(5_000))) {
              forced = true;
              child.kill("SIGKILL");
              await waitForExit(3_000);
            }
          }
          // Never delete storage that may still belong to a live process.
          if (closed) await rm(root, { recursive: true, force: true });
          await testInfo.attach("run-status-server-process.txt", {
            body: Buffer.from(
              `forcedKill=${forced}; reaped=${closed}\n${output.replaceAll(token, "<redacted>")}`,
            ),
            contentType: "text/plain",
          });
          expect(closed, "private backend process was reaped").toBe(true);
        }
      }
    },
    { timeout: 30_000 },
  ],
});

type Run = { id: string; status: string; updated_at: number };
type Receipt = {
  batch_id: string;
  run_id: string;
  state: string;
  accepted: number;
  accepted_at: number;
};
const budget = 8_000;

const pill = (page: Page) => page.locator(".run-status-pill");

async function chooseStatus(page: Page, runPath: string, label: string) {
  await pill(page).click();
  const [saved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === runPath,
      { timeout: budget },
    ),
    page.getByRole("menuitemradio", { name: label, exact: true }).click(),
  ]);
  expect(saved.status()).toBe(200);
  expect(saved.request().postDataJSON()).toEqual({
    status: label.toLowerCase(),
  });
  expect((await saved.json()).status).toBe(label.toLowerCase());
}

test("real status edits propagate across tabs and only fresh writes reactivate canceled runs", async ({
  page,
  browser,
  server,
}, testInfo) => {
  test.setTimeout(90_000);
  const { url, token, api } = server;
  // Separate contexts prevent any storage event or shared client state from
  // explaining the observer's updates. Both tabs must use the real live feed.
  const observerContext = await browser.newContext();
  const observer = await observerContext.newPage();
  const tabs = [page, observer];
  const pageErrors: string[] = [];
  const observations: { phase: string; tab: number; changes: string[] }[] = [];
  for (const [index, tab] of tabs.entries())
    tab.on("pageerror", (error) =>
      pageErrors.push(`tab ${index}: ${error.message}`),
    );
  async function json<T>(
    method: string,
    path: string,
    data?: unknown,
  ): Promise<T> {
    const response = await api.fetch(path, {
      method,
      ...(data === undefined ? {} : { data }),
    });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(
      true,
    );
    return response.json() as Promise<T>;
  }
  try {
    const experiment = await json<{ id: string }>("POST", "/api/experiments", {
      name: "Real run status smoke",
    });
    const run = await json<Run>("POST", "/api/runs", {
      experiment_id: experiment.id,
      name: "Status propagation run",
      params: {},
      tags: {},
    });
    const runPath = `/api/runs/${encodeURIComponent(run.id)}`;
    const metricPath = `${runPath}/metrics`;
    const metrics = (step: number) => ({
      // Old observation times deliberately do not determine write freshness.
      metrics: [
        {
          key: "loss",
          step,
          timestamp: 1_700_000_000_000 + step,
          value: 3 - step,
        },
      ],
    });
    expect(await json("POST", metricPath, metrics(0))).toEqual({ inserted: 1 });
    const detail = `${url}/#/experiments/${encodeURIComponent(experiment.id)}/runs/${encodeURIComponent(run.id)}`;
    for (const tab of tabs) {
      await tab.addInitScript(
        (secret) => sessionStorage.setItem("nset.token", secret),
        token,
      );
      const [document] = await Promise.all([
        tab.goto(detail),
        tab.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            new URL(request.url()).pathname === "/api/live",
          { timeout: budget },
        ),
      ]);
      expect(document?.status()).toBe(200);
      await expect(tab.locator(".run-detail h1")).toHaveText(
        "Status propagation run",
      );
      await expect(pill(tab)).toHaveCount(1);
      await expect(pill(tab)).toContainText("Running");
      const scripts = await tab
        .locator("script[src]")
        .evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLScriptElement).src),
        );
      expect(scripts.length).toBeGreaterThan(0);
      expect(
        scripts.every(
          (src) =>
            src.startsWith(`${url}/`) &&
            !src.includes("/src/") &&
            !src.includes("/@vite/"),
        ),
      ).toBe(true);
    }
    async function changeAndSee(
      phase: string,
      label: string,
      action: () => Promise<unknown>,
    ) {
      // Subscribe before the write and require a real catalog hint on BOTH tabs;
      // an optimistic pill update or a manual reload alone cannot pass this.
      await Promise.all([
        ...tabs.map(async (tab, index) => {
          const response = await tab.waitForResponse(
            async (response) => {
              if (
                response.request().method() !== "POST" ||
                new URL(response.url()).pathname !== "/api/live"
              )
                return false;
              if (!response.ok()) return false;
              const reply = await response.json();
              return (
                reply.reset === false &&
                reply.changes.some(
                  (change: { kind: string }) => change.kind === "catalog",
                )
              );
            },
            { timeout: budget },
          );
          const reply = await response.json();
          observations.push({
            phase,
            tab: index,
            changes: reply.changes.map(
              (change: { kind: string }) => change.kind,
            ),
          });
        }),
        action(),
      ]);
      await Promise.all(
        tabs.map((tab) =>
          expect(pill(tab)).toContainText(label, { timeout: budget }),
        ),
      );
      expect((await json<Run>("GET", runPath)).status).toBe(
        label.toLowerCase(),
      );
    }

    await changeAndSee("detail cancellation", "Canceled", () =>
      chooseStatus(page, runPath, "Canceled"),
    );
    await changeAndSee("fresh direct metrics", "Running", async () => {
      expect(await json("POST", metricPath, metrics(1))).toEqual({
        inserted: 1,
      });
    });
    await changeAndSee("terminal status restored", "Canceled", () =>
      chooseStatus(page, runPath, "Canceled"),
    );
    // Reassert even an unchanged terminal value before accepting the next batch.
    // This must advance the backend's status generation, not block fresh work.
    const beforeReassert = await json<Run>("GET", runPath);
    const cursorBeforeReassert = await json("GET", "/api/live");
    const reasserted = await json<Run>("PATCH", runPath, {
      status: "canceled",
    });
    expect(reasserted.status).toBe("canceled");
    expect(reasserted.updated_at).toBe(beforeReassert.updated_at);
    expect(await json("GET", "/api/live")).toEqual(cursorBeforeReassert);
    await Promise.all(
      tabs.map((tab) => expect(pill(tab)).toContainText("Canceled")),
    );

    const durablePath = `${runPath}/ingest/status-${randomBytes(8).toString("hex")}`;
    const durableBody = metrics(2);
    let receipt: Receipt | undefined;
    await changeAndSee("fresh durable metrics", "Running", async () => {
      receipt = await json<Receipt>("PUT", durablePath, durableBody);
      expect(receipt).toMatchObject({ run_id: run.id, accepted: 1 });
      expect(["pending", "applied"]).toContain(receipt.state);
      await expect
        .poll(async () => (await json<Receipt>("GET", durablePath)).state, {
          timeout: budget,
          intervals: [50, 100, 250],
          message: "new durable batch reaches query storage",
        })
        .toBe("applied");
    });
    await changeAndSee("canceled after durable commit", "Canceled", () =>
      chooseStatus(page, runPath, "Canceled"),
    );
    const canceled = await json<Run>("GET", runPath);
    const beforeReplay = await json<{ cursor: string }>("GET", "/api/live");
    const replay = await json<Receipt>("PUT", durablePath, durableBody);
    expect(replay).toEqual({ ...receipt!, state: "applied" });
    expect(await json<Receipt>("GET", durablePath)).toEqual(replay);
    const afterReplay = await json<Run>("GET", runPath);
    expect(afterReplay.status).toBe("canceled");
    expect(afterReplay.updated_at).toBe(canceled.updated_at);
    // A receipt replay neither projects another point nor emits a status change.
    expect(await json("GET", "/api/live")).toEqual(beforeReplay);
    const history = await json<{ total: number; points: { step: number }[] }>(
      "GET",
      `${metricPath}?key=loss`,
    );
    expect(history.total).toBe(3);
    expect(history.points.map((point) => point.step)).toEqual([0, 1, 2]);
    await Promise.all(
      tabs.map((tab) => expect(pill(tab)).toContainText("Canceled")),
    );

    // Exercise the same native mutation through the runs table as well, while
    // the observer remains on detail and receives the new status without reload.
    await expect(
      page.getByRole("button", { name: "← Runs", exact: true }),
    ).toHaveCount(0);
    await page
      .locator(".view-switch")
      .getByRole("button", { name: "Runs", exact: true })
      .click();
    await expect(page.locator("table .run-status-pill")).toContainText(
      "Canceled",
    );
    await changeAndSee("table status edit", "Failed", () =>
      chooseStatus(page, runPath, "Failed"),
    );
    expect(pageErrors).toEqual([]);
  } finally {
    // Abort outstanding browser long polls before the fixture stops its process.
    await Promise.all([page.close(), observerContext.close()]);
    await testInfo.attach("run-status-server-observations.json", {
      body: Buffer.from(JSON.stringify({ observations, pageErrors }, null, 2)),
      contentType: "application/json",
    });
  }
});
