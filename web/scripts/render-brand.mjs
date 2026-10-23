// Render web/public/favicon.svg beside the header's {n} mark, to PNG for review.
// Usage (from web/): node scripts/render-brand.mjs ../artifacts/brand
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(process.argv[2] ?? "../artifacts/brand");
const svg = readFileSync(resolve("public/favicon.svg"), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
const data = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
await page.setContent(`<!doctype html><body style="margin:0;background:#151617;display:flex;gap:24px;padding:24px;align-items:center;color:#eceff1">
  <img src="${data}" width="128" height="128">
  <div style="background:#dee1e6;padding:8px;display:flex;gap:12px;align-items:center"><img src="${data}" width="32" height="32"><img src="${data}" width="16" height="16"></div>
  <img src="${data}" width="32" height="32">
  <img src="${data}" width="16" height="16">
  <span style="font-family:'Latin Modern Math','STIX Two Math','STIX Two Text','Cambria Math','Times New Roman',Times,serif;font-size:88px;letter-spacing:2px">{<i style="font-family:'STIX Two Text','Times New Roman',Times,serif;font-size:1.08em;padding:0 6px 0 2px">n</i>}</span>
</body>`);
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/favicon.png`, clip: { x: 0, y: 0, width: 720, height: 180 } });
await browser.close();
console.log(`${out}/favicon.png`);
