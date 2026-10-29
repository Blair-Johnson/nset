import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    (window as any).rafTicks = 0;
    window.requestAnimationFrame = (callback) =>
      request((time) => {
        (window as any).rafTicks++;
        callback(time);
      });
  });
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const { ImagePanel } = await import("/src/images.ts");
    const { Api } = await import("/src/api.ts");
    const blobs: Blob[] = [];
    for (const color of ["red", "green", "blue", "orange"]) {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 128;
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, 256, 128);
      context.fillStyle = "white";
      context.fillRect(32, 16, 70, 40);
      blobs.push(
        await new Promise<Blob>((resolve) =>
          canvas.toBlob((blob) => resolve(blob!)),
        ),
      );
    }
    const state: any = { requests: [], worldUpdates: 0, prepares: 0 };
    state.frame = (step: number, run = "a") => ({
      id: `${run}-${step}`,
      run_id: run,
      key: "image",
      step,
      timestamp: 1700000000000 + step,
      content_type: "image/png",
      byte_length: blobs[0].size,
    });
    state.source = (run = "a") => [
      {
        id: run,
        runId: run,
        kind: "image",
        key: "image",
        label: run,
        run: { id: run, name: run },
      },
    ];
    const api = new Api(
      () => "secret",
      async (url: string) => {
        state.requests.push(url);
        if (url.endsWith("/images")) {
          const run = url.match(/\/runs\/([^/]+)\/images$/)![1];
          return Response.json({
            images: [0, 1, 2, 3].map((step) => state.frame(step, run)),
          });
        }
        const id = url.match(/\/images\/([^/]+)\/content$/)![1];
        if (state.holdContent === id)
          await new Promise((resolve) => {
            state.releaseContent = resolve;
          });
        return new Response(blobs[Number(id.split("-").at(-1))], {
          headers: { "Content-Type": "image/png" },
        });
      },
    );
    const host = document.createElement("section");
    host.style.cssText = "width:600px;height:400px";
    document.body.append(host);
    const panel: any = new ImagePanel(host, api, { compact: true });
    const update = panel.viewer.world.update.bind(panel.viewer.world);
    panel.viewer.world.update = (...args: any[]) => {
      state.worldUpdates++;
      return update(...args);
    };
    const prepare = panel.prepare.bind(panel);
    panel.prepare = (...args: any[]) => {
      state.prepares++;
      return prepare(...args);
    };
    state.panel = panel;
    state.host = host;
    state.metadataCount = () =>
      state.requests.filter((url: string) => url.endsWith("/images")).length;
    state.pixels = () => panel.viewer.drawer.canvas.toDataURL();
    (window as any).suspension = state;
    panel.setActive(true);
    panel.setSources(state.source());
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).suspension.panel.displayed))
    .toBe("a-0");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).suspension.panel.cache.size),
    )
    .toBe(2);
  await page.waitForTimeout(100);
}

async function expectIdle(page: Page) {
  await page.waitForTimeout(150); // Let OSD's already-scheduled final tick drain.
  const before = await page.evaluate(() => {
    const s = (window as any).suspension;
    return {
      world: s.panel.viewer.world.getItemCount(),
      updates: s.worldUpdates,
      raf: (window as any).rafTicks,
    };
  });
  expect(before.world).toBe(0);
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(() => {
      const s = (window as any).suspension;
      return {
        world: s.panel.viewer.world.getItemCount(),
        updates: s.worldUpdates,
        raf: (window as any).rafTicks,
      };
    }),
  ).toEqual(before);
}

async function expectCameraRestored(page: Page) {
  const { before, after } = await page.evaluate(() => {
    const s = (window as any).suspension;
    return { before: s.before.camera, after: s.panel.camera() };
  });
  for (const key of ["x", "y", "width", "height", "rotation"])
    expect(after[key]).toBeCloseTo(before[key], 9);
  expect(after.flip).toBe(before.flip);
}

test("inactive loaded viewer closes its world and RAF loop; resume preserves pixels, cache, frame and oriented camera", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const s = (window as any).suspension,
      p = s.panel;
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
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const s = (window as any).suspension,
      p = s.panel;
    s.before = {
      camera: p.camera(),
      pixels: s.pixels(),
      viewer: p.viewer,
      cache: p.cache,
      blob: p.cache.get(p.displayed),
      frames: p.frames,
      requests: s.requests.length,
    };
    p.togglePlay();
    p.setActive(false);
    s.host.hidden = true;
  });
  await expectIdle(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).suspension,
        p = s.panel;
      return {
        camera: p.camera(),
        displayed: p.displayed ?? null,
        requested: p.requested,
        playing: p.playing,
      };
    }),
  ).toEqual({
    camera: await page.evaluate(() => (window as any).suspension.before.camera),
    displayed: null,
    requested: "a-1",
    playing: false,
  });
  await page.evaluate(() => {
    const s = (window as any).suspension;
    s.host.hidden = false;
    s.panel.setActive(true);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).suspension.panel.displayed))
    .toBe("a-1");
  await page.waitForTimeout(200);
  await expectCameraRestored(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).suspension,
        p = s.panel,
        b = s.before;
      return {
        pixels: s.pixels() === b.pixels,
        viewer: p.viewer === b.viewer,
        cache: p.cache === b.cache,
        blob: p.cache.get(p.displayed) === b.blob,
        frames: p.frames === b.frames,
        requests: s.requests.length === b.requests,
        metadata: s.metadataCount(),
        playing: p.playing,
        world: p.viewer.world.getItemCount(),
      };
    }),
  ).toEqual({
    pixels: true,
    viewer: true,
    cache: true,
    blob: true,
    frames: true,
    requests: true,
    metadata: 1,
    playing: false,
    world: 1,
  });
});

test("rapid activation churn coalesces reopening and resumes stable frame identity rather than an old index", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const s = (window as any).suspension,
      p = s.panel;
    await p.show(2);
    s.before = { camera: p.camera(), prepares: s.prepares };
    p.setActive(false);
    // Model an earlier metadata insertion: selection must follow its stable ID.
    p.frames.unshift(s.frame(-1));
    for (let i = 0; i < 20; i++) {
      p.setActive(true);
      p.setActive(false);
    }
  });
  await expectIdle(page);
  await page.evaluate(() => (window as any).suspension.panel.setActive(true));
  await expect
    .poll(() => page.evaluate(() => (window as any).suspension.panel.displayed))
    .toBe("a-2");
  expect(
    await page.evaluate(() => {
      const s = (window as any).suspension;
      return {
        prepares: s.prepares - s.before.prepares,
        index: s.panel.index,
        metadata: s.metadataCount(),
      };
    }),
  ).toEqual({ prepares: 1, index: 3, metadata: 1 });
  await expectCameraRestored(page);
});

test("non-cooperative interrupted content cannot reopen hidden worlds and resumes the interrupted frame", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).suspension;
    s.holdContent = "a-2";
    s.loading = s.panel.show(2);
  });
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as any).suspension.releaseContent),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const s = (window as any).suspension;
    s.panel.setActive(false);
    s.holdContent = undefined;
    s.releaseContent();
    await s.loading;
  });
  await expectIdle(page);
  expect(
    await page.evaluate(() =>
      (window as any).suspension.panel.cache.has("a-2"),
    ),
  ).toBe(false);
  await page.evaluate(() => (window as any).suspension.panel.setActive(true));
  await expect
    .poll(() => page.evaluate(() => (window as any).suspension.panel.displayed))
    .toBe("a-2");
  expect(
    await page.evaluate(() => (window as any).suspension.metadataCount()),
  ).toBe(1);
});

test("late browser decode cannot reinstall a hidden world; inactive selection does no work", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).suspension;
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      HTMLImageElement.prototype.decode = decode;
      await decode.call(this);
      await new Promise((resolve) => {
        s.releaseDecode = resolve;
      });
    };
    s.loading = s.panel.show(2);
  });
  await expect
    .poll(() => page.evaluate(() => !!(window as any).suspension.releaseDecode))
    .toBe(true);
  await page.evaluate(async () => {
    const s = (window as any).suspension;
    s.panel.setActive(false);
    s.releaseDecode();
    await s.loading;
    s.requestsBefore = s.requests.length;
    await s.panel.show(3);
  });
  await expectIdle(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).suspension;
      return s.requests.length === s.requestsBefore;
    }),
  ).toBe(true);
  await page.evaluate(() => (window as any).suspension.panel.setActive(true));
  await expect
    .poll(() => page.evaluate(() => (window as any).suspension.panel.displayed))
    .toBe("a-3");
  expect(
    await page.evaluate(() => (window as any).suspension.metadataCount()),
  ).toBe(1);
});

test("source change while suspended discards old frame/cache/camera restoration and defers metadata", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).suspension,
      p = s.panel;
    p.setCamera({
      x: 0.3,
      y: 0.1,
      width: 0.2,
      height: 0.15,
      rotation: 0,
      flip: false,
    });
    p.setActive(false);
    p.setActive(true); // A queued activation must not restore the previous source.
    p.setActive(false);
    p.setSources(s.source("b"));
    s.beforeRequests = s.requests.length;
  });
  await expectIdle(page);
  expect(
    await page.evaluate(() => {
      const s = (window as any).suspension,
        p = s.panel;
      return {
        camera: p.camera(),
        pending: p.pendingCamera ?? null,
        cache: p.cache.size,
        unchanged: s.requests.length === s.beforeRequests,
      };
    }),
  ).toEqual({ camera: null, pending: null, cache: 0, unchanged: true });
  await page.evaluate(() => (window as any).suspension.panel.setActive(true));
  await expect
    .poll(() => page.evaluate(() => (window as any).suspension.panel.displayed))
    .toBe("b-0");
  expect(
    await page.evaluate(() => {
      const s = (window as any).suspension,
        p = s.panel;
      return {
        metadata: s.metadataCount(),
        world: p.viewer.world.getItemCount(),
        home: p.camera().width >= 1,
        oldCache: p.cache.has("a-0"),
      };
    }),
  ).toEqual({ metadata: 2, world: 1, home: true, oldCache: false });
});

test("suspension cancels crop gestures and destroy cancels queued activation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixture(page);
  const canvas = page.locator(".image-canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 120);
  await expect(page.locator(".image-crop-selection")).toBeVisible();
  await page.evaluate(() => {
    const s = (window as any).suspension;
    s.before = { camera: s.panel.camera() };
    s.panel.setActive(false);
  });
  await expect(page.locator(".image-crop-selection")).toBeHidden();
  await expectIdle(page);
  await page.evaluate(() => (window as any).suspension.panel.setActive(true));
  await expect
    .poll(() => page.evaluate(() => (window as any).suspension.panel.displayed))
    .toBe("a-0");
  await page.mouse.move(box.x + 220, box.y + 180);
  await page.mouse.up();
  await expectCameraRestored(page);
  await page.evaluate(() => {
    const p = (window as any).suspension.panel;
    p.setActive(false);
    p.setActive(true);
    p.destroy();
  });
  await page.waitForTimeout(200);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as any).suspension.panel.activationRaf ?? null,
    ),
  ).toBeNull();
});

test("camera round trips do not drift at quarter turns or arbitrary angles", async ({
  page,
}) => {
  await fixture(page);
  for (const rotation of [90, 180, 270, 33, -30]) {
    await page.evaluate((rotation) => {
      const s = (window as any).suspension,
        p = s.panel;
      p.viewer.viewport.zoomTo(2, undefined, true);
      p.viewer.viewport.setRotation(rotation, true);
      p.viewer.viewport.setFlip(true);
      s.before = { camera: p.camera() };
      p.setActive(false);
      p.setActive(true);
    }, rotation);
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).suspension.panel.displayed),
      )
      .toBe("a-0");
    await expectCameraRestored(page);
  }
  expect(
    await page.evaluate(() => (window as any).suspension.metadataCount()),
  ).toBe(1);
});

test("source replacement during a suspended-frame decode cannot restore stale pixels or camera", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).suspension,
      p = s.panel;
    p.setCamera({
      x: 0.3,
      y: 0.1,
      width: 0.2,
      height: 0.15,
      rotation: 0,
      flip: false,
    });
    p.setActive(false);
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      HTMLImageElement.prototype.decode = decode;
      await decode.call(this);
      await new Promise((resolve) => {
        s.releaseOldDecode = resolve;
      });
    };
    p.setActive(true);
  });
  await expect
    .poll(() =>
      page.evaluate(() => !!(window as any).suspension.releaseOldDecode),
    )
    .toBe(true);
  await page.evaluate(() => {
    const s = (window as any).suspension,
      p = s.panel;
    p.setActive(false);
    p.setSources(s.source("b"));
    p.setActive(true);
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).suspension.panel.displayed))
    .toBe("b-0");
  await page.evaluate(() => (window as any).suspension.releaseOldDecode());
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(() => {
      const s = (window as any).suspension,
        p = s.panel;
      return {
        displayed: p.displayed,
        world: p.viewer.world.getItemCount(),
        home: p.camera().width >= 1,
        oldCache: p.cache.has("a-0"),
        metadata: s.metadataCount(),
      };
    }),
  ).toEqual({
    displayed: "b-0",
    world: 1,
    home: true,
    oldCache: false,
    metadata: 2,
  });
});
