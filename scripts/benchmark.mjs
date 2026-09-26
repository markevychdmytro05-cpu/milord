import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// Offline fixture only. This benchmark never connects to AdsPower or the NBU store.
await mkdir('.local-data', { recursive: true });
await build({
  stdin: { contents: `export { runTask } from './src/core/buyer';
    export { realClock } from './src/core/ports';
    export { Store } from './src/main/store';
    export { readNbuPage, waitForActionablePage } from './src/browser/nbu-page';`, resolveDir: process.cwd() },
  outfile: '.local-data/benchmark-core.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external',
});
const { runTask, realClock, Store, readNbuPage, waitForActionablePage } = await import('../.local-data/benchmark-core.mjs');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  let networkRequests = 0;
  context.on('request', () => networkRequests++);
  await context.route('**/*', (route) => route.abort());
  const page = await context.newPage();
  const delays = [15, 50, 100, 250, 25, 75, 125, 300];
  const results = [];
  const store = new Store('.local-data/benchmark-tasks.json');
  for (const delay of delays) {
    await page.setContent(`<form name="cart_quantity"><input name="cid_id" value="fixture" />
      <input name="products_id" value="1" /><div id="r_buy_intovar">
      <button type="submit" class="buy" disabled>Купити</button></div></form>`);
    const session = {
      read: () => page.evaluate(readNbuPage, false),
      waitForActionable: (timeout) => waitForActionablePage(page, timeout),
      serverOffset: async () => 0,
      reload: async () => page.evaluate((delayMs) => {
        window.fixture = { readyAt: 0, clickedAt: 0, clicks: 0 };
        const button = document.querySelector('button');
        button.addEventListener('click', (event) => {
          event.preventDefault();
          window.fixture.clickedAt = performance.now();
          window.fixture.clicks++;
          button.classList.add('added2cart');
        });
        setTimeout(() => { window.fixture.readyAt = performance.now(); button.disabled = false; }, delayMs);
      }, delay),
      clickBuy: async () => { await page.evaluate(readNbuPage, true); },
      disconnect: async () => {},
    };
    const task = { id: randomUUID(), url: 'https://coins.bank.gov.ua/offline-fixture.html', profileId: 'offline',
      saleAt: Date.now(), leadMin: 1, retrySec: 5, windowMin: 1, mode: 'cart', status: 'scheduled',
      createdAt: Date.now(), updatedAt: Date.now(), clicks: 0, reloads: 0, offsetMs: 0, note: '', events: [] };
    await runTask(task, { connect: async () => session }, realClock, new AbortController().signal,
      (next) => store.saveTask(next));
    const sample = await page.evaluate(() => window.fixture);
    assert.equal(task.status, 'in_cart');
    assert.equal(sample.clicks, 1);
    results.push({ appearanceDelayMs: delay, readyToClickMs: Math.round((sample.clickedAt - sample.readyAt) * 10) / 10 });
  }
  assert.equal(networkRequests, 0);
  const sorted = results.map((sample) => sample.readyToClickMs).sort((a, b) => a - b);
  const report = {
    date: new Date().toISOString(), browser: browser.version(), fixture: 'offline HTML in headless Chrome',
    measurements: 'button enabled to click handler, including core logic and durable JSON intent write',
    realStoreRequests: 0, runs: results.length,
    medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1), results,
  };
  await writeFile('.local-data/benchmark.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
