import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { WorkspaceLibrary } from "../src/workspace-types";

const source = "rx:http-ui-fixture";
const v4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const library = (page: Page): Promise<WorkspaceLibrary> =>
  page.evaluate(() => JSON.parse(localStorage.getItem("nset.workspaces.v2")!));
const activeView = async (page: Page) => {
  const saved = await library(page);
  return saved.views.find(
    (view) => saved.activeByExperiment[view.experimentId] === view.id,
  )!;
};

async function connect(page: Page, experiment: string) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/catalog") {
      await route.fulfill({
        json: {
          experiments: [{ id: "e1", name: "HTTP study", created_at: 0 }],
          runs: [
            {
              id: "r1",
              experiment_id: "e1",
              name: "Baseline",
              status: "finished",
              params: {},
              tags: {},
              created_at: 0,
              updated_at: 0,
            },
          ],
          series: [
            {
              run_id: "r1",
              key: "train/loss",
              kind: "metric",
              count: 2,
              last_step: 1,
              last_timestamp: 1000,
              last_value: 1,
            },
          ],
          rx_enabled: true,
        },
      });
    } else if (path === "/api/rx/catalog") {
      await route.fulfill({
        json: {
          source: { id: source, name: "HTTP rx study" },
          next_after: null,
          runs: [
            {
              id: "1",
              run_uid: "http-run-uid",
              state: "succeeded",
              alias: null,
              config: "",
              argv: [],
              exit_code: 0,
              created_at: "2026-10-01T00:00:00Z",
              started_at: null,
              finished_at: null,
            },
          ],
        },
      });
    } else if (path.endsWith("/metrics")) {
      await route.fulfill({
        json: {
          points: [
            { seq: 1, step: 0, timestamp: 0, value: 2 },
            { seq: 2, step: 1, timestamp: 1000, value: 1 },
          ],
          snapshot: 2,
          total: 2,
          next_after: null,
        },
      });
    } else {
      await route.fulfill({
        status: 500,
        json: { error: `Unexpected fixture endpoint ${path}` },
      });
    }
  });
  await page.goto(`/#/experiments/${encodeURIComponent(experiment)}/runs`);
  await page
    .getByLabel("Access token", { exact: true })
    .fill("http-ui-fixture-token");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Runs", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  expect(await page.evaluate(() => typeof crypto.getRandomValues)).toBe(
    "function",
  );
}

async function viewAction(page: Page, name: string) {
  await page.getByLabel("View actions", { exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}

// The dedicated config tests a real untrustworthy HTTP origin with no shim.
// Ordinary suite runs still exercise the regression by removing randomUUID.
test.beforeEach(async ({ page }, info) => {
  if (info.project.name !== "insecure-http") {
    await page.addInitScript(() => {
      Object.defineProperty(crypto, "randomUUID", {
        value: undefined,
        configurable: true,
      });
    });
  }
});

test("opens an rx experiment and run drawer without randomUUID", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await connect(page, source);
  if (info.project.name === "insecure-http")
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await page.getByRole("checkbox", { name: "Select r1", exact: true }).check();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  const expand = page.getByLabel("Expand run list", { exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".run-drawer-row:visible")).toHaveCount(1);
  await expect(page.locator(".drawer-selection-count")).toContainText("1");
  const saved = await activeView(page);
  expect(saved.id.replace(/^view:/, "")).toMatch(v4);
  expect(saved.selectedRunIds).toEqual([`${source}:http-run-uid`]);
  await page.reload();
  await expect(page.locator(".run-drawer-row:visible")).toHaveCount(1);
  expect((await activeView(page)).id).toBe(saved.id);
  expect(errors).toEqual([]);
});

test("creates and duplicates charts, saves sections/views, and imports without randomUUID", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await connect(page, "e1");
  if (info.project.name === "insecure-http")
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await page
    .getByRole("checkbox", { name: "Select Baseline", exact: true })
    .check();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await expect(page.locator(".dashboard-cell canvas").first()).toBeVisible();
  const original = await activeView(page);
  expect(original.id.replace(/^view:/, "")).toMatch(v4);

  await page.locator("details[data-menu=add] summary").click();
  await page.getByRole("button", { name: "Line plot", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Add chart", exact: true });
  await editor.getByRole("checkbox", { name: /^train\/loss —/ }).check();
  await editor.getByLabel("Chart title", { exact: true }).fill("HTTP chart");
  await editor.getByRole("button", { name: "Add chart", exact: true }).click();
  const card = page
    .locator(".dashboard-cell")
    .filter({ has: page.locator(".card-title", { hasText: /^HTTP chart$/ }) });
  await expect(card.locator("canvas")).toBeVisible();
  await card.getByLabel("Chart actions", { exact: true }).click();
  await card.getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(
    page.locator(".card-title", { hasText: /^HTTP chart copy$/ }),
  ).toBeVisible();
  let current = await activeView(page);
  const custom = current.sections.find(
    (section) => section.title === "Custom charts",
  )!;
  expect(custom.id).toMatch(v4);
  expect(custom.cards).toHaveLength(2);
  expect(custom.cards[0].id.replace(/^card:/, "")).toMatch(v4);
  expect(custom.cards[1].id).toMatch(v4);
  expect(custom.cards[0].id).not.toBe(custom.cards[1].id);

  await viewAction(page, "Add section");
  const sectionDialog = page.getByRole("dialog", {
    name: "Add section",
    exact: true,
  });
  await sectionDialog
    .getByLabel("Section name", { exact: true })
    .fill("HTTP section");
  await sectionDialog
    .getByRole("button", { name: "Save", exact: true })
    .click();
  current = await activeView(page);
  expect(
    current.sections.find((section) => section.title === "HTTP section")!.id,
  ).toMatch(v4);

  await viewAction(page, "Save view as…");
  const saveDialog = page.getByRole("dialog", {
    name: "Save view as",
    exact: true,
  });
  await saveDialog.getByLabel("View name", { exact: true }).fill("HTTP copy");
  await saveDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByLabel("Saved view", { exact: true }).locator("option:checked"),
  ).toHaveText("HTTP copy");
  const copy = await activeView(page);
  expect(copy.id).toMatch(v4);
  expect(copy.id).not.toBe(original.id);
  expect(copy.sections).toEqual(current.sections);

  const downloaded = page.waitForEvent("download");
  await viewAction(page, "Export view");
  const download = await downloaded;
  const contents = await readFile((await download.path())!, "utf8");
  expect(JSON.parse(contents)).toEqual(copy);
  await page
    .getByLabel("Import view file", { exact: true })
    .setInputFiles({
      name: "http-view.json",
      mimeType: "application/json",
      buffer: Buffer.from(contents),
    });
  await expect.poll(async () => (await library(page)).views.length).toBe(3);
  const imported = await activeView(page);
  expect(imported.id).toMatch(v4);
  expect(imported.id).not.toBe(copy.id);
  expect(imported.sections).toEqual(copy.sections);
  expect(new Set((await library(page)).views.map((view) => view.id)).size).toBe(
    3,
  );
  await page.reload();
  await expect(
    page.locator(".card-title", { hasText: /^HTTP chart copy$/ }),
  ).toBeVisible();
  expect(await activeView(page)).toEqual(imported);
  expect(errors).toEqual([]);
});
