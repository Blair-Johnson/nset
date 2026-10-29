import { test, expect } from "@playwright/test";

for (const width of [128, 2048])
  test(`many single-frame panels load without a viewport gesture (width ${width})`, async ({
    page,
  }, testInfo) => {
    const messages: string[] = [];
    page.on("console", (msg) => {
      if (["warning", "error"].includes(msg.type())) messages.push(msg.text());
    });
    page.on("pageerror", (error) => messages.push(error.message));
    await page.route("**/__image_initial_fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body></body>",
      }),
    );
    await page.goto("/__image_initial_fixture");
    await page.evaluate(async (width) => {
      const { ImagePanel } = await import("/src/images.ts");
      const { Api } = await import("/src/api.ts");
      document.body.style.cssText =
        "margin:0;display:grid;grid-template-columns:repeat(4,320px);gap:8px";
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#e54b4b";
      ctx.fillRect(0, 0, width, 64);
      const bytes = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), "image/png"),
      );
      const state: any = { panels: [], requests: [] };
      const api = new Api(
        () => "token",
        async (url: string) => {
          state.requests.push(url);
          if (url.endsWith("/images")) {
            const run = url.split("/").at(-2)!;
            return Response.json({
              images: [
                {
                  id: run,
                  run_id: run,
                  key: "image",
                  step: 0,
                  timestamp: 1700000000000,
                  content_type: "image/png",
                  byte_length: bytes.size,
                },
              ],
            });
          }
          return new Response(bytes, {
            headers: { "Content-Type": "image/png" },
          });
        },
      );
      for (let i = 0; i < 24; i++) {
        const id = `run${i}`;
        const host = document.createElement("section");
        document.body.append(host);
        const panel = new ImagePanel(host, api, { compact: true });
        host.querySelector<HTMLElement>(".image-canvas")!.style.height =
          "140px";
        panel.setActive(true);
        panel.setSources([
          {
            id,
            key: "image",
            kind: "image",
            runId: id,
            label: id,
            run: { id, name: id },
          },
        ]);
        state.panels.push(panel);
      }
      (window as any).initialImages = state;
    }, width);
    try {
      await expect
        .poll(() => page.locator('.frame-info[data-step="0"]').count(), {
          timeout: 12000,
        })
        .toBe(24);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as any).initialImages.panels.filter((p: any) => {
                const canvas = p.viewer.drawer.canvas;
                const pixel = canvas
                  .getContext("2d")
                  ?.getImageData(
                    Math.floor(canvas.width / 2),
                    Math.floor(canvas.height / 2),
                    1,
                    1,
                  ).data;
                return (
                  pixel &&
                  pixel[0] === 229 &&
                  pixel[1] === 75 &&
                  pixel[2] === 75 &&
                  pixel[3] === 255
                );
              }).length,
          ),
        )
        .toBe(24);
      expect(
        await page.evaluate(
          () => (window as any).initialImages.requests.length,
        ),
      ).toBe(48);
      expect(
        messages.filter((text) =>
          /context was lost|Too many active WebGL|nset image frame unavailable/.test(
            text,
          ),
        ),
      ).toEqual([]);
      await expect(
        page.getByRole("button", { name: "Play image timeline" }),
      ).toHaveCount(0);
      await expect(
        page.getByText(/Frame unavailable|No frame loaded/),
      ).toHaveCount(0);
    } finally {
      const panels = await page.evaluate(() =>
        (window as any).initialImages.panels.map((p: any) => {
          const item = p.viewer.world.getItemAt(0);
          return {
            displayed: p.displayed,
            requested: p.requested,
            active: p.active,
            drawer: p.viewer.drawer.getType(),
            items: p.viewer.world.getItemCount(),
            loaded: item?.getFullyLoaded(),
            opacity: item?.getOpacity(),
            bounds: p.viewer.viewport.getBounds(true),
            source: item && {
              width: item.source.width,
              height: item.source.height,
            },
          };
        }),
      );
      await testInfo.attach("initial-loading.json", {
        body: JSON.stringify({ panels, messages }, null, 2),
        contentType: "application/json",
      });
      console.log(
        JSON.stringify({
          kind: "initial-image-loading",
          width,
          loaded: panels.filter((p: any) => p.displayed).length,
          drawers: [...new Set(panels.map((p: any) => p.drawer))],
          warnings: messages.filter((text) => !/websocket|WebSocket/.test(text))
            .length,
        }),
      );
    }
  });
