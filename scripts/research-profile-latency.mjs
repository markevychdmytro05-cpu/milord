// Read-only, sequential document measurements through two existing AdsPower profiles.
// No buy/cart/checkout actions. Only tabs created here are closed; credentials are never recorded.
import { chromium } from 'patchright-core';
import { mkdir, writeFile } from 'node:fs/promises';
const root = '.local-data/speed-research';
await mkdir(root, { recursive: true });
const ids = (process.argv[2] || '').split(',').filter(Boolean);
if (!ids.length || ids.some(id => !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw new Error('Pass comma-separated profile IDs');
const target = process.argv[3] || 'https://coins.bank.gov.ua/nabir-iz-dvoh-pam-jatnih-monet-meshkanci-morskih-glibin-u-suvenirnomu-pakovanni/p-1213.html';
const targetUrl = new URL(target);
if (targetUrl.origin !== 'https://coins.bank.gov.ua' || targetUrl.search || targetUrl.username || targetUrl.password) throw new Error('Use a plain NBU product URL');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessions = [], rows = [];
const api = async (path, id) => {
  const response = await fetch(`http://127.0.0.1:50325/api/v1/browser/${path}?user_id=${id}&open_tabs=1&ip_tab=0`, {
    headers: process.env.ADSPOWER_API_KEY ? { Authorization: `Bearer ${process.env.ADSPOWER_API_KEY}` } : {},
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (result.code !== 0) throw new Error(`AdsPower code ${result.code}`);
  return result.data;
};
try {
  for (const id of ids) {
    const active = await api('active', id);
    const data = active.status === 'Active' ? active : await api('start', id);
    const browser = await chromium.connectOverCDP(data.ws.puppeteer, { noDefaults: true });
    const page = await browser.contexts()[0].newPage();
    sessions.push({ id, browser, page });
    await sleep(1500);
  }
  for (let round = 0; round < 6; round++) {
    for (const { id, page } of round % 2 ? [...sessions].reverse() : sessions) {
      const start = Date.now();
      try {
        const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const state = await page.evaluate(() => ({
          challenge: document.title.startsWith('Establishing a secure connection') || !!document.querySelector('script[src*=".bunny-shield"]'),
          nav: performance.getEntriesByType('navigation').map(entry => ({
            requestStart: entry.requestStart, responseStart: entry.responseStart, responseEnd: entry.responseEnd,
            domInteractive: entry.domInteractive, domContentLoadedEventEnd: entry.domContentLoadedEventEnd,
            domainLookupStart: entry.domainLookupStart, domainLookupEnd: entry.domainLookupEnd,
            connectStart: entry.connectStart, connectEnd: entry.connectEnd, secureConnectionStart: entry.secureConnectionStart,
            transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, nextHopProtocol: entry.nextHopProtocol,
          }))[0],
        }));
        const headers = response?.headers() || {};
        const row = { id, round, at: new Date(start).toISOString(), elapsedMs: Date.now() - start,
          status: response?.status(), ...state, headers: Object.fromEntries(['server', 'server-timing', 'cache-control', 'x-cache', 'age'].filter(key => headers[key]).map(key => [key, headers[key]])) };
        rows.push(row);
        console.log(JSON.stringify({ id, round, status: row.status, elapsedMs: row.elapsedMs,
          ttfbMs: Math.round(state.nav.responseStart - state.nav.requestStart), beforeRequestMs: Math.round(state.nav.requestStart) }));
        if (row.status === 429 || row.status === 403 || state.challenge) throw new Error('Stop: shop throttle/challenge');
      } catch (error) {
        rows.push({ id, round, elapsedMs: Date.now() - start, error: error.name });
        throw error;
      } finally {
        await writeFile(`${root}/profile-latency.json`, JSON.stringify(rows, null, 2));
      }
      await sleep(3000);
    }
  }
} finally {
  for (const { page, browser } of sessions) { await page.close().catch(() => {}); await browser.close(); }
}
