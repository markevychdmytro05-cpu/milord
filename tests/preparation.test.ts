import { chromium, type Browser, type Page, type Response } from 'playwright-core';
import { afterEach, expect, it, vi } from 'vitest';
import { AdsPowerClient, AdsPowerProvider, PreparationGate, responseClockOffset } from '../src/browser/adspower';
import { ShopRequestGuard } from '../src/core/shop-errors';
import { ready } from './helpers';
import { readVisibleCartProductIds } from '../src/browser/nbu-page';

const one = 'https://coins.bank.gov.ua/one.html';
const two = 'https://coins.bank.gov.ua/two.html';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(existing: string[] = [], replies: Array<{ status: number; retry?: string }> = []) {
  const requests: Array<{ url: string; at: number }> = [];
  const frame = {};
  function createPage(initial = 'about:blank') {
    let url = initial; let status = 200;
    let cartIds: string[] = [];
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
      setCartIds: (ids: string[]) => { cartIds = ids; },
      evaluate: vi.fn(async (fn: unknown) => fn === readVisibleCartProductIds ? cartIds : ({ ...ready, rateLimited: status === 429 })),
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


it('recognizes the selected product in another prepared tab cart without a new request', async () => {
  const urls = ['https://coins.bank.gov.ua/one/p-1126.html', 'https://coins.bank.gov.ua/two/p-885.html'];
  const { provider, pages, requests } = fixture(urls);
  const signal = new AbortController().signal;
  const pool = await provider.prepare('abc', urls, signal);
  try {
    const session = await pool.connect('abc', urls[1]!, signal);
    pages[0]!.setCartIds(['1126']);
    expect((await session.read()).inCart).toBe(false);
    pages[0]!.setCartIds(['1126', '885']);
    expect((await session.read()).inCart).toBe(true);
    expect(requests).toHaveLength(0);
  } finally { await pool.disconnect(); }
});

const oldOne = 'https://coins.bank.gov.ua/finished-1.html';
const oldTwo = 'https://coins.bank.gov.ua/finished-2.html';

it('leaves store tabs of earlier purchases untouched and opens its own tab', async () => {
  const { provider, pages, requests, close } = fixture([oldOne, oldTwo]);
  const pool = await provider.prepare('abc', [one], new AbortController().signal);
  expect(requests.map((request) => request.url)).toEqual([one]);
  expect(pages).toHaveLength(3);
  expect(pages[2]!.url()).toBe(one);
  for (const old of pages.slice(0, 2)) {
    expect(old.goto).not.toHaveBeenCalled(); expect(old.reload).not.toHaveBeenCalled(); expect(old.bringToFront).not.toHaveBeenCalled();
  }
  expect(pages[0]!.url()).toBe(oldOne); expect(pages[1]!.url()).toBe(oldTwo);
  expect(close).not.toHaveBeenCalled(); await pool.disconnect();
});

it('does not reuse a single unrelated store tab', async () => {
  const { provider, pages } = fixture([oldOne]);
  const pool = await provider.prepare('abc', [one], new AbortController().signal);
  expect(pages).toHaveLength(2);
  expect(pages[0]!.goto).not.toHaveBeenCalled();
  expect(pages[0]!.url()).toBe(oldOne);
  await pool.disconnect();
});

it('waits for a purchase still in flight in another store tab, changing nothing', async () => {
  const { provider, pages, requests, close } = fixture([oldOne]);
  pages[0]!.evaluate.mockResolvedValue({ ...ready, buyAvailable: false, purchasePending: true });
  await expect(provider.prepare('abc', [one], new AbortController().signal)).rejects.toThrow('триває покупка');
  expect(requests).toHaveLength(0); expect(pages).toHaveLength(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it('does not let a stale 429 page in an unrelated tab pause the bot or reload that tab', async () => {
  const { provider, guard, pages, requests } = fixture([oldOne]);
  pages[0]!.evaluate.mockResolvedValue({ ...ready, buyAvailable: false, rateLimited: true });
  const pool = await provider.prepare('abc', [one], new AbortController().signal);
  expect(guard.isBlocked()).toBe(false);
  expect(pages[0]!.reload).not.toHaveBeenCalled();
  expect(requests.map((request) => request.url)).toEqual([one]);
  await pool.disconnect();
});
