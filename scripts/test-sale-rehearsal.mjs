// Dress rehearsal of a real sale day, fully offline: a fake coins.bank.gov.ua whose own clock may be
// skewed, a product page with NO buy button until the server clock reaches the sale, and our real
// provider + buyer driving a plain Chrome over CDP, exactly like AdsPower. No request reaches the NBU.
//   node --experimental-websocket scripts/test-sale-rehearsal.mjs [skewMs] [normal|overload|drop] [atomicOffsetMs]
//   skewMs: the fake shop's clock minus real time. overload: 503, a 25 s hang, then slow pages.
//   drop: the first 8 connections are cut. slow: every page after the start takes 4 s.
//   hang: the first request after the start is never answered, the rest take 1 s. atomicOffsetMs: pass the SNTP reading to the buyer.
import { build } from 'esbuild';
import https from 'node:https';
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
mkdirSync('.local-data', { recursive: true });
if (!existsSync('.local-data/rh-cert.pem')) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '.local-data/rh-key.pem',
  '-out', '.local-data/rh-cert.pem', '-days', '30', '-subj', '/CN=coins.bank.gov.ua', '-addext', 'subjectAltName=DNS:coins.bank.gov.ua'], { stdio: 'ignore' });
const SKEW = Number(process.argv[2] || 0); // server clock minus real time, ms
const OVERLOAD = process.argv[3] === 'overload';
const DROP = process.argv[3] === 'drop';
const SLOW = process.argv[3] === 'slow';
const HANG = process.argv[3] === 'hang';
const CRASH = process.argv[3] === 'crash'; // the coin's tab dies 3 s before the sale; the scheduler must recover
let afterStart = 0;
await build({ stdin: { contents: `export { AdsPowerProvider, PreparationGate } from './src/browser/adspower';
  export { runTask } from './src/core/buyer'; export { Scheduler } from './src/main/scheduler'; export { Store } from './src/main/store'; export { realClock } from './src/core/ports'; export { ShopRequestGuard } from './src/core/shop-errors';`,
  resolveDir: process.cwd() }, outfile: '.local-data/rehearsal-core.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'error' });
const core = await import('../.local-data/rehearsal-core.mjs');
const serverNow = () => Date.now() + SKEW;
const saleAt = Math.ceil((Date.now() + 25_000) / 1000) * 1000; // whole second, like a real 10:00:00
const log = [];
const tail = `<input type="hidden" name="cid_id" value="283545"></body></html>`;
const head = `<!doctype html><html><head><meta charset="utf-8"><title>Монета</title></head><body><a href="/logoff.php">Вийти</a>`;
const before = `${head}<div class="product"><h1>Пам'ятна монета</h1><p>Тираж 5000</p><p class="price">3 000 грн</p></div>${tail}`;
const after = `${head}<form name="cart_quantity" onsubmit="return false"><input name="products_id" value="1200"/>
  <div id="r_buy_intovar" data-id="1200" style="margin:200px"><button type="submit" class="btn-primary buy" style="width:160px;height:44px">Купити</button></div></form>
  <script>document.querySelector('button.buy').addEventListener('click', e => { e.preventDefault(); navigator.sendBeacon('/__click?trusted=' + e.isTrusted);
    setTimeout(() => document.querySelector('#r_buy_intovar').innerHTML = '<a href="/shopping_cart.php" class="added2cart">У кошику</a>', 300); });</script>${tail}`;
const server = https.createServer({ key: readFileSync('.local-data/rh-key.pem'), cert: readFileSync('.local-data/rh-cert.pem') }, (req, res) => {
  const now = serverNow();
  res.setHeader('Date', new Date(now).toUTCString());
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/__click')) { log.push({ kind: 'CLICK', atServer: now - saleAt, atReal: Date.now() - saleAt, url: req.url }); res.statusCode = 204; return res.end(); }
  if (req.url.includes('p-1200')) {
    const open = now >= saleAt;
    if (DROP && open && ++afterStart <= 8) {
      log.push({ kind: `request #${afterStart} → connection dropped`, atServer: now - saleAt, atReal: Date.now() - saleAt });
      return req.socket.destroy();
    }
    if ((SLOW || HANG) && open) {
      const n = ++afterStart;
      const delay = SLOW ? 4000 : n === 1 ? Infinity : 1000;
      log.push({ kind: `request #${n} arrives${delay === Infinity ? ' (never answered)' : ''}`, atServer: now - saleAt, atReal: Date.now() - saleAt });
      if (delay === Infinity) { req.on('close', () => log.push({ kind: `  #${n} abandoned by client`, atServer: serverNow() - saleAt, atReal: Date.now() - saleAt })); return; }
      return setTimeout(() => {
        if (res.destroyed) return log.push({ kind: `  #${n} abandoned by client`, atServer: serverNow() - saleAt, atReal: Date.now() - saleAt });
        log.push({ kind: `  #${n} → page WITH button`, atServer: serverNow() - saleAt, atReal: Date.now() - saleAt });
        res.end(after);
      }, delay);
    }
    if (OVERLOAD && open) {
      const n = ++afterStart;
      const delay = n === 1 ? 2000 : n === 2 ? 25_000 : n === 3 ? 500 : 3000;
      log.push({ kind: `request #${n} arrives`, atServer: now - saleAt, atReal: Date.now() - saleAt });
      return setTimeout(() => {
        if (res.destroyed || req.destroyed) { log.push({ kind: `  #${n} abandoned by client`, atServer: serverNow() - saleAt, atReal: Date.now() - saleAt }); return; }
        log.push({ kind: n === 1 ? `  #${n} → 503` : n === 3 ? `  #${n} → (dropping)` : `  #${n} → page WITH button`, atServer: serverNow() - saleAt, atReal: Date.now() - saleAt });
        if (n === 1) { res.statusCode = 503; return res.end('<html><body><h1>503 Service Unavailable</h1></body></html>'); }
        if (n === 3) { log.push({ kind: '  #3 connection dropped', atServer: serverNow() - saleAt, atReal: Date.now() - saleAt }); return req.socket.destroy(); }
        res.end(after);
      }, delay);
    }
    log.push({ kind: open ? 'page WITH button' : 'page without button', atServer: now - saleAt, atReal: Date.now() - saleAt });
    return res.end(open ? after : before);
  }
  res.end(`${head}<p>Головна</p>${tail}`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = 9300 + Math.floor(Math.random() * 300);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'rehearsal-'))}`, '--no-first-run', '--ignore-certificate-errors', '--window-size=1200,900',
  `--host-resolver-rules=MAP coins.bank.gov.ua:443 127.0.0.1:${server.address().port}`, 'https://coins.bank.gov.ua/'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 2000));
const { webSocketDebuggerUrl: ws } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const client = { start: async () => ws, active: async () => ws };
const realProvider = new core.AdsPowerProvider(client, new core.ShopRequestGuard(), new core.PreparationGate(0));
// Black box: the journal deliberately never stores raw browser errors, so the rehearsal prints them.
const provider = { connect: async (...args) => {
  const session = await realProvider.connect(...args);
  for (const [name, fn] of Object.entries(session)) if (typeof fn === 'function') session[name] = async (...a) => {
    try { return await fn(...a); } catch (error) { console.log(`  [raw ${name} error at real T${Date.now() - saleAt >= 0 ? '+' : ''}${Date.now() - saleAt}] ${error?.stack?.split('\n').slice(0, 4).join(' | ')}`); throw error; }
  };
  return session;
} };
const task = { id: 'rehearsal', url: 'https://coins.bank.gov.ua/coin/p-1200.html', profileId: 'p', saleAt, leadMin: 1, retrySec: 1, windowMin: 2,
  mode: 'cart', status: 'scheduled', createdAt: Date.now(), updatedAt: Date.now(), clicks: 0, reloads: 0, offsetMs: 0, note: '', events: [] };
// Flight recorder: if the buyer ever stalls, the last journal lines show where.
const recorder = process.env.REHEARSAL_TRACE ? setInterval(() => {
  const last = task.events.at(-1);
  console.log(`[trace real T${Date.now() - saleAt >= 0 ? '+' : ''}${Date.now() - saleAt}] status=${task.status} last: ${last?.details?.saleDeltaMs} ${last?.message} phase=${last?.details?.phase}`);
}, 5000) : undefined;
const ATOMIC = process.argv[4] !== undefined ? Number(process.argv[4]) : undefined;
const atomicReading = ATOMIC === undefined ? undefined : { offsetMs: ATOMIC, uncertaintyMs: 0, at: Date.now(), servers: 2 };
if (CRASH) {
  // Through the real scheduler, which owns reconnection.
  const store = new core.Store(join(mkdtempSync(join(tmpdir(), 'rehearsal-store-')), 'tasks.json'));
  await store.load();
  const scheduler = new core.Scheduler(store, () => realProvider, () => {}, () => {}, (m) => console.log('scheduler error', m), () => atomicReading);
  scheduler.start();
  await scheduler.addMany([{ profileId: 'p', url: task.url, saleAt, leadMin: 1, retrySec: 1, windowMin: 2, mode: 'cart' }]);
  setTimeout(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    for (const t of list.filter(t => t.url.includes('p-1200'))) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
    log.push({ kind: 'TAB KILLED', atServer: serverNow() - saleAt, atReal: Date.now() - saleAt });
  }, saleAt - Date.now() - 3000);
  const until = Date.now() + 150_000;
  while (Date.now() < until && !['in_cart', 'failed', 'expired', 'interrupted', 'cancelled'].includes(store.tasks()[0]?.status)) await new Promise(r => setTimeout(r, 200));
  Object.assign(task, store.tasks()[0]);
  await scheduler.stop();
} else await core.runTask(task, provider, core.realClock, AbortSignal.timeout(200_000), async () => {}, () => [], () => atomicReading);
clearInterval(recorder); chrome.kill(); server.close();
console.log(`\n### ${(process.argv[3] || 'normal').toUpperCase()} server clock skew ${SKEW >= 0 ? '+' : ''}${SKEW} ms → task ${task.status}, bot offset estimate ${task.offsetMs} ms [${task.offsetLowMs}..${task.offsetHighMs}]`);
for (const e of log) console.log(`  ${e.kind.padEnd(20)} server T${e.atServer >= 0 ? '+' : ''}${e.atServer} ms   (real T${e.atReal >= 0 ? '+' : ''}${e.atReal})`);
const j = task.events.filter(e => (e.details?.saleDeltaMs ?? -Infinity) >= -5000 || !e.details?.saleDeltaMs && e.at >= saleAt - 5000).map(e => `    journal ${String(e.details?.saleDeltaMs ?? '').padStart(6)}  ${e.message}${e.details?.clickMethod ? ' [' + e.details.clickMethod + ']' : ''}${e.details?.ttfbMs !== undefined ? ` [request ${e.details.requestMs} ms, server ${e.details.ttfbMs} ms, HTTP ${e.details.httpStatus}]` : ''}`);
console.log(j.join('\n'));
console.log(`  button seen at T+${task.buttonSeenMs} (bot's server-time estimate), reloads before button: ${task.buttonReloads}, first click T+${task.firstClickMs}, cart T+${task.cartMs}`);
