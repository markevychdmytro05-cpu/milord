import { describe, expect, it, vi } from 'vitest';
import { AdsPowerClient, validateCdpEndpoint } from '../src/browser/adspower';
import { productUrl, taskInputSchema } from '../src/core/model';
import { task } from './helpers';

describe('AdsPower Local API adapter', () => {
  it('starts the selected profile and uses its CDP endpoint', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: 0, data: { ws: { puppeteer: 'ws://127.0.0.1:54321/devtools/browser/test' } },
    })));
    const client = new AdsPowerClient('http://127.0.0.1:50325', 'test-secret', request);
    expect(await client.start('abc123', new AbortController().signal)).toContain('54321');
    const [url, options] = request.mock.calls[0]!;
    expect(String(url)).toContain('user_id=abc123');
    expect(String(url)).toContain('open_tabs=1');
    expect(options?.headers).toEqual({ Authorization: 'Bearer test-secret' });
    expect(options?.redirect).toBe('error');
  });

  it('does not send a local API key to an external host', () => {
    expect(() => new AdsPowerClient('https://example.com', 'secret')).toThrow();
    expect(() => new AdsPowerClient('http://user:password@localhost:50325', 'secret')).toThrow();
    expect(() => validateCdpEndpoint('wss://example.com/browser')).toThrow();
  });

  it('does not surface a raw AdsPower error body', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: -1, msg: 'private-token' })));
    const client = new AdsPowerClient('http://localhost:50325', '', request);
    await expect(client.start('abc', new AbortController().signal)).rejects.toThrow('could not start');
  });
});

describe('task validation', () => {
  it('accepts a product link and removes only its fragment', () => {
    expect(productUrl('https://coins.bank.gov.ua/product_info.php?products_id=1#details'))
      .toBe('https://coins.bank.gov.ua/product_info.php?products_id=1');
  });

  it.each([
    'https://example.com/coin', 'http://coins.bank.gov.ua/coin',
    'https://coins.bank.gov.ua/product_info.php?products_id=1&action=add_product',
    'https://user:password@coins.bank.gov.ua/coin',
  ])('rejects unsafe or mutating navigation: %s', (url) => {
    expect(() => productUrl(url)).toThrow();
  });

  it('rejects invalid numeric settings rather than creating a tight retry loop', () => {
    expect(taskInputSchema.safeParse({ ...task(), retrySec: 0 }).success).toBe(false);
    expect(taskInputSchema.safeParse({ ...task(), saleAt: NaN }).success).toBe(false);
  });
});

it('fetches all profile pages and exposes only the fields needed for selection', async () => {
  vi.useFakeTimers();
  try {
    const profiles = Array.from({ length: 100 }, (_, index) => ({ user_id: `p${index}`, serial_number: String(index), name: `Profile ${index}`, password: 'private', proxy: 'secret' }));
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { list: profiles } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { list: [{ user_id: 'last', serial_number: '101', name: 'Last' }] } })));
    const client = new AdsPowerClient('http://localhost:50325', 'key', request);
    const resultPromise = client.listProfiles(new AbortController().signal);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result).toHaveLength(101);
    expect(result[0]).toEqual({ id: 'p0', number: '0', name: 'Profile 0' });
    expect(String(request.mock.calls[1]![0])).toContain('page=2');
    expect(request.mock.calls[0]![1]?.headers).toEqual({ Authorization: 'Bearer key' });
    expect(JSON.stringify(result)).not.toContain('private');
  } finally { vi.useRealTimers(); }
});

it('does not expose raw API errors while listing profiles', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: -1, msg: 'secret-password' })));
  const client = new AdsPowerClient('http://localhost:50325', '', request);
  await expect(client.listProfiles(new AbortController().signal)).rejects.toThrow('доступ до API');
});

it('spaces shared API requests and skips cancelled requests', async () => {
  vi.useFakeTimers();
  try {
    const { ProfileStartGate } = await import('../src/browser/adspower');
    const gate = new ProfileStartGate();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      code: 0, data: { ws: { puppeteer: 'ws://127.0.0.1:54321/devtools/browser/test' } },
    })));
    const a = new AdsPowerClient('http://localhost:50325', '', request, gate);
    const b = new AdsPowerClient('http://localhost:50325', '', request, gate);
    await a.start('a', new AbortController().signal);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(b.start('cancelled', cancelled.signal)).rejects.toThrow();
    const next = b.start('b', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1099);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(request).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
