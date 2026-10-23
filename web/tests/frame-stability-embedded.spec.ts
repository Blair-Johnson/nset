import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

test("real authenticated server bytes retain old pixels during delayed content", async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    !process.env.NSET_IMAGE_BINARY,
    "Set NSET_IMAGE_BINARY to an existing Rust server binary",
  );
  const temporary = await mkdtemp(join(tmpdir(), "nset-frame-stability-"));
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const token = randomBytes(24).toString("hex");
  const headers = { Authorization: `Bearer ${token}` };
  const server = spawn(
    process.env.NSET_IMAGE_BINARY!,
    ["--data-dir", temporary, "--listen", `127.0.0.1:${port}`],
    {
      env: { ...process.env, NSET_TOKEN: token },
      stdio: "ignore",
    },
  );
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await request.get(`${url}/api/health`, { headers })).status();
        } catch {
          return 0;
        }
      })
      .toBe(200);
    expect((await request.get(url)).status()).toBe(200);
    const experiment = await (
      await request.post(`${url}/api/experiments`, {
        headers,
        data: { name: "Frame stability" },
      })
    ).json();
    const run = await (
      await request.post(`${url}/api/runs`, {
        headers,
        data: {
          experiment_id: experiment.id,
          name: "Native bytes",
          params: {},
          tags: {},
        },
      })
    ).json();
    await page.route(/^http:\/\/127\.0\.0\.1:\d+\/$/, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><body></body>",
      }),
    );
    await page.goto("/");
    const images = await page.evaluate(() =>
      ["#dc2828", "#28b450", "#2850dc"].map((color) => {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 128;
        const context = canvas.getContext("2d")!;
        context.fillStyle = color;
        context.fillRect(0, 0, 256, 128);
        return canvas.toDataURL("image/png").split(",")[1];
      }),
    );
    const ids: string[] = [];
    for (let step = 0; step < images.length; step++) {
      const response = await request.post(
        `${url}/api/runs/${run.id}/images?key=native&step=${step}`,
        {
          headers: { ...headers, "Content-Type": "image/png" },
          data: Buffer.from(images[step], "base64"),
        },
      );
      expect(response.ok()).toBe(true);
      ids.push((await response.json()).id);
    }
    expect(
      (await request.get(`${url}/api/images/${ids[0]}/content`)).status(),
    ).toBe(401);
    let held = false;
    let authorized = 0;
    await page.route("**/api/**", async (route) => {
      expect(route.request().headers().authorization).toBe(
        headers.Authorization,
      );
      authorized++;
      const path = new URL(route.request().url()).pathname;
      const response = await route.fetch({ url: `${url}${path}` });
      if (path.includes(ids[2])) {
        held = true;
        await gate;
      }
      await route.fulfill({ response });
    });
    await page.evaluate(
      async ({ run, token }) => {
        const { ImagePanel } = await import("/src/images.ts");
        const { Api } = await import("/src/api.ts");
        document.body.style.cssText =
          "background:#171b20;color:#ddd;margin:16px;font:13px sans-serif";
        const host = document.createElement("section");
        host.style.width = "600px";
        document.body.append(host);
        const panel = new ImagePanel(host, new Api(() => token), {
          compact: true,
        });
        (window as any).embeddedPanel = panel;
        panel.setActive(true);
        panel.setSources([
          {
            id: "native",
            key: "native",
            kind: "image",
            runId: run.id,
            label: "Native",
            run,
          },
        ]);
      },
      { run, token },
    );
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
    await page.getByRole("button", { name: "1:1 pixels", exact: true }).click();
    const canvas = page.locator(".image-canvas");
    const geometry = await canvas.boundingBox();
    const zoom = await canvas.getAttribute("data-zoom");
    const before = await canvas.screenshot();
    await page
      .locator('input[type="range"]')
      .evaluate((input: HTMLInputElement) => {
        input.value = "2";
        input.dispatchEvent(new Event("input"));
      });
    await expect.poll(() => held).toBe(true);
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "0");
    expect(await canvas.boundingBox()).toEqual(geometry);
    expect(await canvas.screenshot()).toEqual(before);
    await page.screenshot({
      path: testInfo.outputPath("embedded-delayed-content.png"),
    });
    release();
    await expect(page.locator(".frame-info")).toHaveAttribute("data-step", "2");
    expect(await canvas.boundingBox()).toEqual(geometry);
    await expect(canvas).toHaveAttribute("data-zoom", zoom!);
    expect(await canvas.screenshot()).not.toEqual(before);
    expect(authorized).toBeGreaterThanOrEqual(3);
    await expect(page.locator("body")).not.toContainText("Loading frame");
  } finally {
    release();
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
