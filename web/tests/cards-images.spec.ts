import { test, expect } from "@playwright/test";

test("compact image panels keep exact sources, authenticated bytes, cameras and request races independent", async ({
  page,
}) => {
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
    document.body.style.cssText =
      "margin:20px;min-height:1800px;display:grid;grid-template-columns:600px 600px;align-content:start;gap:20px";
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 128;
    canvas.getContext("2d")!.fillRect(0, 0, 256, 128);
    const bytes: Blob = await new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), "image/png"),
    );
    const state: any = { panels: [], requests: [], pending: [], delay: false };
    const api = new Api(
      () => "secret",
      async (url: string, init: RequestInit) => {
        state.requests.push({
          url,
          authorization: (init.headers as any).Authorization,
          signal: init.signal,
        });
        if (url.endsWith("/images"))
          return Response.json({
            images: ["a", "b", "unselected"].flatMap((key) =>
              [0, 1, 2].map((step) => ({
                id: `${key}${step}`,
                run_id: "run",
                key,
                step,
                timestamp: 1700000000000 + step,
                content_type: "image/png",
                byte_length: bytes.size,
              })),
            ),
          });
        if (state.fail) throw Error("Image unavailable");
        if (state.delay && url.includes("/a2/"))
          await new Promise((resolve) => state.pending.push(resolve));
        return new Response(bytes, {
          headers: { "Content-Type": "image/png" },
        });
      },
    );
    for (const key of ["a", "b"]) {
      const host = document.createElement("section");
      host.dataset.panel = key;
      document.body.append(host);
      const panel = new ImagePanel(host, api, { compact: true });
      panel.setActive(true);
      panel.setSources([
        {
          id: key,
          key,
          kind: "image",
          runId: "run",
          label: key,
          run: { id: "run", name: "Run" },
        },
      ]);
      state.panels.push(panel);
    }
    (window as any).imageFixture = state;
  });
  const a = page.locator("[data-panel=a]"),
    b = page.locator("[data-panel=b]");
  await expect(a.locator(".frame-info")).toHaveText("Step 0 · 1 / 3");
  await expect(b.locator(".frame-info")).toHaveText("Step 0 · 1 / 3");
  expect(await page.locator("[id]").count()).toBe(0);
  await a.getByRole("button", { name: "1:1 pixels", exact: true }).click();
  await expect
    .poll(() => a.locator(".image-canvas").getAttribute("data-pixel-zoom"))
    .toBe("1");
  const camera = await a.locator(".image-canvas").getAttribute("data-zoom");
  await a.getByRole("button", { name: "Next →", exact: true }).click();
  await expect(a.locator(".frame-info")).toHaveText("Step 1 · 2 / 3");
  await expect(a.locator(".image-canvas")).toHaveAttribute(
    "data-zoom",
    camera!,
  );
  await expect(b.locator(".frame-info")).toHaveText("Step 0 · 1 / 3");
  expect(
    await page.evaluate(() => {
      const s = (window as any).imageFixture;
      return [
        s.requests.every((r: any) => r.authorization === "Bearer secret"),
        s.panels.map((p: any) => [...new Set(p.frames.map((f: any) => f.key))]),
      ];
    }),
  ).toEqual([true, [["a"], ["b"]]]);
  await page.evaluate(() => {
    const s = (window as any).imageFixture;
    s.panels[0].cache.delete("a2");
    s.delay = true;
    void s.panels[0].show(2);
    void s.panels[0].show(0);
    for (const resolve of s.pending) resolve();
  });
  await expect(a.locator(".frame-info")).toHaveText("Step 0 · 1 / 3");
  await page.evaluate(async () => {
    const s = (window as any).imageFixture;
    s.fail = true;
    s.panels[0].cache.delete("a2");
    await s.panels[0].show(2);
  });
  await expect(a.locator(".frame-info")).toHaveText("Frame unavailable");
  expect(
    await page.evaluate(() =>
      (window as any).imageFixture.panels[0].viewer.world.getItemCount(),
    ),
  ).toBe(0);
  await page.evaluate(() => (window as any).imageFixture.panels[0].destroy());
  await expect(b.locator(".frame-info")).toHaveText("Step 0 · 1 / 3");
});
