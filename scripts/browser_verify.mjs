import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'web/package.json'));
const {chromium} = require('playwright');
const artifacts = path.join(root, 'artifacts/screenshots');
await mkdir(artifacts, {recursive: true});
const browser = await chromium.launch({headless: true});
const page = await browser.newPage({viewport: {width: 1500, height: 1100}, deviceScaleFactor: 1});
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const screenshot = name => page.screenshot({path: path.join(artifacts, name + '.png'), fullPage: true});
const text = selector => page.locator(selector).innerText();
const cell = async (container, run, column) => page.locator(container + ' tbody tr')
  .filter({hasText: run}).locator('td').nth(column).innerText();
try {
  await page.goto(process.env.NSET_BROWSER_URL);
  await page.locator('#token').fill(process.env.NSET_BROWSER_TOKEN);
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('#login-dialog').waitFor({state: 'hidden'});
  await page.getByLabel('Experiment', {exact: true}).selectOption(JSON.parse(process.env.NSET_BROWSER_FIXTURE).experiment);
  await page.getByLabel('Compare Curve A', {exact: true}).waitFor({state: 'visible'});
  await page.locator('#select-all').click();
  await page.waitForFunction(() => document.querySelector('#load-status').textContent.startsWith('Snapshot complete'));
  await page.locator('#pin-a').fill('5');
  await page.locator('#pin-b').fill('10');
  await page.locator('#threshold').fill('2');
  assert.equal(Number(await cell('#readout', 'Curve A', 2)), 2);
  assert.equal(Number(await cell('#readout', 'Curve A', 3)), 3);
  assert.equal(Number(await cell('#readout', 'Curve B', 2)), 2);
  assert.match(await cell('#crossings', 'Curve A', 1), /^5, 15$/);
  assert.match(await cell('#crossings', 'Curve B', 2), /\[0, 5\]/);
  await screenshot('01-timeseries');
  const before = await text('#readout');
  const box = await page.locator('#plot .u-over').boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3, {steps: 12});
  await page.mouse.up();
  assert.equal(await text('#readout'), before, 'zoom must not change numerical readouts');
  await page.setViewportSize({width: 1100, height: 1000});
  assert.equal(await text('#readout'), before, 'resize must not change numerical readouts');
  await page.locator('#reset-zoom').click();
  await page.getByRole('tab', {name: 'Plot configuration', exact: true}).click();
  await page.getByLabel('Y scale', {exact: true}).selectOption('log');
  await page.getByRole('button', {name: 'Apply configuration', exact: true}).click();
  await page.getByRole('tab', {name: 'Timeseries', exact: true}).click();
  assert.equal(await text('#readout'), before, 'log scale must not change numerical readouts');
  await screenshot('02-log-scale');
  await page.locator('#view-name').fill('Log comparison');
  await page.locator('#save-view').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-view').click();
  const download = await downloadPromise;
  const exported = path.join(artifacts, 'view.json');
  await download.saveAs(exported);
  const view = JSON.parse(await readFile(exported, 'utf8'));
  assert.equal(view.config.yScale, 'log');
  assert.ok(!JSON.stringify(view).includes(process.env.NSET_BROWSER_TOKEN));
  await page.getByRole('tab', {name: 'Plot configuration', exact: true}).click();
  await page.getByLabel('Advanced uPlot JSON').fill('{"hooks":{"draw":[]}}');
  await page.getByRole('button', {name: 'Apply configuration', exact: true}).click();
  assert.match(await page.locator('#settings-pane [role=alert]').innerText(), /protected|unsupported/i);
  await page.getByLabel('Advanced uPlot JSON').fill('{}');
  await page.getByLabel('Y scale', {exact: true}).selectOption('linear');
  await page.getByRole('button', {name: 'Apply configuration', exact: true}).click();
  await page.locator('#saved-views').selectOption('Log comparison');
  await page.locator('#load-view').click();
  await page.waitForFunction(() => document.querySelector('#load-status').textContent.startsWith('Snapshot complete'));
  assert.equal(await page.getByLabel('Y scale', {exact: true}).inputValue(), 'log');
  await screenshot('03-configuration');
  await page.getByRole('tab', {name: 'Timeseries', exact: true}).click();
  await page.locator('#interpolation').selectOption('pchip');
  assert.equal(Number(await cell('#readout', 'Curve A', 2)), 2.5);
  await page.locator('#interpolation').selectOption('linear');
  await page.locator('#import-view').setInputFiles(exported);
  await page.waitForFunction(() => document.querySelector('#load-status').textContent.startsWith('Snapshot complete'));
  await page.getByRole('tab', {name: 'Images', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.frame-info').textContent.includes('1 of 4'));
  await screenshot('04-image-timeline');
  const viewport = page.locator('#image-viewer');
  const imageBox = await viewport.boundingBox();
  await page.mouse.move(imageBox.x + imageBox.width * 0.55, imageBox.y + imageBox.height * 0.5);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(500);
  const camera = () => viewport.evaluate(el => ({zoom: Number(el.dataset.zoom),
    x: Number(el.dataset.centerX), y: Number(el.dataset.centerY)}));
  const cameraBefore = await camera();
  assert.ok(Number.isFinite(cameraBefore.zoom) && cameraBefore.zoom > 0, 'viewer camera telemetry available');
  await page.getByLabel('Image frame timeline').evaluate(el => {
    el.value = '2'; el.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await page.waitForFunction(() => document.querySelector('.frame-info').textContent.includes('3 of 4'));
  await page.waitForTimeout(300);
  const cameraAfter = await camera();
  for (const key of ['zoom', 'x', 'y']) assert.ok(Math.abs(cameraBefore[key] - cameraAfter[key]) < 1e-8,
    `image ${key} changed on scrub: ${cameraBefore[key]} vs ${cameraAfter[key]}`);
  await screenshot('05-image-zoom-preserved');
  await page.getByRole('button', {name: '← Previous', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.frame-info').textContent.includes('2 of 4'));
  await viewport.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.frame-info').textContent.includes('3 of 4'));
  await page.getByRole('button', {name: 'Play', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.frame-info').textContent.includes('4 of 4'));
  await page.getByRole('button', {name: 'Reset view', exact: true}).click();
  await page.getByRole('tab', {name: 'Timeseries', exact: true}).click();
  await page.setViewportSize({width: 820, height: 1050});
  await screenshot('06-narrow-layout');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false,
    'page itself should not overflow horizontally');
  await page.locator('#logout').click();
  await page.locator('#login-dialog').waitFor({state: 'visible'});
  assert.equal(await page.evaluate(() => sessionStorage.getItem('nset.token')), null);
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log(JSON.stringify({kind: 'final', phase: 'browser', status: 'passed',
    assertions: ['interpolated readouts', 'all crossings and plateau', 'zoom/resize/log invariance',
      'PCHIP', 'saved view export/import', 'protected options', 'image camera preservation',
      'image keyboard and playback', 'responsive layout', 'token cleanup'], screenshots: artifacts}));
} catch (error) {
  await screenshot('failure');
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
