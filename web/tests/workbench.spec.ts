import { test, expect, type Page } from "@playwright/test";
const runs = [
  {
    id: "r1",
    experiment_id: "e1",
    name: "baseline <b>literal</b>",
    status: "finished",
    params: { lr: 0.001 },
    tags: { model: "resnet" },
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  {
    id: "r2",
    experiment_id: "e1",
    name: "candidate / irregular grid",
    status: "running",
    params: { lr: 0.002 },
    tags: { model: "resnet" },
    created_at: 1700000001000,
    updated_at: 1700000001000,
  },
];
const experiments = [
  { id: "e1", name: "Vision study", created_at: 1700000000000 },
  { id: "e2", name: "Empty experiment", created_at: 1700000001000 },
];
async function fixture(page: Page) {
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    expect(req.headers().authorization).toBe("Bearer fixture-secret");
    const url = new URL(req.url());
    if (url.pathname === "/api/catalog") {
      await route.fulfill({
        json: {
          experiments,
          runs,
          series: runs.flatMap((r) =>
            ["train/loss", "eval/score"].map((key) => ({
              run_id: r.id,
              key,
              kind: "metric",
              count: 4,
              last_step: 8,
              last_timestamp: 1700000008000,
              last_value: 1,
            })),
          ),
        },
      });
      return;
    }
    if (url.pathname.endsWith("/metrics")) {
      const first = url.pathname.includes("/r1/");
      const xs = first ? [0, 1, 3, 8] : [0, 2, 5, 8];
      const ys = first ? [4, 2, 3, 1] : [3.5, 2.5, 2.7, 0.8];
      const points = xs.map((step, i) => ({
        seq: i + 1,
        step,
        timestamp: 1700000000000 + step * 1000,
        value: ys[i],
      }));
      const after = url.searchParams.get("after");
      await route.fulfill({
        json: {
          points: after ? points.slice(2) : points.slice(0, 2),
          snapshot: 4,
          total: 4,
          next_after: after ? null : 2,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "fixture missing" } });
  });
  await page.goto("/");
  await page.getByLabel("Access token", { exact: true }).fill("fixture-secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#connection")).toHaveText("Connected");
}
async function charts(page: Page) {
  await page.getByRole("button", { name: "Vision study", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await page.locator(".dashboard-cell canvas").first().waitFor();
}
const card = (page: Page, title: string) =>
  page
    .locator(".dashboard-cell")
    .filter({
      has: page.locator(".card-title", {
        hasText: new RegExp("^" + title + "$"),
      }),
    });

test("experiment and run tables preserve filtering and selection through navigation", async ({
  page,
}, info) => {
  await fixture(page);
  await expect(page.locator(".experiment-link")).toHaveCount(2);
  await page.getByRole("button", { name: "Vision study", exact: true }).click();
  await expect(page.locator(".run-table b")).toHaveCount(0);
  await page
    .getByLabel("Search runs, parameters or tags", { exact: true })
    .fill("candidate");
  await page
    .getByRole("checkbox", { name: "Select all matching runs", exact: true })
    .check();
  await expect(page.locator(".selection-count")).toHaveText("1 selected");
  await page.getByRole("button", { name: "View charts", exact: true }).click();
  await card(page, "loss").locator("canvas").waitFor();
  await expect(card(page, "loss").locator(".card-legend")).toContainText(
    "candidate",
  );
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await expect(
    page.getByLabel("Search runs, parameters or tags", { exact: true }),
  ).toHaveValue("candidate");
  await expect(page.locator(".selection-count")).toHaveText("1 selected");
  await page.screenshot({
    path: info.outputPath("runs-table.png"),
    fullPage: true,
  });
});

test("namespace collapse, view names and run choices survive reload", async ({
  page,
}, info) => {
  await fixture(page);
  await charts(page);
  const section = page
    .locator(".chart-section")
    .filter({ has: page.locator(".section-toggle", { hasText: "train" }) });
  await section.locator(".section-toggle").click();
  await expect(section.locator(".chart-grid")).toBeHidden();
  await page.getByLabel("View actions", { exact: true }).click();
  await page.getByRole("button", { name: "Save as…", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Save view as",
    exact: true,
  });
  await dialog.getByLabel("View name", { exact: true }).fill("Review");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.reload();
  await expect(page.locator("#connection")).toHaveText("Connected");
  await expect(
    page.getByLabel("Saved view", { exact: true }).locator("option:checked"),
  ).toHaveText("Review");
  await expect(section.locator(".chart-grid")).toBeHidden();
  await expect(page.locator(".run-picker summary")).toContainText("2");
  await page.screenshot({
    path: info.outputPath("saved-dashboard.png"),
    fullPage: true,
  });
});

test("editing is contextual and cancel does not mutate a card", async ({
  page,
}, info) => {
  await fixture(page);
  await charts(page);
  const loss = card(page, "loss");
  await loss.getByLabel("Chart actions", { exact: true }).click();
  await loss.getByRole("button", { name: "Edit chart", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit chart", exact: true });
  await editor
    .getByLabel("Chart title", { exact: true })
    .fill("Cancelled edit");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(loss.locator(".card-title")).toHaveText("loss");
  await loss.getByLabel("Chart actions", { exact: true }).click();
  await loss.getByRole("button", { name: "Edit chart", exact: true }).click();
  await editor.getByRole("tab", { name: "Axes", exact: true }).click();
  await editor.getByLabel("Y scale", { exact: true }).selectOption("log");
  await editor.locator(".ce-preview-plot canvas").waitFor();
  await page.screenshot({
    path: info.outputPath("contextual-editor.png"),
    fullPage: true,
  });
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(editor).toBeHidden();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("nset.workspaces.v2")!),
  );
  const specs = saved.views[0].sections.flatMap((s: any) => s.cards);
  expect(specs.find((c: any) => c.title === "loss").config.yScale).toBe("log");
  expect(specs.find((c: any) => c.title === "score").config.yScale).toBe(
    "linear",
  );
});

test("empty experiment has a clear table and chart creation remains available", async ({
  page,
}) => {
  await fixture(page);
  await page
    .getByRole("button", { name: "Empty experiment", exact: true })
    .click();
  await expect(page.locator(".empty-table")).toContainText("No runs");
  await page.getByRole("button", { name: "Charts", exact: true }).click();
  await expect(page.locator(".dashboard-empty")).toContainText("Select runs");
  await page.locator("details[data-menu=add] summary").click();
  await page.getByRole("button", { name: "Line chart", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Add chart", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("narrow dashboard stays within viewport and logout removes credentials", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fixture(page);
  await charts(page);
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.screenshot({
    path: info.outputPath("dashboard-narrow.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 2,
    ),
  ).toBe(false);
  await page.locator("#logout").click();
  await expect(page.locator("#login-dialog")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("nset.token"))).toBe(
    null,
  );
  expect(await page.locator(".dashboard-cell").count()).toBe(0);
  expect(errors).toEqual([]);
});
