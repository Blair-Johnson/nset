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
    "Event #1 - config - 2026-10-01T00:00:01Z",
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

test("oversized descendant paths truncate the added preview without changing raw evidence", async ({
  page,
}) => {
  const value = {
    config: {
      ["x".repeat(200000)]: Object.fromEntries(
        Array.from({ length: 999 }, (_, i) => [`f${i}`, i]),
      ),
      safe: 7,
    },
  };
  const stored = JSON.stringify(value);
  expect(Buffer.byteLength(stored)).toBeLessThan(256 * 1024);
  await fixture(page, async (route, request) => {
    if (!request.path.endsWith("/records")) return false;
    await route.fulfill({
      json: result({ records: [{ ...record("1"), data: value, raw: stored }] }),
    });
    return true;
  });
  await inspect(page, "config");
  const section = await add(page, "config");
  await expect(section).toContainText("4,096 path bytes");
  await expect(section.locator(".run-config-row")).toHaveCount(2);
  await expect(
    section.locator('[data-source-path=\'$["config"]["safe"]\']'),
  ).toContainText("7");
  expect((await section.textContent())!.length).toBeLessThan(2048);
  await section.getByRole("button", { name: "Copy raw event" }).click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe(stored);
  await section.getByText("Stored event JSON", { exact: true }).click();
  await expect(section.locator(".run-event-raw pre")).toHaveText(stored);
});

for (const teardown of ["logout", "beforeunload"] as const) {
  for (const phase of ["debounce", "fields", "records"] as const) {
    test(`production ${teardown} cancels event config ${phase} work`, async ({
      page,
    }) => {
      const calls: string[] = [];
      let release: (() => void) | undefined;
      await page.addInitScript(() => {
        const original = window.fetch.bind(window);
        (window as any).__eventRequests = [];
        window.fetch = (input, init) => {
          const path = String(input);
          if (/\/rx\/(fields|records)$/.test(path)) {
            const entry = { path, aborted: init?.signal?.aborted ?? false };
            (window as any).__eventRequests.push(entry);
            init?.signal?.addEventListener("abort", () => {
              entry.aborted = true;
            });
          }
          return original(input, init);
        };
      });
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/catalog") {
          await route.fulfill({
            json: { experiments: [], runs: [], series: [], rx_enabled: true },
          });
        } else if (path === "/api/rx/catalog") {
          await route.fulfill({
            json: {
              source: { id: "rx:fixture", name: "fixture" },
              next_after: null,
              runs: [
                {
                  id: 1,
                  run_uid: "uid-one",
                  state: "succeeded",
                  alias: null,
                  config: "fixture",
                  argv: [],
                  exit_code: 0,
                  created_at: "2026-10-01T00:00:00Z",
                  started_at: null,
                  finished_at: null,
                },
              ],
            },
          });
        } else if (path.endsWith("/fields") || path.endsWith("/records")) {
          calls.push(path);
          if (path.endsWith(`/${phase}`))
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          await route.fulfill({
            json: result({ fields: hints, records: [record("1")] }),
          });
        } else
          await route.fulfill({
            status: 404,
            json: { error: "unexpected endpoint" },
          });
      });
      try {
        await page.goto(
          "/#/experiments/rx%3Afixture/runs/rx%3Afixture%3Auid-one",
        );
        await page
          .getByLabel("Access token", { exact: true })
          .fill("fixture-token");
        await page
          .getByRole("button", { name: "Connect", exact: true })
          .click();
        await expect(search(page)).toBeVisible();
        if (phase === "debounce") {
          // Both events run in one task, before the discovery debounce can fire.
          await page.evaluate((teardown) => {
            const input = document.querySelector<HTMLInputElement>(
              '.run-config input[type="search"]',
            )!;
            input.value = "config";
            input.dispatchEvent(new Event("input", { bubbles: true }));
            if (teardown === "logout")
              document.getElementById("logout")!.click();
            else window.dispatchEvent(new Event("beforeunload"));
          }, teardown);
        } else {
          if (phase === "records") await inspect(page, "config");
          else await search(page).fill("config");
          await expect
            .poll(
              () => calls.filter((path) => path.endsWith(`/${phase}`)).length,
            )
            .toBe(1);
          if (teardown === "logout") await page.locator("#logout").click();
          else
            await page.evaluate(() =>
              window.dispatchEvent(new Event("beforeunload")),
            );
          await expect
            .poll(() =>
              page.evaluate(
                (phase) =>
                  (window as any).__eventRequests.find((r: any) =>
                    r.path.endsWith(`/${phase}`),
                  )?.aborted,
                phase,
              ),
            )
            .toBe(true);
        }
        await page.waitForTimeout(350);
        const expected =
          phase === "debounce"
            ? []
            : phase === "fields"
              ? ["/api/rx/fields"]
              : ["/api/rx/fields", "/api/rx/records"];
        expect(calls).toEqual(expected);
        expect(
          await page.evaluate(() => (window as any).__eventRequests.length),
        ).toBe(expected.length);
        if (teardown === "logout") {
          await expect(page.locator("#connection")).toHaveText("Disconnected");
          await expect(page.locator(".run-detail")).toHaveCount(0);
        }
      } finally {
        release?.();
      }
    });
  }
}

async function polishFixture(
  page: Page,
  options: { multiple?: boolean; noHints?: boolean; delay?: number } = {},
) {
  const value = {
    benchmark_args: { config: "config.yaml" },
    config: {
      callbacks: { on_step_end: ["save"] },
      data: { baseband: true },
      "a.b": "literal",
      a: { b: "nested" },
      "\u65e5\u672c\u8a9e": "caf\u00e9 \ud83d\udce1",
      safe: 42,
    },
  };
  const offered = [
    "benchmark_args.config",
    ...Array.from({ length: 45 }, (_, i) => `config.child${i}`),
    "config.callbacks",
    "config",
  ];
  const requests = await fixture(page, async (route, request) => {
    if (request.path.endsWith("/fields")) {
      if (options.delay)
        await new Promise((resolve) => setTimeout(resolve, options.delay));
      await route.fulfill({
        json: result({
          fields: options.noHints
            ? []
            : offered.map((path) => ({ ...hints[0], path })),
        }),
      });
      return true;
    }
    if (request.path.endsWith("/records")) {
      if (options.delay)
        await new Promise((resolve) => setTimeout(resolve, options.delay));
      const rows = [
        { ...record("4"), data: value, raw: JSON.stringify(value) },
      ];
      if (options.multiple) rows.push({ ...rows[0], seq: "8" });
      await route.fulfill({ json: result({ records: rows }) });
      return true;
    }
    return false;
  });
  return { value, requests };
}

test("polish: exact config ranks before prefixes and substrings even beyond the displayed page", async ({
  page,
}) => {
  await polishFixture(page);
  await search(page).fill("config");
  await expect(
    page.locator(".run-event-fields button").first(),
  ).toHaveAttribute("aria-label", "Inspect event field config");
  const labels = await page
    .locator(".run-event-fields button[aria-label]")
    .allTextContents();
  expect(labels[1]).toMatch(/^config\./);
  expect(
    labels.slice(0, 25).some((s) => s.startsWith("benchmark_args.config")),
  ).toBe(false);
});

test("polish: normal event metadata has no replacement glyphs or blanket disclaimers", async ({
  page,
}) => {
  await fixture(page);
  await inspect(page, "config");
  await add(page, "config");
  const text = await page.locator(".run-detail").textContent();
  expect(text).not.toContain("\ufffd");
  expect(text).not.toMatch(
    /Display only|display only|parsed preview|Numbers may be rounded|not run parameters|Additions last while/,
  );
  await expect(page.locator(".run-event-config")).toContainText(
    "approximate / out of range",
  );
});

for (const waitForHints of [false, true]) {
  test(`polish: Enter alone adds single exact config ${waitForHints ? "after hints" : "immediately"}`, async ({
    page,
  }) => {
    const { requests } = await polishFixture(page, { delay: 80 });
    await search(page).fill("config");
    if (waitForHints)
      await expect(
        page.locator(".run-event-fields button").first(),
      ).toBeVisible();
    await search(page).press("Enter");
    await expect(
      page.getByRole("region", { name: "config from event 4", exact: true }),
    ).toBeVisible();
    await search(page).press("Enter");
    await expect(page.locator(".run-event-config")).toHaveCount(1);
    expect(
      requests
        .filter((r) => r.path.endsWith("/records"))
        .every((r) => r.body.runs[0] === "uid-one"),
    ).toBe(true);
  });
}

test("polish: Enter skips field click but leaves repeated occurrences as an explicit choice", async ({
  page,
}) => {
  await polishFixture(page, { multiple: true });
  await search(page).fill("config");
  await search(page).press("Enter");
  await expect(
    page.getByRole("button", { name: "Add config from event 4", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add config from event 8", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".run-event-config")).toHaveCount(0);
  await add(page, "config", "8");
  await expect(page.locator(".run-event-config")).toHaveCount(1);
});

test("polish: event namespace labels match native nested config and preserve Unicode and literal keys", async ({
  page,
}) => {
  const { value } = await polishFixture(page);
  await search(page).fill("config");
  await page.getByRole("button", { name: "Show more matching fields" }).click();
  await page
    .getByRole("button", { name: "Inspect event field config", exact: true })
    .click();
  const section = await add(page, "config", "4");
  await expect(
    section.locator(
      '[data-source-path=\'$["config"]["data"]["baseband"]\'] .run-config-path',
    ),
  ).toHaveText("config.data.baseband");
  await expect(
    section.locator(
      '[data-source-path=\'$["config"]["callbacks"]["on_step_end"][0]\'] .run-config-path',
    ),
  ).toHaveText("config.callbacks.on_step_end[0]");
  await expect(
    section.locator(
      '[data-source-path=\'$["config"]["a.b"]\'] .run-config-path',
    ),
  ).toHaveText('config["a.b"]');
  await expect(
    section.locator(
      '[data-source-path=\'$["config"]["a"]["b"]\'] .run-config-path',
    ),
  ).toHaveText("config.a.b");
  await expect(section).toContainText("caf\u00e9 \ud83d\udce1");
  await section
    .getByRole("button", { name: 'Copy path $["config"]["a.b"]', exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe(
    '$["config"]["a.b"]',
  );
  await section.getByRole("button", { name: "Copy raw event" }).click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe(
    JSON.stringify(value),
  );
  const nativeLabels = await page.evaluate(async () => {
    const { renderRunConfig } = await import("/src/run-config.ts");
    const native = renderRunConfig(
      {
        config: {
          data: { baseband: true },
          callbacks: { on_step_end: ["save"] },
        },
      },
      "native",
    );
    return Array.from(
      native.querySelectorAll(".run-config-path"),
      (n) => n.textContent,
    );
  });
  const eventLabels = await section
    .locator(".run-config-path")
    .allTextContents();
  for (const label of nativeLabels) expect(eventLabels).toContain(label);
});

test("polish: Enter resolves an exact path absent from sampled hints, but never a case-folded or substring guess", async ({
  page,
}) => {
  await polishFixture(page, { noHints: true });
  await search(page).fill("config");
  await expect(
    page.getByText("No matching logged fields in this scan."),
  ).toBeVisible();
  await search(page).press("Enter");
  await expect(
    page.getByRole("region", { name: "config from event 4", exact: true }),
  ).toBeVisible();
  for (const text of ["Config", "conf"]) {
    await search(page).fill(text);
    await search(page).press("Enter");
    await expect(page.getByText("No occurrences in this page.")).toBeVisible();
    await expect(page.locator(".run-event-config")).toHaveCount(1);
  }
});

for (const incomplete of ["cursor", "partial"] as const) {
  test(`polish: Enter does not infer a unique occurrence from a ${incomplete} result`, async ({
    page,
  }) => {
    await fixture(page, async (route, request) => {
      if (!request.path.endsWith("/records")) return false;
      await route.fulfill({
        json: result({
          records: [record("1")],
          ...(incomplete === "cursor"
            ? { next_cursor: "more" }
            : {
                diagnostics: {
                  ...diagnostics,
                  partial: true,
                  reasons: ["scan budget reached"],
                },
              }),
        }),
      });
      return true;
    });
    await search(page).fill("config");
    await search(page).press("Enter");
    await expect(
      page.getByRole("button", {
        name: "Add config from event 1",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".run-event-config")).toHaveCount(0);
    if (incomplete === "partial")
      await expect(
        page.getByText("Limited scan: scan budget reached."),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("button", { name: "Next occurrences" }),
      ).toBeVisible();
  });
}

test("polish: Enter reentrancy is bounded and modifier/composition defaults are untouched", async ({
  page,
}) => {
  const { requests } = await polishFixture(page, { delay: 250 });
  await search(page).fill("config");
  const defaults = await search(page).evaluate((input) =>
    [
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
      { isComposing: true },
    ].map((modifier) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...modifier,
      });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  );
  expect(defaults).toEqual([false, false, false, false, false]);
  await search(page).press("Enter");
  await search(page).press("Enter");
  await search(page).dispatchEvent("keydown", { key: "Enter", repeat: true });
  await expect(
    page.getByRole("region", { name: "config from event 4", exact: true }),
  ).toBeVisible();
  expect(requests.filter((r) => r.path.endsWith("/records"))).toHaveLength(1);
  await expect(search(page)).toBeFocused();
  const response = page.waitForResponse((r) => r.url().endsWith("/rx/records"));
  await search(page).press("Enter");
  await response;
  await expect(page.locator(".run-event-config")).toHaveCount(1);
  await expect(search(page)).toBeFocused();
});

for (const action of ["clear", "escape", "switch", "edit"] as const) {
  test(`polish: pending Enter cannot add after ${action}`, async ({ page }) => {
    let release: (() => void) | undefined;
    const requests = await fixture(page, async (route, request) => {
      if (!request.path.endsWith("/records")) return false;
      if (request.body.filters.conditions[0].path === "config")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await route.fulfill({
        json: result({
          records: [{ ...record("1"), run_uid: request.body.runs[0] }],
        }),
      });
      return true;
    });
    try {
      await search(page).fill("config");
      await search(page).press("Enter");
      await expect
        .poll(() => requests.filter((r) => r.path.endsWith("/records")).length)
        .toBe(1);
      if (action === "clear") await search(page).fill("");
      else if (action === "escape") await search(page).press("Escape");
      else {
        if (action === "switch")
          await page.evaluate(() => (window as any).__render("uid-new"));
        await search(page).fill("scalar");
        await search(page).press("Enter");
        await expect(
          page.getByRole("region", {
            name: "scalar from event 1",
            exact: true,
          }),
        ).toBeVisible();
      }
      release?.();
      await page.waitForTimeout(300);
      await expect(
        page.getByRole("region", { name: "config from event 1", exact: true }),
      ).toHaveCount(0);
      await expect(page.locator(".run-event-config")).toHaveCount(
        action === "clear" || action === "escape" ? 0 : 1,
      );
    } finally {
      release?.();
    }
  });
}

test("polish: Enter aborts in-flight discovery without stale hints or form submission", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const requests = await fixture(page, async (route, request) => {
    if (request.path.endsWith("/fields")) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({ json: result({ fields: hints }) });
      return true;
    }
    if (request.path.endsWith("/records")) {
      await route.fulfill({ json: result({ records: [record("1")] }) });
      return true;
    }
    return false;
  });
  await page.evaluate(() => {
    const config = document.querySelector(".run-config")!;
    const form = document.createElement("form");
    form.onsubmit = (event) => {
      event.preventDefault();
      (window as any).__submitted = true;
    };
    config.before(form);
    form.append(config);
  });
  try {
    await search(page).fill("config");
    await expect
      .poll(() => requests.filter((r) => r.path.endsWith("/fields")).length)
      .toBe(1);
    await search(page).press("Enter");
    await expect(
      page.getByRole("region", { name: "config from event 1", exact: true }),
    ).toBeVisible();
    release?.();
    await page.waitForTimeout(250);
    await expect(page.locator(".run-event-fields button")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).__submitted),
    ).toBeUndefined();
  } finally {
    release?.();
  }
});

test("polish: Enter preserves Unicode root keys and values including literal replacement characters", async ({
  page,
}) => {
  const value = {
    "\u65e5\u672c\u8a9e": "caf\u00e9 \ud83d\udce1",
    "\ufffd": "literal \ufffd data",
    "a.b": 1,
    a: { b: 2 },
    Config: 3,
    config: 4,
  };
  await fixture(page, async (route, request) => {
    if (!request.path.endsWith("/records")) return false;
    await route.fulfill({
      json: result({
        records: [{ ...record("1"), data: value, raw: JSON.stringify(value) }],
      }),
    });
    return true;
  });
  for (const [query, label, expected] of [
    [
      "\u65e5\u672c\u8a9e",
      '["\u65e5\u672c\u8a9e"]',
      '"caf\u00e9 \ud83d\udce1"',
    ],
    ['["\ufffd"]', '["\ufffd"]', '"literal \ufffd data"'],
    ['$["a.b"]', '["a.b"]', "1"],
    ["a.b", "a.b", "2"],
    ["Config", "Config", "3"],
    ["config", "config", "4"],
  ]) {
    await search(page).fill(query);
    await search(page).press("Enter");
    const section = page.getByRole("region", {
      name: `${label} from event 1`,
      exact: true,
    });
    await expect(section).toBeVisible();
    await search(page).fill("");
    await expect(section.locator(".run-config-value")).toHaveText(expected);
    await expect(section.locator(".run-config-path")).toHaveText(label);
  }
  await expect(page.locator(".run-event-config")).toHaveCount(6);
});

test("polish: Unicode summary boundaries do not split surrogate pairs", async ({
  page,
}) => {
  const text = "x".repeat(158) + "\ud83d\udce1" + "tail";
  const value = {
    kind: "k".repeat(119) + "\ud83d\udce1" + "tail",
    scalar: text,
  };
  await fixture(page, async (route, request) => {
    if (!request.path.endsWith("/records")) return false;
    await route.fulfill({
      json: result({
        records: [{ ...record("1"), data: value, raw: JSON.stringify(value) }],
      }),
    });
    return true;
  });
  await inspect(page, "scalar");
  const metadata = await page.locator(".run-event-choice span").textContent();
  expect(metadata).toContain("\ud83d\udce1");
  expect(metadata).not.toContain("\ufffd");
  expect(metadata).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  const section = await add(page, "scalar");
  await expect(section.locator(".run-config-value")).toHaveText(
    JSON.stringify(text),
  );
});

test("polish: Enter retains partial discovery status and never duplicates an added descendant", async ({
  page,
}) => {
  await fixture(page, async (route, request) => {
    if (request.path.endsWith("/fields")) {
      await route.fulfill({
        json: result({
          fields: hints,
          diagnostics: {
            ...diagnostics,
            partial: true,
            reasons: ["field visit budget reached"],
          },
          next_cursor: "next",
        }),
      });
      return true;
    }
    if (request.path.endsWith("/records")) {
      await route.fulfill({ json: result({ records: [record("1")] }) });
      return true;
    }
    return false;
  });
  await search(page).fill("config");
  await expect(
    page.getByText("Limited scan: field visit budget reached."),
  ).toBeVisible();
  await search(page).press("Enter");
  await expect(
    page.getByRole("region", { name: "config from event 1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Limited scan: field visit budget reached."),
  ).toBeVisible();
  await search(page).fill("config.model");
  const response = page.waitForResponse((r) => r.url().endsWith("/rx/records"));
  await search(page).press("Enter");
  await response;
  await expect(page.locator(".run-event-config")).toHaveCount(1);
});
