import { test, expect, type Page, type Route } from "@playwright/test";

const diagnostics = {
  scanned: 2,
  matched: 2,
  bytes: 100,
  invalid_json: 0,
  oversized: 0,
  skipped_axes: 0,
  skipped_groups: 0,
  omitted_traces: 0,
  points: 0,
  partial: false,
  reasons: [],
};
const data = {
  kind: "config",
  config: {
    model: { width: 64 },
    seed: 7,
    "a.b": 1,
    a: { b: 2 },
    unsafe: 9007199254740992,
  },
  benchmark_args: { width: 128 },
  scalar: "hello",
};
const raw =
  '{"kind":"config","config":{"model":{"width":64},"seed":7,"a.b":1,"a":{"b":2},"unsafe":9007199254740993},"benchmark_args":{"width":128},"scalar":"hello"}';
const record = (seq: string, value = data) => ({
  run_uid: "uid-one",
  seq,
  received_at: `2026-10-01T00:00:0${seq}Z`,
  data: value,
  raw: seq === "1" ? raw : JSON.stringify(value),
});
const result = (extra: object = {}) => ({
  diagnostics,
  fields: [],
  records: [],
  next_cursor: null,
  coverage: "bounded",
  traces: [],
  ...extra,
});
const hints = [
  { path: "config", types: ["object"] },
  { path: "config.model", types: ["object"] },
  { path: "config.seed", types: ["number"] },
  { path: 'config["a.b"]', types: ["number"] },
  { path: "config.a.b", types: ["number"] },
  { path: "benchmark_args", types: ["object"] },
  { path: "scalar", types: ["string"] },
].map((h) => ({ ...h, values: [], present: 2 }));

type Request = {
  path: string;
  body: any;
  authorization: string | undefined;
  method: string;
};
async function fixture(
  page: Page,
  handler?: (route: Route, request: Request) => Promise<boolean>,
  native = false,
) {
  const requests: Request[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const request = {
      path: new URL(req.url()).pathname,
      body: req.postDataJSON(),
      authorization: req.headers().authorization,
      method: req.method(),
    };
    requests.push(request);
    if (handler && (await handler(route, request))) return;
    if (request.path.endsWith("/fields")) {
      await route.fulfill({
        json: result({
          fields: hints.filter((h) =>
            h.path.toLowerCase().includes(request.body.search.toLowerCase()),
          ),
        }),
      });
    } else if (request.path.endsWith("/records")) {
      await route.fulfill({
        json: result({
          records: [
            record("1"),
            record("2", {
              ...data,
              config: { ...data.config, model: { width: 96 } },
            }),
          ],
        }),
      });
    } else
      await route.fulfill({
        status: 500,
        json: { error: "Unexpected write or endpoint" },
      });
  });
  await page.route("**/__event_config_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main></main></body></html>",
    }),
  );
  await page.goto("/__event_config_fixture");
  await page.evaluate(async (native) => {
    await import("/src/style.css");
    const { renderRunDetail } = await import("/src/run-detail.ts");
    const { Api } = await import("/src/api.ts");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).__copied = text;
        },
      },
    });
    let controller: AbortController;
    (window as any).__render = (uid = "uid-one") => {
      controller?.abort();
      controller = new AbortController();
      const run = {
        id: uid,
        experiment_id: "exp",
        name: uid,
        status: "finished",
        created_at: 1,
        updated_at: 2,
        params: { native: { learning_rate: 0.1 } },
        tags: { owner: "team" },
        ...(native
          ? {}
          : { rx: { sourceId: "rx:fixture", uid, state: "completed" } }),
      };
      document.querySelector("main")!.replaceChildren(
        renderRunDetail(run, {
          api: new Api(() => "fixture-token"),
          signal: controller.signal,
          onBack: () => {},
          onTags: async (patch: Record<string, unknown>) => {
            (window as any).__patch = patch;
            return { ...run, tags: { ...run.tags, ...patch } };
          },
        }),
      );
    };
    (window as any).__render();
  }, native);
  return requests;
}
const search = (page: Page) =>
  page.getByRole("searchbox", {
    name: "Search configuration paths and values",
  });
async function inspect(page: Page, path: string, query = path) {
  await search(page).fill(query);
  await page
    .getByRole("button", { name: `Inspect event field ${path}`, exact: true })
    .click();
}
async function add(page: Page, path: string, seq = "1") {
  const b = page.getByRole("button", {
    name: `Add ${path} from event ${seq}`,
    exact: true,
  });
  await b.focus();
  await page.keyboard.press("Enter");
  return page.getByRole("region", {
    name: `${path} from event ${seq}`,
    exact: true,
  });
}

test("typing discovers this run's event objects; keyboard add expands nested config without writes", async ({
  page,
}) => {
  const requests = await fixture(page);
  await inspect(page, "config");
  const section = await add(page, "config");
  await expect(section).toContainText("64");
  await expect(section).toContainText(
    "Event #1 � config � 2026-10-01T00:00:01Z",
  );
  await expect(
    section.getByRole("button", { name: "Toggle config.model", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await section
    .getByRole("button", { name: "Toggle config.model", exact: true })
    .click();
  await expect(
    section.locator('[data-source-path=\'$["config"]["model"]["width"]\']'),
  ).toHaveCount(0);
  await section
    .getByRole("button", { name: "Toggle config.model", exact: true })
    .click();
  await expect(
    section.locator('[data-source-path=\'$["config"]["model"]["width"]\']'),
  ).toContainText("64");
  await expect(
    page.getByRole("button", {
      name: "Added config from event 1",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(page.locator(".run-event-config")).toHaveCount(1);
  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(
    section.getByRole("button", { name: "Toggle config", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(
    section.getByRole("button", { name: "Toggle config", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("button", {
      name: "Inspect event field config.model",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Added config.model from event 1",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Add config.model from event 2",
      exact: true,
    }),
  ).toBeEnabled();
  await section.getByRole("button", { name: "Copy raw event" }).click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe(raw);
  await expect(section).toContainText("approximate / out of range");
  await expect(
    section.getByRole("button", { name: /^Copy value / }),
  ).toHaveCount(0);
  await section.getByText("Stored event JSON", { exact: true }).click();
  await expect(section.locator(".run-event-raw pre")).toHaveText(raw);
  await search(page).fill("");
  await expect(
    page.locator(
      '.run-config-row[data-source-path=\'$["native"]["learning_rate"]\']',
    ),
  ).toBeVisible();
  await expect(section).toContainText("64");
  await expect(
    page.getByRole("button", { name: /^Inspect event field/ }),
  ).toHaveCount(0);
  expect(
    requests.every(
      (r) =>
        r.authorization === "Bearer fixture-token" &&
        r.body.runs.length === 1 &&
        r.body.runs[0] === "uid-one" &&
        r.method === "POST" &&
        ["/api/rx/fields", "/api/rx/records"].includes(r.path),
    ),
  ).toBeTruthy();
  await expect(page.getByRole("button", { name: "Add tag" })).toHaveCount(0);
});

test("repeated values stay distinct and benchmark overrides remain separate", async ({
  page,
}) => {
  await fixture(page);
  await inspect(page, "config");
  const first = await add(page, "config", "1");
  const second = await add(page, "config", "2");
  await expect(first).toContainText("64");
  await expect(second).toContainText("96");
  await inspect(page, "benchmark_args", "benchmark");
  const benchmark = await add(page, "benchmark_args");
  await search(page).fill("");
  await expect(benchmark).toContainText("128");
  await expect(first).toContainText("64");
  await expect(second).toContainText("96");
  await expect(page.locator(".run-event-config")).toHaveCount(3);
  await first.getByRole("button", { name: "Remove", exact: true }).click();
  await inspect(page, "config");
  await expect(
    page.getByRole("button", { name: "Add config from event 1", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", {
      name: "Added config from event 2",
      exact: true,
    }),
  ).toBeDisabled();
});

test("scalar fields and literal/nested collisions retain exact source addressing", async ({
  page,
}) => {
  await fixture(page);
  await inspect(page, "scalar");
  await expect(await add(page, "scalar")).toContainText('"hello"');
  await inspect(page, 'config["a.b"]', "a.b");
  const literal = await add(page, 'config["a.b"]');
  await inspect(page, "config.a.b", "a.b");
  const nested = await add(page, "config.a.b");
  await search(page).fill("");
  await expect(literal.locator(".run-config-value")).toHaveText("1");
  await expect(nested.locator(".run-config-value")).toHaveText("2");
  await literal
    .getByRole("button", { name: 'Copy path $["config"]["a.b"]', exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe(
    '$["config"]["a.b"]',
  );
});

test("clearing and switching runs cancels requests and ignores late results", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const requests = await fixture(page, async (route, request) => {
    if (request.path.endsWith("fields") && request.body.search === "slow") {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route
        .fulfill({ json: result({ fields: [hints[0]] }) })
        .catch(() => {});
      return true;
    }
    return false;
  });
  await search(page).fill("slow");
  await expect.poll(() => !!release).toBeTruthy();
  await search(page).fill("");
  release!();
  await expect(
    page.getByRole("button", { name: /^Inspect event field/ }),
  ).toHaveCount(0);
  await inspect(page, "config");
  await add(page, "config");
  release = undefined;
  await search(page).fill("slow");
  await expect.poll(() => !!release).toBeTruthy();
  await page.evaluate(() => (window as any).__render("uid-two"));
  release!();
  await expect(page.locator(".run-event-config")).toHaveCount(0);
  await expect(search(page)).toHaveValue("");
  await inspect(page, "scalar");
  expect(requests.at(-1)!.body.runs).toEqual(["uid-two"]);
  await expect(page.getByText("No occurrences in this page.")).toBeVisible();
});

test("bounded hint pages, scan-more, errors, and occurrence pagination are explicit", async ({
  page,
}) => {
  let fail = true;
  await fixture(page, async (route, request) => {
    if (request.path.endsWith("fields")) {
      if (fail) {
        fail = false;
        await route.fulfill({ status: 503, json: { error: "busy" } });
      } else if (request.body.cursor) await route.fulfill({ json: result() });
      else
        await route.fulfill({
          json: result({
            fields: Array.from({ length: 30 }, (_, i) => ({
              ...hints[0],
              path: `config${i}`,
            })),
            next_cursor: "next-scan",
            diagnostics: {
              ...diagnostics,
              partial: true,
              reasons: ["scan budget reached"],
            },
          }),
        });
      return true;
    }
    if (request.path.endsWith("records")) {
      await route.fulfill({
        json: result({
          records: [],
          next_cursor: request.body.cursor ? null : "next-records",
        }),
      });
      return true;
    }
    return false;
  });
  await search(page).fill("config");
  await page.getByRole("button", { name: "Retry event search" }).click();
  await expect(
    page.getByRole("button", { name: /^Inspect event field/ }),
  ).toHaveCount(25);
  await expect(
    page.getByText(/Limited scan: scan budget reached/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show more matching fields" }).click();
  await expect(
    page.getByRole("button", { name: /^Inspect event field/ }),
  ).toHaveCount(30);
  await page
    .getByRole("button", { name: "Inspect event field config0", exact: true })
    .click();
  await page.getByRole("button", { name: "Next occurrences" }).click();
  await expect(
    page.getByRole("button", { name: "Next occurrences" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Scan more events" }).click();
  await expect(
    page.getByText("No matching logged fields in this scan."),
  ).toBeVisible();
});

test("native configuration filtering and permitted tag editing stay native-only", async ({
  page,
}) => {
  const requests = await fixture(page, undefined, true);
  await expect(page.locator(".run-event-discovery")).toHaveCount(0);
  await search(page).fill("learning_rate");
  await expect(
    page.locator(".run-config-value").filter({ hasText: "0.1" }),
  ).toBeVisible();
  await search(page).fill("missing");
  await expect(
    page.getByText("No matching configuration paths or values."),
  ).toBeVisible();
  await search(page).fill("");
  await expect(page.getByRole("button", { name: "Add tag" })).toBeVisible();
  await page.getByRole("button", { name: "Add tag" }).click();
  await page
    .getByRole("textbox", { name: "Tag key", exact: true })
    .fill("purpose");
  await page
    .getByRole("textbox", { name: "Tag value", exact: true })
    .fill('"inspection"');
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__patch)).toEqual({
    purpose: "inspection",
  });
  expect(requests).toHaveLength(0);
});

test("large event trees render bounded rows and retain complete raw evidence", async ({
  page,
}) => {
  const wide = {
    config: Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [`field${i}`, i]),
    ),
  };
  const wideRaw = JSON.stringify(wide);
  await fixture(page, async (route, request) => {
    if (!request.path.endsWith("records")) return false;
    await route.fulfill({
      json: result({ records: [{ ...record("1"), data: wide, raw: wideRaw }] }),
    });
    return true;
  });
  await inspect(page, "config");
  const section = await add(page, "config");
  await expect(section.locator(".run-config-row")).toHaveCount(200);
  await expect(section).toContainText(
    "Tree preview limited to 1,000 values / 16 levels",
  );
  await section.getByRole("button", { name: "Show 200 more" }).click();
  await expect(section.locator(".run-config-row")).toHaveCount(400);
  await section.getByRole("button", { name: "Copy raw event" }).click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe(wideRaw);
});

test("occurrence pages preserve additions and cap memory-only sections", async ({
  page,
}) => {
  const requests = await fixture(page, async (route, request) => {
    if (!request.path.endsWith("records")) return false;
    const start = request.body.cursor ? Number(request.body.cursor) : 1;
    await route.fulfill({
      json: result({
        records: Array.from({ length: 5 }, (_, i) => record(String(start + i))),
        next_cursor: start < 11 ? String(start + 5) : null,
      }),
    });
    return true;
  });
  await inspect(page, "config");
  for (let i = 1; i <= 12; i++) {
    if (i === 6 || i === 11)
      await page.getByRole("button", { name: "Next occurrences" }).click();
    await add(page, "config", String(i));
  }
  await expect(page.locator(".run-event-config")).toHaveCount(12);
  await expect(
    page.getByRole("button", { name: "Add config from event 13", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("12 event fields displayed. Remove one to add another."),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "config from event 1", exact: true })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await add(page, "config", "13");
  await expect(page.locator(".run-event-config")).toHaveCount(12);
  expect(
    requests
      .filter((r) => r.path.endsWith("records"))
      .every((r) => r.body.limit === 5),
  ).toBeTruthy();
});

test("discovered escaped keys remain visible and missing clipboard offers raw-text fallback", async ({
  page,
}) => {
  const path = '$["a\\\"b"]';
  const value = { 'a"b': "escaped key value" };
  await fixture(page, async (route, request) => {
    if (request.path.endsWith("fields")) {
      await route.fulfill({
        json: result({ fields: [{ ...hints[0], path, types: ["string"] }] }),
      });
      return true;
    }
    if (request.path.endsWith("records")) {
      await route.fulfill({
        json: result({
          records: [
            { ...record("1"), data: value, raw: JSON.stringify(value) },
          ],
        }),
      });
      return true;
    }
    return false;
  });
  await inspect(page, path, 'a"b');
  const section = await add(page, path);
  await expect(section.locator(".run-config-value")).toHaveText(
    '"escaped key value"',
  );
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    }),
  );
  await section.getByRole("button", { name: "Copy raw event" }).click();
  await expect(
    section.getByText("Copy unavailable; select the stored event text below."),
  ).toBeVisible();
  await section.getByText("Stored event JSON", { exact: true }).click();
  await expect(section.locator(".run-event-raw pre")).toHaveText(
    JSON.stringify(value),
  );
  await section
    .getByRole("button", { name: `Copy path ${path}`, exact: true })
    .click();
  await expect(
    section.getByText("Copy unavailable. Select the path text."),
  ).toBeVisible();
});
