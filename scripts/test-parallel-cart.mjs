import { build } from 'esbuild';
import { chromium } from 'patchright-core';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

await mkdir('.local-data', { recursive: true });
await build({ stdin: { contents: `export { AdsPowerProvider, PreparationGate } from './src/browser/adspower';
 export { Scheduler } from './src/main/scheduler'; export { Store } from './src/main/store';`, resolveDir: process.cwd() },
 outfile: '.local-data/parallel-core.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { AdsPowerProvider, PreparationGate, Scheduler, Store } = await import('../.local-data/parallel-core.mjs');
const saleRefresh = process.argv.includes('--sale-refresh');
const sharedCart = process.argv.includes('--shared-cart');
const directory = await mkdtemp(join(tmpdir(), 'nbu-parallel-cdp-'));
let context, scheduler;
try {
 context = await chromium.launchPersistentContext(directory, { channel: 'chrome', headless: true,
   args: ['--remote-debugging-port=0'], serviceWorkers: 'block' });
 const [port, path] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
 const endpoint = `ws://127.0.0.1:${port}${path}`;
 const urls = [1, 2, 3].map(id => `https://coins.bank.gov.ua/offline-${id}/p-${id}.html`);
 const cart = new Map(), submissions = [], confirmations = [], navigations = [];
 let pending = 0, peakPending = 0;
 await context.route('**/*', async route => {
   const request = route.request(), url = new URL(request.url());
   if (url.href === 'https://coins.bank.gov.ua/offline-cart' && request.method() === 'POST') {
     const id = Number(new URLSearchParams(request.postData()).get('id'));
     assert.ok([1, 2, 3].includes(id));
     submissions.push({ id, at: Date.now() }); peakPending = Math.max(peakPending, ++pending);
     await new Promise(resolve => setTimeout(resolve, id === 1 ? 1500 : id === 2 ? 80 : 250));
     cart.set(id, (cart.get(id) ?? 0) + 1); pending--;
     confirmations.push({ id, at: Date.now() });
     return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ added: id, cart: [...cart.keys()] }) });
   }
   const index = urls.indexOf(url.href);
   if (index === -1) return route.abort();
   assert.equal(request.method(), 'GET'); navigations.push(url.href);
   const disabled = saleRefresh && navigations.filter(u => u === url.href).length === 1;
   const id = index + 1;
   return route.fulfill({ status: 200, contentType: 'text/html', body:
     `<form name="cart_quantity"><input name="cid_id" value="fixture"><input name="products_id" value="${id}">
      <div id="r_buy_intovar"><button type="submit" class="buy" ${disabled ? 'disabled' : ''}>Купити</button></div></form>
      <script>document.querySelector('form').onsubmit=async(event)=>{
        event.preventDefault();const button=document.querySelector('button');button.classList.add('clicked');
        const queue=document.createElement('p');queue.id='cart-queue-position';queue.textContent='1';document.body.append(queue);
        const result=await(await fetch('/offline-cart',{method:'POST',body:new URLSearchParams({id:'${id}'})})).json();
        if(result.added===${id} && !(${sharedCart} && ${id}===3)){queue.remove();button.classList.remove('clicked');button.classList.add('added2cart');}
        if(${sharedCart} && ${id}===1){
          const popup=document.createElement('div');popup.id='modal_cart_popup';
          popup.innerHTML=result.cart.map(product=>'<div class="cartContent_body"><input name="products_id[]" value="'+product+'"><select name="cart_quantity[]"><option>1</option></select><div class="cart-item-timer"><span class="timer-numbers">29:59</span></div></div>').join('');
          document.body.append(popup);
        }
      };</script>` });
 });
 const provider = new AdsPowerProvider({ start: async () => endpoint }, undefined, new PreparationGate(0));
 const store = new Store(join(directory, 'tasks.json'));
 const errors = [];
 scheduler = new Scheduler(store, () => provider, () => {}, () => {}, e => errors.push(e));
 const saleAt = Date.now() + 1500;
 await scheduler.addMany(urls.map(url => ({ profileId: 'offline', url, saleAt, leadMin: 1, retrySec: 5, windowMin: 1, mode: 'cart' })));
 const deadline = Date.now() + 12000;
 while (store.tasks().some(t => t.status !== 'in_cart') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
 await scheduler.stop();
 assert.deepEqual(errors, []);
 assert.deepEqual(store.tasks().map(t => t.status), ['in_cart', 'in_cart', 'in_cart']);
 assert.deepEqual(store.tasks().map(t => [t.clicks, t.reloads]), Array.from({length:3}, () => [1, saleRefresh ? 1 : 0]));
 assert.deepEqual([...cart.entries()].sort(), [[1, 1], [2, 1], [3, 1]]);
 assert.equal(navigations.length, saleRefresh ? 6 : 3);
 assert.equal(submissions.length, 3);
 assert.equal(peakPending, 3);
 assert.ok(submissions.every(s => s.at >= saleAt));
 assert.ok(Math.max(...submissions.map(s => s.at)) < Math.min(...confirmations.map(s => s.at)));
 assert.equal(confirmations.at(-1).id, 1); // The slow first product never holds up either later product.
 const report = { saleRefresh, sharedCart, fixture: 'offline Chromium + real scheduler + durable JSON store', realStoreRequests: 0,
   cart: Object.fromEntries(cart), peakPending, navigationRequests: navigations.length,
   clickSpreadMs: Math.max(...submissions.map(s => s.at)) - Math.min(...submissions.map(s => s.at)),
   submissions: submissions.map(s => ({ id: s.id, afterSaleMs: s.at - saleAt })),
   confirmations: confirmations.map(s => ({ id: s.id, afterSaleMs: s.at - saleAt })) };
 await writeFile(`.local-data/parallel-benchmark${saleRefresh ? '-refresh' : ''}${sharedCart ? '-shared-cart' : ''}.json`, JSON.stringify(report, null, 2));
 console.log(JSON.stringify(report, null, 2));
} finally {
 await scheduler?.stop();
 await context?.close();
 await rm(directory, { recursive: true, force: true });
}
