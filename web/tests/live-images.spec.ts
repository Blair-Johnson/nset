import { test, expect, type Page } from "@playwright/test";

async function fixture(
  page: Page,
  holdInitial = false,
  { single = false, compact = true } = {},
) {
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/");
  const options = { holdInitial, single, compact };
  await page.evaluate(async ({ holdInitial, single, compact }) => {
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
      frames: single
        ? [frame(0), frame(99, "other")]
        : [frame(0), frame(2), frame(4), frame(99, "other")],
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
    const panel = new ImagePanel(host, api, { compact });
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
  }, options);
  if (!holdInitial) {
    await expect(page.locator(".frame-info")).toContainText(
      compact ? `Step 0 · 1 / ${single ? 1 : 3}` : `1 of ${single ? 1 : 3}`,
    );
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).liveImages.panel.cache.size),
      )
      .toBe(single ? 1 : 2);
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
  await expect(page.getByRole("slider")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Play image timeline" }),
  ).toHaveCount(0);
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

for (const flushInactive of [false, true]) {
  test(`initial single-frame metadata resumes after activation churn (${flushInactive ? "inactive animation frame" : "synchronous"})`, async ({
    page,
  }) => {
    await fixture(page, true, { single: true });
    await expect.poll(() => metadataCount(page)).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).liveImages.pending.length),
      )
      .toBe(1);
    await page.evaluate(async (flushInactive) => {
      const s = (window as any).liveImages,
        p = s.panel;
      s.initialRequest = s.requests[0];
      s.releaseInitial = s.pending.shift();
      // No animation frame may run between these three transitions.
      p.setActive(false);
      p.setActive(true);
      p.setActive(false);
      if (flushInactive) {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        s.inactive = {
          active: p.active,
          metadata: s.metadataCount(),
          content: s.contentCount(),
        };
      }
      p.setActive(true);
    }, flushInactive);
    if (flushInactive) {
      expect(
        await page.evaluate(() => (window as any).liveImages.inactive),
      ).toEqual({ active: false, metadata: 1, content: 0 });
    }
    await expect.poll(() => metadataCount(page)).toBe(2);
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).liveImages.pending.length),
      )
      .toBe(1);
    expect(
      await page.evaluate(async () => {
        const s = (window as any).liveImages,
          p = s.panel;
        // The transport ignores abort. Only the old response is released;
        // replacement metadata remains held so it cannot hide a stale commit.
        s.releaseInitial();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return {
          aborted: s.initialRequest.signal.aborted,
          metadata: s.metadataCount(),
          content: s.contentCount(),
          metadataPending: p.metadataPending,
          frames: p.frames.map((f: any) => f.id),
          displayed: p.displayed ?? null,
          requested: p.requested ?? null,
          items: p.viewer.world.getItemCount(),
        };
      }),
    ).toEqual({
      aborted: true,
      metadata: 2,
      content: 0,
      metadataPending: true,
      frames: [],
      displayed: null,
      requested: null,
      items: 0,
    });
    await expect(page.locator(".frame-info")).toHaveText("No frame loaded");
    await page.evaluate(() => {
      const s = (window as any).liveImages;
      s.hold = false;
      s.release();
    });
    await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 1");
    expect(
      await page.evaluate(() => {
        const s = (window as any).liveImages,
          p = s.panel;
        return {
          metadata: s.metadataCount(),
          content: s.contentCount(),
          displayed: p.displayed,
          frames: p.frames.map((f: any) => f.id),
          items: p.viewer.world.getItemCount(),
          playing: p.playing,
        };
      }),
    ).toEqual({
      metadata: 2,
      content: 1,
      displayed: "run-a-0",
      frames: ["run-a-0"],
      items: 1,
      playing: false,
    });
  });
}

test("inactive source replacement clears obsolete identity without loading until activation", async ({
  page,
}) => {
  await fixture(page, false, { single: true });
  expect(
    await page.evaluate(async () => {
      const s = (window as any).liveImages,
        p = s.panel;
      p.setActive(false);
      s.hold = true;
      s.frames = [s.frame(10, "a", "new")];
      p.setSources(s.source("new"));
      p.setActive(false);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return {
        active: p.active,
        metadata: s.metadataCount(),
        content: s.contentCount(),
        pending: s.pending.length,
        displayed: p.displayed ?? null,
        requested: p.requested ?? null,
        frames: p.frames.map((f: any) => f.id),
        all: p.all.map((f: any) => f.id),
        cache: p.cache.size,
        items: p.viewer.world.getItemCount(),
      };
    }),
  ).toEqual({
    active: false,
    metadata: 1,
    content: 1,
    pending: 0,
    displayed: null,
    requested: null,
    frames: [],
    all: [],
    cache: 0,
    items: 0,
  });
  await expect(page.locator(".frame-info")).toHaveText("No frame loaded");
  await expect(page.locator(".frame-info")).not.toHaveAttribute("data-step");
  await expect(page.locator(".frame-info")).not.toHaveAttribute("title");
  await page.evaluate(() => (window as any).liveImages.panel.setActive(true));
  await expect.poll(() => metadataCount(page)).toBe(2);
  expect(
    await page.evaluate(() => {
      const s = (window as any).liveImages;
      return {
        newRun: s.requests
          .filter((r: any) => r.url.endsWith("/images"))[1]
          .url.endsWith("/runs/new/images"),
        pending: s.pending.length,
        content: s.contentCount(),
      };
    }),
  ).toEqual({ newRun: true, pending: 1, content: 1 });
  await expect(page.locator(".frame-info")).toHaveText("No frame loaded");
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.hold = false;
    s.release();
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 10 · 1 / 1");
  expect(
    await page.evaluate(() => {
      const s = (window as any).liveImages,
        p = s.panel;
      return {
        metadata: s.metadataCount(),
        content: s.contentCount(),
        displayed: p.displayed,
        frames: p.frames.map((f: any) => f.id),
        cache: p.cache.size,
        items: p.viewer.world.getItemCount(),
        playing: p.playing,
      };
    }),
  ).toEqual({
    metadata: 2,
    content: 2,
    displayed: "new-a-10",
    frames: ["new-a-10"],
    cache: 1,
    items: 1,
    playing: false,
  });
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

for (const compact of [true, false]) {
  test(`single image hides sequence controls without a layout gap (${compact ? "compact" : "full"})`, async ({
    page,
  }) => {
    await fixture(page, false, { single: true, compact });
    await expect(page.locator(".frame-info")).toBeVisible();
    await expect(
      page.getByLabel("Native resolution image viewport"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Zoom in", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("slider")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Play image timeline" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "← Previous", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Next →", exact: true }),
    ).toHaveCount(0);
    await page.getByLabel("More image controls").click();
    await expect(page.getByLabel("Playback rate")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Rotate ↻", exact: true }),
    ).toBeVisible();
    expect(
      await page.locator(".card-image-timeline").evaluate((timeline) => {
        const info = timeline.querySelector(".frame-info")!;
        const controls = [...timeline.querySelectorAll("button, input")];
        return {
          controls: controls.length,
          collapsed: controls.every(
            (control) => control.getClientRects().length === 0,
          ),
          extraHeight:
            timeline.getBoundingClientRect().height -
            info.getBoundingClientRect().height,
        };
      }),
    ).toEqual({ controls: 4, collapsed: true, extraHeight: 0 });
    expect(
      await page.evaluate(() => {
        const p = (window as any).liveImages.panel;
        p.togglePlay();
        return p.playing;
      }),
    ).toBe(false);
  });
}

test("multiple images expose navigation and playback; source replacement and clear hide them", async ({
  page,
}) => {
  await fixture(page);
  const slider = page.getByRole("slider", { name: "Image frame timeline" });
  const play = page.getByRole("button", { name: "Play image timeline" });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("max", "2");
  await expect(play).toBeVisible();
  await page.getByRole("button", { name: "Next →", exact: true }).click();
  await expect(page.locator(".frame-info")).toHaveText("Step 2 · 2 / 3");
  await page.getByRole("button", { name: "← Previous", exact: true }).click();
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 1 / 3");
  await slider.focus();
  await slider.press("End");
  await expect(page.locator(".frame-info")).toHaveText("Step 4 · 3 / 3");
  await page.getByLabel("More image controls").click();
  await expect(page.getByLabel("Playback rate")).toBeVisible();
  await page.getByLabel("Playback rate").selectOption("1000");
  await play.click();
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.hold = true;
    s.frames = [s.frame(10, "a", "new")];
    s.panel.setSources(s.source("new"));
  });
  await expect(page.getByRole("status")).toHaveText("Loading image metadata…");
  await expect(slider).toHaveCount(0);
  await expect(play).toHaveCount(0);
  await expect(page.getByLabel("Playback rate")).toBeHidden();
  await page.evaluate(() => {
    const s = (window as any).liveImages;
    s.hold = false;
    s.release();
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 10 · 1 / 1");
  await expect(slider).toHaveCount(0);
  await expect(play).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).liveImages.panel.playing),
  ).toBe(false);
  await page.evaluate(() => (window as any).liveImages.panel.clear());
  await expect(page.getByRole("status")).toHaveText("Disconnected");
  await expect(slider).toHaveCount(0);
  await expect(play).toHaveCount(0);
});

test("a second live image reveals controls without replacing the image, camera or selection", async ({
  page,
}) => {
  await fixture(page, false, { single: true });
  await expect(page.getByRole("slider")).toHaveCount(0);
  await page.evaluate(async () => {
    const s = (window as any).liveImages,
      p = s.panel;
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
      item: p.viewer.world.getItemAt(0),
      camera: p.camera(),
      frame: p.displayed,
      content: s.contentCount(),
    };
    s.frames.push(s.frame(-1));
    p.refreshLive();
  });
  await expect(page.locator(".frame-info")).toHaveText("Step 0 · 2 / 2");
  const slider = page.getByRole("slider", { name: "Image frame timeline" });
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute("max", "1");
  await expect(slider).toHaveValue("1");
  await expect(
    page.getByRole("button", { name: "Play image timeline" }),
  ).toBeVisible();
  await page.getByLabel("More image controls").click();
  await expect(page.getByLabel("Playback rate")).toBeVisible();
  expect(
    await page.evaluate(() => {
      const s = (window as any).liveImages,
        p = s.panel;
      return {
        item: p.viewer.world.getItemAt(0) === s.before.item,
        camera: JSON.stringify(p.camera()) === JSON.stringify(s.before.camera),
        frame: p.displayed === s.before.frame,
        content: s.contentCount() === s.before.content,
        playing: p.playing,
      };
    }),
  ).toEqual({
    item: true,
    camera: true,
    frame: true,
    content: true,
    playing: false,
  });
  await page.getByRole("button", { name: "← Previous", exact: true }).click();
  await expect(page.locator(".frame-info")).toHaveText("Step -1 · 1 / 2");
});
