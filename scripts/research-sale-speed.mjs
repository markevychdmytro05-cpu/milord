// Repeatable offline experiment using the real buyer/provider against a local HTTPS shop.
// --simulate: virtual-time population, --browser: Chrome trials. Never uses an AdsPower profile.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { chromium } from 'patchright-core';

const root = '.local-data/speed-research';
await mkdir(root, { recursive: true });
const variants = ['baseline', 'paced', 'burst15', 'timeout20', 'combined', 'bounded', 'current'];
const cores = {};
for (const variant of variants) {
  const cadence = ['paced', 'combined', 'bounded'].includes(variant);
  const longer = ['timeout20', 'combined'].includes(variant);
  await build({ stdin: { contents: `export { runTask } from './src/core/buyer';
    export { AdsPowerProvider, PreparationGate } from './src/browser/adspower';
    export { PageRecorder } from './src/browser/page-recorder'; export { realClock } from './src/core/ports'; export { ShopRequestGuard } from './src/core/shop-errors';
    export { FakeClock, fakeBrowser, task, ready } from './tests/helpers';`, resolveDir: process.cwd() },
    outfile: `${root}/experiment-${variant}.mjs`, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'experimental-policies', setup(builder) {
      builder.onLoad({ filter: /src\/core\/buyer\.ts$/ }, async args => {
        let text = await readFile(variant === 'current' ? args.path : `${root}/buyer-before-speed.ts`, 'utf8');
        if (cadence) {
          text = text.replace('let nextReloadAt = 0;', 'let nextReloadAt = 0; let reloadStartedAt = 0;');
          text = text.replaceAll('const timing = await session.reload();', 'reloadStartedAt = clock.now(); const timing = await session.reload();');
          text = text.replaceAll('nextReloadAt = clock.now() + reloadInterval();',
            variant === 'bounded'
              ? 'nextReloadAt = task.retrySec === 1 && startNow() - task.saleAt < 20_000 ? clock.now() + Math.max(200, reloadInterval() - (clock.now() - reloadStartedAt)) : clock.now() + reloadInterval();'
              : 'nextReloadAt = task.retrySec === 1 && startNow() - task.saleAt < 20_000 ? Math.max(clock.now(), reloadStartedAt + reloadInterval()) : clock.now() + reloadInterval();');
        }
        if (variant === 'burst15') text = text.replace('if (elapsedMs < 5_000)', 'if (elapsedMs < 15_000)');
        return { contents: text, loader: 'ts' };
      });
      builder.onLoad({ filter: /src\/browser\/adspower\.ts$/ }, async args => {
        let text = await readFile(variant === 'current' ? args.path : `${root}/adspower-before-speed.ts`, 'utf8');
        if (longer) text = text.replace('10_000 + reloadTimeouts * 5000', '20_000 + reloadTimeouts * 5000');
        return { contents: text, loader: 'ts' };
      });
    } }],
  });
  cores[variant] = await import(`../${root}/experiment-${variant}.mjs`);
}
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
const originalRandom = Math.random;
Math.random = () => 0.5; // Same timer jitter and pointer aim for both sides of each experiment.

if (process.argv.includes('--simulate')) {
  const results = [];
  for (const delay of [250, 500, 1000, 2000]) {
    for (const variant of variants) {
      const core = cores[variant], rows = [];
      for (let sample = 0; sample < 101; sample++) {
        const publish = 6000 + sample * 40;
        const clock = new core.FakeClock();
        let loaded = false;
        const browser = core.fakeBrowser(clock, () => ({ ...core.ready, buyAvailable: loaded, inCart: browser.clicks.length > 0 }));
        browser.session.reload = async () => {
          browser.reloads.push(clock.now());
          const available = clock.now() - 1_000_000 >= publish;
          clock.time += delay;
          loaded = available;
          return { ttfbMs: delay, httpStatus: 200 };
        };
        const task = core.task({ retrySec: 1 });
        await core.runTask(task, browser.provider, clock, new AbortController().signal, async () => {});
        assert.equal(task.status, 'in_cart'); assert.equal(browser.clicks.length, 1);
        rows.push({ delay, publish, click: task.firstClickMs, lag: task.firstClickMs - publish, requests: task.reloads });
      }
      const row = { delay, variant, samples: rows.length, lagMedian: percentile(rows.map(r => r.lag), 0.5),
        lagP95: percentile(rows.map(r => r.lag), 0.95), meanRequests: rows.reduce((sum, r) => sum + r.requests, 0) / rows.length };
      console.log(JSON.stringify(row)); results.push({ ...row, rows });
    }
  }
  await writeFile(`${root}/simulation.json`, JSON.stringify(results, null, 2));
}

if (process.argv.includes('--browser')) {
  let trial;
  let cleaningUp = false;
  let chromeStderr = '';
  const lifecycle = [];
  const recordLifecycle = (event, detail = {}) => lifecycle.push({ at: new Date().toISOString(),
    saleDeltaMs: trial ? Date.now() - trial.saleAt : undefined, scenario: trial?.scenario.name, cleaningUp, event, ...detail });
  const timers = new Set();
  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
  const head = '<!doctype html><html><head><meta charset="utf-8"></head><body><input name="cid_id" value="test"><h1>Local sale experiment</h1>';
  const noButton = head + '<p>Sale not open</p></body></html>';
  const withButton = head + `<form name="cart_quantity" onsubmit="return false"><input name="products_id" value="1200">
    <div id="r_buy_intovar" data-id="1200"><button type="submit" class="buy" style="margin:80px;width:160px;height:50px">Купити</button></div></form>
    <script>document.querySelector('button').addEventListener('click', async e => {
      e.preventDefault(); e.target.classList.add('clicked');
      await fetch('/__click?trusted='+e.isTrusted, {method:'POST'});
      document.querySelector('#r_buy_intovar').innerHTML='<a class="added2cart" href="shopping_cart.php">У кошику</a>';
    });</script></body></html>`;
  const server = https.createServer({ key: readFileSync('.local-data/rh-key.pem'), cert: readFileSync('.local-data/rh-cert.pem') }, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/__late-handler') {
      res.setHeader('Content-Type', 'text/javascript');
      later(() => res.end(withButton.match(/<script>([\s\S]*?)<\/script>/)[1]), 2000);
      return;
    }
    if (req.url.startsWith('/__click')) {
      trial.clicks.push({ at: Date.now() - trial.saleAt, trusted: req.url.endsWith('true') });
      res.end('{}'); return;
    }
    if (!req.url.includes('p-1200.html') || !trial) { res.end(head + '</body></html>'); return; }
    const elapsed = Date.now() - trial.saleAt;
    if (elapsed < 0) { res.end(noButton); return; }
    const n = ++trial.requests, active = trial;
    let delay = active.scenario.delay;
    if (active.scenario.firstHang && n === 1) delay = Infinity;
    const available = elapsed >= active.scenario.publish;
    const entry = { n, requestAt: elapsed, delay: Number.isFinite(delay) ? delay : 'infinite', available };
    active.network.push(entry);
    res.on('close', () => { if (!res.writableFinished) entry.abortedAt = Date.now() - active.saleAt; });
    if (delay === Infinity) return;
    if (n === 1 && active.scenario.firstDrop) { req.socket.destroy(); return; }
    later(() => {
      entry.responseAt = Date.now() - active.saleAt;
      if (res.destroyed) return;
      if (n === 1 && active.scenario.firstStatus) {
        res.statusCode = active.scenario.firstStatus;
        if (res.statusCode === 429) res.setHeader('Retry-After', '1');
        res.end(`<html><head><title>HTTP ${res.statusCode}</title></head><body><h1>${res.statusCode} Error</h1></body></html>`);
        return;
      }
      const html = active.scenario.slowScript
        ? withButton.replace(/<script>[\s\S]*?<\/script>/, '<script defer src="/__late-handler"></script>') : withButton;
      res.end(available ? html : noButton);
    }, delay);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'nbu-speed-research-'));
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${directory}`, '--no-first-run', '--disable-background-networking', '--ignore-certificate-errors',
    `--host-resolver-rules=MAP coins.bank.gov.ua:443 127.0.0.1:${server.address().port}, MAP * ~NOTFOUND, EXCLUDE localhost`,
    '--window-size=1200,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', data => { chromeStderr = (chromeStderr + data.toString()).slice(-16_384); });
  chrome.on('exit', (code, signal) => recordLifecycle('chrome-exit', { code, signal }));
  chrome.on('error', error => recordLifecycle('chrome-process-error', { message: error.message }));
  const results = [];
  let browser;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(port, 'Chrome must start');
    const endpoint = `http://127.0.0.1:${port}`;
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    browser.on('disconnected', () => recordLifecycle('observer-disconnected'));
    browser.contexts()[0].on('page', page => {
      recordLifecycle('page-created');
      page.on('close', () => recordLifecycle('page-closed', { path: new URL(page.url()).pathname }));
      page.on('crash', () => recordLifecycle('page-crashed', { path: new URL(page.url()).pathname }));
    });
    const scenarios = [
      { name: 'button-at-8s-fast-response', publish: 8000, delay: 500, variants: ['baseline', 'paced', 'burst15', 'bounded', 'current'] },
      { name: 'button-at-8s-slow-response', publish: 8000, delay: 2000, variants: ['baseline', 'paced', 'bounded', 'current'] },
      { name: '13s-working-response', publish: 0, delay: 13_000, variants: ['baseline', 'timeout20'] },
      { name: 'first-request-never-answers', publish: 0, delay: 1000, firstHang: true, variants: ['baseline', 'timeout20', 'paced'] },
      { name: 'resilience-503-then-ready', publish: 0, delay: 500, firstStatus: 503, variants: ['current'] },
      { name: 'resilience-dropped-connection', publish: 0, delay: 500, firstDrop: true, variants: ['current'] },
      { name: 'resilience-slow-deferred-handler', publish: 0, delay: 500, slowScript: true, variants: ['current'] },
      { name: 'resilience-429-then-ready', publish: 0, delay: 500, firstStatus: 429, variants: ['current'] },
    ];
    for (const scenario of scenarios.filter(s => !process.env.RESEARCH_SCENARIO || s.name.includes(process.env.RESEARCH_SCENARIO))
      .flatMap(s => Array.from({ length: Number(process.env.RESEARCH_REPEATS || 1) }, (_, repeat) => ({ ...s, repeat })))) {
      for (const variant of (process.env.RESEARCH_VARIANT === 'current' ? ['current'] : scenario.variants.filter(v => !process.env.RESEARCH_VARIANT || process.env.RESEARCH_VARIANT.split(',').includes(v)))) {
        const core = cores[variant];
        const task = core.task({ id: `${String(results.length).padStart(8, '0')}-research`, url: `https://coins.bank.gov.ua/case-${results.length}/p-1200.html`,
          retrySec: 1, saleAt: Date.now() + 3500, windowMin: 1 });
        trial = { scenario, saleAt: task.saleAt, clicks: [], requests: 0, network: [] };
        const realProvider = new core.AdsPowerProvider({ start: async () => endpoint }, new core.ShopRequestGuard(), new core.PreparationGate(0), undefined, variant === 'current' ? new core.PageRecorder(`${root}/current-captures`) : undefined);
        const provider = { connect: async (...args) => {
          const session = await realProvider.connect(...args);
          for (const [name, fn] of Object.entries(session)) if (typeof fn === 'function') session[name] = async (...params) => {
            try { return await fn(...params); } catch (error) {
              trial.errors ??= []; trial.errors.push({ operation: name, at: Date.now() - trial.saleAt, message: error.message.slice(0,700) });
              throw error;
            }
          };
          return session;
        } };
        await core.runTask(task, provider, core.realClock, AbortSignal.timeout(75_000), async () => {}, () => [],
          () => ({ offsetMs: 0, uncertaintyMs: 0, at: Date.now(), servers: 2 }));
        const row = { scenario: scenario.name, repeat: scenario.repeat, variant, status: task.status, firstClickMs: task.firstClickMs,
          buttonSeenMs: task.buttonSeenMs, reloads: task.reloads, journal: task.events, ...trial };
        row.scenario = scenario.name;
        results.push(row);
        await writeFile(`${root}/browser-trials${process.env.RESEARCH_RUN ? "-" + process.env.RESEARCH_RUN : process.env.RESEARCH_VARIANT ? "-" + process.env.RESEARCH_VARIANT : ""}.json`, JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ scenario: scenario.name, variant, status: task.status, firstClickMs: task.firstClickMs,
          reloads: task.reloads, aborted: trial.network.filter(r => r.abortedAt).length }));
        assert.equal(task.status, 'in_cart'); assert.equal(trial.clicks.length, 1); assert.ok(trial.clicks[0].trusted);
        if (scenario.firstStatus === 429) assert.ok(trial.network[1].requestAt - trial.network[0].responseAt >= 29_900, 'Honor shared 429 cooldown');
        if (scenario.slowScript) assert.ok(task.firstClickMs >= 2500, 'Wait for the deferred purchase handler');
        cleaningUp = true;
        for (const page of browser.contexts()[0].pages()) if (page.url().includes('p-1200')) await page.close();
        cleaningUp = false;
      }
    }
  } finally {
    cleaningUp = true;
    await browser?.close(); chrome.kill(); for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await writeFile(`${root}/browser-lifecycle-${process.env.RESEARCH_RUN || 'latest'}.json`, JSON.stringify({ lifecycle, chromeStderr }, null, 2));
  }
}
Math.random = originalRandom;
