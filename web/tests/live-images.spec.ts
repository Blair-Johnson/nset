import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, holdInitial = false) {
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async (holdInitial) => {
    const { ImagePanel } = await import("/src/images.ts");
    const { Api } = await import("/src/api.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    canvas.getContext("2d")!.fillRect(0, 0, 256, 128);
    const bytes: Blob = await new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), "image/png"),
    );
    const frame = (step: number, key = "a", run = "run") => ({
      id: `${run}-${key}-${step}`,
      run_id: run,
      key,
      step,
      timestamp: 1700000000000 + step,
      content_type: "image/png",
      byte_length: bytes.size,
    });
    const state: any = {
      frame,
      frames: [frame(0), frame(2), frame(4), frame(99, "other")],
      requests: [],
      pending: [],
      hold: holdInitial,
      fail: false,
    };
    const api = new Api(
      () => "secret",
      async (url: string, init: RequestInit) => {
        state.requests.push({
          url,
          signal: init.signal,
          authorization: (init.headers as any).Authorization,
        });
        if (url.endsWith("/images")) {
          const images = [...state.frames];
          if (state.hold)
            await new Promise((resolve) => state.pending.push(resolve));
          if (state.fail) throw new Error("Metadata offline");
          return Response.json({ images });
        }
        if (state.holdContent && url.includes(`/${state.holdContent}/`))
          await new Promise((resolve) => {
            state.releaseContent = resolve;
          });
        return new Response(bytes, {
          headers: { "Content-Type": "image/png" },
        });
      },
    );
    const host = document.createElement("section");
    host.style.cssText = "width:600px;height:400px";
    document.body.append(host);
    const panel = new ImagePanel(host, api, { compact: true });
    state.panel = panel;
    state.source = (run = "run") => [
      {
        id: run + "-a",
        key: "a",
        kind: "image",
        runId: run,
        label: "A",
        run: { id: run, name: run },
      },
    ];
    state.metadataCount = () =>
      state.requests.filter((r: any) => r.url.endsWith("/images")).length;
    state.contentCount = () =>
      state.requests.filter((r: any) => r.url.endsWith("/content")).length;
    state.release = () => {
      for (const resolve of state.pending.splice(0)) resolve();
    };
    panel.setActive(true);
    panel.setSources(state.source());
    (window as any).liveImages = state;
  }, holdInitial);
  if (!holdInitial) {
    await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 3");
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).liveImages.panel.cache.size),
      )
      .toBe(2);
  }
}

const metadataCount = (page: Page) =>
  page.evaluate(() => (window as any).liveImages.metadataCount());

test("live metadata retains viewer, frame, camera, blob cache and paused selection across late insertion", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const s = (window as any).liveImages,
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
    await new Promise(requestAnimationFrame);
    s.before = {
      viewer: p.viewer,
      item: p.viewer.world.getItemAt(0),
      camera: p.camera(),
      cache: p.cache,
      blob: p.cache.get(p.displayed),
      content: s.contentCount(),
      frame: p.displayed,
    };
    s.frames = [s.frame(6), s.frame(1), ...s.frames, s.frame(2)];
    for (let i = 0; i < 30; i++) p.refreshLive();
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 2 · 3 / 5");
  await expect(page.getByRole("slider")).toHaveAttribute("max", "4");
  expect(await page.getByRole("slider").inputValue()).toBe("2");
  expect(await metadataCount(page)).toBe(2);
  expect(
    await page.evaluate(() => {
      const s = (window as any).liveImages,
        p = s.panel,
        b = s.before;
      return {
        viewer: p.viewer === b.viewer,
        item: p.viewer.world.getItemAt(0) === b.item,
        camera: JSON.stringify(p.camera()) === JSON.stringify(b.camera),
        cache: p.cache === b.cache,
        blob: p.cache.get(p.displayed) === b.blob,
        content: s.contentCount() === b.content,
        frame: p.displayed === b.frame,
        playing: p.playing,
        steps: p.frames.map((f: any) => f.step),
        authenticated: s.requests.every(
          (r: any) => r.authorization === "Bearer secret",
        ),
      };
    }),
  ).toEqual({
    viewer: true,
    item: true,
    camera: true,
    cache: true,
    blob: true,
    content: true,
    frame: true,
    playing: false,
    steps: [0, 1, 2, 4, 6],
    authenticated: true,
  });
  await page.waitForTimeout(250);
  expect(await metadataCount(page)).toBe(2);
});

test("playback keeps its intent and advances by frame identity after a late insert", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const s = (window as any).liveImages,
      p = s.panel;
    await p.show(1);
    p.togglePlay();
    s.timer = p.timer;
    s.frames.push(s.frame(1), s.frame(6));
    p.refreshLive();
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 2 · 3 / 5");
  expect(
    await page.evaluate(() => {
      const s = (window as any).liveImages;
      return [s.panel.playing, s.panel.timer === s.timer];
    }),
  ).toEqual([true, true]);
  await expect(page.locator(".frame-info")).toHaveText("Step 4 · 4 / 5");
  await expect(page.locator(".frame-info")).toHaveText("Step 6 · 5 / 5");
  await page.evaluate(() => (window as any).liveImages.panel.stop());
});

test("hints during initial metadata and live requests coalesce without losing the newest metadata", async ({
  page,
}) => {
  await fixture(page, true);
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.frames.push(s.frame(6));
    for (let i = 0; i < 20; i++) s.panel.refreshLive();
    s.release();
  });
  await expect.poll(() => metadataCount(page)).toBe(2);
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.frames.push(s.frame(8));
    for (let i = 0; i < 20; i++) s.panel.refreshLive();
    s.hold = false;
    s.release();
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 5");
  expect(await metadataCount(page)).toBe(3);
});

test("inactive panels defer hints, cancel live work and catch up only on activation", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.hold = true;
    s.panel.refreshLive();
  });
  await expect.poll(() => metadataCount(page)).toBe(2);
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.panel.setActive(false);
    s.frames.push(s.frame(6));
    for (let i = 0; i < 20; i++) s.panel.refreshLive();
    s.hold = false;
    s.release();
  });
  await page.waitForTimeout(100);
  expect(await metadataCount(page)).toBe(2);
  expect(
    await page.evaluate(
      () =>
        (window as any).liveImages.requests.filter((r: any) =>
          r.url.endsWith("/images"),
        )[1].signal.aborted,
    ),
  ).toBe(true);
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 3");
  await page.evaluate(() => (window as any).liveImages.panel.setActive(true));
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 4");
  expect(await metadataCount(page)).toBe(3);
});

test("source replacement and destroy abort live requests and reject non-cooperative stale replies", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.hold = true;
    s.panel.refreshLive();
  });
  await expect.poll(() => metadataCount(page)).toBe(2);
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.hold = false;
    s.frames = [s.frame(10, "a", "new")];
    s.panel.setSources(s.source("new"));
    s.release();
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 10 · 1 / 1");
  expect(
    await page.evaluate(
      () =>
        (window as any).liveImages.requests.filter((r: any) =>
          r.url.endsWith("/images"),
        )[1].signal.aborted,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.hold = true;
    s.panel.refreshLive();
  });
  await expect.poll(() => metadataCount(page)).toBe(4);
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.panel.destroy();
    s.release();
    s.panel.refreshLive();
    s.panel.setActive(true);
  });
  expect(
    await page.evaluate(
      () =>
        (window as any).liveImages.requests.filter((r: any) =>
          r.url.endsWith("/images"),
        )[3].signal.aborted,
    ),
  ).toBe(true);
  await expect(page.locator(".frame-info")).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(await metadataCount(page)).toBe(4);
  expect(
    await page.evaluate(() => (window as any).liveImages.panel.cache.size),
  ).toBe(0);
});

test("metadata errors retry the final update without another hint; healthy idle panels do not poll", async ({
  page,
}) => {
  await fixture(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.item = s.panel.viewer.world.getItemAt(0);
    s.fail = true;
    s.panel.refreshLive();
  });
  await expect(page.getByRole("status")).toContainText(
    "Image updates unavailable: Metadata offline",
  );
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 3");
  await page.clock.runFor(250);
  expect(await metadataCount(page)).toBe(2);
  expect(
    await page.evaluate(() => {
      const s = (window as any).liveImages;
      return s.panel.viewer.world.getItemAt(0) === s.item;
    }),
  ).toBe(true);
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.fail = false;
    s.frames.push(s.frame(6));
  });
  await page.clock.runFor(1000);
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 4");
  await expect(page.locator(".image-frame-status")).toHaveText("");
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.fail = true;
    s.panel.refreshLive();
  });
  await expect(page.getByRole("status")).toContainText("Metadata offline");
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.fail = false;
    s.frames.push(s.frame(8));
    s.panel.setActive(false);
    s.panel.setActive(true);
  });
  await page.clock.runFor(32);
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 5");
  await expect(page.locator(".image-frame-status")).toHaveText("");
  expect(await metadataCount(page)).toBe(5);
  await page.clock.fastForward(30000);
  expect(await metadataCount(page)).toBe(5);
});

test("a requested frame completing after metadata insertion keeps its identity and corrected index", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.holdContent = "run-a-4";
    s.pendingShow = s.panel.show(2);
    s.frames.push(s.frame(1));
    s.panel.refreshLive();
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 4");
  expect(await page.getByRole("slider").inputValue()).toBe("3");
  await page.evaluate(async () => {
    const s = (window as any).liveImages;
    s.releaseContent();
    await s.pendingShow;
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 4 · 4 / 4");
  expect(await page.getByRole("slider").inputValue()).toBe("3");
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.panel.setActive(false);
    s.panel.setActive(true);
  });
  await page.waitForTimeout(100);
  expect(await metadataCount(page)).toBe(2);
});

test("an initially empty source shows frame zero on first arrival without autoplay", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const s = (window as any).liveImages;
    s.frames = [];
    await s.panel.refresh();
  });
  await expect(page.getByRole("status")).toHaveText("No images found");
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.frames = [s.frame(4), s.frame(0)];
    s.panel.refreshLive();
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 2");
  expect(
    await page.evaluate(() => (window as any).liveImages.panel.playing),
  ).toBe(false);
});
