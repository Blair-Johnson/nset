import { test, expect, type Page } from "@playwright/test";
async function fixture(page: Page) {
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><body></body>",
    }),
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const { runColorButton } = await import("/src/run-color-picker.ts");
    const { runColor } = await import("/src/series-colors.ts");
    const catalog: any = {
      experiments: [],
      series: [],
      runs: [{ id: "r1", name: "Adam <literal>", created_at: 1 }],
    };
    const host = document.createElement("div");
    host.id = "swatches";
    document.body.append(host);
    const paint = () => {
      host.replaceChildren(runColorButton(catalog, "r1"));
      host.dataset.color = runColor(catalog, "r1");
    };
    (window as any).colorEvents = 0;
    window.addEventListener("nset:run-colors-changed", () => {
      (window as any).colorEvents++;
      paint();
    });
    paint();
  });
}
test("run swatch applies, persists, resets and restores focus after caller rerenders", async ({
  page,
}) => {
  await fixture(page);
  const swatch = page.getByRole("button", {
    name: "Change color for Adam <literal>",
    exact: true,
  });
  await swatch.click();
  await page.getByRole("button", { name: "Use #c084fc", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#swatches")).toHaveAttribute(
    "data-color",
    "#c084fc",
  );
  await expect(swatch).toBeFocused();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("nset:run-colors:v1")!).r1,
    ),
  ).toBe("#c084fc");
  await swatch.click();
  await page.getByLabel("Custom color", { exact: true }).fill("#123456");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator("#swatches")).toHaveAttribute(
    "data-color",
    "#123456",
  );
  await swatch.click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.locator("#swatches")).toHaveAttribute(
    "data-color",
    "#60a5fa",
  );
  expect(await page.evaluate(() => (window as any).colorEvents)).toBe(3);
});
test("Escape and Cancel leave color unchanged; failed saves retain the picker and old color", async ({
  page,
}) => {
  await fixture(page);
  const swatch = page.getByRole("button", {
    name: "Change color for Adam <literal>",
    exact: true,
  });
  await swatch.focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Custom color", { exact: true }).fill("#123456");
  await page.keyboard.press("Escape");
  await expect(swatch).toBeFocused();
  await swatch.click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#swatches")).toHaveAttribute(
    "data-color",
    "#60a5fa",
  );
  expect(await page.evaluate(() => (window as any).colorEvents)).toBe(0);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw Error("quota");
    };
  });
  await swatch.click();
  await page.getByRole("button", { name: "Use #c084fc", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not save");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#swatches")).toHaveAttribute(
    "data-color",
    "#60a5fa",
  );
});
test("cross-tab preference updates repaint shared swatches", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    localStorage.setItem(
      "nset:run-colors:v1",
      JSON.stringify({ r1: "#34d399" }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "nset:run-colors:v1",
        storageArea: localStorage,
      }),
    );
  });
  await expect(page.locator("#swatches")).toHaveAttribute(
    "data-color",
    "#34d399",
  );
});
