import { expect, test, type Page, type Route } from "@playwright/test";
import type { LiveChange } from "../src/live";

const source = { id: "rx:recovery", name: "Recovery repo", readonly: true };
const runId = `${source.id}:quiet-run`;

/** Real index.html/main.ts and run table; only HTTP is mocked. */
async function fixture(page: Page) {
  const polls: Route[] = [];
  const pollBodies: { cursor: string }[] = [];
  const writes: string[] = [];
  const unexpected: string[] = [];
  const requests = { catalog: 0, rx: 0, checkpoint: 0 };
  let unavailable = false;
  const run = {
    id: "1",
    run_uid: "quiet-run",
    state: "active",
    alias: "Before final write",
    config: "{}",
    argv: "[]",
    created_at: "2026-10-01T00:00:00Z",
    started_at: "2026-10-01T00:00:00Z",
    finished_at: null as string | null,
    exit_code: null as number | null,
  };
  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, json: body });

  await page.addInitScript(() => sessionStorage.setItem("nset.token", "test"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toBe("Bearer test");
    if (path === "/api/live") {
      if (request.method() === "GET") {
        requests.checkpoint++;
        return json(route, { cursor: "live:0" });
      }
      expect(request.method()).toBe("POST");
      pollBodies.push(request.postDataJSON());
      polls.push(route);
      return; // Never synthesize idle replies or a hot polling loop.
    }
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({
        status: 500,
        json: { error: "Unexpected write" },
      });
    }
    if (path === "/api/catalog") {
      requests.catalog++;
      return json(route, {
        rx_enabled: true,
        metric_seq: 0,
        experiments: [
          { id: "native", name: "Native experiment", created_at: 1 },
        ],
        runs: [
          {
            id: "native-run",
            experiment_id: "native",
            name: "Native retained",
            status: "finished",
            params: {},
            tags: {},
            created_at: 1,
            updated_at: 1,
          },
        ],
        series: [],
      });
    }
    if (path === "/api/rx/catalog") {
      requests.rx++;
      // A configured source can fail inside an HTTP-200 response. This is not
      // an authoritative empty catalog, nor an Api.response HTTP exception.
      return json(route, {
        source,
        next_after: null,
        high_water: "1",
        source_generation: "recovery-generation",
        ...(unavailable
          ? { runs: [], error: "Cannot read rx catalog: temporary outage" }
          : { runs: [{ ...run }] }),
      });
    }
    if (path === "/api/views") return json(route, { views: [] });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 404,
      json: { error: `Unexpected API: ${path}` },
    });
  });

  await page.clock.install();
  await page.goto(`/#/experiments/${encodeURIComponent(source.id)}/runs`);
  const row = page.locator(`tbody tr[data-run-id="${runId}"]`);
  await expect(row).toContainText("Before final write");
  await expect(row.locator(".status")).toHaveText("Running");
  await expect(page.locator("#connection")).toHaveText("Connected");
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));

  async function until<T>(read: () => T | Promise<T>, expected: T) {
    await expect
      .poll(
        async () => {
          await page.clock.runFor(100);
          return read();
        },
        { timeout: 10_000, intervals: [0, 10, 20, 50] },
      )
      .toEqual(expected);
  }
  async function takePoll() {
    await until(() => polls.length > 0, true);
    return polls.shift()!;
  }
  return {
    row,
    requests,
    pollBodies,
    writes,
    unexpected,
    until,
    takePoll,
    json,
    finalWrite() {
      run.state = "succeeded";
      run.alias = "Final quiet result";
      run.finished_at = "2026-10-01T00:01:00Z";
      run.exit_code = 0;
      unavailable = true;
    },
    recover() {
      unavailable = false;
    },
  };
}

for (const kind of ["rx", "catalog"] as const) {
  test(`${kind} repair retains valid rx metadata and replays the final unacknowledged change`, async ({
    page,
  }) => {
    const live = await fixture(page);
    expect(live.requests).toEqual({ catalog: 1, rx: 1, checkpoint: 1 });
    const finalReply = {
      cursor: "live:1",
      reset: false,
      changes: [{ kind }] satisfies LiveChange[],
    };

    // The run writes exactly once, then remains quiet through the outage and
    // recovery. Both deliveries below are the same hint and the same cursor.
    live.finalWrite();
    await live.json(await live.takePoll(), finalReply);
    await live.until(() => live.requests.rx, 2);
    const retry = await live.takePoll();
    // Flush the main model's debounce: a destructive install must be visible,
    // not masked by a stale table while we inspect the failed repair.
    await page.clock.runFor(600);
    await expect(live.row).toContainText("Before final write");
    await expect(live.row.locator(".status")).toHaveText("Running");
    expect(retry.request().postDataJSON()).toEqual({ cursor: "live:0" });
    expect(live.requests.checkpoint).toBe(1);

    live.recover(); // No new write, manual refresh, navigation or new hint.
    await live.json(retry, finalReply);
    await live.until(
      () => live.row.locator(".status").textContent(),
      "Finished",
    );
    await expect(live.row).toContainText("Final quiet result");
    await expect(page.locator("#connection")).toHaveText("Connected");
    const acknowledged = await live.takePoll();
    expect(acknowledged.request().postDataJSON()).toEqual({ cursor: "live:1" });
    expect(live.pollBodies).toEqual([
      { cursor: "live:0" },
      { cursor: "live:0" },
      { cursor: "live:1" },
    ]);
    expect(live.requests).toEqual({
      catalog: kind === "rx" ? 1 : 3,
      rx: 3,
      checkpoint: 1,
    });

    // Read the retained native catalog through the real router, without reload.
    await page.evaluate(() => {
      location.hash = "#/experiments/native/runs";
    });
    const native = page.locator('tbody tr[data-run-id="native-run"]');
    await expect(native).toContainText("Native retained");
    await expect(native.locator(".status")).toHaveText("Finished");
    expect(live.writes, "live repair must not publish workspace state").toEqual(
      [],
    );
    expect(live.unexpected, "only declared API requests are allowed").toEqual(
      [],
    );
  });
}
