import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, compact = true, frameCount = 4) {
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/");
  await page.evaluate(
    async ({ compact, frameCount }) => {
      const { ImagePanel } = await import("/src/images.ts");
      const { Api } = await import("/src/api.ts");
      document.body.style.cssText =
        "margin:16px;background:#171b20;color:#ddd;font:13px sans-serif";
      const host = document.createElement("section");
      host.style.cssText = "width:600px;max-width:100%";
      document.body.append(host);
      const bytes = await Promise.all(
        ["#dc2828", "#28b450", "#2850dc", "#dcb428", "#dc28dc"]
          .slice(0, frameCount)
          .map(async (color) => {
            const canvas = document.createElement("canvas");
            canvas.width = 256;
            canvas.height = 128;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 256, 128);
            return new Promise<Blob>((resolve) =>
              canvas.toBlob((blob) => resolve(blob!), "image/png"),
            );
          }),
      );
      const state: any = {
        pendingFetch: [],
        pendingDecode: [],
        pendingReady: [],
        pendingRetry: [],
        pendingTimeout: [],
        retryFired: 0,
        nativeDecodeRejections: 0,
        commits: [],
        requests: [],
        samples: [],
      };
      new MutationObserver((records) => {
        for (const record of records) {
          const step = (record.target as HTMLElement).dataset.step;
          if (step !== undefined) state.commits.push(step);
        }
      }).observe(host, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-step"],
      });
      // Gate just recovery timers, leaving OSD's animation/network timers native.
      // Releasing a cancelled timer must not execute its callback.
      const setTimer = window.setTimeout.bind(window);
      const clearTimer = window.clearTimeout.bind(window);
      const held = new Set<number>();
      window.setTimeout = ((
        callback: TimerHandler,
        delay?: number,
        ...args: any[]
      ) => {
        const queue =
          delay === 200 && state.holdRetry
            ? "pendingRetry"
            : delay === 10000 && state.holdTimeout
              ? "pendingTimeout"
              : undefined;
        if (!queue) return setTimer(callback, delay, ...args);
        const fire = () => {
          if (!held.delete(id)) return;
          clearTimer(id);
          if (queue === "pendingRetry") state.retryFired++;
          (callback as (...args: any[]) => void)(...args);
        };
        const id = setTimer(fire, 60000);
        held.add(id);
        state[queue].push(fire);
        return id;
      }) as typeof window.setTimeout;
      window.clearTimeout = (id?: number) => {
        if (id !== undefined) held.delete(id);
        clearTimer(id);
      };
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this);
        if (state.rejectDecodeOnce) {
          state.rejectDecodeOnce = false;
          state.nativeDecodeRejections++;
          throw new DOMException(
            "One-shot decode failure on valid bytes",
            "EncodingError",
          );
        }
        if (state.delayDecode)
          await new Promise((resolve) => state.pendingDecode.push(resolve));
      };
      const api = new Api(
        () => "secret",
        async (url: string, init: RequestInit) => {
          state.requests.push({ url, signal: init.signal });
          if (url.endsWith("/images"))
            return Response.json({
              images: bytes.map((blob, step) => ({
                id: `f${step}`,
                run_id: "run",
                key: "image",
                step,
                timestamp: 1700000000000 + step,
                content_type: "image/png",
                byte_length: blob.size,
              })),
            });
          const index = Number(url.match(/\/f(\d)\//)![1]);
          if (state.delayFetch === index)
            await new Promise((resolve) => state.pendingFetch.push(resolve));
          if (state.fail === index) throw Error("Network unavailable");
          return new Response(
            state.corrupt === index || state.corruptFrames?.includes(index)
              ? new Blob(["invalid"], { type: "image/png" })
              : bytes[index],
            {
              headers: { "Content-Type": "image/png" },
            },
          );
        },
      );
      const panel = new ImagePanel(host, api, { compact });
      state.panel = panel;
      const viewer = (panel as any).viewer;
      const add = viewer.addTiledImage.bind(viewer);
      viewer.addTiledImage = (options: any) =>
        add({
          ...options,
          success: (event: any) => {
            if (state.delayReady) {
              const original = event.item.getFullyLoaded.bind(event.item);
              event.item.getFullyLoaded = () => false;
              state.pendingReady.push(() => {
                event.item.getFullyLoaded = original;
                event.item.raiseEvent("fully-loaded-change", {
                  fullyLoaded: original(),
                });
              });
            }
            options.success(event);
          },
        });
      state.camera = () => {
        const center = viewer.viewport.getCenter(true);
        return [
          viewer.viewport.getZoom(true),
          center.x,
          center.y,
          viewer.viewport.getRotation(),
          viewer.viewport.getFlip(),
        ];
      };
      state.geometry = () =>
        [
          host,
          host.querySelector(".image-canvas"),
          host.querySelector(".card-image-timeline"),
        ].map((el) => {
          const r = el.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        });
      const pixel = document.createElement("canvas");
      pixel.width = pixel.height = 1;
      const context = pixel.getContext("2d", { willReadFrequently: true })!;
      state.pixel = () => {
        const canvas = viewer.drawer.canvas;
        context.clearRect(0, 0, 1, 1);
        context.drawImage(
          canvas,
          Math.floor(canvas.width / 2),
          Math.floor(canvas.height / 2),
          1,
          1,
          0,
          0,
          1,
          1,
        );
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const sample = () => {
        if (state.sampling)
          state.samples.push({
            pixel: state.pixel(),
            geometry: state.geometry(),
            camera: state.camera(),
          });
        if (!state.destroyed) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      (window as any).stability = state;
      panel.setActive(true);
      panel.setSources([
        {
          id: "image",
          key: "image",
          kind: "image",
          runId: "run",
          label: "Image",
          run: { id: "run", name: "Run" },
        },
      ]);
    },
    { compact, frameCount },
  );
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
  await expect
    .poll(() => page.evaluate(() => (window as any).stability.pixel()))
    .toEqual([220, 40, 40, 255]);
}

async function frame(page: Page, index: number) {
  await page
    .locator('input[type="range"]')
    .evaluate((input: HTMLInputElement, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, index);
}
async function release(page: Page, queue: string) {
  await page.evaluate((queue) => {
    const s = (window as any).stability;
    for (const resolve of s[queue].splice(0)) resolve();
  }, queue);
}
async function queued(page: Page, queue: string) {
  await expect
    .poll(() =>
      page.evaluate((queue) => (window as any).stability[queue].length, queue),
    )
    .toBeGreaterThan(0);
}

for (const compact of [true, false]) {
  test(`delayed fetch, decode and full readiness retain pixels and geometry (${compact ? "compact" : "full"})`, async ({
    page,
  }, testInfo) => {
    await fixture(page, compact);
    const geometry = await page.evaluate(() => {
      const s = (window as any).stability;
      s.delayFetch = 2;
      s.delayDecode = s.delayReady = s.sampling = true;
      return s.geometry();
    });
    await frame(page, 2);
    await queued(page, "pendingFetch");
    await expect(page.getByRole("status", { includeHidden: true })).toBeEmpty();
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
    await release(page, "pendingFetch");
    await queued(page, "pendingDecode");
    const camera = await page.evaluate(() => {
      const s = (window as any).stability,
        viewport = s.panel.viewer.viewport;
      const center = viewport.getCenter(true);
      center.x += 0.02;
      viewport.panTo(center, true);
      viewport.zoomTo(viewport.getZoom(true) * 1.2, undefined, true);
      return s.camera();
    });
    await page.screenshot({ path: testInfo.outputPath("delayed-decode.png") });
    await release(page, "pendingDecode");
    await queued(page, "pendingReady");
    expect(
      await page.evaluate(() => {
        const s = (window as any).stability;
        return [s.pixel(), s.panel.viewer.world.getItemAt(1).getOpacity()];
      }),
    ).toEqual([[220, 40, 40, 255], 0]);
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
    await release(page, "pendingReady");
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "2");
    await expect
      .poll(() => page.evaluate(() => (window as any).stability.pixel()))
      .toEqual([40, 80, 220, 255]);
    const finalCamera = await page.evaluate(() =>
      (window as any).stability.camera(),
    );
    for (let i = 0; i < 4; i++)
      expect(finalCamera[i]).toBeCloseTo(camera[i], 9);
    expect(finalCamera[4]).toBe(camera[4]);
    const samples = await page.evaluate(() => {
      const s = (window as any).stability;
      s.sampling = false;
      return s.samples;
    });
    expect(samples.length).toBeGreaterThan(2);
    for (const sample of samples) {
      expect([
        [220, 40, 40, 255],
        [40, 80, 220, 255],
      ]).toContainEqual(sample.pixel);
      expect(sample.geometry).toEqual(geometry);
    }
    await expect(page.locator("body")).not.toContainText("Loading frame");
  });
}

test("latest scrub wins through ignored fetch aborts, delayed decode and invisible staging", async ({
  page,
}) => {
  await fixture(page);
  for (const phase of ["Fetch", "Decode", "Ready"]) {
    await page.evaluate((phase) => {
      const s = (window as any).stability;
      s.panel.cache.delete("f2");
      s[`delay${phase}`] = phase === "Fetch" ? 2 : true;
    }, phase);
    await frame(page, 2);
    await queued(page, `pending${phase}`);
    await page.evaluate((phase) => {
      const s = (window as any).stability;
      s[`delay${phase}`] = false;
      s.stale = s.panel.frameAbort.signal;
    }, phase);
    await frame(page, 1);
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "1");
    await release(page, `pending${phase}`);
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "1");
    expect(
      await page.evaluate(() => {
        const s = (window as any).stability;
        return [
          s.stale.aborted,
          s.panel.viewer.world.getItemCount(),
          s.pixel(),
        ];
      }),
    ).toEqual([true, 1, [40, 180, 80, 255]]);
  }
});

test("failed bytes and decode retain the frame; overlay errors cannot move the timeline", async ({
  page,
}) => {
  await fixture(page);
  const geometry = await page.evaluate(() =>
    (window as any).stability.geometry(),
  );
  for (const kind of ["fail", "corrupt"]) {
    await page.evaluate((kind) => {
      const s = (window as any).stability;
      s.fail = undefined;
      s[kind] = 2;
      s.panel.cache.delete("f2");
    }, kind);
    await frame(page, 2);
    await expect(page.getByRole("status")).toContainText("Frame unavailable");
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
    expect(
      await page.evaluate(() => {
        const s = (window as any).stability;
        return [s.geometry(), s.pixel(), s.panel.viewer.world.getItemCount()];
      }),
    ).toEqual([geometry, [220, 40, 40, 255], 1]);
  }
  await page.evaluate(() => {
    (window as any).stability.corrupt = undefined;
  });
  await frame(page, 2);
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "2");
  await expect(page.getByRole("status", { includeHidden: true })).toBeEmpty();
});

test("camera survives scrub and paced playback, including pan, rotation and flip", async ({
  page,
}) => {
  await fixture(page);
  const camera = await page.evaluate(() => {
    const s = (window as any).stability,
      viewport = s.panel.viewer.viewport;
    viewport.zoomTo(viewport.getZoom(true) * 1.6, undefined, true);
    const center = viewport.getCenter(true);
    center.x += 0.03;
    viewport.panTo(center, true);
    viewport.setRotation(90, true);
    viewport.setFlip(true);
    s.sampling = true;
    return s.camera();
  });
  await frame(page, 1);
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "1");
  await page.locator(".card-image-more > summary").click();
  await page.getByLabel("Playback rate").selectOption("100");
  await page.locator(".card-image-more > summary").click();
  await page.evaluate(() => {
    (window as any).stability.delayDecode = true;
  });
  await page.getByRole("button", { name: "Play image timeline" }).click();
  await queued(page, "pendingDecode");
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "1");
  await page.evaluate(() => {
    (window as any).stability.delayDecode = false;
  });
  await release(page, "pendingDecode");
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "3");
  await expect(
    page.getByRole("button", { name: "Play image timeline" }),
  ).toHaveAttribute("aria-pressed", "false");
  const samples = await page.evaluate(() => {
    const s = (window as any).stability;
    s.sampling = false;
    return s.samples;
  });
  for (const sample of samples) {
    for (let i = 0; i < 4; i++)
      expect(sample.camera[i]).toBeCloseTo(camera[i], 9);
    expect(sample.camera[4]).toBe(camera[4]);
  }
});

test("deactivation cancels staging and resumes safely; destroy settles pending decode", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    (window as any).stability.delayReady = true;
  });
  await frame(page, 2);
  await queued(page, "pendingReady");
  await page.evaluate(() => {
    const s = (window as any).stability;
    s.panel.setActive(false);
    s.delayReady = false;
  });
  await release(page, "pendingReady");
  expect(
    await page.evaluate(() =>
      (window as any).stability.panel.viewer.world.getItemCount(),
    ),
  ).toBe(0);
  await page.evaluate(() => (window as any).stability.panel.setActive(true));
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "2");
  await page.evaluate(() => {
    const s = (window as any).stability;
    s.delayDecode = true;
    s.pending = s.panel.show(3).then(() => {
      s.settled = true;
    });
  });
  await queued(page, "pendingDecode");
  await page.evaluate(() => {
    const s = (window as any).stability;
    s.destroyed = true;
    s.panel.destroy();
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).stability.settled))
    .toBe(true);
  await release(page, "pendingDecode");
  await expect(page.locator(".image-canvas")).toHaveCount(0);
});

test("390px timeline stays in place during delayed frame and empty selection", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  const geometry = await page.evaluate(() => {
    const s = (window as any).stability;
    s.delayDecode = true;
    return s.geometry();
  });
  await frame(page, 2);
  await queued(page, "pendingDecode");
  await page.screenshot({ path: testInfo.outputPath("narrow-pending.png") });
  expect(
    await page.evaluate(() => (window as any).stability.geometry()),
  ).toEqual(geometry);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.evaluate(() => (window as any).stability.panel.setSources([]));
  await expect(page.getByRole("status")).toHaveText("No images selected");
  const emptyGeometry = await page.evaluate(() =>
    (window as any).stability.geometry(),
  );
  expect(emptyGeometry[1]).toEqual(geometry[1]);
  expect(emptyGeometry[2].slice(0, 3)).toEqual(geometry[2].slice(0, 3));
  await expect(
    page.getByRole("button", { name: "Play image timeline" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("slider", { name: "Image frame timeline" }),
  ).toHaveCount(0);
  await release(page, "pendingDecode");
});

async function recoverySetup(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => {
    const s = (window as any).stability;
    // Initial frame prefetch is not an attempt by playback. Start counting fresh.
    s.panel.prefetchAbort?.abort();
    s.panel.cache.delete("f1");
    s.requests = [];
    const speed = document.querySelector<HTMLSelectElement>(
      '[aria-label="Playback rate"]',
    )!;
    speed.value = "100";
  });
  return errors;
}

async function fetchCount(page: Page, index: number) {
  return page.evaluate(
    (index) =>
      (window as any).stability.requests.filter((request: any) =>
        request.url.endsWith(`/f${index}/content`),
      ).length,
    index,
  );
}

async function painted(page: Page) {
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
}

for (const compact of [true, false]) {
  test(`autoplay retries one native decode rejection with fresh valid bytes (${compact ? "compact" : "full"})`, async ({
    page,
  }) => {
    await fixture(page, compact);
    const errors = await recoverySetup(page);
    await page.evaluate(() => {
      const s = (window as any).stability;
      s.rejectDecodeOnce = s.holdRetry = true;
    });
    await page.getByRole("button", { name: "Play image timeline" }).click();
    await queued(page, "pendingRetry");
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
    expect(await fetchCount(page, 1)).toBe(1);
    expect(
      await page.evaluate(
        () => (window as any).stability.nativeDecodeRejections,
      ),
    ).toBe(1);
    expect(
      await page.evaluate(() => (window as any).stability.pixel()),
    ).toEqual([220, 40, 40, 255]);
    await release(page, "pendingRetry");
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "3");
    await expect(
      page.getByRole("button", { name: "Play image timeline" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(await fetchCount(page, 1)).toBe(2);
    expect(
      await page.evaluate(() => (window as any).stability.commits),
    ).toEqual(["0", "1", "2", "3"]);
    await expect(page.getByRole("status", { includeHidden: true })).toBeEmpty();
    expect(errors).toEqual([]);
  });
}

test("persistent corrupt playback frame is tried twice, skipped, and remembered at natural end", async ({
  page,
}) => {
  await fixture(page);
  const errors = await recoverySetup(page);
  await page.evaluate(() => {
    const s = (window as any).stability;
    s.corrupt = 1;
    s.holdRetry = true;
  });
  await page.getByRole("button", { name: "Play image timeline" }).click();
  await queued(page, "pendingRetry");
  expect(await fetchCount(page, 1)).toBe(1);
  await release(page, "pendingRetry");
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "3");
  await expect(
    page.getByRole("button", { name: "Play image timeline" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status")).toContainText(
    /(?:skipp\w*.*1|1.*skipp)/i,
  );
  await expect(page.getByRole("status")).toContainText(/step\s*1\b/i);
  expect(await fetchCount(page, 1)).toBe(2);
  expect(await page.evaluate(() => (window as any).stability.commits)).toEqual([
    "0",
    "2",
    "3",
  ]);
  await expect
    .poll(() => page.evaluate(() => (window as any).stability.pixel()))
    .toEqual([220, 180, 40, 255]);
  expect(errors).toEqual([]);
});

test("three consecutive failed frames pause before a later good frame and offer Retry frame", async ({
  page,
}) => {
  await fixture(page, true, 5);
  const errors = await recoverySetup(page);
  await page.evaluate(() => {
    (window as any).stability.corruptFrames = [1, 2, 3];
  });
  await page.getByRole("button", { name: "Play image timeline" }).click();
  await expect(page.getByRole("status")).toContainText(
    /(?:skipp\w*.*3|3.*skipp)/i,
  );
  await expect(page.getByRole("status")).toContainText(/paus|stop/i);
  await expect(page.getByRole("status")).toContainText(/step\s*3\b/i);
  await expect(
    page.getByRole("button", { name: "Retry frame", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play image timeline" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
  for (const index of [1, 2, 3]) expect(await fetchCount(page, index)).toBe(2);
  expect(await fetchCount(page, 4)).toBe(0);
  expect(await page.evaluate(() => (window as any).stability.pixel())).toEqual([
    220, 40, 40, 255,
  ]);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("section")!.style.width = "300px";
    document.querySelector<HTMLElement>(".image-canvas")!.style.height = "70px";
    (window as any).stability.corruptFrames = [];
  });
  const retry = page.getByRole("button", { name: "Retry frame", exact: true });
  const canvasBounds = (await page.locator(".image-canvas").boundingBox())!;
  const retryBounds = (await retry.boundingBox())!;
  expect(retryBounds.y).toBeGreaterThanOrEqual(canvasBounds.y);
  expect(retryBounds.y + retryBounds.height).toBeLessThanOrEqual(
    canvasBounds.y + canvasBounds.height,
  );
  expect(retryBounds.x + retryBounds.width).toBeLessThanOrEqual(
    canvasBounds.x + canvasBounds.width,
  );
  await retry.click();
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "3");
  await expect(page.getByRole("status", { includeHidden: true })).toBeEmpty();
  expect(errors).toEqual([]);
});

test("explicit show pauses playback; manual failure keeps pixels until Retry frame succeeds", async ({
  page,
}) => {
  await fixture(page);
  const errors = await recoverySetup(page);
  await page.evaluate(async () => {
    const s = (window as any).stability;
    s.corrupt = 2;
    s.holdRetry = true;
    document
      .querySelector<HTMLButtonElement>('[aria-label="Play image timeline"]')!
      .click();
    await s.panel.show(2);
  });
  await expect(page.getByRole("status")).toContainText("Frame unavailable");
  await expect(
    page.getByRole("button", { name: "Retry frame", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play image timeline" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
  expect(
    await page.evaluate(() => {
      const s = (window as any).stability;
      return [
        s.pixel(),
        s.pendingRetry.length,
        s.panel.viewer.world.getItemCount(),
      ];
    }),
  ).toEqual([[220, 40, 40, 255], 0, 1]);
  expect(await fetchCount(page, 2)).toBe(1);
  await page.evaluate(() => {
    (window as any).stability.corrupt = undefined;
  });
  await page.getByRole("button", { name: "Retry frame", exact: true }).click();
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "2");
  await expect
    .poll(() => page.evaluate(() => (window as any).stability.pixel()))
    .toEqual([40, 80, 220, 255]);
  expect(await fetchCount(page, 2)).toBe(2);
  await expect(page.getByRole("status", { includeHidden: true })).toBeEmpty();
  await expect(
    page.getByRole("button", { name: "Retry frame", exact: true }),
  ).toBeHidden();
  expect(errors).toEqual([]);
});

test("Pause during retry backoff cancels the pending retry without skipping", async ({
  page,
}) => {
  await fixture(page);
  const errors = await recoverySetup(page);
  await page.evaluate(() => {
    const s = (window as any).stability;
    s.rejectDecodeOnce = s.holdRetry = true;
  });
  const play = page.getByRole("button", { name: "Play image timeline" });
  await play.click();
  await queued(page, "pendingRetry");
  await play.click();
  await release(page, "pendingRetry");
  await painted(page);
  await expect(play).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
  expect(await fetchCount(page, 1)).toBe(1);
  expect(await page.evaluate(() => (window as any).stability.retryFired)).toBe(
    0,
  );
  await expect(page.getByRole("status", { includeHidden: true })).toBeEmpty();
  expect(errors).toEqual([]);
});

test("Pause then Play during noncooperative decode cannot revive the stale playback loop", async ({
  page,
}) => {
  await fixture(page);
  const errors = await recoverySetup(page);
  await page.evaluate(() => {
    (window as any).stability.delayDecode = true;
  });
  await page.getByRole("button", { name: "Play image timeline" }).click();
  await queued(page, "pendingDecode");
  await page.evaluate(() => {
    const s = (window as any).stability;
    s.stale = s.panel.frameAbort.signal;
    const play = document.querySelector<HTMLButtonElement>(
      '[aria-label="Play image timeline"]',
    )!;
    play.click();
    play.click();
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).stability.pendingDecode.length),
    )
    .toBe(2);
  expect(
    await page.evaluate(() => (window as any).stability.stale.aborted),
  ).toBe(true);
  await page.evaluate(() => {
    (window as any).stability.pendingDecode.shift()();
  });
  await painted(page);
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
  await expect(
    page.getByRole("button", { name: "Play image timeline" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    (window as any).stability.delayDecode = false;
  });
  await release(page, "pendingDecode");
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "3");
  await expect(
    page.getByRole("button", { name: "Play image timeline" }),
  ).toHaveAttribute("aria-pressed", "false");
  const commits = await page.evaluate(
    () => (window as any).stability.commits as string[],
  );
  expect(new Set(commits).size).toBe(commits.length);
  expect(commits[0]).toBe("0");
  expect(commits.at(-1)).toBe("3");
  await expect(page.getByRole("status", { includeHidden: true })).toBeEmpty();
  expect(errors).toEqual([]);
});

test("10s attempt deadline covers noncooperative fetch, decode, and OSD readiness and retries fresh", async ({
  page,
}) => {
  for (const phase of ["Fetch", "Decode", "Ready"]) {
    await test.step(phase, async () => {
      await fixture(page);
      const errors = await recoverySetup(page);
      await page.evaluate((phase) => {
        const s = (window as any).stability;
        s.holdTimeout = s.holdRetry = true;
        s[`delay${phase}`] = phase === "Fetch" ? 1 : true;
      }, phase);
      await page.getByRole("button", { name: "Play image timeline" }).click();
      await queued(page, `pending${phase}`);
      await queued(page, "pendingTimeout");
      await release(page, "pendingTimeout");
      await queued(page, "pendingRetry");
      await expect(page.locator(".frame-info")).toHaveAttribute(
        "data-step",
        "0",
      );
      await page.evaluate((phase) => {
        (window as any).stability[`delay${phase}`] = undefined;
      }, phase);
      await release(page, "pendingRetry");
      await expect(page.locator(".frame-info")).toHaveAttribute(
        "data-step",
        "3",
      );
      await expect(
        page.getByRole("button", { name: "Play image timeline" }),
      ).toHaveAttribute("aria-pressed", "false");
      expect(await fetchCount(page, 1)).toBe(2);
      await release(page, `pending${phase}`);
      await painted(page);
      await expect(page.locator(".frame-info")).toHaveAttribute(
        "data-step",
        "3",
      );
      expect(
        await page.evaluate(() =>
          (window as any).stability.panel.viewer.world.getItemCount(),
        ),
      ).toBe(1);
      await expect(
        page.getByRole("status", { includeHidden: true }),
      ).toBeEmpty();
      expect(errors).toEqual([]);
    });
  }
});

test("seek, deactivate, source switch, and destroy cancel an in-flight automatic retry", async ({
  page,
}) => {
  for (const action of ["seek", "deactivate", "sources", "destroy"]) {
    await test.step(action, async () => {
      await fixture(page);
      const errors = await recoverySetup(page);
      await page.evaluate(() => {
        const s = (window as any).stability;
        s.rejectDecodeOnce = s.holdRetry = true;
      });
      await page.getByRole("button", { name: "Play image timeline" }).click();
      await queued(page, "pendingRetry");
      await page.evaluate(() => {
        (window as any).stability.delayFetch = 1;
      });
      await release(page, "pendingRetry");
      await queued(page, "pendingFetch");
      await page.evaluate((action) => {
        const s = (window as any).stability;
        s.stale = s.requests
          .filter((request: any) => request.url.endsWith("/f1/content"))
          .at(-1).signal;
        s.delayFetch = undefined;
        if (action === "seek") void s.panel.show(3);
        else if (action === "deactivate") s.panel.setActive(false);
        else if (action === "sources") s.panel.setSources([]);
        else {
          s.destroyed = true;
          s.panel.destroy();
        }
      }, action);
      expect(
        await page.evaluate(() => (window as any).stability.stale.aborted),
      ).toBe(true);
      await release(page, "pendingFetch");
      await painted(page);
      expect(await fetchCount(page, 1)).toBe(2);
      if (action === "destroy")
        await expect(page.locator(".image-canvas")).toHaveCount(0);
      else if (action === "sources")
        await expect(page.getByRole("status")).toHaveText("No images selected");
      else {
        await expect(page.locator(".frame-info")).toHaveAttribute(
          "data-step",
          action === "seek" ? "3" : "0",
        );
        await expect(
          page.getByRole("button", { name: "Play image timeline" }),
        ).toHaveAttribute("aria-pressed", "false");
        await expect(
          page.getByRole("status", { includeHidden: true }),
        ).toBeEmpty();
      }
      expect(errors).toEqual([]);
    });
  }
});

for (const compact of [true, false]) {
  test(`image hover stays quiet and manual pause has no overlay (${compact ? "compact" : "full"})`, async ({
    page,
  }) => {
    await fixture(page, compact);
    await recoverySetup(page);
    const play = page.getByRole("button", { name: "Play image timeline" });
    const canvas = page.locator(".image-canvas");
    await expect(play).not.toHaveAttribute("title");
    await expect(canvas).not.toHaveAttribute("title");
    await expect(canvas).toHaveAttribute(
      "aria-label",
      "Native resolution image viewport",
    );
    await page.evaluate(() => {
      (window as any).stability.delayDecode = true;
    });
    await play.click();
    await queued(page, "pendingDecode");
    await expect(play).toHaveAttribute("aria-pressed", "true");
    await expect(play).not.toHaveAttribute("title");
    await canvas.hover();
    await play.click();
    await expect(play).toHaveAttribute("aria-pressed", "false");
    await expect(play).not.toHaveAttribute("title");
    await expect(page.getByRole("status", { includeHidden: true })).toBeEmpty();
    await release(page, "pendingDecode");
    await painted(page);
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
    await expect(page.getByRole("status", { includeHidden: true })).toBeEmpty();
  });
}
