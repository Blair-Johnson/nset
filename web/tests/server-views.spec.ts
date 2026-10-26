import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { newChart } from "../src/workspace";
import type { Workspace } from "../src/workspace-types";

const id = "server:00000000-0000-0000-0000-000000000001";
const routeHash = `#/views/${encodeURIComponent(id)}`;
const draftKey = `nset.server-view-draft.v1:${encodeURIComponent(id)}`;
function mockServer() {
  const chart = newChart("timeseries", ["loss"], "Shared loss");
  chart.id = "stable-chart";
  let workspace: Workspace = {
    version: 2,
    id,
    experimentId: "exp",
    name: "Shared view",
    selectedRunIds: ["r1"],
    sections: [
      { id: "metrics", title: "Metrics", collapsed: false, cards: [chart] },
    ],
    updatedAt: 1,
  };
  let revision = 1,
    failSave = false,
    catalogRequests = 0;
  const writes: { revision: number; workspace: Workspace }[] = [];
  const gets: string[] = [];
  let saveGate: Promise<void> | undefined;
  const runs = ["r1", "r2"].map((id) => ({
    id,
    experiment_id: "exp",
    name: `Run ${id}`,
    status: "finished",
    params: {},
    tags: {},
    created_at: 1,
    updated_at: 1,
  }));
  const envelope = () => ({
    id,
    revision,
    workspace: structuredClone(workspace),
  });
  async function install(context: BrowserContext) {
    await context.addInitScript(() =>
      sessionStorage.setItem("nset.token", "test"),
    );
    await context.route("**/api/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const json = (value: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(value),
        });
      if (url.pathname === "/api/catalog") {
        catalogRequests++;
        const available = (
          workspace.selectedRunIds.includes("r2") ? runs : [runs[0]]
        ).map((run) => ({ ...run, experiment_id: workspace.experimentId }));
        return json({
          experiments: [
            {
              id: workspace.experimentId,
              name:
                workspace.experimentId === "exp"
                  ? "Experiment"
                  : "Other experiment",
              created_at: 1,
            },
          ],
          runs: available,
          series: available.map((run) => ({
            run_id: run.id,
            key: "loss",
            kind: "metric",
            count: 2,
            last_step: 1,
            last_timestamp: 2,
            last_value: 0.5,
          })),
        });
      }
      if (url.pathname === "/api/views")
        return json({
          views: [
            {
              id,
              name: workspace.name,
              experimentId: workspace.experimentId,
              revision,
              updatedAt: workspace.updatedAt,
            },
          ],
        });
      if (decodeURIComponent(url.pathname) === `/api/views/${id}`) {
        if (request.method() === "PUT") {
          const body = request.postDataJSON();
          writes.push(body);
          if (saveGate) await saveGate;
          if (failSave) return json({ error: "Server write unavailable" }, 503);
          if (body.revision !== revision)
            return json({ error: "Conflict" }, 409);
          workspace = { ...body.workspace, updatedAt: ++revision };
          return json(envelope());
        }
        gets.push(url.search);
        if (Number(url.searchParams.get("revision")) === revision)
          return route.fulfill({ status: 204 });
        return json(envelope());
      }
      if (url.pathname.endsWith("/metrics"))
        return json({
          points: [
            { seq: 1, step: 0, timestamp: 1, value: 1 },
            { seq: 2, step: 1, timestamp: 2, value: 0.5 },
          ],
          next_after: null,
          snapshot: 2,
          total: 2,
        });
      return json({ error: `Unexpected API: ${url.pathname}` }, 404);
    });
  }
  return {
    install,
    writes,
    gets,
    get workspace() {
      return workspace;
    },
    get revision() {
      return revision;
    },
    get catalogRequests() {
      return catalogRequests;
    },
    update(patch: Partial<Workspace>) {
      workspace = {
        ...workspace,
        ...structuredClone(patch),
        updatedAt: ++revision,
      };
    },
    fail(value = true) {
      failSave = value;
    },
    delaySave() {
      let release!: () => void;
      saveGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        saveGate = undefined;
        release();
      };
    },
  };
}
async function open(page: Page) {
  await page.goto(`/${routeHash}`);
  await expect(page.locator(".workspace-view-control")).toContainText(
    "Shared view",
  );
  await expect(page.locator(".workspace-view-control")).toContainText("Server");
  await expect(page.locator('[data-card-id="stable-chart"]')).toBeVisible();
}
async function action(page: Page, name: string) {
  await page.getByLabel("View actions", { exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function rename(page: Page, name: string) {
  await action(page, "Rename view");
  const dialog = page.getByRole("dialog", { name: "Rename view", exact: true });
  await dialog.getByLabel("View name").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#view-modified")).toBeVisible();
}
async function pollNow(page: Page) {
  // Exercise the real visibility-resume poll without sleeping for its timer.
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
}

test("exact server URL follows clean changes and preserves unchanged cards and route", async ({
  page,
  context,
}) => {
  const server = mockServer();
  await server.install(context);
  await open(page);
  await page.locator('[data-card-id="stable-chart"]').evaluate((node) => {
    (window as any).__originalCard = node;
  });
  server.update({ name: "Published remotely" });
  await pollNow(page);
  await expect(page.locator(".workspace-view-control")).toContainText(
    "Published remotely",
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).__originalCard ===
        document.querySelector('[data-card-id="stable-chart"]'),
    ),
  ).toBe(true);
  expect(new URL(page.url()).hash).toBe(routeHash);
  await expect(page.locator("#view-modified")).toBeHidden();
  expect(server.gets.some((query) => query.includes("revision=1"))).toBe(true);
  const before = server.catalogRequests;
  server.update({ selectedRunIds: ["r2"] });
  await pollNow(page);
  await expect.poll(() => server.catalogRequests).toBeGreaterThan(before);
  await expect(page.locator(".run-drawer")).toContainText("Run r2");
  await expect(page.locator("#global-error")).toBeHidden();
});

test("dirty name persists across reload; stale save is visible and revert loads latest", async ({
  page,
  context,
}) => {
  const server = mockServer();
  await server.install(context);
  await open(page);
  await rename(page, "My draft");
  server.update({ name: "Other client" });
  await pollNow(page);
  await expect(page.locator(".workspace-view-control")).toContainText(
    "My draft",
  );
  expect(new URL(page.url()).hash).toBe(routeHash);
  await page.reload();
  await expect(page.locator(".workspace-view-control")).toContainText(
    "My draft",
  );
  await expect(page.locator("#view-modified")).toBeVisible();
  await page.getByLabel("Save view changes", { exact: true }).click();
  await expect(page.locator("#global-error")).toContainText("409");
  expect(server.writes[0].revision).toBe(1);
  await expect(page.locator("#view-modified")).toBeVisible();
  await action(page, "Revert to saved");
  await expect(page.locator(".workspace-view-control")).toContainText(
    "Other client",
  );
  await expect(page.locator("#view-modified")).toBeHidden();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), draftKey),
  ).toBeNull();
});

test("failed save retains draft; Save as makes a local copy and original follows server", async ({
  page,
  context,
}) => {
  const server = mockServer();
  await server.install(context);
  await open(page);
  await rename(page, "Local draft");
  server.fail();
  await action(page, "Save changes");
  await expect(page.locator("#global-error")).toContainText(
    "Server write unavailable",
  );
  await expect(page.locator("#view-modified")).toBeVisible();
  server.fail(false);
  server.update({ name: "Current server" });
  await action(page, "Save view as…");
  const dialog = page.getByRole("dialog", {
    name: "Save view as",
    exact: true,
  });
  await dialog.getByLabel("View name").fill("My local copy");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/#\/experiments\/exp\/charts$/);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("nset.workspaces.v2")!),
  );
  const copy = saved.views.find((v: Workspace) => v.name === "My local copy");
  expect(copy.id).not.toBe(id);
  expect(copy.revision).toBeUndefined();
  expect(copy.base).toBeUndefined();
  expect(saved.views.some((v: Workspace) => v.id === id)).toBe(false);
  await expect(page.getByLabel("Saved view")).toHaveValue(copy.id);
  await page.getByLabel("Saved view").selectOption(id);
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(id)));
  await expect(page.locator(".workspace-view-control")).toContainText(
    "Current server",
  );
  await expect(page.locator("#view-modified")).toBeHidden();
  expect(server.writes).toHaveLength(1);
});

test("local edits during pending save are retained and save only acknowledges its snapshot", async ({
  page,
  context,
}) => {
  const server = mockServer();
  await server.install(context);
  await open(page);
  await rename(page, "Submitted");
  const release = server.delaySave();
  await page.getByLabel("Save view changes", { exact: true }).click();
  await expect.poll(() => server.writes.length).toBe(1);
  await rename(page, "Newer draft");
  release();
  await expect.poll(() => server.revision).toBe(2);
  await expect(page.locator(".workspace-view-control")).toContainText(
    "Newer draft",
  );
  await expect(page.locator("#view-modified")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!).base.revision,
        draftKey,
      ),
    )
    .toBe(2);
  expect(server.workspace.name).toBe("Submitted");
});

test("two independent clients follow clean changes but never overwrite a dirty client", async ({
  browser,
}) => {
  const server = mockServer();
  const a = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
    }),
    b = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    await server.install(a);
    await server.install(b);
    const first = await a.newPage(),
      second = await b.newPage();
    await open(first);
    await open(second);
    await rename(first, "First draft");
    await rename(second, "Second draft");
    await first.getByLabel("Save view changes", { exact: true }).click();
    await expect.poll(() => server.revision).toBe(2);
    await pollNow(second);
    await expect(second.locator(".workspace-view-control")).toContainText(
      "Second draft",
    );
    await second.getByLabel("Save view changes", { exact: true }).click();
    await expect(second.locator("#global-error")).toContainText("409");
    await action(second, "Revert to saved");
    await expect(second.locator(".workspace-view-control")).toContainText(
      "First draft",
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test("run selection is a published shared edit and local routes remain local", async ({
  page,
  context,
}) => {
  const server = mockServer();
  await server.install(context);
  await open(page);
  await page
    .getByRole("checkbox", { name: "Show Run r1", exact: true })
    .uncheck();
  await expect(page.locator("#view-modified")).toBeVisible();
  expect(new URL(page.url()).hash).toBe(routeHash);
  await page.getByLabel("Save view changes", { exact: true }).click();
  await expect(page.locator("#view-modified")).toBeHidden();
  expect(server.workspace.selectedRunIds).toEqual([]);
  await page.goto("/#/experiments/exp/charts");
  await expect(page.locator(".workspace-view-control")).toContainText(
    "Overview",
  );
  await expect(
    page.getByLabel("Saved view").locator("option", { hasText: "Server" }),
  ).toHaveCount(1);
  await expect(page.locator("#view-modified")).toBeHidden();
});

test("changing a shared view's experiment rebuilds its shell without changing its link", async ({
  page,
  context,
}) => {
  const server = mockServer();
  await server.install(context);
  await open(page);
  server.update({ experimentId: "other" });
  await pollNow(page);
  await expect(page.locator("#header-context")).toContainText(
    "Other experiment",
  );
  expect(new URL(page.url()).hash).toBe(routeHash);
  await expect(page.locator('[data-card-id="stable-chart"]')).toBeVisible();
  await rename(page, "Draft in other experiment");
  server.update({ experimentId: "exp" });
  await pollNow(page);
  await action(page, "Revert to saved");
  await expect(page.locator("#header-context")).toContainText("Experiment");
  await expect(page.locator("#header-context")).not.toContainText(
    "Other experiment",
  );
  await expect(page.locator("#view-modified")).toBeHidden();
  expect(new URL(page.url()).hash).toBe(routeHash);
});

test("filtering a shared view updates its draft selection and preserves it on reload", async ({ page, context }) => {
  const server = mockServer();
  server.update({ selectedRunIds: ["r1", "r2"] });
  await server.install(context);
  await open(page);
  await page.getByLabel("Find runs", { exact: true }).fill("r1");
  await expect(page.locator("#view-modified")).toBeVisible();
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).workspace.selectedRunIds, draftKey)).toEqual(["r1"]);
  expect(server.workspace.selectedRunIds).toEqual(["r1", "r2"]);
  await page.reload();
  await expect(page.locator("#view-modified")).toBeVisible();
  await page.getByLabel("Save view changes", { exact: true }).click();
  await expect(page.locator("#view-modified")).toBeHidden();
  expect(server.workspace.selectedRunIds).toEqual(["r1"]);
});

test("large shared view configuration survives filtering, publishing and reload", async ({ page, context }, testInfo) => {
  const server = mockServer();
  const sections = structuredClone(server.workspace.sections);
  const styles = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [
    JSON.stringify(["metric", `run-${i}`, "train/loss"]),
    { color: "#123456", width: 2, points: true, pointSize: 5, visible: true, alpha: 0.75 },
  ]));
  sections[0].cards[0].config.runs = styles;
  const configBytes = Buffer.byteLength(JSON.stringify(sections[0].cards[0].config));
  expect(configBytes).toBeGreaterThan(262144);
  server.update({ sections, selectedRunIds: ["r1", "r2"] });
  await server.install(context);
  await open(page);
  await page.getByLabel("Find runs", { exact: true }).fill("r1");
  await expect(page.locator("#view-modified")).toBeVisible();
  await expect(page.locator("#global-error")).toBeHidden();
  await page.reload();
  await expect(page.locator("#view-modified")).toBeVisible();
  await page.getByLabel("Save view changes", { exact: true }).click();
  await expect(page.locator("#view-modified")).toBeHidden();
  expect(server.workspace.selectedRunIds).toEqual(["r1"]);
  expect(server.workspace.sections[0].cards[0].config.runs).toEqual(styles);
  await page.reload();
  await expect(page.locator('[data-card-id="stable-chart"]')).toBeVisible();
  await expect(page.locator("#view-modified")).toBeHidden();
  await expect(page.locator("#global-error")).toBeHidden();
  expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toBeNull();
  await testInfo.attach("large-shared-view", {
    body: JSON.stringify({ configBytes, styles: Object.keys(styles).length, writes: server.writes.length }),
    contentType: "application/json",
  });
});
