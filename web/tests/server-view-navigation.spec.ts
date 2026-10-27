import { test, expect, type Page } from "@playwright/test";
import type { Workspace } from "../src/workspace-types";

const sharedId = "server:00000000-0000-0000-0000-000000000001";
const secondId = "server:00000000-0000-0000-0000-000000000002";
const otherId = "server:00000000-0000-0000-0000-000000000003";
const sharedHash = `#/views/${encodeURIComponent(sharedId)}`;
const draftKey = `nset.server-view-draft.v1:${encodeURIComponent(sharedId)}`;
const picker = (page: Page) =>
  page.getByRole("combobox", { name: "Saved view", exact: true });

function workspace(id: string, name: string, experimentId = "exp"): Workspace {
  return {
    version: 2,
    id,
    name,
    experimentId,
    selectedRunIds: [],
    sections: [],
    updatedAt: 1,
  };
}

async function fixture(
  page: Page,
  localViews: Workspace[] = [],
  sharedViews = [workspace(sharedId, "Shared view")],
  listReady: Promise<void> = Promise.resolve(),
) {
  const listed = sharedViews.map((view) => ({
    id: view.id,
    name: view.name,
    experimentId: view.experimentId,
    revision: 1,
    updatedAt: 1,
  }));
  const writes: string[] = [];
  await page.addInitScript((views) => {
    sessionStorage.setItem("nset.token", "test");
    // Do not overwrite edits when a test reloads the page.
    if (!localStorage.getItem("nset.workspaces.v2") && views.length)
      localStorage.setItem(
        "nset.workspaces.v2",
        JSON.stringify({ version: 2, views, activeByExperiment: {} }),
      );
  }, localViews);
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (request.method() !== "GET") {
      writes.push(request.method());
      return json({ error: "Navigation must not publish views" }, 500);
    }
    if (url.pathname === "/api/catalog")
      return json({
        experiments: [
          { id: "exp", name: "Experiment", created_at: 1 },
          { id: "other", name: "Other experiment", created_at: 1 },
        ],
        runs: [],
        series: [],
      });
    if (url.pathname === "/api/views") {
      await listReady;
      return json({ views: listed });
    }
    const view = sharedViews.find(
      (view) => decodeURIComponent(url.pathname) === `/api/views/${view.id}`,
    );
    if (view) {
      if (url.searchParams.get("revision") === "1")
        return route.fulfill({ status: 204 });
      return json({ id: view.id, revision: 1, workspace: view });
    }
    return json({ error: `Unexpected API: ${url.pathname}` }, 404);
  });
  return { listed, writes };
}

async function open(page: Page) {
  await page.goto(`/${sharedHash}`);
  await expect(picker(page)).toBeVisible();
  await expect(picker(page)).toHaveValue(sharedId);
  await expect(picker(page).locator("option:checked")).toHaveText(
    "Shared view · Server",
  );
}

async function rename(page: Page, name: string) {
  await page.getByLabel("View actions", { exact: true }).click();
  await page.getByRole("button", { name: "Rename view", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Rename view", exact: true });
  await dialog.getByLabel("View name").fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#view-modified")).toBeVisible();
}

test("fresh server direct link offers a lazy local Overview and a return to the shared view", async ({
  page,
}) => {
  const server = await fixture(page);
  await open(page);
  await expect(picker(page).locator("option")).toHaveText([
    "Overview",
    "Shared view · Server",
  ]);
  expect(
    await page.evaluate(() => localStorage.getItem("nset.workspaces.v2")),
  ).toBeNull();

  await picker(page).selectOption({ label: "Overview" });
  await expect(page).toHaveURL(/#\/experiments\/exp\/charts$/);
  await expect(picker(page).locator("option:checked")).toHaveText("Overview");
  const localId = await picker(page).inputValue();
  expect(localId).not.toBe(sharedId);
  expect(localId).not.toBe("");
  await picker(page).selectOption(sharedId);
  await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(sharedId)}$`));
  await expect(picker(page)).toHaveValue(sharedId);
  await expect(page.locator("#view-modified")).toBeHidden();
  expect(server.writes).toEqual([]);
});

test("picker switches between same-experiment local and server views, excluding other experiments", async ({
  page,
}) => {
  const locals = [
    workspace("local-a", "Local A"),
    workspace("local-b", "Local B"),
    workspace("local-other", "Other local", "other"),
  ];
  const server = await fixture(page, locals, [
    workspace(sharedId, "Shared view"),
    workspace(secondId, "Second shared"),
    workspace(otherId, "Other shared", "other"),
  ]);
  await open(page);
  await expect
    .poll(() =>
      picker(page)
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value).sort(),
        ),
    )
    .toEqual(["local-a", "local-b", sharedId, secondId].sort());
  expect(await picker(page).locator("option").allTextContents()).toEqual(
    expect.arrayContaining([
      "Local A",
      "Local B",
      "Shared view · Server",
      "Second shared · Server",
    ]),
  );
  await picker(page).selectOption(secondId);
  await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(secondId)}$`));
  await expect(picker(page)).toHaveValue(secondId);
  await picker(page).selectOption("local-b");
  await expect(page).toHaveURL(/#\/experiments\/exp\/charts$/);
  await expect(picker(page)).toHaveValue("local-b");
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("nset.workspaces.v2")!),
  );
  expect(saved.activeByExperiment.exp).toBe("local-b");
  expect(saved.views.map((view: Workspace) => view.id)).toEqual(
    locals.map((view) => view.id),
  );
  await picker(page).selectOption("local-a");
  await expect(picker(page)).toHaveValue("local-a");
  await picker(page).selectOption(sharedId);
  await expect(picker(page)).toHaveValue(sharedId);
  expect(server.writes).toEqual([]);
});

test("a delayed initial server list refreshes an already loaded direct-link picker", async ({
  page,
}) => {
  let releaseList!: () => void;
  const listReady = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  const server = await fixture(
    page,
    [],
    [
      workspace(sharedId, "Shared view"),
      workspace(secondId, "Second shared"),
      workspace(otherId, "Other shared", "other"),
    ],
    listReady,
  );
  const listRequested = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/views",
  );
  await open(page);
  await listRequested;
  // The route has rendered, but the poll started without an active workspace.
  await expect(picker(page).locator("option")).toHaveText([
    "Overview",
    "Shared view · Server",
  ]);
  releaseList();
  await expect(picker(page).locator("option")).toHaveText([
    "Overview",
    "Second shared · Server",
    "Shared view · Server",
  ]);
  await expect(picker(page)).toHaveValue(sharedId);
  await picker(page).selectOption(secondId);
  await expect(picker(page)).toHaveValue(secondId);
  expect(server.writes).toEqual([]);
});

test("switching away from a dirty server view retains its draft without publishing it", async ({
  page,
}) => {
  const server = await fixture(page);
  await open(page);
  await rename(page, "Unpublished draft");
  await picker(page).selectOption({ label: "Overview" });
  await expect(page).toHaveURL(/#\/experiments\/exp\/charts$/);
  expect(
    await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key)!).workspace.name,
      draftKey,
    ),
  ).toBe("Unpublished draft");
  await picker(page).selectOption(sharedId);
  await expect(picker(page).locator("option:checked")).toHaveText(
    "Unpublished draft · Server",
  );
  await expect(page.locator("#view-modified")).toBeVisible();
  await page.reload();
  await expect(picker(page)).toHaveValue(sharedId);
  await expect(picker(page).locator("option:checked")).toHaveText(
    "Unpublished draft · Server",
  );
  await expect(page.locator("#view-modified")).toBeVisible();
  expect(server.writes).toEqual([]);
});

test("active server view remains selectable when its summary is absent or has moved experiments", async ({
  page,
}) => {
  const server = await fixture(page);
  server.listed.splice(0);
  await open(page);
  await rename(page, "Draft in original experiment");
  server.listed.push(
    {
      id: sharedId,
      name: "Published elsewhere",
      experimentId: "other",
      revision: 2,
      updatedAt: 2,
    },
    {
      id: secondId,
      name: "New shared view",
      experimentId: "exp",
      revision: 1,
      updatedAt: 1,
    },
  );
  // Trigger the same refresh used when the browser tab becomes visible.
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/views",
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await response;
  await expect(picker(page).locator("option")).toHaveCount(3);
  await expect(picker(page)).toHaveValue(sharedId);
  await expect(picker(page).locator("option:checked")).toHaveText(
    "Draft in original experiment · Server",
  );
  await expect(page.locator("#header-context")).toContainText("Experiment");
  await expect(page.locator("#header-context")).not.toContainText(
    "Other experiment",
  );
  expect(server.writes).toEqual([]);
});
