import { writeFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, compact: boolean, width: number) {
  await page.setViewportSize({ width, height: 1000 });
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
    await import("/src/style.css");
    document.body.style.cssText = "margin:16px;font:13px sans-serif";
    const host = document.createElement("section");
    host.style.cssText = "width:600px;max-width:100%";
    document.body.append(host);
    const bytes = await Promise.all(
      ["red", "green", "blue"].map((color) => {
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
    const s: any = { queues: {}, requests: [], samples: [] };
    const wait = (key: string) =>
      new Promise<void>((resolve) => (s.queues[key] ??= []).push(resolve));
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this);
      if (s.delayDecode) await wait("decode");
    };
    const api = new Api(
      () => "secret",
      async (url: string, init: RequestInit) => {
        s.requests.push({
          url,
          authorization: new Headers(init.headers).get("Authorization"),
        });
        if (url.endsWith("/images")) {
          if (s.delayMetadata) await wait("metadata");
          const run = url.includes("/other/") ? "other" : "run";
          return Response.json({
            images: ["prediction", "target", "third"].map((key, index) => ({
              id: `${run}-${key}`,
              run_id: run,
              key,
              step: [900, 20, 50][index],
              timestamp: 1700000000000 + index,
              content_type: "image/png",
              byte_length: bytes[index].size,
            })),
          });
        }
        const id = url.match(/\/images\/([^/]+)\/content/)![1];
        if (s.delayFetch === id) await wait(id); // Deliberately ignore abort until the API returns.
        if (s.fail === id) throw Error("Network unavailable");
        const index = ["prediction", "target", "third"].findIndex((key) =>
          id.endsWith(key),
        );
        return new Response(
          s.corrupt === id
            ? new Blob(["invalid"], { type: "image/png" })
            : bytes[index],
          {
            headers: { "Content-Type": "image/png" },
          },
        );
      },
    );
    const panel = new ImagePanel(host, api, { compact });
    s.panel = panel;
    s.info = (panel as any).info;
    s.geometry = () =>
      [
        host,
        host.querySelector(".image-canvas"),
        host.querySelector(".card-image-timeline"),
      ]
        .filter(Boolean)
        .map((el) => {
          const r = el!.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height];
        });
    s.snapshot = () => ({
      text: s.info.textContent,
      step: s.info.getAttribute("data-step"),
      title: s.info.getAttribute("title"),
      displayed: (panel as any).displayed ?? null,
      items: (panel as any).viewer.world.getItemCount(),
    });
    new MutationObserver(() => s.samples.push(s.snapshot())).observe(s.info, {
      childList: true,
      attributes: true,
    });
    (window as any).identity = s;
    panel.setActive(true);
    panel.setSources(
      ["run", "other"].flatMap((runId) =>
        ["prediction", "target", "third", "empty"].map((key) => ({
          id: `${runId}-${key}`,
          key,
          kind: "image",
          runId,
          label: key,
          run: {
            id: runId,
            name: runId === "run" ? "Original run" : "Other run",
          },
        })),
      ),
    );
  }, compact);
  await committed(page, "run-prediction", "900");
}

async function committed(page: Page, id: string, step: string) {
  await expect(page.locator(".frame-info")).toHaveAttribute("data-step", step);
  const state = await page.evaluate(() => (window as any).identity.snapshot());
  expect(state.displayed).toBe(id);
  expect(state.items).toBe(1);
  expect(state.text.toLowerCase()).toContain(`step ${step}`);
  expect((state.title ?? state.text).toLowerCase()).toContain(
    id.endsWith("prediction") ? "prediction" : id.split("-")[1],
  );
}
async function neutral(page: Page, text = "No frame loaded") {
  expect(
    await page.evaluate(() => (window as any).identity.snapshot()),
  ).toEqual({
    text,
    step: null,
    title: null,
    displayed: null,
    items: 0,
  });
}
async function key(page: Page, value: string) {
  await page
    .getByRole("combobox", { name: "Image key", exact: true })
    .selectOption(value);
}
async function queued(page: Page, name: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (name) => (window as any).identity.queues[name]?.length ?? 0,
        name,
      ),
    )
    .toBeGreaterThan(0);
}
async function release(page: Page, name: string) {
  await page.evaluate(async (name) => {
    for (const resolve of (window as any).identity.queues[name]?.splice(0) ??
      [])
      resolve();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }, name);
}
async function geometry(page: Page) {
  return page.evaluate(() => (window as any).identity.geometry());
}
async function atomicSamples(page: Page) {
  const samples = await page.evaluate(() => (window as any).identity.samples);
  for (const sample of samples) {
    if (!sample.displayed) {
      expect(["No frame loaded", "Frame unavailable"]).toContain(sample.text);
      expect(sample.step).toBeNull();
      expect(sample.title).toBeNull();
    } else {
      const key = sample.displayed.split("-")[1];
      expect(sample.step).toBe(
        (
          { prediction: "900", target: "20", third: "50" } as Record<
            string,
            string
          >
        )[key],
      );
      expect((sample.title ?? sample.text).toLowerCase()).toContain(key);
      expect(sample.items).toBe(1);
    }
  }
  await expect(page.locator("body")).not.toContainText("Loading frame");
}

for (const compact of [true, false])
  for (const width of [1440, 390]) {
    const variant = `${compact ? "compact" : "full"} ${width}`;
    test(`source switch clears identity; stale fetch cannot restore it (${variant})`, async ({
      page,
    }, testInfo) => {
      await fixture(page, compact, width);
      const before = await geometry(page);
      await page.evaluate(() => {
        (window as any).identity.delayFetch = "run-target";
      });
      await key(page, "target");
      await queued(page, "run-target");
      await neutral(page);
      expect(await geometry(page)).toEqual(before);
      await page.screenshot({
        path: testInfo.outputPath("source-pending.png"),
      });
      await key(page, "third");
      await committed(page, "run-third", "50");
      await release(page, "run-target");
      await committed(page, "run-third", "50");
      await key(page, "empty");
      await neutral(page);
      await expect(
        page.getByRole("status", { includeHidden: true }),
      ).toHaveText("No images found");
      expect(await geometry(page)).toEqual(before);
      await atomicSamples(page);
      writeFileSync(
        testInfo.outputPath("identity-evidence.json"),
        JSON.stringify(
          {
            variant,
            geometry: before,
            samples: await page.evaluate(
              () => (window as any).identity.samples,
            ),
          },
          null,
          2,
        ),
      );
      await testInfo.attach("identity-evidence", {
        body: JSON.stringify({
          variant,
          geometry: before,
          samples: await page.evaluate(() => (window as any).identity.samples),
        }),
        contentType: "application/json",
      });
    });

    test(`run switch, refresh and clear reset metadata immediately (${variant})`, async ({
      page,
    }, testInfo) => {
      await fixture(page, compact, width);
      const before = await geometry(page);
      // load() already empties this selector. Isolate its existing narrow-toolbar
      // reflow from caption changes: emptying only options must produce the same
      // geometry as a metadata-pending reset, without changing raster dimensions.
      const emptySelectorGeometry = await page.evaluate(() => {
        const s = (window as any).identity;
        const select = s.panel.keySelect;
        const options = [...select.children];
        const value = select.value;
        select.replaceChildren();
        const result = s.geometry();
        select.replaceChildren(...options);
        select.value = value;
        return result;
      });
      expect(
        emptySelectorGeometry.slice(1).map((rect: number[]) => rect.slice(2)),
      ).toEqual(before.slice(1).map((rect: number[]) => rect.slice(2)));
      writeFileSync(
        testInfo.outputPath("reset-geometry.json"),
        JSON.stringify(
          {
            variant,
            before,
            emptySelectorGeometry,
          },
          null,
          2,
        ),
      );
      await testInfo.attach("reset-geometry", {
        body: JSON.stringify({ variant, before, emptySelectorGeometry }),
        contentType: "application/json",
      });
      await page.evaluate(() => {
        (window as any).identity.delayMetadata = true;
      });
      await page
        .getByRole("combobox", { name: "Image run", exact: true })
        .selectOption("other");
      await queued(page, "metadata");
      await neutral(page);
      expect(await geometry(page)).toEqual(emptySelectorGeometry);
      await page.evaluate(() => {
        (window as any).identity.delayMetadata = false;
      });
      await release(page, "metadata");
      await committed(page, "other-prediction", "900");
      await page.evaluate(() => {
        const s = (window as any).identity;
        s.delayMetadata = true;
        void s.panel.refresh();
      });
      await queued(page, "metadata");
      await neutral(page);
      expect(await geometry(page)).toEqual(emptySelectorGeometry);
      await page.evaluate(() => (window as any).identity.panel.clear());
      await release(page, "metadata");
      await neutral(page);
      await atomicSamples(page);
    });

    test(`failed first frame never inherits old source metadata (${variant})`, async ({
      page,
    }) => {
      await fixture(page, compact, width);
      const before = await geometry(page);
      await page.evaluate(() => {
        (window as any).identity.fail = "run-target";
      });
      await key(page, "target");
      await expect(
        page.getByRole("status", { includeHidden: true }),
      ).toContainText("Network unavailable");
      await neutral(page, "Frame unavailable");
      await page.evaluate(() => {
        (window as any).identity.corrupt = "run-third";
      });
      await key(page, "third");
      await expect(
        page.getByRole("status", { includeHidden: true }),
      ).not.toBeEmpty();
      await neutral(page, "Frame unavailable");
      expect(await geometry(page)).toEqual(before);
      await atomicSamples(page);
    });

    test(`source decode cannot commit after deactivation or destruction (${variant})`, async ({
      page,
    }) => {
      await fixture(page, compact, width);
      await page.evaluate(() => {
        (window as any).identity.delayDecode = true;
      });
      await key(page, "target");
      await queued(page, "decode");
      await neutral(page);
      await page.evaluate(() => {
        const s = (window as any).identity;
        s.panel.setActive(false);
        s.delayDecode = false;
      });
      await release(page, "decode");
      await neutral(page);
      await page.evaluate(() => (window as any).identity.panel.setActive(true));
      await committed(page, "run-target", "20");
      await page.evaluate(() => {
        (window as any).identity.delayDecode = true;
      });
      await key(page, "third");
      await queued(page, "decode");
      await page.evaluate(() => (window as any).identity.panel.destroy());
      await release(page, "decode");
      await expect(page.locator(".image-canvas")).toHaveCount(0);
      expect(
        await page.evaluate(() => {
          const info = (window as any).identity.info;
          return [
            info.textContent,
            info.getAttribute("data-step"),
            info.getAttribute("title"),
          ];
        }),
      ).toEqual(["No frame loaded", null, null]);
      await atomicSamples(page);
    });
  }
