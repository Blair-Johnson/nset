// Standalone release smoke. The caller owns a disposable loopback server/fixture.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const [base, source] = process.argv.slice(2);
const url = new URL(base);
assert.equal(url.hostname, "127.0.0.1");
assert.ok(!["8081", "8082", ""].includes(url.port));
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1500, height: 1100 },
});
await context.tracing.start({ screenshots: true, snapshots: true });
try {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__copied = text;
        },
      },
    }),
  );
  await page.goto(
    `${base}/#/experiments/${encodeURIComponent(source)}/runs/${encodeURIComponent(`${source}:demo-859`)}`,
  );
  await page.getByLabel("Access token", { exact: true }).fill("test-secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const search = page.getByRole("searchbox", {
    name: "Search configuration paths and values",
  });
  await search.fill("config");
  await search.press("Enter");
  const section = page.getByRole("region", {
    name: "config from event 1",
    exact: true,
  });
  await section.waitFor();
  assert.equal(await page.evaluate(() => document.characterSet), "UTF-8");
  const labels = await section.locator(".run-config-path").allTextContents();
  assert.ok(labels.includes("config.data.baseband"));
  assert.ok(labels.includes("config.callbacks.on_step_end[0]"));
  assert.ok(labels.includes('config["a.b"]'));
  assert.ok(labels.includes("config.a.b"));
  assert.ok(labels.includes('config["\u65e5\u672c\u8a9e"]'));
  assert.ok((await section.textContent()).includes("caf\u00e9 \ud83d\udce1"));
  assert.ok(
    (await section.textContent()).includes("approximate / out of range"),
  );
  assert.ok(!(await page.locator("body").innerText()).includes("\ufffd"));
  assert.doesNotMatch(
    await section.textContent(),
    /Display only|parsed preview|Numbers may be rounded/,
  );
  await section.getByRole("button", { name: "Copy raw event" }).click();
  const rawResponse = await page.request.post(`${base}/api/rx/records`, {
    headers: { Authorization: "Bearer test-secret" },
    data: {
      source_id: source,
      runs: ["demo-859"],
      filters: { conditions: [{ path: "config", op: "exists" }] },
      limit: 5,
    },
  });
  assert.equal(rawResponse.status(), 200);
  const raw = (await rawResponse.json()).records[0].raw;
  assert.equal(await page.evaluate(() => window.__copied), raw);
  assert.ok(raw.includes("9007199254740993"));
  assert.ok(raw.includes("caf\u00e9 \ud83d\udce1"));
  const repeated = page.waitForResponse((r) =>
    r.url().endsWith("/api/rx/records"),
  );
  await search.press("Enter");
  await repeated;
  assert.equal(await page.locator(".run-event-config").count(), 1);
  await page.screenshot({
    path: "artifacts/event-config-embedded.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      kind: "embedded-ui",
      event_config: "passed",
      utf8: true,
      exact_enter: true,
    }),
  );
} finally {
  await context.tracing.stop({
    path: "artifacts/event-config-embedded-trace.zip",
  });
  await browser.close();
}
