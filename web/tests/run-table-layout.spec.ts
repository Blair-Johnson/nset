import { test, expect, type Page, type Locator } from "@playwright/test";

async function fixture(page: Page) {
  await page.route("**/__run_table_layout", (route) =>
    route.fulfill({
      contentType: "text/html",
      // Match main.ts's shell, including the normally hidden error banner and
      // the #page wrapper. A bare <main> misses the production padding overflow.
      body: `<!doctype html><html><head><link rel="stylesheet" href="/src/style.css"></head><body>
        <div id="app"><header class="app-header"><a class="brand" href="#">{n}</a>
        <nav class="header-context" aria-label="Location">Sweep</nav></header>
        <main id="main"><div id="global-error" class="alert" hidden></div><div id="page"></div></main></div>
        </body></html>`,
    }),
  );
  await page.goto("/__run_table_layout");
  await page.evaluate(async () => {
    const { runTable, tableState } = await import("/src/browser-tables.ts");
    const { plotIcon } = await import("/src/plot-icons.ts");
    const experiment = { id: "sweep", name: "Sweep", created_at: 0 };
    const runs = Array.from({ length: 120 }, (_, i) => ({
      id: `run-${i}`,
      experiment_id: "sweep",
      name: `Candidate ${String(i).padStart(3, "0")} — long training run identity with optimizer, dataset and configuration details`,
      status: "finished",
      created_at: i,
      updated_at: i,
      params: { "train.lr": i, train: { lr: i / 100 }, note: "a".repeat(120) },
      tags: {},
    }));
    const catalog = {
      experiments: [experiment],
      runs,
      series: runs.flatMap((run, i) =>
        ["loss", "validation/quality"].map((key) => ({
          kind: "metric",
          run_id: run.id,
          key,
          last_value: i,
          last_step: 1,
          count: 1,
        })),
      ),
    } as any;
    const state = tableState();
    state.sort = "name";
    state.descending = false;
    state.metrics = ["loss"];
    const host = document.querySelector("#page")!;
    let table: ReturnType<typeof runTable> | undefined;
    const selections: string[][] = [];
    const away = (kind: string) => {
      table?.destroy();
      const view = document.createElement("section");
      view.style.minHeight = "1600px";
      const back = document.createElement("button");
      back.textContent = `Back from ${kind}`;
      back.onclick = show;
      view.append(back);
      host.replaceChildren(view);
    };
    const show = () => {
      table?.destroy();
      table = runTable(
        catalog,
        experiment,
        ["run-0"],
        (ids) => {
          selections.push(ids);
        },
        () => away("charts"),
        () => away("detail"),
        state,
        undefined,
        undefined,
        undefined,
        async (run, status) => ({ ...run, status }),
      );
      const views = document.createElement("nav");
      views.className = "view-switch";
      views.setAttribute("aria-label", "Experiment views");
      for (const [key, label, icon] of [
        ["runs", "Runs", "view-runs"],
        ["charts", "Charts", "view-charts"],
      ] as const) {
        const button = document.createElement("button");
        button.className = "view-switch-button";
        button.setAttribute("aria-label", label);
        button.setAttribute("aria-pressed", String(key === "runs"));
        button.classList.toggle("active", key === "runs");
        button.append(plotIcon(icon));
        button.onclick = () => {
          if (key === "charts") away("charts");
        };
        views.append(button);
      }
      table.querySelector(".table-toolbar")!.prepend(views);
      host.replaceChildren(table);
    };
    (window as any).__runLayout = {
      state,
      catalog,
      selections,
      show,
      tick: () => {
        catalog.series[0].last_value++;
        table!.updateCatalog(catalog);
      },
      destroy: () => table!.destroy(),
    };
    document.addEventListener(
      "pointerdown",
      (event) => {
        (window as any).__runLayout.pointerId = event.pointerId;
      },
      true,
    );
    show();
  });
  await expect(
    page.getByRole("region", { name: "Scrollable runs table" }),
  ).toBeVisible();
}

const handle = (page: Page, key: string) =>
  page.locator(`.column-resize-handle[data-column-key=${JSON.stringify(key)}]`);
const columnWidth = (separator: Locator) =>
  separator.evaluate(
    (node) => node.parentElement!.getBoundingClientRect().width,
  );

async function drag(
  page: Page,
  separator: Locator,
  dx: number,
  release = true,
) {
  await separator.scrollIntoViewIfNeeded();
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, {
    steps: 8,
  });
  if (release) await page.mouse.up();
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 390, height: 740 },
  { width: 800, height: 360 },
]) {
  test(`${viewport.width}×${viewport.height}: only rows scroll, including wrapped toolbar and footer`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    const wrap = page.locator(".run-table-scroll");
    const geometry = () =>
      page.evaluate(() => ({
        toolbar: document
          .querySelector(".table-toolbar")!
          .getBoundingClientRect().top,
        header: document.querySelector("thead th")!.getBoundingClientRect().top,
        footer: document.querySelector(".table-footer")!.getBoundingClientRect()
          .bottom,
        height: document.documentElement.scrollHeight,
        width: document.documentElement.scrollWidth,
        scrollY,
      }));
    const before = await geometry();
    expect(before.height).toBeLessThanOrEqual(viewport.height);
    expect(before.width).toBeLessThanOrEqual(viewport.width);
    await wrap.hover();
    await page.mouse.wheel(0, 600);
    await expect
      .poll(() => wrap.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(100);
    const after = await geometry();
    expect(after.scrollY).toBe(0);
    expect(after.toolbar).toBe(before.toolbar);
    expect(after.header).toBeCloseTo(before.header, 0);
    expect(after.footer).toBeLessThanOrEqual(viewport.height);
    // Browsers may cap one wheel event to a viewport-sized movement.
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, 5000);
          return wrap.evaluate(
            (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
          );
        },
        { intervals: [100] },
      )
      .toBeLessThanOrEqual(1);
    await page.mouse.wheel(0, 5000);
    expect((await geometry()).scrollY).toBe(0);
    await expect(page.locator("tbody tr")).toHaveCount(120);
    await expect(
      page.getByRole("button", { name: /^(Next|Previous)$/ }),
    ).toHaveCount(0);
    expect(
      await wrap.evaluate((node) =>
        node.contains(document.querySelector("thead")),
      ),
    ).toBe(false);
    expect((await geometry()).header).toBeCloseTo(before.header, 0);
    await page.getByText("Columns", { exact: true }).click();
    await expect(
      page.getByRole("searchbox", { name: "Search columns", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("searchbox", { name: "Search columns", exact: true })
      .press("Escape");
    await page.locator(".run-filter-control summary").click();
    await expect(page.locator(".run-filter-control details")).toHaveAttribute(
      "open",
      "",
    );
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("navigation", { name: "Experiment views" }),
    ).toBeVisible();
    expect((await geometry()).scrollY).toBe(0);
  });
}

test("Run drag reveals the name without sorting, selecting or replacing status controls; widths survive refresh and routes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await fixture(page);
  const resize = handle(page, "name");
  const clipping = () =>
    page
      .locator(".run-link")
      .first()
      .evaluate((node) => node.scrollWidth - node.clientWidth);
  const clipped = await clipping();
  expect(clipped).toBeGreaterThan(0);
  await page.locator(".run-table-scroll").evaluate((node) => {
    node.scrollTop = 120;
  });
  await page.evaluate(() => {
    (window as any).__statusBefore = document.querySelector(
      ".run-status-control",
    );
  });
  await drag(page, resize, 620);
  expect(await columnWidth(resize)).toBeCloseTo(860, 0);
  expect(await clipping()).toBeLessThan(clipped);
  expect(
    await page.evaluate(() => (window as any).__runLayout.state.sort),
  ).toBe("name");
  expect(
    await page.evaluate(() => (window as any).__runLayout.state.descending),
  ).toBe(false);
  expect(
    await page.evaluate(() => (window as any).__runLayout.selections),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.querySelector(".run-status-control") ===
        (window as any).__statusBefore,
    ),
  ).toBe(true);
  expect(
    await page.locator(".run-table-scroll").evaluate((node) => node.scrollTop),
  ).toBe(120);
  const width = await columnWidth(resize);
  await page.evaluate(() => (window as any).__runLayout.tick());
  expect(await columnWidth(resize)).toBe(width);
  await page.locator('.sort-button[data-sort-key="name"]').click();
  expect(
    await page.evaluate(() => (window as any).__runLayout.state.descending),
  ).toBe(true);
  expect(await columnWidth(resize)).toBe(width);
  const search = page.getByRole("searchbox", {
    name: "Search runs, parameters or tags",
    exact: true,
  });
  await search.fill("Candidate 00");
  await expect(page.locator("tbody tr")).toHaveCount(10);
  expect(await columnWidth(resize)).toBe(width);
  await search.fill("");
  await page.getByRole("button", { name: "Charts", exact: true }).click();
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeGreaterThan(800);
  await page.getByRole("button", { name: "Back from charts" }).click();
  expect(await columnWidth(resize)).toBe(width);
  await page.locator(".run-link").first().click();
  await page.getByRole("button", { name: "Back from detail" }).click();
  expect(await columnWidth(resize)).toBe(width);
  expect(await page.evaluate(() => scrollY)).toBe(0);
});

test("added metric and exact parameter paths resize independently and persist when toggled", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await fixture(page);
  await page.getByText("Columns", { exact: true }).click();
  const keys = ["validation/quality", '$["train.lr"]', '$["train"]["lr"]'];
  for (const key of keys)
    await page.getByRole("checkbox", { name: key, exact: true }).check();
  await page
    .getByRole("searchbox", { name: "Search columns", exact: true })
    .press("Escape");
  const fields = [
    "status",
    "created_at",
    "metric:validation/quality",
    ...keys.slice(1).map((key) => `parameter:${key}`),
  ];
  const expected: Record<string, number> = {};
  for (const [index, key] of fields.entries()) {
    const separator = handle(page, key);
    await separator.focus();
    const before = await columnWidth(separator);
    await separator.press("ArrowRight");
    if (index % 2) await separator.press("ArrowRight");
    expected[key] = before + (index % 2 ? 32 : 16);
    expect(await columnWidth(separator)).toBeCloseTo(expected[key], 0);
  }
  // Exercise pointer resizing on an added metric as well as the Run column.
  await drag(page, handle(page, "metric:validation/quality"), 70);
  expected["metric:validation/quality"] += 70;
  await page.evaluate(() => (window as any).__runLayout.tick());
  await page.getByText("Columns", { exact: true }).click();
  await page.getByRole("checkbox", { name: keys[1], exact: true }).uncheck();
  await page.getByRole("checkbox", { name: keys[1], exact: true }).check();
  await page
    .getByRole("searchbox", { name: "Search columns", exact: true })
    .press("Escape");
  for (const [key, width] of Object.entries(expected))
    expect(await columnWidth(handle(page, key))).toBeCloseTo(width, 0);
  expect(
    await page.evaluate(() => (window as any).__runLayout.state.sort),
  ).toBe("name");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1440);
  const literal = handle(page, `parameter:${keys[1]}`);
  await literal.focus();
  await literal.press("Home");
  expect(await columnWidth(literal)).toBeCloseTo(200, 0);
  expect(await columnWidth(handle(page, `parameter:${keys[2]}`))).toBeCloseTo(
    expected[`parameter:${keys[2]}`],
    0,
  );
});

test("mobile defaults yield to custom widths across viewport changes; cancellation restores widths and releases capture", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await fixture(page);
  const resize = handle(page, "name");
  expect(await columnWidth(resize)).toBeCloseTo(180, 0);
  await drag(page, resize, 80);
  expect(await columnWidth(resize)).toBeCloseTo(260, 0);
  await page.setViewportSize({ width: 1200, height: 450 });
  expect(await columnWidth(resize)).toBeCloseTo(260, 0);
  await drag(page, resize, 90, false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await columnWidth(resize)).toBeCloseTo(260, 0);
  await drag(page, resize, 70, false);
  await resize.evaluate((node) =>
    node.dispatchEvent(
      new PointerEvent("pointercancel", {
        pointerId: (window as any).__runLayout.pointerId,
        bubbles: true,
      }),
    ),
  );
  await page.mouse.up();
  expect(await columnWidth(resize)).toBeCloseTo(260, 0);
  await expect(page.locator(".is-column-resizing")).toHaveCount(0);
  await drag(page, resize, 70, false);
  await resize.evaluate((node) =>
    node.releasePointerCapture((window as any).__runLayout.pointerId),
  );
  await page.mouse.up();
  expect(await columnWidth(resize)).toBeCloseTo(260, 0);
  await resize.press("Home");
  expect(await columnWidth(resize)).toBeCloseTo(240, 0);
  await page.setViewportSize({ width: 390, height: 600 });
  await expect.poll(() => columnWidth(resize)).toBeCloseTo(180, 0);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeLessThanOrEqual(600);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await drag(page, resize, 60, false);
  await page.evaluate(() => (window as any).__runLayout.destroy());
  await page.mouse.up();
  await expect(page.locator(".is-column-resizing")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as any).__runLayout.state.columnWidths.name,
    ),
  ).toBeUndefined();
  await page.evaluate(() => (window as any).__runLayout.show());
  expect(await columnWidth(resize)).toBeCloseTo(180, 0);
});

test("very wide Run columns scroll aside without obscuring other fields", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await fixture(page);
  const resize = handle(page, "name");
  await expect(resize).not.toHaveAttribute("title");
  await resize.focus();
  for (let i = 0; i < 12; i++) await resize.press("Shift+ArrowRight");
  await expect(page.locator(".run-table")).toHaveClass(/run-name-unpinned/);
  const wrap = page.locator(".run-table-scroll");
  await wrap.evaluate((node) => {
    node.scrollLeft = node.scrollWidth;
  });
  await expect(handle(page, "created_at")).toBeInViewport();
  expect(
    await handle(page, "created_at").evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return (
        document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        ) === node
      );
    }),
  ).toBe(true);
  await wrap.evaluate((node) => {
    node.scrollLeft = 0;
  });
  await resize.press("Home");
  await expect(page.locator(".run-table")).not.toHaveClass(/run-name-unpinned/);
});

test("all filtered rows render, default tracks fill the viewport, and explicit widths stay exact", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await fixture(page);
  const table = page.getByRole("table", { name: "Runs", exact: true });
  await expect(table).toHaveCount(1);
  await expect(table.getByRole("columnheader")).toHaveCount(5);
  await expect(table.getByRole("row")).toHaveCount(121);
  await page
    .getByRole("searchbox", {
      name: "Search runs, parameters or tags",
      exact: true,
    })
    .fill("Candidate 0");
  await expect(table.locator("tbody tr")).toHaveCount(100);
  await expect(page.locator(".table-summary")).toContainText("100 matching");
  await expect(
    page.getByRole("button", { name: /^(Next|Previous)$/ }),
  ).toHaveCount(0);
  await page.getByText("Columns", { exact: true }).click();
  await page.getByRole("checkbox", { name: "loss", exact: true }).uncheck();
  await page
    .getByRole("searchbox", { name: "Search columns", exact: true })
    .press("Escape");
  const measure = () =>
    table.evaluate((node) => {
      const head = node.querySelector("thead")!;
      const body = node.querySelector("tbody")!;
      const headers = [...head.querySelectorAll("th")].map((n) =>
        n.getBoundingClientRect(),
      );
      const cells = [...body.querySelector("tr")!.children].map((n) =>
        n.getBoundingClientRect(),
      );
      return {
        available: body.clientWidth,
        headerWidth: head.querySelector("tr")!.getBoundingClientRect().width,
        rowWidth: body.querySelector("tr")!.getBoundingClientRect().width,
        aligned: headers.every(
          (r, i) =>
            Math.abs(r.width - cells[i].width) < 1 &&
            Math.abs(r.x - cells[i].x) < 1,
        ),
        rule: getComputedStyle(body.querySelector("td:nth-child(2)")!)
          .borderRightWidth,
        sameParent: head.parentElement === body.parentElement,
      };
    });
  await expect.poll(async () => (await measure()).aligned).toBe(true);
  let geometry = await measure();
  expect(geometry.headerWidth).toBeGreaterThanOrEqual(geometry.available);
  expect(geometry.rowWidth).toBeGreaterThanOrEqual(geometry.available);
  expect(geometry.rule).toBe("0px");
  expect(geometry.sameParent).toBe(true);
  const resize = handle(page, "created_at");
  const before = await columnWidth(resize);
  await resize.focus();
  await resize.press("ArrowLeft");
  expect(await columnWidth(resize)).toBeCloseTo(before - 16, 0);
  await page.evaluate(() => (window as any).__runLayout.tick());
  expect(await columnWidth(resize)).toBeCloseTo(before - 16, 0);
  expect(
    await page.evaluate(() =>
      Object.keys((window as any).__runLayout.state.columnWidths),
    ),
  ).toEqual(["created_at"]);
  await page.setViewportSize({ width: 800, height: 360 });
  expect(await columnWidth(resize)).toBeCloseTo(before - 16, 0);
  await table.locator("tbody").evaluate((node) => {
    node.scrollLeft = 200;
    node.scrollTop = node.scrollHeight;
  });
  await expect.poll(async () => (await measure()).aligned).toBe(true);
  await expect(page.locator(".table-more-below")).toBeHidden();
  await table.locator("tbody").evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(page.locator(".table-more-below")).toBeVisible();
});

test("shrinking the trailing default column moves its boundary and leaves trailing fill", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await fixture(page);
  await page.getByText("Columns", { exact: true }).click();
  await page.getByRole("checkbox", { name: "loss", exact: true }).uncheck();
  await page
    .getByRole("searchbox", { name: "Search columns", exact: true })
    .press("Escape");
  const resize = handle(page, "created_at");
  const boundary = () =>
    resize.evaluate((node) => node.getBoundingClientRect().right);
  const beforeWidth = await columnWidth(resize);
  const beforeBoundary = await boundary();
  const statusWidth = await columnWidth(handle(page, "status"));
  await drag(page, resize, -100, false);
  expect(await columnWidth(resize)).toBeCloseTo(beforeWidth - 100, 0);
  expect(await boundary()).toBeCloseTo(beforeBoundary - 100, 0);
  expect(await columnWidth(handle(page, "status"))).toBe(statusWidth);
  await page.mouse.up();
  expect(await boundary()).toBeCloseTo(beforeBoundary - 100, 0);
  await page.evaluate(() => (window as any).__runLayout.tick());
  expect(await boundary()).toBeCloseTo(beforeBoundary - 100, 0);
  await resize.press("ArrowLeft");
  expect(await boundary()).toBeCloseTo(beforeBoundary - 116, 0);
  await resize.press("Home");
  expect(await boundary()).toBeCloseTo(beforeBoundary, 0);
  await drag(page, resize, -100, false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await boundary()).toBeCloseTo(beforeBoundary, 0);
  expect(await columnWidth(resize)).toBeCloseTo(beforeWidth, 0);

  // Even when every field is custom, rows fill the viewport without stretching
  // any saved width; the unused portion is a trailing, non-column area.
  await page.evaluate(() => {
    (window as any).__runLayout.state.columnWidths = {
      name: 240,
      status: 120,
      created_at: 176,
    };
    (window as any).__runLayout.show();
  });
  for (const [key, width] of [
    ["name", 240],
    ["status", 120],
    ["created_at", 176],
  ] as const)
    expect(await columnWidth(handle(page, key))).toBe(width);
  const geometry = await page.locator(".run-table").evaluate((node) => ({
    available: node.querySelector("tbody")!.clientWidth,
    row: node.querySelector("tbody tr")!.getBoundingClientRect().width,
    header: node.querySelector("thead tr")!.getBoundingClientRect().width,
    finalCell: node
      .querySelector("tbody tr td:last-child")!
      .getBoundingClientRect().right,
    rowRight: node.querySelector("tbody tr")!.getBoundingClientRect().right,
  }));
  expect(geometry.row).toBe(geometry.available);
  expect(geometry.header).toBe(geometry.available);
  expect(geometry.rowRight - geometry.finalCell).toBeGreaterThan(100);
});
