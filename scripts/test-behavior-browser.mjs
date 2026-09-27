import { chromium } from 'patchright-core';
import { build } from 'esbuild';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'nbu-behavior-test-'));
await build({ stdin: { contents: "export {BehaviorTester} from './src/browser/behavior-test'; export {AdsPowerClient,PreparationGate} from './src/browser/adspower'; export {ShopRequestGuard} from './src/core/shop-errors';", resolveDir: process.cwd() }, outfile: '.local-data/behavior-test.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { BehaviorTester, AdsPowerClient, PreparationGate, ShopRequestGuard } = await import('../.local-data/behavior-test.mjs');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--remote-debugging-port=${port}`] });
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  let requests = 0, clicks = 0, moves = 0, wheels = 0, hovers = 0;
  const clicked = [];
  // The page reports its own events with a beacon: stealth automation exposes no bindings to the page.
  const onEvent = (kind, text) => {
    if (kind === 'click') { clicks++; clicked.push(text); } if (kind === 'move') moves++; if (kind === 'wheel') wheels++; if (kind === 'hover') hovers++;
  };
  // All URLs, including the shop domain, are fulfilled locally. No NBU connection is made.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__event') { onEvent(url.searchParams.get('kind'), url.searchParams.get('text')); return route.fulfill({ status: 204 }); }
    requests++;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><head><title>Offline fixture</title></head><body style="height:3500px;margin:0">
      <div style="position:sticky;top:40px;display:flex;gap:25px;padding:40px">
      <a href="https://coins.bank.gov.ua/coin/p-2.html">Монета 2</a><a href="https://coins.bank.gov.ua/coin/p-3.html">Монета 3</a>
      <a href="https://coins.bank.gov.ua/coin/p-4.html?action=add_product">Купити</a>
      <a href="https://example.org/coin/p-5.html">Зовнішній сайт</a><button>Купити</button></div>
      <script>const testEvent=(kind,text='')=>navigator.sendBeacon('/__event?'+new URLSearchParams({kind,text}));document.addEventListener('click',e=>testEvent('click',e.target.textContent));document.addEventListener('mousemove',()=>testEvent('move'));
      document.addEventListener('wheel',()=>testEvent('wheel'));document.querySelectorAll('a').forEach(a=>a.addEventListener('mouseenter',()=>testEvent('hover')));</script></body></html>` });
  });
  const page = await context.newPage();
  await page.goto('https://coins.bank.gov.ua/start/p-1.html');
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const client = new AdsPowerClient('http://localhost:50325', '');
  client.active = async () => webSocketDebuggerUrl;
  let time = 0;
  const clock = { now: () => time, sleep: async (ms, signal) => { signal.throwIfAborted(); time += ms; await new Promise(resolve => setTimeout(resolve, 1)); } };
  const result = await new BehaviorTester(client, new ShopRequestGuard(), new PreparationGate(0), clock, () => 0.4)
    .run('offline-profile', { navigate: true, durationMs: 90_000 }, AbortSignal.timeout(60_000));
  assert.ok(result.navigations >= 2); assert.ok(result.scrolls >= 4);
  // Every navigation is a real click on a coin link, never on a buy link, button or foreign site.
  assert.ok(clicks >= result.navigations); assert.ok(clicked.every(text => /^Монета \d$/.test(text)), clicked.join());
  assert.ok(moves > 50); assert.ok(wheels > 0); assert.ok(hovers > 0);
  assert.equal(await page.locator('[id^="nbu-test-"]').count(), 0);
  assert.equal(context.pages().length, 1);
  await page.screenshot({ path: join(directory, 'after-test.png') });
  console.log(JSON.stringify({ success: true, moves, wheels, hovers, clicks, navigations: result.navigations, locallyFulfilledRequests: requests }));
} finally { await browser.close(); }
