import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "web/package.json"));
const { chromium, expect } = require("@playwright/test");
const url = process.env.NSET_BROWSER_URL;
const token = process.env.NSET_BROWSER_TOKEN;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
async function api(method, endpoint, body) {
  const response = await fetch(`${url}/api${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(
    response.ok,
    `${method} ${endpoint}: ${response.status} ${await response.clone().text()}`,
  );
  return response.status === 204 ? null : response.json();
}
const rx = await api("GET", "/rx/catalog");
const source = rx.source.id;
const runUids = rx.runs.map((run) => run.run_uid);
const chart = (id, title, uid) => ({
  id,
  title,
  kind: "timeseries",
  source: { mode: "selected", keys: [] },
  records: {
    sourceId: source,
    runUids: [uid],
    x: "epoch",
    ys: ["loss"],
    filters: {
      any: false,
      conditions: [{ path: "kind", op: "eq", value: "epoch" }],
    },
  },
  config: {},
  outliers: "all",
  size: "normal",
});
let saved = await api("POST", "/views", {
  workspace: {
    version: 2,
    id: "incoming",
    name: "Curated rx experiment",
    experimentId: source,
    selectedRunIds: runUids.map((uid) => `${source}:${uid}`),
    updatedAt: 0,
    sections: [
      {
        id: "results",
        title: "Results",
        collapsed: false,
        cards: [chart("loss-a", "First run loss", runUids[0])],
      },
    ],
  },
});
const endpoint = `/views/${encodeURIComponent(saved.id)}`;
assert.equal(await api("GET", `${endpoint}?revision=${saved.revision}`), null);
async function publish(mutate) {
  const workspace = structuredClone(saved.workspace);
  mutate(workspace);
  saved = await api("PUT", endpoint, { revision: saved.revision, workspace });
}
const browser = await chromium.launch({ headless: true });
const errors = [];
const first = await browser.newContext({
  viewport: { width: 1500, height: 1000 },
});
const second = await browser.newContext({
  viewport: { width: 1500, height: 1000 },
});
const page = await first.newPage();
const other = await second.newPage();
for (const target of [page, other])
  target.on("pageerror", (error) => errors.push(error.message));
const link = `${url}/#/views/${encodeURIComponent(saved.id)}`;
const cards = (target) => target.locator(".dashboard-cell");
async function connect(target) {
  await target.goto(link);
  await target.getByLabel("Access token", { exact: true }).fill(token);
  await target.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(target.locator("#connection")).toHaveText("Connected");
  await expect(cards(target)).toHaveCount(1);
}
async function action(target, name) {
  const menu = target.locator("details[data-menu=view]");
  if (!(await menu.evaluate((node) => node.open)))
    await menu.locator("summary").first().click();
  await menu.getByRole("button", { name, exact: true }).click();
}
async function rename(target, name) {
  await action(target, "Rename view");
  const dialog = target.getByRole("dialog", {
    name: "Rename view",
    exact: true,
  });
  await dialog.getByLabel("View name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
}
const selectedName = (target) =>
  target.locator("#view-select option:checked, .workspace-view-name");
try {
  await connect(page);
  await connect(other);
  await expect(page.locator(".uplot").first()).toBeVisible();
  await page.evaluate(() => {
    window.originalCard = document.querySelector(".dashboard-cell");
  });
  await publish((view) =>
    view.sections[0].cards.push(chart("loss-b", "Second run loss", runUids[1])),
  );
  await expect(cards(page)).toHaveCount(2, { timeout: 15000 });
  await expect(cards(other)).toHaveCount(2, { timeout: 15000 });
  assert.ok(
    await page.evaluate(
      () => window.originalCard === document.querySelector(".dashboard-cell"),
    ),
    "unchanged card was replaced",
  );
  await rename(page, "Unsaved local draft");
  await expect(page.locator("#view-modified")).toBeVisible();
  await publish((view) => {
    view.name = "Agent revision";
  });
  await expect(selectedName(other)).toContainText("Agent revision", {
    timeout: 15000,
  });
  await expect(selectedName(page)).toContainText("Unsaved local draft");
  await page.reload();
  await expect(selectedName(page)).toContainText("Unsaved local draft");
  await page
    .getByRole("button", { name: "Save view changes", exact: true })
    .click();
  await expect(page.locator("#global-error")).toBeVisible();
  await expect(page.locator("#view-modified")).toBeVisible();
  assert.equal((await api("GET", endpoint)).workspace.name, "Agent revision");
  await action(page, "Revert to saved");
  await expect(selectedName(page)).toContainText("Agent revision");
  await expect(page.locator("#view-modified")).toBeHidden();
  await rename(page, "User saved revision");
  await page
    .getByRole("button", { name: "Save view changes", exact: true })
    .click();
  await expect(page.locator("#view-modified")).toBeHidden();
  await expect(selectedName(other)).toContainText("User saved revision", {
    timeout: 15000,
  });
  saved = await api("GET", endpoint);
  assert.equal(saved.workspace.name, "User saved revision");
  await mkdir(path.join(root, "artifacts/server-views"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "artifacts/server-views/shared-rx-view.png"),
    fullPage: true,
  });
  await rename(page, "Fork this draft");
  await publish((view) => {
    view.name = "Latest agent revision";
  });
  await expect(selectedName(other)).toContainText("Latest agent revision", {
    timeout: 15000,
  });
  await action(page, "Save view as…");
  const dialog = page.getByRole("dialog", {
    name: "Save view as",
    exact: true,
  });
  await dialog.getByLabel("View name", { exact: true }).fill("My local copy");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(selectedName(page)).toContainText("My local copy");
  assert.ok(
    !page.url().includes("#/views/"),
    "local copy retained server route",
  );
  assert.equal((await api("GET", "/views")).views.length, 1);
  assert.equal(
    (await api("GET", endpoint)).workspace.name,
    "Latest agent revision",
  );
  const localId = await page.locator("#view-select").inputValue();
  assert.notEqual(localId, saved.id);
  await page.locator("#view-select").selectOption(saved.id);
  await expect(selectedName(page)).toContainText("Latest agent revision");
  await expect(page).toHaveURL(link);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      kind: "final",
      test: "shared-view-browser",
      status: "passed",
      clients: 2,
      view: saved.id,
      revision: saved.revision,
    }),
  );
} finally {
  await browser.close();
}
