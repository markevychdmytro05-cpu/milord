import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page, Response } from 'patchright-core';
import { describe, expect, it } from 'vitest';
import { PageRecorder } from '../src/browser/page-recorder';
import { runTask } from '../src/core/buyer';
import type { CaptureRequest } from '../src/core/ports';
import { fakeBrowser, FakeClock, ready, task } from './helpers';

const fakePage = (content: () => string) => ({
  isClosed: () => false,
  evaluate: async () => ({ html: `<html><body>${content()}</body></html>`, text: content(), url: 'https://coins.bank.gov.ua/p-1.html' }),
}) as unknown as Page;
const fakeResponse = (type: string, body: string) => ({
  url: () => 'https://coins.bank.gov.ua/ajax.php?queue=1', status: () => 200, headers: () => ({ 'content-type': 'application/json' }),
  text: async () => body,
  request: () => ({ resourceType: () => type, method: () => 'POST', postData: () => 'products_id=1' }),
}) as unknown as Response;

describe('page recorder', () => {
  it('saves a page only when its text changes, and the page’s own XHR once recording started', async () => {
    let now = 1_000_000;
    const root = await mkdtemp(join(tmpdir(), 'nbu-captures-'));
    const recorder = new PageRecorder(root, () => now).forTask('348a0db9-763a-419a-b670-54d556659a96', 1_000_000);
    let text = 'Черга: 1200';
    const page = fakePage(() => text);
    recorder.response(fakeResponse('xhr', '{"ignored":true}')); // Before the first snapshot: not recorded.
    await recorder.snapshot(page, { label: 'click-1', saleDeltaMs: 20, force: true });
    text = 'Черга: 900';
    now += 500; await recorder.snapshot(page, { label: 'after-click', saleDeltaMs: 520 }); // Too soon.
    text = 'Черга: 1200';
    now += 1000; await recorder.snapshot(page, { label: 'after-click', saleDeltaMs: 1520 }); // Same text.
    text = 'Черга: 900';
    now += 1000; await recorder.snapshot(page, { label: 'after-click', saleDeltaMs: 2520 });
    recorder.response(fakeResponse('xhr', '{"position":900}'));
    recorder.response(fakeResponse('image', 'png'));
    recorder.response({ ...fakeResponse('xhr', 'tracking'), url: () => 'https://www.youtube.com/log' } as unknown as Response);
    await recorder.snapshot(page, { label: 'final-in_cart', saleDeltaMs: 2600, force: true });
    const files = (await readdir(recorder.dir)).sort();
    expect(files.filter(name => name.endsWith('.html'))).toEqual([
      '001_p0000020ms_click-1.html', '002_p0002520ms_after-click.html', '003_p0002600ms_final-in_cart.html']);
    expect(await readFile(join(recorder.dir, '002_p0002520ms_after-click.txt'), 'utf8')).toBe('Черга: 900');
    const network = (await readFile(join(recorder.dir, 'network.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(network).toHaveLength(1);
    expect(network[0]).toMatchObject({ method: 'POST', status: 200, body: '{"position":900}', requestBody: 'products_id=1' });
  });
});

describe('purchase workflow records', () => {
  it('records before the sale and after the click, never between the start and the first click', async () => {
    const clock = new FakeClock();
    clock.time = 1_000_000 - 5 * 60_000; // Started at the lead time, as the scheduler does.
    const requests: CaptureRequest[] = [];
    let clicks = 0;
    const browser = fakeBrowser(clock, () => ({ ...ready, buyAvailable: !clicks, inCart: clicks > 0 && clock.now() > 1_004_000 }));
    browser.session.capture = async (request) => { requests.push({ ...request, clicksAtCapture: clicks } as CaptureRequest); };
    const click = browser.session.clickBuy;
    browser.session.clickBuy = async () => { clicks++; await click(); };
    await runTask(task(), browser.provider, clock, new AbortController().signal, async () => {});
    const labels = requests.map(request => request.label);
    expect(labels[0]).toBe('before-sale');
    expect(labels).toContain('click-1');
    expect(labels).toContain('after-click');
    expect(labels.at(-1)).toBe('final-in_cart');
    const inSaleBeforeClick = requests.filter(r => r.saleDeltaMs >= 0 && (r as unknown as { clicksAtCapture: number }).clicksAtCapture === 0);
    expect(inSaleBeforeClick).toEqual([]);
  });
  it('skips the pre-sale record when preparation finished inside the sale window', async () => {
    const clock = new FakeClock();
    const labels: string[] = [];
    const browser = fakeBrowser(clock, () => ({ ...ready, inCart: browser.clicks.length > 0 }));
    browser.session.capture = async (request) => { labels.push(request.label); };
    await runTask(task(), browser.provider, clock, new AbortController().signal, async () => {});
    expect(labels).not.toContain('before-sale');
    expect(labels[0]).toBe('click-1');
  });
});
