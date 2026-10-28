import { test, expect, type Page } from "@playwright/test";

type Surface = "table" | "drawer" | "detail";
const surfaces: Surface[] = ["table", "drawer", "detail"];
const alpha = {
  id: "alpha",
  experiment_id: "exp",
  name: "Alpha",
  status: "running",
  params: {},
  tags: { owner: "team" },
  created_at: 1700000000000,
  updated_at: 1700000000000,
};

async function fixture(page: Page, surface: Surface, readonly = false) {
  await page.route("**/__run_status_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><body><main style="padding:12px"></main></body></html>',
    }),
  );
  await page.route("**/api/runs/*", async (route) => {
    await route.fulfill({
      json: {
        ...alpha,
        ...route.request().postDataJSON(),
        updated_at: alpha.updated_at + 1000,
      },
    });
  });
  await page.goto("/__run_status_fixture");
  await page.evaluate(
    async ({ surface, readonly, alpha }) => {
      await import("/src/style.css");
      const { Api } = await import("/src/api.ts");
      const api = new Api(() => "status-test-token");
      const run = {
        ...alpha,
        ...(readonly
          ? { rx: { sourceId: "source", uid: "alpha", state: "running" } }
          : {}),
      };
      const experiment = {
        id: "exp",
        name: "Experiment",
        created_at: alpha.created_at,
      };
      let catalog = {
        experiments: [experiment],
        runs: [run, { ...alpha, id: "beta", name: "Beta", status: "finished" }],
        series: [
          {
            run_id: "alpha",
            key: "loss",
            kind: "metric",
            count: 1,
            last_step: 0,
            last_timestamp: alpha.updated_at,
            last_value: 0.5,
          },
        ],
      };
      const state = window as any;
      state.selection = ["alpha"];
      state.selectionCalls = 0;
      state.detailCalls = 0;
      state.statusCalls = 0;
      const onSelection = (ids: string[]) => {
        state.selection = ids;
        state.selectionCalls++;
      };
      const onDetails = () => {
        state.detailCalls++;
      };
      const onStatus = async (current: any, status: any) => {
        state.statusCalls++;
        return api.patchRun(current.id, { status });
      };
      const main = document.querySelector("main")!;
      if (surface === "table") {
        const { runTable, tableState } = await import("/src/browser-tables.ts");
        state.view = runTable(
          catalog,
          experiment,
          ["alpha"],
          onSelection,
          () => {},
          onDetails,
          tableState(),
          undefined,
          () => state.selection,
          undefined,
          onStatus,
        );
        main.append(state.view);
        state.originalRow = main.querySelector('tbody tr[data-run-id="alpha"]');
        state.originalCheck = state.originalRow.querySelector(
          'input[type="checkbox"]',
        );
      } else if (surface === "drawer") {
        const { RunDrawer, runDrawerState } =
          await import("/src/run-drawer.ts");
        state.view = new RunDrawer(
          "exp",
          { ...runDrawerState("exp"), open: true },
          onSelection,
          onDetails,
          undefined,
          undefined,
          onStatus,
        );
        main.className = "workspace-layout";
        main.append(state.view.backdrop, state.view.pane);
        state.view.update(catalog, ["alpha"]);
        state.view.mount();
        state.originalRow = main.querySelector(
          '.run-drawer-row[data-run-id="alpha"]',
        );
        state.originalCheck = state.originalRow.querySelector(
          'input[type="checkbox"]',
        );
      } else {
        const { renderRunDetail } = await import("/src/run-detail.ts");
        state.view = renderRunDetail(run, {
          catalog,
          onStatus,
          onTags: (tags: any) => api.patchRun(run.id, { tags }),
        });
        main.append(state.view);
      }
      state.originalPill =
        main.querySelector('[data-run-id="alpha"] .run-status-pill') ??
        main.querySelector(".run-status-pill");
      state.refreshMetric = (value: number) => {
        catalog = {
          ...catalog,
          series: catalog.series.map((series) => ({
            ...series,
            last_value: value,
          })),
        };
        state.view.updateCatalog(catalog);
      };
      state.refresh = (status: string) => {
        catalog = {
          ...catalog,
          runs: catalog.runs.map((r: any) =>
            r.id === "alpha" ? { ...r, status } : r,
          ),
        };
        if (surface === "drawer") state.view.update(catalog, state.selection);
        else state.view.updateCatalog(catalog);
      };
    },
    { surface, readonly, alpha },
  );
}

for (const surface of surfaces) {
  test(`${surface}: editable status uses surface-appropriate styling without text glyphs`, async ({
    page,
  }) => {
    await fixture(page, surface);
    const pill = page.getByRole("button", {
      name: "Running status for Alpha",
      exact: true,
    });
    const chevron = pill.locator("span.run-status-chevron");
    if (surface === "drawer") {
      await expect(chevron).toBeHidden();
      await expect(pill).toHaveCSS("font-size", "11px");
      await expect(pill).toHaveCSS("border-top-width", "0px");
      await expect(pill).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await pill.click();
      await expect(
        page.getByRole("menuitemradio", { name: "Canceled", exact: true }),
      ).toBeVisible();
      return;
    }
    await expect(chevron).toBeVisible();
    await expect(chevron).toHaveAttribute("aria-hidden", "true");
    await expect(chevron).toHaveText("");
    await expect(chevron).toHaveCSS("display", /^(inline-)?flex$/);
    await expect(chevron).toHaveCSS("align-items", "center");
    await expect(chevron).toHaveCSS("justify-content", "center");
    await expect(chevron).toHaveCSS("width", "12px");
    await expect(chevron).toHaveCSS("height", "12px");
    await expect(pill).toHaveCSS("align-items", "center");
    const icon = chevron.locator("svg");
    await expect(icon).toHaveCount(1);
    await expect(icon).toBeVisible();
    const pillBox = (await pill.boundingBox())!;
    const chevronBox = (await chevron.boundingBox())!;
    const iconBox = (await icon.boundingBox())!;
    expect(
      Math.abs(
        iconBox.y + iconBox.height / 2 - (pillBox.y + pillBox.height / 2),
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        iconBox.x + iconBox.width / 2 - (chevronBox.x + chevronBox.width / 2),
      ),
    ).toBeLessThanOrEqual(1);
  });

  test(`${surface}: saves canceled through the pill without navigating or selecting`, async ({
    page,
  }) => {
    await fixture(page, surface);
    if (surface === "detail") {
      await page
        .getByRole("button", { name: "+ Add tag", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Tag key", exact: true })
        .fill("draft");
      await page
        .getByRole("textbox", { name: "Tag value", exact: true })
        .fill("not saved");
      await page.evaluate(() => {
        (window as any).originalForm = document.querySelector(
          ".run-detail-tag-form",
        );
      });
    } else {
      await page
        .getByRole("searchbox", {
          name:
            surface === "table"
              ? "Search runs, parameters or tags"
              : "Find runs",
          exact: true,
        })
        .fill("Alpha");
      // Filtering legitimately replaces table rows; snapshot the filtered controls.
      await page.evaluate(() => {
        const s = window as any;
        s.originalRow = document.querySelector(
          'tbody tr[data-run-id="alpha"],.run-drawer-row[data-run-id="alpha"]',
        );
        s.originalCheck = s.originalRow.querySelector('input[type="checkbox"]');
        s.originalPill = s.originalRow.querySelector(".run-status-pill");
      });
    }
    const pill = page.getByRole("button", {
      name: "Running status for Alpha",
      exact: true,
    });
    await expect(pill).not.toHaveAttribute("title");
    await pill.click();
    await expect(pill).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("menuitemradio")).toHaveCount(4);
    const request = page.waitForRequest(
      (request) => request.method() === "PATCH",
    );
    await page
      .getByRole("menuitemradio", { name: "Canceled", exact: true })
      .click();
    const sent = await request;
    expect(sent.postDataJSON()).toEqual({ status: "canceled" });
    expect(sent.headers().authorization).toBe("Bearer status-test-token");
    await expect(
      page.getByRole("button", {
        name: "Canceled status for Alpha",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const s = window as any;
        return {
          selection: s.selection,
          selectionCalls: s.selectionCalls,
          detailCalls: s.detailCalls,
          samePill: s.originalPill.isConnected,
        };
      }),
    ).toEqual({
      selection: ["alpha"],
      selectionCalls: 0,
      detailCalls: 0,
      samePill: true,
    });
    if (surface === "detail") {
      await expect(
        page.getByRole("textbox", { name: "Tag value", exact: true }),
      ).toHaveValue("not saved");
      expect(
        await page.evaluate(
          () =>
            (window as any).originalForm ===
            document.querySelector(".run-detail-tag-form"),
        ),
      ).toBe(true);
    } else {
      expect(
        await page.evaluate(
          () =>
            (window as any).originalRow.isConnected &&
            (window as any).originalCheck.checked,
        ),
      ).toBe(true);
      const filter = page.getByRole("combobox", {
        name:
          surface === "table" ? "Run status" : "Filter chart runs by status",
        exact: true,
      });
      await filter.selectOption("canceled");
      await expect(
        page.getByRole("button", {
          name: "Canceled status for Alpha",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "Finished status for Beta",
          exact: true,
        }),
      ).not.toBeVisible();
    }
  });

  test(`${surface}: API failure retains the prior status and offers a working retry`, async ({
    page,
  }) => {
    await fixture(page, surface);
    await page.route("**/api/runs/*", (route) =>
      route.fulfill({
        status: 403,
        json: { error: "This token cannot edit runs" },
      }),
    );
    const pill = page.getByRole("button", {
      name: "Running status for Alpha",
      exact: true,
    });
    await pill.click();
    await page
      .getByRole("menuitemradio", { name: "Failed", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Could not save status: This token cannot edit runs",
    );
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute("aria-busy", "false");
    expect(await page.evaluate(() => (window as any).selectionCalls)).toBe(0);
    await page.route("**/api/runs/*", (route) =>
      route.fulfill({ json: { ...alpha, status: "finished" } }),
    );
    await pill.click();
    await page
      .getByRole("menuitemradio", { name: "Finished", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Finished status for Alpha",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.locator(
        '.run-status-control[data-run-id="alpha"] .run-status-error',
      ),
    ).not.toBeVisible();
  });

  test(`${surface}: keyboard menu navigation and instance cleanup`, async ({
    page,
  }) => {
    await fixture(page, surface);
    const pill = page.getByRole("button", {
      name: "Running status for Alpha",
      exact: true,
    });
    await pill.focus();
    await pill.press("ArrowDown");
    await expect(
      page.getByRole("menuitemradio", { name: "Running", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      page.getByRole("menuitemradio", { name: "Canceled", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect(
      page.getByRole("menuitemradio", { name: "Canceled", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pill).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await pill.press("Enter");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    const canceled = page.getByRole("button", {
      name: "Canceled status for Alpha",
      exact: true,
    });
    await expect(canceled).toBeFocused();
    await canceled.click();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await canceled.click();
    await page.evaluate(() => (window as any).view.destroy());
    await expect(page.locator(".run-status-menu:popover-open")).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await canceled.click();
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test(`${surface}: external rx status is visibly read-only`, async ({
    page,
  }) => {
    await fixture(page, surface, true);
    const pill = page.getByRole("button", {
      name: "Running status for Alpha (read-only)",
      exact: true,
    });
    await expect(pill).toBeDisabled();
    await expect(pill.locator("span.run-status-chevron")).toHaveCount(1);
    await expect(pill.locator("span.run-status-chevron")).toBeHidden();
    await expect(pill).not.toHaveAttribute("title");
    await expect(pill).not.toHaveAttribute("aria-haspopup");
    await expect(pill.locator("..")).toHaveAttribute("data-readonly", "true");
    await pill.dispatchEvent("click");
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).statusCalls)).toBe(0);
  });
}

test("detail live catalog updates preserve an open tag editor", async ({
  page,
}) => {
  await fixture(page, "detail");
  await page.getByRole("button", { name: "+ Add tag", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Tag value", exact: true })
    .fill("draft value");
  await page.evaluate(() => (window as any).refresh("failed"));
  await expect(
    page.getByRole("button", { name: "Failed status for Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Tag value", exact: true }),
  ).toHaveValue("draft value");
});

test("canceled catalog validation, filter persistence, and API error fallback", async ({
  page,
}) => {
  await fixture(page, "table");
  const result = await page.evaluate(
    async ({ alpha }) => {
      const { Api } = await import("/src/api.ts");
      const { fetchCatalog } = await import("/src/catalog.ts");
      const { saveRunSearch, loadRunSearch } =
        await import("/src/run-filter-state.ts");
      const payload = {
        experiments: [
          { id: "exp", name: "Experiment", created_at: alpha.created_at },
        ],
        runs: [{ ...alpha, status: "canceled" }],
        series: [],
      };
      const api = new Api(
        () => "token",
        async () => new Response(JSON.stringify(payload), { status: 200 }),
      );
      const catalog = await fetchCatalog(api);
      saveRunSearch("status-test", { query: "Alpha", status: "canceled" });
      let invalid = "";
      payload.runs[0].status = "cancelled";
      try {
        await fetchCatalog(api);
      } catch (error) {
        invalid = (error as Error).message;
      }
      let failure: any;
      const broken = new Api(
        () => "token",
        async () => new Response("unavailable", { status: 503 }),
      );
      try {
        await broken.patchRun("alpha/slash", { status: "canceled" });
      } catch (error) {
        failure = {
          message: (error as Error).message,
          status: (error as any).status,
        };
      }
      return {
        status: catalog.runs[0].status,
        search: loadRunSearch("status-test"),
        invalid,
        failure,
      };
    },
    { alpha },
  );
  expect(result).toEqual({
    status: "canceled",
    search: { query: "Alpha", status: "canceled" },
    invalid: "Invalid run status.",
    failure: { message: "HTTP 503", status: 503 },
  });
});

test("pending status saves keep the previous label and reject duplicate gestures", async ({
  page,
}) => {
  await fixture(page, "table");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/runs/*", async (route) => {
    await pending;
    await route.fulfill({ json: { ...alpha, status: "canceled" } });
  });
  const pill = page.getByRole("button", {
    name: "Running status for Alpha",
    exact: true,
  });
  await pill.click();
  await page
    .getByRole("menuitemradio", { name: "Canceled", exact: true })
    .click();
  await expect(pill).toHaveAttribute("aria-busy", "true");
  await expect(pill).toContainText("Running");
  await pill.dispatchEvent("click");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).statusCalls)).toBe(1);
  release();
  await expect(
    page.getByRole("button", {
      name: "Canceled status for Alpha",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Canceled status for Alpha",
      exact: true,
    }),
  ).toHaveAttribute("aria-busy", "false");
});

for (const redraw of ["metric", "selection"] as const) {
  test(`pending table status survives ${redraw} redraws and retains failures`, async ({
    page,
  }) => {
    await fixture(page, "table");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await page.route("**/api/runs/*", async (route) => {
      requests++;
      await pending;
      await route.fulfill({
        status: 403,
        json: { error: "This token cannot edit runs" },
      });
    });
    const pill = page.getByRole("button", {
      name: "Running status for Alpha",
      exact: true,
    });
    const row = page.locator('tbody tr[data-run-id="alpha"]');
    const error = row.getByRole("alert");
    const redrawTable = async (again = false) => {
      if (redraw === "metric") {
        const value = again ? 0.125 : 0.25;
        await page.evaluate(
          (value) => (window as any).refreshMetric(value),
          value,
        );
        await expect(row.locator(".number-cell")).toHaveText(String(value));
      } else {
        await page
          .getByRole("checkbox", { name: "Select Beta", exact: true })
          .setChecked(!again);
      }
    };
    try {
      await pill.click();
      const request = page.waitForRequest(
        (request) => request.method() === "PATCH",
      );
      await page
        .getByRole("menuitemradio", { name: "Canceled", exact: true })
        .click();
      await request;
      await expect(pill).toHaveAttribute("aria-busy", "true");
      await redrawTable();
      expect(
        await page.evaluate(() => {
          const s = window as any;
          return {
            redrawn: !s.originalRow.isConnected,
            samePill:
              s.originalPill ===
              document.querySelector(
                'tbody tr[data-run-id="alpha"] .run-status-pill',
              ),
          };
        }),
      ).toEqual({ redrawn: true, samePill: true });
      await expect(pill).toHaveAttribute("aria-busy", "true");
      await pill.dispatchEvent("click");
      await pill.press("ArrowDown");
      await expect(page.getByRole("menu")).toHaveCount(0);
      // Even a queued activation on an old menu item must not start another save.
      await row
        .locator(".run-status-option")
        .filter({ hasText: "Failed" })
        .dispatchEvent("click");
      expect(await page.evaluate(() => (window as any).statusCalls)).toBe(1);
      expect(requests).toBe(1);
      release();
      await expect(error).toContainText(
        "Could not save status: This token cannot edit runs",
      );
      await expect(pill).toHaveAttribute("aria-busy", "false");
      await redrawTable(true);
      await expect(error).toContainText(
        "Could not save status: This token cannot edit runs",
      );
      await expect(pill).toHaveAttribute(
        "aria-describedby",
        (await error.getAttribute("id"))!,
      );
      await page.route("**/api/runs/*", (route) =>
        route.fulfill({ json: { ...alpha, status: "canceled" } }),
      );
      await pill.click();
      await page
        .getByRole("menuitemradio", { name: "Canceled", exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name: "Canceled status for Alpha",
          exact: true,
        }),
      ).toBeVisible();
      await expect(error).toBeHidden();
      expect(await page.evaluate(() => (window as any).statusCalls)).toBe(2);
    } finally {
      release();
    }
  });
}

test("narrow drawer Escape closes the status menu before the drawer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await fixture(page, "drawer");
  const drawer = page.getByRole("dialog", { name: "Chart runs", exact: true });
  const pill = page.getByRole("button", {
    name: "Running status for Alpha",
    exact: true,
  });
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  await pill.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(pill).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(pill).toBeHidden();
  const expand = page.getByRole("button", {
    name: "Expand run list",
    exact: true,
  });
  await expect(expand).toBeFocused();
  await expand.click();
  await pill.focus();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(expand).toBeFocused();
});

for (const width of [320, 390]) {
  test(`${width}px status menu stays in view and uses application colors`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 480 });
    await fixture(page, "detail");
    const pill = page.getByRole("button", {
      name: "Running status for Alpha",
      exact: true,
    });
    expect(
      await pill.evaluate((node) => {
        const reference = document.createElement("span");
        reference.style.color = "var(--info)";
        document.body.append(reference);
        const expected = getComputedStyle(reference).color;
        reference.remove();
        return getComputedStyle(node).color === expected;
      }),
    ).toBe(true);
    await pill.click();
    const menu = page.getByRole("menu", { name: "Change run status" });
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(480);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(pill).toBeFocused();
  });
}
