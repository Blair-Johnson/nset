import { test, expect, type Page } from "@playwright/test";

async function fixture(page: Page, large = false, detail = false) {
  await page.route("**/__run_detail_fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body><main></main></body></html>",
    }),
  );
  await page.goto("/__run_detail_fixture");
  await page.evaluate(
    async ({ large, detail }) => {
      await import("/src/style.css");
      await import("/src/run-detail.css");
      const params = large
        ? Object.fromEntries(
            Array.from({ length: 1500 }, (_, i) => [
              `train.optim.field_${i}`,
              i,
            ]),
          )
        : {
            "data.source.root_path": "/mnt/" + "long-directory/".repeat(30),
            "train.optim.lr": 0.001,
            train: {
              optim: { lr: 0.002 },
              enabled: false,
              seed: null,
              widths: [64, 128],
            },
            "train.optim": "leaf and namespace coexist",
            "unsafe.<img src=x onerror=alert(1)>":
              "<script>window.injected=true</script>",
          };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as any).__copied = text;
          },
        },
      });
      (window as any).__params = params;
      const main = document.querySelector("main")!;
      main.style.padding = "0";
      if (detail) {
        const { renderRunDetail } = await import("/src/run-detail.ts");
        const run = {
          id: "run-1",
          name: "Training " + "very-long-run-name".repeat(8),
          experiment_id: "exp-1",
          status: "finished",
          params,
          tags: { owner: "team", purpose: ["test", "review"] },
          created_at: 1700000000000,
          updated_at: 1700000060000,
        };
        main.append(
          renderRunDetail(run, {
            catalog: { experiments: [], runs: [run], series: [] },
            onBack: () => {
              (window as any).__back = true;
            },
          }),
        );
      } else {
        const { renderRunConfig } = await import("/src/run-config.ts");
        main.className = "run-detail";
        main.append(renderRunConfig(params, "run-1"));
      }
    },
    { large, detail },
  );
}

test("configuration keeps collision values typed, safe and exactly copyable", async ({
  page,
}) => {
  await fixture(page);
  const literal = page.locator(".run-config-row").filter({
    has: page.getByRole("button", {
      name: 'Copy value $["train.optim.lr"]',
      exact: true,
    }),
  });
  const nested = page.locator(".run-config-row").filter({
    has: page.getByRole("button", {
      name: 'Copy value $["train"]["optim"]["lr"]',
      exact: true,
    }),
  });
  await expect(literal.locator(".run-config-value")).toHaveText("0.001");
  await expect(nested.locator(".run-config-value")).toHaveText("0.002");
  await nested
    .getByRole("button", {
      name: 'Copy path $["train"]["optim"]["lr"]',
      exact: true,
    })
    .click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe(
    '$["train"]["optim"]["lr"]',
  );
  await page
    .getByRole("button", {
      name: 'Copy value $["train"]["enabled"]',
      exact: true,
    })
    .click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe("false");
  await expect(page.locator('.run-config-value[data-type="null"]')).toHaveText(
    "null",
  );
  await expect(
    page.locator(".run-config-rows img, .run-config-rows script"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Copy JSON", exact: true }).click();
  expect(
    await page.evaluate(() => JSON.parse((window as any).__copied)),
  ).toEqual(await page.evaluate(() => (window as any).__params));
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("run-run-1-config.json");
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(
    await page.evaluate(() => (window as any).__params),
  );
});

test("search reveals values inside collapsed namespaces and preserves keyboard toggle focus", async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(
    page.locator('.run-config-value[data-type="number"]'),
  ).toHaveCount(0);
  await page.getByRole("searchbox").fill("0.002");
  await expect(
    page.locator(".run-config-value").filter({ hasText: /^0\.002$/ }),
  ).toBeVisible();
  await page.getByRole("searchbox").fill("not-present");
  await expect(
    page.getByText("No matching configuration paths or values."),
  ).toBeVisible();
  await page.getByRole("searchbox").fill("");
  const toggle = page.getByRole("button", {
    name: "Toggle train",
    exact: true,
  });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: 'Copy value $["train"]["widths"][1]',
      exact: true,
    }),
  ).toBeVisible();
});

test("1500 fields stay bounded and searchable beyond the rendered page", async ({
  page,
}) => {
  await fixture(page, true);
  await expect(page.locator(".run-config-row")).toHaveCount(200);
  await page.getByRole("button", { name: "Show 200 more" }).click();
  await expect(page.locator(".run-config-row")).toHaveCount(400);
  await page.getByRole("searchbox").fill("field_1499");
  await expect(page.locator(".run-config-row")).toHaveCount(3);
  await expect(page.locator(".run-config-value").last()).toHaveText("1499");
  await page.getByRole("searchbox").fill("");
  await expect(page.locator(".run-config-row")).toHaveCount(200);
});

test("390px layout wraps full long values without global overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  const value = page
    .locator(".run-config-row")
    .filter({
      has: page.getByRole("button", {
        name: 'Copy value $["data.source.root_path"]',
        exact: true,
      }),
    })
    .locator(".run-config-value");
  expect(await value.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: "test-results/run-detail-narrow.png",
    fullPage: true,
  });
});

test("dedicated page has separate tags, full timestamps and routing callbacks", async ({
  page,
}) => {
  await fixture(page, false, true);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Training",
  );
  await expect(page.getByRole("region", { name: "Run tags" })).toContainText(
    "team",
  );
  await expect(page.locator("time").first()).toHaveAttribute(
    "datetime",
    "2023-11-14T22:13:20.000Z",
  );
  await page.getByRole("button", { name: "← Runs", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Charts", exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__back)).toBe(true);
  await expect(page.locator("[data-run-color-id='run-1']")).toBeVisible();
  await page.evaluate(() =>
    window.addEventListener("nset:run-colors-changed", () => {
      (window as any).__colorChanged = true;
    }),
  );
  await page.locator("[data-run-color-id='run-1']").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("button", { name: /^Use #/ })
    .first()
    .click();
  expect(await page.evaluate(() => (window as any).__colorChanged)).toBe(true);
  await page.screenshot({
    path: "test-results/run-detail-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("clipboard denial is recoverable and does not claim success", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error("denied");
    };
  });
  await page.getByRole("button", { name: "Copy JSON", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Copy unavailable. Select text or export JSON.",
  );
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeEnabled();
});
