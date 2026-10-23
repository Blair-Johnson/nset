import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, compact = true) {
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async (compact) => {
    const { ImagePanel } = await import("/src/images.ts");
    const { Api } = await import("/src/api.ts");
    document.body.style.cssText =
      "margin:16px;background:#171b20;color:#ddd;font:13px sans-serif";
    const host = document.createElement("section");
    host.style.cssText = "width:600px;max-width:100%";
    document.body.append(host);
    const bytes = await Promise.all(
      ["#dc2828", "#28b450", "#2850dc", "#dcb428"].map(async (color) => {
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
      requests: [],
      samples: [],
    };
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this);
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
          state.corrupt === index
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
  }, compact);
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
  ).toBe(1);
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
  expect(
    await page.evaluate(() => (window as any).stability.geometry()),
  ).toEqual(geometry);
  await release(page, "pendingDecode");
});
