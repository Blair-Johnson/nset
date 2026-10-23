import { test, expect, type Page, type TestInfo } from "@playwright/test";

const baseline = process.env.IMAGE_ZOOM_BASELINE === "1";
const variant = baseline ? "center-baseline" : "pointer-anchored";

test.beforeAll(() => {
  console.log(
    JSON.stringify({
      kind: "config",
      variant,
      environment: {
        node: process.version,
        platform: process.platform,
        pixi: process.env.PIXI_ENVIRONMENT_NAME,
        port: process.env.NSET_TEST_PORT,
      },
      data: "1024-square PNG; red12x12 marker centered580,430",
      protocol:
        "Chromium DPR1 screenshot centroid; three60px wheel events35ms apart",
    }),
  );
});

async function fixture(page: Page) {
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
    document.body.style.cssText = "margin:0;min-height:3000px;background:white";
    const host = document.createElement("section");
    host.style.cssText = "width:740px;margin:180px 0 0 120px";
    document.body.append(host);
    const source = document.createElement("canvas");
    source.width = source.height = 1024;
    const ctx = source.getContext("2d")!;
    ctx.fillStyle = "#ddd";
    ctx.fillRect(0, 0, 1024, 1024);
    ctx.fillStyle = "#f00";
    ctx.fillRect(574, 424, 12, 12);
    const bytes: Blob = await new Promise((resolve) =>
      source.toBlob((b) => resolve(b!)),
    );
    const api = new Api(
      () => "secret",
      async (url: string) => {
        if (url.endsWith("/images"))
          return Response.json({
            images: [0, 1].map((step) => ({
              id: `marker${step}`,
              run_id: "run",
              key: "marker",
              step,
              timestamp: 1700000000000 + step,
              content_type: "image/png",
              byte_length: bytes.size,
            })),
          });
        return new Response(bytes, {
          headers: { "Content-Type": "image/png" },
        });
      },
    );
    const panel = new ImagePanel(host, api, { compact: true });
    panel.setActive(true);
    panel.setSources([
      {
        id: "marker",
        key: "marker",
        kind: "image",
        runId: "run",
        label: "marker",
        run: { id: "run", name: "Run" },
      },
    ]);
    (window as any).pointerZoom = { panel, host };
  });
  await expect(page.locator(".frame-info")).toHaveText(/Step 0 .* 1 \/ 2/);
  await settle(page);
}
async function settle(page: Page) {
  // Let OSD start an animation queued by the preceding wheel event.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.waitForFunction(() => {
    const v = (window as any).pointerZoom.panel.viewer;
    return (
      v.world.getItemCount() === 1 &&
      !v.isAnimating() &&
      v.world.getItemAt(0).getFullyLoaded()
    );
  });
  await page.waitForTimeout(100);
}

// Read actual composited screenshot pixels, not an inverse of the mapping under test.
async function marker(page: Page, info: TestInfo, name: string) {
  const png = await page
    .locator(".image-canvas")
    .screenshot({ path: info.outputPath(`${name}.png`) });
  const point = await page.evaluate(
    async (data) => {
      const image = new Image();
      image.src = data;
      await image.decode();
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
      let x = 0,
        y = 0,
        n = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 220 && pixels[i + 1] < 50 && pixels[i + 2] < 50) {
          const p = i / 4;
          x += (p % c.width) + 0.5;
          y += Math.floor(p / c.width) + 0.5;
          n++;
        }
      }
      return { x: x / n, y: y / n, n };
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );
  expect(point.n).toBeGreaterThan(10);
  return point;
}

for (const rotation of [0, 90])
  for (const flipped of [false, true]) {
    test(`pointer marker rotation=${rotation} flipped=${flipped}`, async ({
      page,
    }, info) => {
      test.setTimeout(120000);
      await fixture(page);
      const results: any[] = [];
      for (const layout of ["normal", "scrolled", "resized", "maximized"]) {
        await page.evaluate((layout) => {
          const { host } = (window as any).pointerZoom;
          host.style.cssText =
            layout === "maximized"
              ? "position:fixed;inset:0;width:100vw;height:100vh;z-index:1000;background:white"
              : `width:${layout === "resized" ? 920 : 740}px;margin:180px 0 0 120px`;
          host.querySelector(".image-canvas").style.height =
            layout === "maximized" ? "800px" : "460px";
          window.scrollTo(0, layout === "scrolled" ? 130 : 0);
        }, layout);
        await page.waitForTimeout(250);
        for (const direction of [-1, 1]) {
          await page.evaluate(
            ({ rotation, flipped }) => {
              const v = (window as any).pointerZoom.panel.viewer.viewport;
              v.setRotation(rotation, true);
              v.setFlip(flipped);
              v.zoomTo(1.4, undefined, true);
              v.panTo({ x: 0.5, y: 0.5 }, true);
              v.applyConstraints(true);
            },
            { rotation, flipped },
          );
          await settle(page);
          const label = `${layout}-${direction < 0 ? "in" : "out"}`;
          const before = await marker(page, info, `${label}-before`);
          const box = (await page.locator(".image-canvas").boundingBox())!;
          const pointer = { x: box.x + before.x, y: box.y + before.y };
          await page.mouse.move(pointer.x, pointer.y);
          await page.keyboard.down("Alt");
          // Successive real input events exercise OSD's animated camera, not just immediate zoom.
          for (let i = 0; i < 3; i++) {
            await page.mouse.wheel(0, direction * 60);
            await page.waitForTimeout(35);
          }
          await page.keyboard.up("Alt");
          await settle(page);
          const after = await marker(page, info, `${label}-after`);
          const drift = Math.hypot(after.x - before.x, after.y - before.y);
          const camera = await page.evaluate(() => {
            const v = (window as any).pointerZoom.panel.viewer.viewport;
            return {
              zoom: v.getZoom(true),
              center: v.getCenter(true),
              rotation: v.getRotation(),
              flip: v.getFlip(),
            };
          });
          expect(camera.zoom).toBeCloseTo(
            1.4 * Math.exp(-direction * 180 * 0.002),
            5,
          );
          results.push({ layout, direction, drift, before, after, camera });
          console.log(
            JSON.stringify({
              kind: "measurement",
              variant,
              rotation,
              flipped,
              layout,
              direction,
              metrics: { drift_px: drift },
            }),
          );
          if (baseline) expect(drift).toBeGreaterThan(15);
          else expect(drift).toBeLessThan(1.5);
          if (!baseline) {
            await page.evaluate(async () => {
              const p = (window as any).pointerZoom.panel;
              await p.show(p.index === 0 ? 1 : 0);
            });
            await settle(page);
            const replacement = await page.evaluate(() => {
              const v = (window as any).pointerZoom.panel.viewer.viewport;
              return {
                zoom: v.getZoom(true),
                center: v.getCenter(true),
                rotation: v.getRotation(),
                flip: v.getFlip(),
              };
            });
            expect(replacement.zoom).toBeCloseTo(camera.zoom, 12);
            expect(replacement.center.x).toBeCloseTo(camera.center.x, 12);
            expect(replacement.center.y).toBeCloseTo(camera.center.y, 12);
            expect(replacement.rotation).toBe(camera.rotation);
            expect(replacement.flip).toBe(camera.flip);
            const frame = await marker(page, info, `${label}-replacement`);
            expect(
              Math.hypot(frame.x - after.x, frame.y - after.y),
            ).toBeLessThan(1);
          }
        }
      }
      await info.attach("pixel-displacement", {
        body: JSON.stringify({ variant, rotation, flipped, results }, null, 2),
        contentType: "application/json",
      });
    });
  }

test("wheel guards, delta units, finite extremes and constraints", async ({
  page,
}) => {
  test.skip(
    baseline,
    "Baseline comparison isolates the original center zoom behavior",
  );
  await fixture(page);
  const dispatch = async (deltaY: number, deltaMode = 0, options = {}) =>
    page.evaluate(
      ({ deltaY, deltaMode, options }) => {
        const { panel } = (window as any).pointerZoom;
        const element = panel.viewer.canvas;
        const r = element.getBoundingClientRect();
        const event = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          altKey: true,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
          deltaY: Number.isFinite(deltaY) ? deltaY : 0,
          deltaMode,
          ...options,
        });
        // WebIDL rejects non-finite constructor values; inject malformed
        // deltas explicitly to exercise the handler's defensive guard.
        if (!Number.isFinite(deltaY))
          Object.defineProperty(event, "deltaY", { value: deltaY });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      },
      { deltaY, deltaMode, options },
    );
  const reset = async () => {
    await page.evaluate(() => {
      const v = (window as any).pointerZoom.panel.viewer.viewport;
      v.zoomTo(1.4, undefined, true);
      v.panTo({ x: 0.5, y: 0.5 }, true);
    });
    await settle(page);
  };
  const zoom = () =>
    page.evaluate(() =>
      (window as any).pointerZoom.panel.viewer.viewport.getZoom(true),
    );
  for (const [delta, mode] of [
    [48, 0],
    [3, 1],
  ]) {
    await reset();
    expect(await dispatch(delta, mode)).toBe(true);
    await settle(page);
    expect(await zoom()).toBeCloseTo(1.4 * Math.exp(-48 * 0.002), 6);
  }
  await reset();
  const height = await page.evaluate(
    () =>
      (window as any).pointerZoom.panel.viewer.viewport.getContainerSize().y,
  );
  expect(await dispatch(48 / height, 2)).toBe(true);
  await settle(page);
  expect(await zoom()).toBeCloseTo(1.4 * Math.exp(-48 * 0.002), 6);
  await reset();
  for (const delta of [NaN, Infinity, -Infinity, 0]) {
    await dispatch(delta);
    await settle(page);
    expect(await zoom()).toBeCloseTo(1.4, 6);
  }
  for (const delta of [-Number.MAX_VALUE, Number.MAX_VALUE]) {
    await dispatch(delta);
    await settle(page);
    const state = await page.evaluate(() => {
      const v = (window as any).pointerZoom.panel.viewer.viewport;
      return {
        zoom: v.getZoom(true),
        min: v.getMinZoom(),
        max: v.getMaxZoom(),
        center: v.getCenter(true),
      };
    });
    expect(
      Number.isFinite(state.zoom) &&
        Number.isFinite(state.center.x) &&
        Number.isFinite(state.center.y),
    ).toBe(true);
    expect(state.zoom).toBeGreaterThanOrEqual(state.min - 1e-9);
    expect(state.zoom).toBeLessThanOrEqual(state.max + 1e-9);
  }
  for (const modifiers of [
    { shiftKey: true },
    { ctrlKey: true },
    { metaKey: true },
  ]) {
    await reset();
    expect(await dispatch(-48, 0, modifiers)).toBe(true);
    await settle(page);
    expect(await zoom()).toBeCloseTo(1.4 * Math.exp(48 * 0.002), 6);
  }
  await reset();
  expect(await dispatch(80, 0, { altKey: false })).toBe(false);
  await settle(page);
  expect(await zoom()).toBeCloseTo(1.4, 6);
  await page.evaluate(() => (window as any).pointerZoom.panel.setActive(false));
  expect(await dispatch(80)).toBe(false);
  await settle(page);
  expect(await zoom()).toBeCloseTo(1.4, 6);
  await page.evaluate(() => (window as any).pointerZoom.panel.setActive(true));
  const box = (await page.locator(".image-canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 180);
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  expect(await zoom()).toBeCloseTo(1.4, 6);
});
