import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Real Chromium/CDP, synthetic store responses only. No AdsPower or real store access.
await mkdir('.local-data', { recursive: true });
await build({ stdin: { contents: `export { AdsPowerProvider, PreparationGate } from './src/browser/adspower';
  export { runTask } from './src/core/buyer'; export { realClock } from './src/core/ports';`, resolveDir: process.cwd() },
  outfile: '.local-data/preparation-core.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { AdsPowerProvider, PreparationGate, runTask, realClock } = await import('../.local-data/preparation-core.mjs');
const directory = await mkdtemp(join(tmpdir(), 'nbu-offline-cdp-'));
let context;
let pool;
try {
  context = await chromium.launchPersistentContext(directory, { channel: 'chrome', headless: true,
    args: ['--remote-debugging-port=0'], serviceWorkers: 'block' });
  const [port, path] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  const endpoint = `ws://127.0.0.1:${port}${path}`;
  const urls = ['https://coins.bank.gov.ua/offline-one.html', 'https://coins.bank.gov.ua/offline-two.html'];
  const requests = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (!urls.includes(url)) return route.abort();
    assert.equal(route.request().method(), 'GET');
    requests.push({ url, at: Date.now() });
    const attempt = requests.filter((request) => request.url === url).length;
    if (url === urls[1] && attempt === 1) return route.fulfill({ status: 429,
      headers: { 'retry-after': '30', 'content-type': 'text/html' }, body: '<title>Помилка 429</title><h1>429 Помилка</h1>' });
    await route.fulfill({ status: 200, contentType: 'text/html', headers: { date: new Date().toUTCString() }, body:
      `<form name="cart_quantity"><input name="cid_id" value="fixture"><input name="products_id" value="1">
       <div id="r_buy_intovar"><button type="submit" class="buy">Купити</button></div></form>
       <script>window.clicks=0;document.querySelector('button').onclick=(e)=>{
       e.preventDefault();window.clicks++;e.target.classList.add('added2cart');};</script>` });
  });
  const provider = new AdsPowerProvider({ start: async () => endpoint }, undefined, new PreparationGate(0));
  const signal = new AbortController().signal;
  pool = await provider.prepare('offline', urls, signal, { deadline: Date.now() + 90_000,
    onRateLimit: async () => console.log('Offline fixture returned 429; waiting for automatic retry.') });
  const productPages = context.pages().filter((page) => urls.includes(page.url()));
  assert.equal(productPages.length, 2);
  for (const page of productPages) assert.equal(await page.evaluate(() => window.clicks), 0);
  assert.equal(requests.length, 3);
  const secondRequests = requests.filter((request) => request.url === urls[1]);
  assert.ok(secondRequests[1].at - secondRequests[0].at >= 30_000);
  for (const url of urls) {
    const task = { id: randomUUID(), url, profileId: 'offline', saleAt: Date.now(), leadMin: 1,
      retrySec: 5, windowMin: 1, mode: 'cart', status: 'scheduled', createdAt: Date.now(), updatedAt: Date.now(),
      clicks: 0, reloads: 0, offsetMs: 0, note: '', events: [] };
    await runTask(task, pool, realClock, signal, async () => {});
    assert.equal(task.status, 'in_cart'); assert.equal(task.clicks, 1); assert.equal(task.reloads, 0);
  }
  assert.equal(requests.length, 3); // No new navigation or HEAD probes at handoff.
  for (const page of productPages) assert.equal(await page.evaluate(() => window.clicks), 1);
  console.log('PASS: both tabs prepared; automatic 429 retry after 30 s; one click per product; no handoff requests. Real store requests: 0.');
} finally {
  await pool?.disconnect().catch(() => {});
  await context?.close();
  await rm(directory, { recursive: true, force: true });
}
