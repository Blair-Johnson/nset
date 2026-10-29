import { readFile, writeFile } from "node:fs/promises";
import {
  expect,
  test,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import { newChart } from "../src/workspace";
import type { CatalogSeries, Workspace } from "../src/workspace-types";

// Record pre-fix counts without disabling fixture/protocol/preservation checks.
// NSET_TEST_PORT=4201 NSET_DEMAND_BASELINE=1 npx playwright test tests/dashboard-demand.spec.ts --workers=1
const baseline = process.env.NSET_DEMAND_BASELINE === "1";
const viewId = "server:00000000-0000-0000-0000-000000000240";
const cardId = (section: number, index: number) => `demand-${section}-${index}`;
const keyFor = (section: number, index: number) =>
  `section_${section}/key_${index}`;
const firstIds = [cardId(0, 0), cardId(0, 1)];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
type History = { runId: string; key: string; after: string | null };
type Probe = { rafCallbacks: number; canvasesCreated: number };

/** Real index.html/main.ts/MetricStore/ChartCard/ImagePanel; only HTTP is mocked.
 * All 240 authored keys exist on dense. Sparse has one key. The second relevant
 * sparse chart is an explicit dense source, independent of drawer selection.
 */
async function fixture(
  page: Page,
  selected: "sparse" | "dense",
  folded: boolean,
) {
  const workspace: Workspace = {
    version: 2,
    id: viewId,
    experimentId: "demand",
    name: "Dashboard demand fixture",
    selectedRunIds: [selected],
    updatedAt: 1,
    sections: Array.from({ length: 30 }, (_, section) => ({
      id: `section-${section}`,
      title: `Section ${String(section).padStart(2, "0")}`,
      collapsed: folded,
      cards: Array.from({ length: 8 }, (_, index) => {
        const card = newChart(index >= 6 ? "image" : "timeseries", [
          keyFor(section, index),
        ]);
        card.id = cardId(section, index);
        card.layout = { width: 300, height: 240 };
        if (section === 0 && index === 1)
          card.source = {
            mode: "explicit",
            series: [{ runId: "dense", key: keyFor(0, 1), kind: "metric" }],
          };
        return card;
      }),
    })),
  };
  const runs = ["sparse", "dense"].map((id) => ({
    id,
    name: id === "sparse" ? "Sparse run" : "Dense run",
    experiment_id: "demand",
    status: "running",
    params: {},
    tags: {},
    created_at: 1,
    updated_at: 1,
  }));
  const summary = (
    runId: string,
    section: number,
    index: number,
  ): CatalogSeries => ({
    run_id: runId,
    key: keyFor(section, index),
    kind: index >= 6 ? "image" : "metric",
    count: 2,
    last_step: 1,
    last_timestamp: 2,
    last_value: index >= 6 ? null : 0.5,
  });
  const series = [
    summary("sparse", 0, 0),
    ...workspace.sections.flatMap((section, i) =>
      section.cards.map((_, j) => summary("dense", i, j)),
    ),
  ];
  const histories: History[] = [];
  const imageMetadata: string[] = [];
  const imageContent: string[] = [];
  const requests: string[] = [];
  const unexpected: string[] = [];
  const polls: Route[] = [];
  let catalogRequests = 0;
  let imageFrameCount = 1;
  const json = (route: Route, body: unknown) => route.fulfill({ json: body });
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.addInitScript(() => {
    sessionStorage.setItem("nset.token", "test");
    const probe: Probe = { rafCallbacks: 0, canvasesCreated: 0 };
    (window as unknown as { demandProbe: Probe }).demandProbe = probe;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        probe.rafCallbacks++;
        callback(time);
      });
    const create = document.createElement.bind(document);
    document.createElement = ((...args: Parameters<typeof create>) => {
      if (String(args[0]).toLowerCase() === "canvas") probe.canvasesCreated++;
      return create(...args);
    }) as typeof document.createElement;
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    requests.push(`${request.method()} ${path}${url.search}`);
    if (path === "/api/live") {
      if (request.method() === "GET") return json(route, { cursor: "live:0" });
      // Hold idle long polls: returning immediate empty replies creates a hot loop.
      polls.push(route);
      return;
    }
    if (path === "/api/catalog") {
      catalogRequests++;
      return json(route, {
        experiments: [
          { id: "demand", name: "Demand experiment", created_at: 1 },
        ],
        runs,
        series,
        metric_seq: 2,
      });
    }
    if (path === "/api/views")
      return json(route, {
        views: [
          {
            id: viewId,
            name: workspace.name,
            experimentId: "demand",
            revision: 1,
            updatedAt: 1,
          },
        ],
      });
    if (path === `/api/views/${viewId}` && request.method() === "GET") {
      if (url.searchParams.get("revision") === "1")
        return route.fulfill({ status: 204 });
      return json(route, { id: viewId, revision: 1, workspace });
    }
    const metrics = path.match(/^\/api\/runs\/(sparse|dense)\/metrics$/);
    if (metrics) {
      const runId = metrics[1],
        key = url.searchParams.get("key")!;
      histories.push({ runId, key, after: url.searchParams.get("after") });
      const available = series.some(
        (s) => s.run_id === runId && s.key === key && s.kind === "metric",
      );
      return json(route, {
        points: available
          ? [0, 1].map((step) => ({
              seq: step + 1,
              step,
              timestamp: step + 1,
              value: 1 - step / 2,
            }))
          : [],
        snapshot: 2,
        total: available ? 2 : 0,
        next_after: null,
      });
    }
    const images = path.match(/^\/api\/runs\/(sparse|dense)\/images$/);
    if (images) {
      imageMetadata.push(images[1]);
      return json(route, {
        images: series
          .filter((s) => s.run_id === images[1] && s.kind === "image")
          .flatMap((s, i) =>
            Array.from({ length: imageFrameCount }, (_, step) => ({
              id: step === 0 ? `frame-${i}` : `frame-${i}-step-${step}`,
              run_id: s.run_id,
              key: s.key,
              step,
              timestamp: step + 1,
              content_type: "image/png",
              byte_length: png.length,
            })),
          ),
      });
    }
    if (/^\/api\/images\/[^/]+\/content$/.test(path)) {
      imageContent.push(path);
      return route.fulfill({ contentType: "image/png", body: png });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({
      status: 404,
      json: { error: `Unexpected API: ${path}` },
    });
  });
  await page.goto(`/#/views/${encodeURIComponent(viewId)}`);
  await expect(page.locator(".workspace-view-control")).toContainText(
    workspace.name,
  );
  await expect(page.locator("#connection")).toHaveText("Connected");
  return {
    workspace,
    histories,
    imageMetadata,
    imageContent,
    requests,
    unexpected,
    addImageFrameWithoutHint() {
      imageFrameCount++;
    },
    async publishNewSeries() {
      series.push(summary("sparse", 0, 2));
      const before = catalogRequests;
      await expect.poll(() => polls.length).toBeGreaterThan(0);
      await json(polls.shift()!, {
        cursor: "live:1",
        reset: false,
        changes: [{ kind: "catalog" }],
      });
      await expect.poll(() => catalogRequests).toBeGreaterThan(before);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const materializedIds = (page: Page) =>
  page
    .locator(".dashboard-cell[data-card-id]")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.cardId!).sort(),
    );
const historyIds = (f: Fixture) =>
  [...new Set(f.histories.map((h) => `${h.runId}:${h.key}`))].sort();
const sparseHistory = [
  `sparse:${keyFor(0, 0)}`,
  `dense:${keyFor(0, 1)}`,
].sort();

async function diagnostic(
  page: Page,
  f: Fixture,
  info: TestInfo,
  phase: string,
  interactionMs?: number,
) {
  // A fixed observation window is evidence, not a timing pass/fail threshold.
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => ({
    ...(window as unknown as { demandProbe: Probe }).demandProbe,
    started: performance.now(),
  }));
  const requestStart = f.requests.length;
  await page.waitForTimeout(500);
  const counts = await page.evaluate((before) => {
    const probe = (window as unknown as { demandProbe: Probe }).demandProbe;
    return {
      domNodes: document.querySelectorAll("*").length,
      materializedCards: document.querySelectorAll(
        ".dashboard-cell[data-card-id]",
      ).length,
      canvases: document.querySelectorAll("#dashboard canvas").length,
      viewers: document.querySelectorAll("#dashboard .openseadragon-container")
        .length,
      canvasesCreated: probe.canvasesCreated,
      rafCallbacks: probe.rafCallbacks - before.rafCallbacks,
      observationMs: performance.now() - before.started,
    };
  }, before);
  const report = {
    kind: "dashboard-demand",
    phase,
    baseline,
    definitions: { sections: 30, cards: 240, scalarCards: 180, imageCards: 60 },
    ...counts,
    interactionMs,
    requests: {
      total: f.requests.length,
      settledWindow: f.requests.length - requestStart,
      histories: f.histories,
      imageMetadata: f.imageMetadata,
      imageContent: f.imageContent,
      all: f.requests,
      unexpected: f.unexpected,
    },
  };
  console.log(JSON.stringify(report));
  const path = info.outputPath(`${phase}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  await info.attach(`${phase}.json`, { path, contentType: "application/json" });
  expect(f.unexpected).toEqual([]);
  return counts;
}

async function demandIds(page: Page, ids: string[]) {
  if (!baseline)
    await expect.poll(() => materializedIds(page)).toEqual([...ids].sort());
}
async function expandFirst(page: Page) {
  const toggle = page.locator('[data-section-id="section-0"] .section-toggle');
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const start = performance.now();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return performance.now() - start;
}
async function definitionsPreserved(page: Page, f: Fixture) {
  // Export the actual active draft, not our server's immutable input object.
  const downloaded = page.waitForEvent("download");
  await page.getByLabel("View actions", { exact: true }).click();
  await page.getByRole("button", { name: "Export view", exact: true }).click();
  const exported: Workspace = JSON.parse(
    await readFile((await (await downloaded).path())!, "utf8"),
  );
  expect(exported.sections.map(({ cards }) => cards)).toEqual(
    f.workspace.sections.map(({ cards }) => cards),
  );
  expect(exported.sections).toHaveLength(30);
}

test("sparse startup omits known-empty cards without deleting definitions or explicit sources", async ({
  page,
}, info) => {
  const f = await fixture(page, "sparse", false);
  await expect(
    page.locator(`[data-card-id="${firstIds[0]}"] canvas`),
  ).toHaveCount(1);
  const counts = await diagnostic(page, f, info, "sparse-open-startup");
  await demandIds(page, firstIds);
  if (!baseline) {
    expect(counts.materializedCards).toBeLessThanOrEqual(2);
    expect(counts.canvases).toBeLessThanOrEqual(2);
    expect(counts.viewers).toBe(0);
    expect(historyIds(f)).toEqual(sparseHistory);
    expect(f.histories).toHaveLength(2);
    expect(f.imageMetadata).toEqual([]);
    expect(f.imageContent).toEqual([]);
  }
  await definitionsPreserved(page, f);
});

for (const selected of ["sparse", "dense"] as const) {
  test(`${selected}: initially folded sections allocate no viewers or histories; expanding one is bounded`, async ({
    page,
  }, info) => {
    const f = await fixture(page, selected, true);
    const initial = await diagnostic(
      page,
      f,
      info,
      `${selected}-folded-startup`,
    );
    await demandIds(page, []);
    if (!baseline) {
      expect(initial.canvases).toBe(0);
      expect(initial.viewers).toBe(0);
      expect(f.histories).toEqual([]);
      expect(f.imageMetadata).toEqual([]);
      expect(f.imageContent).toEqual([]);
    }
    const elapsed = await expandFirst(page);
    await expect(
      page.locator(`[data-card-id="${firstIds[0]}"] canvas`),
    ).toHaveCount(1);
    const ids =
      selected === "sparse"
        ? firstIds
        : Array.from({ length: 8 }, (_, i) => cardId(0, i));
    await diagnostic(page, f, info, `${selected}-one-expanded`, elapsed);
    await demandIds(page, ids);
    if (!baseline) {
      const expected =
        selected === "sparse"
          ? sparseHistory
          : Array.from({ length: 6 }, (_, i) => `dense:${keyFor(0, i)}`).sort();
      expect(historyIds(f)).toEqual(expected);
      expect(f.histories).toHaveLength(expected.length);
      expect(f.imageMetadata.every((id) => id === "dense")).toBe(true);
      await expect(page.locator("#dashboard canvas")).toHaveCount(
        selected === "dense" ? 8 : 2,
      );
      await expect(
        page.locator("#dashboard .openseadragon-container"),
      ).toHaveCount(selected === "dense" ? 2 : 0);
      if (selected === "sparse") {
        expect(f.imageMetadata).toEqual([]);
        expect(f.imageContent).toEqual([]);
      } else {
        expect(f.imageMetadata.length).toBeGreaterThan(0);
        expect(new Set(f.imageContent).size).toBe(2);
      }
    }
    await definitionsPreserved(page, f);
  });
}

test("selection restores and removes matching cards; live catalog revives a formerly empty chart", async ({
  page,
}, info) => {
  const f = await fixture(page, "sparse", true);
  await expandFirst(page);
  await demandIds(page, firstIds);
  const dense = page.getByRole("checkbox", {
    name: "Show Dense run",
    exact: true,
  });
  const sparse = page.getByRole("checkbox", {
    name: "Show Sparse run",
    exact: true,
  });
  const started = performance.now();
  await dense.check();
  await demandIds(
    page,
    Array.from({ length: 8 }, (_, i) => cardId(0, i)),
  );
  await diagnostic(
    page,
    f,
    info,
    "selection-dense-added",
    performance.now() - started,
  );
  await dense.uncheck();
  await demandIds(page, firstIds);
  await sparse.uncheck();
  await demandIds(page, [cardId(0, 1)]); // Explicit reference still resolves with no selected run.
  await sparse.check();
  await demandIds(page, firstIds);
  const beforeLive = f.histories.length;
  await f.publishNewSeries();
  await expect(
    page.locator(`[data-card-id="${cardId(0, 2)}"] canvas`),
  ).toHaveCount(1);
  await diagnostic(page, f, info, "live-series-arrived");
  await demandIds(page, [...firstIds, cardId(0, 2)]);
  if (!baseline) {
    expect(f.histories.slice(beforeLive)).toEqual([
      { runId: "sparse", key: keyFor(0, 2), after: null },
    ]);
    expect(f.histories.every((h) => h.key.startsWith("section_0/"))).toBe(true);
  }
  await definitionsPreserved(page, f);
});

test("opened dense section becomes idle when folded and preserves state on reopen", async ({
  page,
}, info) => {
  const f = await fixture(page, "dense", true);
  await expandFirst(page);
  const scalarSelector = Array.from(
    { length: 6 },
    (_, i) => `[data-card-id="${cardId(0, i)}"] canvas`,
  ).join(", ");
  const scalars = page.locator(scalarSelector);
  await expect(scalars).toHaveCount(6);
  const scalarCanvases = await scalars.elementHandles();
  const images = [6, 7].map((i) =>
    page.locator(`[data-card-id="${cardId(0, i)}"]`),
  );
  const waitForImages = async () => {
    for (const image of images) {
      // Frame info is committed only after decoded tiles are ready, not merely
      // when the HTTP response or viewer container has been created.
      await expect(image.locator(".frame-info")).toHaveAttribute(
        "data-step",
        "0",
      );
      await expect(image.locator(".image-frame-status")).toHaveText("");
      await expect(image.locator(".image-canvas")).toHaveAttribute(
        "data-zoom",
        /\d/,
      );
    }
  };
  await waitForImages();
  await expect.poll(() => new Set(f.imageContent).size).toBe(2);
  if (!baseline) {
    await expect.poll(() => f.histories.length).toBe(6);
    expect(historyIds(f)).toEqual(
      Array.from({ length: 6 }, (_, i) => `dense:${keyFor(0, i)}`).sort(),
    );
  }

  // Exercise a non-home camera through the actual toolbar, not viewer internals.
  const viewport = images[0].locator(".image-canvas");
  const homeZoom = Number(await viewport.getAttribute("data-zoom"));
  await images[0]
    .getByRole("button", { name: "Zoom out", exact: true })
    .click();
  await expect
    .poll(async () => Number(await viewport.getAttribute("data-zoom")))
    .toBeCloseTo(homeZoom / 1.5, 5);
  const camera = await viewport.evaluate((node) => {
    const { zoom, centerX, centerY } = (node as HTMLElement).dataset;
    return [Number(zoom), Number(centerX), Number(centerY)];
  });
  const frames = await Promise.all(
    images.map((image) => image.locator(".frame-info").textContent()),
  );
  for (const image of images)
    await expect(
      image.locator('button[aria-label="Play image timeline"]'),
    ).not.toHaveAttribute("aria-pressed", "true");

  const historyCount = f.histories.length;
  const toggle = page.locator('[data-section-id="section-0"] .section-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  for (const image of images) await expect(image).toBeHidden();
  // Let one-shot layout/observer work drain. diagnostic then records a separate
  // 500 ms window; it must see no recurring OSD or scalar animation callbacks.
  await page.waitForTimeout(300);
  const folded = await diagnostic(page, f, info, "dense-opened-then-folded");
  if (!baseline) {
    expect(folded.rafCallbacks).toBe(0);
    expect(f.histories).toHaveLength(historyCount);
  }

  await expandFirst(page);
  await expect(scalars).toHaveCount(6);
  await waitForImages();
  for (const [index, canvas] of scalarCanvases.entries()) {
    expect(
      await scalars
        .nth(index)
        .evaluate((node, original) => node === original, canvas),
    ).toBe(true);
    await canvas.dispose();
  }
  for (const [index, image] of images.entries()) {
    await expect(image.locator(".frame-info")).toHaveText(frames[index]!);
    await expect(
      image.locator('button[aria-label="Play image timeline"]'),
    ).not.toHaveAttribute("aria-pressed", "true");
  }
  for (const [index, attribute] of [
    "data-zoom",
    "data-center-x",
    "data-center-y",
  ].entries())
    await expect
      .poll(async () => Number(await viewport.getAttribute(attribute)))
      .toBeCloseTo(camera[index], 5);
  await diagnostic(page, f, info, "dense-folded-then-reopened");
  // Observe the reopened state long enough to catch unintended playback startup.
  for (const [index, image] of images.entries()) {
    await expect(image.locator(".frame-info")).toHaveText(frames[index]!);
    await expect(
      image.locator('button[aria-label="Play image timeline"]'),
    ).not.toHaveAttribute("aria-pressed", "true");
  }
});

for (const folded of [false, true]) {
  test(`explicit Refresh revalidates image metadata without a live hint (folded=${folded})`, async ({
    page,
  }) => {
    const f = await fixture(page, "dense", true);
    await expandFirst(page);
    const image = page.locator(`[data-card-id="${cardId(0, 6)}"]`);
    const info = image.locator(".frame-info");
    await expect(info).toHaveAttribute("data-step", "0");
    const viewer = await image
      .locator(".openseadragon-container")
      .elementHandle();
    const timeline = image.getByRole("slider", {
      name: "Image frame timeline",
      includeHidden: true,
    });
    await expect(timeline).toHaveAttribute("max", "0");
    const toggle = page.locator(
      '[data-section-id="section-0"] .section-toggle',
    );
    if (folded) {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
    }
    const requestsBefore = f.imageMetadata.length;
    f.addImageFrameWithoutHint();
    await page.locator("#refresh").click();
    await expect(page.locator("#refresh")).toBeEnabled();
    if (folded) {
      await page.waitForTimeout(300);
      expect(f.imageMetadata.length).toBe(requestsBefore);
      await expandFirst(page);
    }
    await expect(timeline).toHaveAttribute("max", "1");
    await expect(info).toHaveAttribute("data-step", "0");
    expect(
      await image
        .locator(".openseadragon-container")
        .evaluate((node, old) => node === old, viewer),
    ).toBe(true);
    await viewer?.dispose();
    expect(f.unexpected).toEqual([]);
  });
}
