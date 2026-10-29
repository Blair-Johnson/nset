import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    // Keep demand under the test's control, not observer delivery timing.
    (window as any).IntersectionObserver = undefined;
    const { ChartCard } = await import("/src/cards.ts");
    const { newChart } = await import("/src/workspace.ts");
    const { Api } = await import("/src/api.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "blue";
    context.fillRect(0, 0, 256, 128);
    context.fillStyle = "white";
    context.fillRect(32, 16, 70, 40);
    const bytes = await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!)),
    );
    const run = {
      id: "r",
      name: "Run",
      experiment_id: "e",
      status: "finished",
      params: {},
      tags: {},
      created_at: 0,
      updated_at: 0,
    };
    const frame = (step: number, key = "a") => ({
      id: `${key}-${step}`,
      run_id: run.id,
      key,
      step,
      timestamp: 1700000000000 + step,
      content_type: "image/png",
      byte_length: bytes.size,
    });
    const catalog = (keys: string[]) => ({
      experiments: [],
      runs: [run],
      series: keys.map((key) => ({
        run_id: run.id,
        key,
        kind: "image",
        count: 3,
        last_step: 4,
        last_timestamp: 1700000000004,
        last_value: null,
      })),
    });
    const state: any = {
      frame,
      catalog,
      frames: [frame(0), frame(2), frame(4)],
      metadata: 0,
      content: 0,
    };
    const api = new Api(
      () => "secret",
      async (url: string) => {
        if (url.endsWith("/images")) {
          state.metadata++;
          return Response.json({ images: state.frames });
        }
        state.content++;
        return new Response(bytes, {
          headers: { "Content-Type": "image/png" },
        });
      },
    );
    const host = document.createElement("section");
    document.body.append(host);
    const spec = newChart("image", ["a", "b"], "Images A and B");
    spec.layout = { width: 640, height: 400 };
    state.card = new ChartCard(
      host,
      spec,
      {
        api,
        catalog: catalog(["a"]),
        selectedRunIds: [run.id],
        store: {
          clear() {},
          async load() {
            return [];
          },
        },
      },
      {
        onEdit() {},
        onDuplicate() {},
        onRemove() {},
        onMove() {},
        onResize() {},
      },
    );
    state.host = host;
    (window as any).sourceResume = state;
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 3");
  await page.evaluate(async () => {
    const s = (window as any).sourceResume;
    const p = s.card.images;
    await p.show(1);
    p.setCamera({
      x: 0.2,
      y: 0.1,
      width: 0.4,
      height: 0.3,
      rotation: 90,
      flip: true,
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).sourceResume.card.images.cache.size),
    )
    .toBe(3);
  await page.evaluate(() => {
    const s = (window as any).sourceResume;
    const p = s.card.images;
    s.before = {
      panel: p,
      viewer: p.viewer,
      item: p.viewer.world.getItemAt(0),
      camera: p.camera(),
      cache: p.cache,
      blob: p.cache.get("a-2"),
      content: s.content,
      metadata: s.metadata,
    };
  });
}

async function expectRetained(page: Page, activeItem = false) {
  const result = await page.evaluate(() => {
    const s = (window as any).sourceResume;
    const p = s.card.images;
    return {
      panel: p === s.before.panel,
      viewer: p.viewer === s.before.viewer,
      item: p.viewer.world.getItemAt(0) === s.before.item,
      cache: p.cache === s.before.cache,
      blob: p.cache.get("a-2") === s.before.blob,
      content: s.content === s.before.content,
      frame: p.displayed,
      key: p.keySelect.value,
      before: s.before.camera,
      after: p.camera(),
    };
  });
  expect(result).toMatchObject({
    panel: true,
    viewer: true,
    cache: true,
    blob: true,
    content: true,
    frame: "a-2",
    key: "a",
  });
  if (activeItem) expect(result.item).toBe(true);
  for (const key of ["x", "y", "width", "height", "rotation"])
    expect(result.after[key]).toBeCloseTo(result.before[key], 9);
  expect(result.after.flip).toBe(result.before.flip);
}

for (const suspended of [true, false]) {
  test(`compatible catalog source addition retains ${suspended ? "suspended" : "active"} card frame, camera and cache`, async ({
    page,
  }) => {
    await fixture(page);
    const before = await page.evaluate((suspended) => {
      const s = (window as any).sourceResume;
      if (suspended) {
        // The same ChartCard demand gate used by folded sections/navigation.
        s.card.setActive(false);
        s.host.hidden = true;
      }
      s.frames = [s.frame(1), ...s.frames, s.frame(6), s.frame(0, "b")];
      s.card.updateCatalog(s.catalog(["a", "b"]));
      return s.before.metadata;
    }, suspended);
    if (suspended) {
      await page.waitForTimeout(100);
      expect(
        await page.evaluate(() => {
          const s = (window as any).sourceResume;
          return {
            metadata: s.metadata,
            world: s.card.images.viewer.world.getItemCount(),
            dirty: s.card.imageSourcesDirty,
          };
        }),
      ).toEqual({ metadata: before, world: 0, dirty: true });
      await page.evaluate(() => {
        const s = (window as any).sourceResume;
        s.host.hidden = false;
        s.card.setActive(true);
      });
    }
    await expect(page.locator(".frame-info")).toHaveText("Step 2 · 3 / 5");
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).sourceResume.card.images.displayed),
      )
      .toBe("a-2");
    await expectRetained(page, !suspended);
    expect(
      await page.evaluate(() => (window as any).sourceResume.metadata),
    ).toBe(before + 1);
    expect(await page.getByLabel("Image frame timeline").inputValue()).toBe(
      "2",
    );
    await expect(page.getByLabel("Image key").locator("option")).toHaveText([
      "a",
      "b",
    ]);
    await page.getByLabel("Image key").selectOption("b");
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).sourceResume.card.images.displayed),
      )
      .toBe("b-0");
  });
}

test("same-source updates refresh active metadata and choices without replacing the image", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).sourceResume;
    s.frames.push(s.frame(1));
    s.card.images.setSources(
      s.card.sources.map((source: any) => ({
        ...source,
        run: { ...source.run, name: "Renamed run" },
      })),
    );
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 2 · 3 / 4");
  await expect(page.getByLabel("Image run").locator("option")).toHaveText([
    "Renamed run",
  ]);
  await expectRetained(page, true);
  expect(await page.evaluate(() => (window as any).sourceResume.metadata)).toBe(
    2,
  );
});

test("removing the selected key still resets a suspended card before loading its replacement", async ({
  page,
}) => {
  await fixture(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).sourceResume;
      const p = s.card.images;
      s.card.setActive(false);
      s.frames = [s.frame(0, "b"), s.frame(1, "b")];
      s.card.updateCatalog(s.catalog(["b"]));
      s.card.setActive(true);
      // setSources runs before panel activation, so reset is synchronous while
      // metadata remains deferred until the activation animation frame.
      return {
        camera: p.camera(),
        cache: p.cache.size,
        world: p.viewer.world.getItemCount(),
        pending: p.pendingCamera ?? null,
        resumeFrame: p.resumeFrame ?? null,
        metadata: s.metadata,
      };
    }),
  ).toEqual({
    camera: null,
    cache: 0,
    world: 0,
    pending: null,
    resumeFrame: null,
    metadata: 1,
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).sourceResume.card.images.displayed),
    )
    .toBe("b-0");
  expect(
    await page.evaluate(() => {
      const s = (window as any).sourceResume;
      return {
        key: s.card.images.keySelect.value,
        oldCache: s.card.images.cache.has("a-2"),
        home:
          Math.abs(
            s.card.images.viewer.viewport.getZoom(true) -
              s.card.images.viewer.viewport.getHomeZoom(),
          ) < 1e-9,
        metadata: s.metadata,
      };
    }),
  ).toEqual({ key: "b", oldCache: false, home: true, metadata: 2 });
});
