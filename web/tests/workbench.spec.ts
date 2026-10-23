import { test, expect, type Page } from "@playwright/test";
const runs = [
  {
    id: "r1",
    experiment_id: "e1",
    name: "baseline <b>literal</b>",
    status: "finished",
    params: { lr: 0.001, batch: 64 },
    tags: { model: "resnet" },
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  {
    id: "r2",
    experiment_id: "e1",
    name: "candidate / irregular grid",
    status: "running",
    params: { lr: 0.002, batch: 128 },
    tags: { model: "resnet" },
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
async function fixture(page: Page, delayedFrames = false) {
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    expect(req.headers().authorization).toBe("Bearer fixture-secret");
    expect(url.search).not.toContain("fixture-secret");
    const path = url.pathname;
    let data: unknown;
    if (path === "/api/experiments")
      data = {
        experiments: [
          {
            id: "e1",
            name: "Vision / optimization study",
            created_at: 1700000000000,
          },
        ],
      };
    else if (path === "/api/runs") data = { runs };
    else if (path.endsWith("/metric-keys"))
      data = { keys: ["validation/loss"] };
    else if (path.endsWith("/metrics")) {
      const isFirst = path.includes("/r1/");
      const xs = isFirst ? [0, 1, 3, 8] : [0, 2, 5, 8];
      const ys = isFirst ? [4, 2, 3, 1] : [3.5, 2.5, 2.7, 0.8];
      const points = xs.map((step, i) => ({
        seq: i + 1,
        step,
        timestamp: 1700000000000 + step * 1000,
        value: ys[i],
      }));
      const after = url.searchParams.get("after");
      if (after) expect(url.searchParams.get("snapshot")).toBe("4");
      data = {
        points: after ? points.slice(2) : points.slice(0, 2),
        snapshot: 4,
        total: 4,
        next_after: after ? null : 2,
      };
    } else if (path.endsWith("/images")) {
      const run = path.includes("/r1/") ? "r1" : "r2";
      data = {
        images: [0, 1, 2].map((i) => ({
          id: `${run}-frame-${i}`,
          run_id: run,
          key: "prediction",
          step: i * 10,
          timestamp: 1700000000000 + i * 1000,
          content_type: "image/png",
          byte_length: png.length,
        })),
      };
    } else if (path.endsWith("/content")) {
      if (delayedFrames && path.includes("frame-1"))
        await new Promise((resolve) => setTimeout(resolve, 3500));
      await route.fulfill({ status: 200, contentType: "image/png", body: png });
      return;
    } else {
      await route.fulfill({ status: 404, json: { error: "fixture missing" } });
      return;
    }
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.getByLabel("Access token").fill("fixture-secret");
  await page.getByRole("button", { name: "Connect to tracker" }).click();
  await expect(page.locator("#connection")).toHaveText("Connected");
  await page
    .getByRole("checkbox", {
      name: "Compare baseline <b>literal</b>",
      exact: true,
    })
    .check();
  await page
    .getByRole("checkbox", {
      name: "Compare candidate / irregular grid",
      exact: true,
    })
    .check();
  await expect(page.locator("#load-status")).toContainText("Snapshot complete");
}
test("complete snapshots, inspector, protected JSON and saved view export", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fixture(page);
  await expect(page.locator("#data-note")).toContainText("8 observations");
  await expect(page.locator("#run-list b")).toHaveCount(0);
  await page.locator("#pin-a").fill("1");
  await page.locator("#pin-b").fill("3");
  await page.locator("#threshold").fill("2.5");
  await expect(page.locator("#readout")).toContainText("2.5666667");
  await expect(page.locator("#crossings")).toContainText("0.75");
  await page.locator("#interpolation").selectOption("pchip");
  await expect(page.locator("#data-note")).toContainText("pchip");
  await page.screenshot({
    path: testInfo.outputPath("workbench-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Plot configuration" }).click();
  await page.getByLabel("Advanced uPlot JSON").fill('{"hooks":{"draw":[]}}');
  await page
    .getByRole("button", { name: "Apply configuration", exact: true })
    .click();
  await expect(page.locator("#settings-pane .error")).toContainText(
    "protected",
  );
  await page
    .getByLabel("Advanced uPlot JSON")
    .fill(
      '{"axes":[{"values":"scientific"}],"cursor":{"drag":{"x":true,"y":true}}}',
    );
  await page.getByLabel("Y scale", { exact: true }).selectOption("asinh");
  await page
    .getByRole("button", { name: "Apply configuration", exact: true })
    .click();
  await expect(page.locator("#settings-pane .error")).toHaveText("");
  await page.getByLabel("Saved view name").fill("Comparison A");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("Saved views")).toHaveValue("Comparison A");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const file = await download;
  const stream = await file.createReadStream();
  let text = "";
  for await (const chunk of stream!) text += chunk;
  expect(text).not.toContain("fixture-secret");
  expect(JSON.parse(text).config.yScale).toBe("asinh");
  expect(errors).toEqual([]);
});
test("image timeline loads authenticated blobs, supports stepping and reset", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fixture(page);
  await page.getByRole("tab", { name: "Images", exact: true }).click();
  await expect(page.locator(".frame-info")).toContainText("step 0");
  await page.getByRole("button", { name: "Next \u2192", exact: true }).click();
  await expect(page.locator(".frame-info")).toContainText("step 10");
  await page.locator("#image-viewer").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".frame-info")).toContainText("step 20");
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await page
    .getByRole("button", { name: "Rotate \u21bb", exact: true })
    .click();
  await page.getByRole("button", { name: "Flip \u2194", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("image-viewer.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByLabel("Access token")).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem("nset.token")),
  ).toBeNull();
  expect(errors).toEqual([]);
});
test("mobile layout keeps controls and table available", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.locator("#threshold").fill("2.5");
  await expect(page.locator("#crossings")).toContainText("0.75");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("workbench-mobile.png"),
    fullPage: true,
  });
});

test("latest requested image wins over delayed fetches", async ({ page }) => {
  await fixture(page, true);
  await page.getByRole("tab", { name: "Images", exact: true }).click();
  await expect(page.locator(".frame-info")).toContainText("step 0");
  const timeline = page.getByRole("slider", { name: "Image frame timeline" });
  await timeline.fill("1");
  await timeline.fill("2");
  await expect(page.locator(".frame-info")).toContainText("step 20");
  await page.waitForTimeout(4000);
  await expect(page.locator(".frame-info")).toContainText("step 20");
});

test("zoom leaves numerical answers unchanged and reset restores view", async ({
  page,
}) => {
  await fixture(page);
  await page.locator("#pin-a").fill("1.5");
  await page.locator("#pin-b").fill("6");
  await page.locator("#threshold").fill("2.5");
  const before = await page.locator("#readout").innerText();
  const crossings = await page.locator("#crossings").innerText();
  const box = await page.locator(".u-over").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width * 0.65,
    box!.y + box!.height * 0.5,
    { steps: 10 },
  );
  await page.mouse.up();
  expect(await page.locator("#readout").innerText()).toBe(before);
  expect(await page.locator("#crossings").innerText()).toBe(crossings);
  await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
  expect(await page.locator("#readout").innerText()).toBe(before);
});

test("runtime range rejection preserves saved settings, chart and numerical readouts", async ({
  page,
}) => {
  await fixture(page);
  await page.locator("#interpolation").selectOption("pchip");
  const saved = await page.evaluate(() => localStorage.getItem("nset.config"));
  const readout = await page.locator("#readout").textContent();
  await page.evaluate(() => {
    (window as any).__previousCanvas = document.querySelector("#plot canvas");
  });
  await page.getByRole("tab", { name: "Plot configuration" }).click();
  await page
    .getByLabel("Y minimum", { exact: true })
    .fill(String(Number.MAX_VALUE));
  await page
    .getByRole("button", { name: "Apply configuration", exact: true })
    .click();
  await expect(page.locator("#global-error")).toContainText("were not applied");
  expect(await page.evaluate(() => localStorage.getItem("nset.config"))).toBe(
    saved,
  );
  expect(await page.locator("#readout").textContent()).toBe(readout);
  expect(
    await page.evaluate(
      () =>
        (window as any).__previousCanvas ===
        document.querySelector("#plot canvas"),
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Reset defaults", exact: true })
    .click();
  await expect(page.locator("#global-error")).toBeHidden();
  expect(
    JSON.parse(
      (await page.evaluate(() => localStorage.getItem("nset.config")))!,
    ).yMin,
  ).toBe(null);
});
