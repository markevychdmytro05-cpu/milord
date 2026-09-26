import { chromium, type Browser, type Page, type Response } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { AdsPowerClient, AdsPowerProvider, PreparationGate, responseClockOffset } from '../src/browser/adspower';
import { ShopRequestGuard } from '../src/core/shop-errors';
import { ready } from './helpers';

const one = 'https://coins.bank.gov.ua/one.html';
const two = 'https://coins.bank.gov.ua/two.html';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(existing: string[] = [], replies: Array<{ status: number; retry?: string }> = []) {
  const requests: Array<{ url: string; at: number }> = [];
  const frame = {};
  function createPage(initial = 'about:blank') {
    let url = initial; let status = 200;
    const handlers = new Set<(response: Response) => void>();
    const request = async (target: string) => {
      url = target; requests.push({ url, at: Date.now() });
      const reply = replies.shift() ?? { status: 200 }; status = reply.status;
      const response = { url: () => url, status: () => status, ok: () => status === 200,
        headers: () => ({ date: new Date(Date.now()).toUTCString(), 'retry-after': reply.retry }),
        request: () => ({ isNavigationRequest: () => true, frame: () => frame }),
      } as unknown as Response;
      for (const handler of handlers) handler(response);
      return response;
    };
    return {
      url: () => url, isClosed: () => false, mainFrame: () => frame,
      setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(), bringToFront: vi.fn(async () => {}),
      on: (_event: string, handler: (response: Response) => void) => handlers.add(handler),
      off: (_event: string, handler: (response: Response) => void) => handlers.delete(handler),
      goto: vi.fn(request), reload: vi.fn(() => request(url)),
      evaluate: vi.fn(async () => ({ ...ready, rateLimited: status === 429 })),
    };
  }
  const pages = existing.map(createPage);
  const context = { pages: () => pages, newPage: vi.fn(async () => {
    const page = createPage(); pages.push(page); return page as unknown as Page;
  }) };
  const close = vi.fn(async () => {});
  vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue({ contexts: () => [context], close } as unknown as Browser);
  const client = new AdsPowerClient('http://localhost:50325', '');
  const start = vi.spyOn(client, 'start').mockResolvedValue('ws://localhost:54321/devtools/browser/test');
  const guard = new ShopRequestGuard();
  const provider = new AdsPowerProvider(client, guard, new PreparationGate(0));
  return { provider, guard, start, close, pages, requests };
}

it('opens every target during preparation and hands off without navigating or starting the profile again', async () => {
  const { provider, start, close, pages, requests } = fixture([two]);
  const signal = new AbortController().signal;
  const pool = await provider.prepare('abc', [one, two], signal);
  expect(requests.map((request) => request.url)).toEqual([one]); // Already-open second product is retained.
  expect(pages.map((page) => page.url())).toEqual([two, one]);
  const a = await pool.connect('abc', one, signal); await a.disconnect();
  const b = await pool.connect('abc', two, signal); await b.serverOffset(); await b.disconnect();
  expect(start).toHaveBeenCalledTimes(1); expect(requests).toHaveLength(1);
  expect(close).not.toHaveBeenCalled(); await pool.disconnect(); expect(close).toHaveBeenCalledTimes(1);
});

it('retries a 429 document after Retry-After before opening the next product', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const { provider, requests } = fixture([], [{ status: 429, retry: '45' }, { status: 200 }, { status: 200 }]);
  const paused = vi.fn(async () => {});
  const promise = provider.prepare('abc', [one, two], new AbortController().signal,
    { deadline: 1_300_000, onRateLimit: paused });
  await vi.advanceTimersByTimeAsync(44_999);
  expect(requests).toEqual([{ url: one, at: 1_000_000 }]);
  await vi.advanceTimersByTimeAsync(1);
  const pool = await promise;
  expect(requests).toEqual([{ url: one, at: 1_000_000 }, { url: one, at: 1_045_000 }, { url: two, at: 1_045_000 }]);
  expect(paused).toHaveBeenCalled(); await pool.disconnect();
});

it('bounds repeated 429 recovery by the task deadline and disconnects', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const { provider, requests, close } = fixture([], [{ status: 429 }, { status: 429 }]);
  const promise = provider.prepare('abc', [one, two], new AbortController().signal, { deadline: 1_060_000 });
  const assertion = expect(promise).rejects.toThrow('429');
  await vi.runAllTimersAsync(); await assertion;
  expect(requests.map((request) => request.at)).toEqual([1_000_000, 1_030_000]);
  expect(close).toHaveBeenCalledTimes(1);
});

it('cancels a preparation cooldown without opening the remaining products', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const { provider, requests, close } = fixture([], [{ status: 429 }]);
  const controller = new AbortController();
  const promise = provider.prepare('abc', [one, two], controller.signal);
  const assertion = expect(promise).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1000); controller.abort(); await assertion;
  expect(requests).toHaveLength(1); expect(close).toHaveBeenCalledTimes(1);
});

it('shares cooldown with another profile before its first store navigation', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const { provider, guard, requests } = fixture(); guard.block('40');
  const promise = provider.prepare('another', [two], new AbortController().signal);
  await vi.advanceTimersByTimeAsync(39_999); expect(requests).toEqual([]);
  await vi.advanceTimersByTimeAsync(1); const pool = await promise;
  expect(requests).toEqual([{ url: two, at: 1_040_000 }]); await pool.disconnect();
});

it('estimates time from the document header and rejects missing or extreme values', () => {
  expect(responseClockOffset('Thu, 01 Jan 1970 00:02:00 GMT', 120_500)).toBe(-500);
  expect(responseClockOffset(undefined, 120_500)).toBe(0);
  expect(responseClockOffset('Thu, 01 Jan 1970 00:02:00 GMT', 1_000_000)).toBe(0);
});
