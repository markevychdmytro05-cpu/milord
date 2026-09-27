import { describe, expect, it, vi } from 'vitest';
import { AdsPowerClient, compensateForLatency, reloadTiming, responseClockOffset, validateCdpEndpoint } from '../src/browser/adspower';
import { productUrl, taskInputSchema } from '../src/core/model';
import { task } from './helpers';

const failureOf = async (attempt: Promise<unknown>): Promise<Error> => {
  try { await attempt; } catch (error) { return error as Error; }
  throw new Error('expected the call to fail');
};

describe('clock offset estimation', () => {
  it('keeps the receipt time when no request time was recorded', () => {
    expect(compensateForLatency(10_000, undefined)).toBe(10_000);
  });

  it('shifts the receipt time back by half the round trip', () => {
    expect(compensateForLatency(10_400, 10_000)).toBe(10_200);
  });

  it('never looks earlier than the request itself, even with a clock glitch', () => {
    expect(compensateForLatency(9_900, 10_000)).toBe(9_900);
  });

  it('reduces the offset error introduced by a slow round trip', () => {
    // Server clock reads exactly 10_000; the request took 800ms round trip.
    const date = new Date(10_000).toUTCString();
    const receivedAt = 10_800;
    const uncompensated = responseClockOffset(date, receivedAt);
    const compensated = responseClockOffset(date, compensateForLatency(receivedAt, 10_000));
    expect(Math.abs(compensated)).toBeLessThan(Math.abs(uncompensated));
  });
});

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
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: -1, msg: 'private-secret' })));
    const client = new AdsPowerClient('http://localhost:50325', '', request);
    const failure = await failureOf(client.start('abc', new AbortController().signal));
    expect(failure.message).toContain('не зміг запустити профіль (код -1)');
    expect(failure.message).not.toContain('private-secret');
  });

  it.each([
    [{ code: -1, msg: 'user_id is not exist' }, 'не знайшов цей профіль'],
    [{ code: -1, msg: 'Too many request per second' }, 'обмежив частоту'],
    [{ code: -1, msg: 'Invalid API key' }, 'API-ключ'],
  ])('explains a known AdsPower failure without echoing its text: %j', async (body, expected) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    const failure = await failureOf(new AdsPowerClient('http://localhost:50325', '', request).start('abc', new AbortController().signal));
    expect(failure.message).toContain(expected);
    expect(failure.message).not.toContain(body.msg);
    expect(failure.name).toBe('UserFacingError');
  });

  it('says AdsPower is unreachable, wrong-key or failing, using fixed text', async () => {
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed ECONNREFUSED 127.0.0.1:50325'));
    const unreachable = await failureOf(new AdsPowerClient('http://localhost:50325', '', down).start('abc', new AbortController().signal));
    expect(unreachable.message).toContain('зв’язатися з AdsPower');
    expect(unreachable.message).not.toContain('50325');
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response('key=abc', { status: 401 }));
    expect((await failureOf(new AdsPowerClient('http://localhost:50325', 'abc', denied).start('abc', new AbortController().signal))).message).toContain('API-ключ');
    const broken = vi.fn<typeof fetch>().mockResolvedValue(new Response('boom', { status: 500 }));
    expect((await failureOf(new AdsPowerClient('http://localhost:50325', '', broken).start('abc', new AbortController().signal))).message).toContain('HTTP 500');
  });

  it('opens AdsPower when it is not running and retries the start', async () => {
    const ws = 'ws://127.0.0.1:9222/devtools/browser/x';
    let up = false;
    const request = vi.fn<typeof fetch>(async (input) => {
      if (!up) throw new TypeError('fetch failed ECONNREFUSED');
      if (String(input).endsWith('/status')) return new Response(JSON.stringify({ code: 0 }));
      return new Response(JSON.stringify({ code: 0, data: { ws: { puppeteer: ws } } }));
    });
    const launch = vi.fn(async () => { up = true; });
    const client = new AdsPowerClient('http://localhost:50325', '', request, undefined, launch);
    await expect(client.start('abc', new AbortController().signal)).resolves.toBe(ws);
    expect(launch).toHaveBeenCalledOnce();
  });

  it('does not report a cancelled start as an AdsPower problem', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    const request = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(new AdsPowerClient('http://localhost:50325', '', request).start('abc', cancelled.signal)).rejects.toThrow();
    const failure = await failureOf(new AdsPowerClient('http://localhost:50325', '', request).start('abc', cancelled.signal));
    expect(failure.name).not.toBe('UserFacingError');
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

it('checks an existing browser without starting it and uses only its local CDP endpoint', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    code: 0, data: { status: 'Active', ws: { puppeteer: 'ws://localhost:54321/devtools/browser/test' } },
  })));
  const client = new AdsPowerClient('http://localhost:50325', 'test-key', request);
  expect(await client.active('abc', new AbortController().signal)).toContain('54321');
  expect(new URL(String(request.mock.calls[0]![0])).pathname).toBe('/api/v1/browser/active');
  expect(request.mock.calls[0]![1]?.headers).toEqual({ Authorization: 'Bearer test-key' });
  expect(request).toHaveBeenCalledTimes(1);
});
it('leaves inactive browsers closed', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { status: 'Inactive' } })));
  expect(await new AdsPowerClient('http://localhost:50325', '', request).active('abc', new AbortController().signal)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});
it('does not leak raw status errors or connect to external browser endpoints', async () => {
  for (const body of [{ code: -1, msg: 'private-secret' },
    { code: 0, data: { status: 'Active', ws: { puppeteer: 'wss://private-secret.example/browser' } } }]) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    const error = await failureOf(new AdsPowerClient('http://localhost:50325', '', request).active('abc', new AbortController().signal));
    expect(error.message).not.toContain('private-secret');
  }
});

describe('reload timing for the journal', () => {
  const response = (timing: Record<string, number>, date?: string) => ({
    status: () => 200,
    headers: () => (date ? { date } : {}) as Record<string, string>,
    request: () => ({ timing: () => timing }),
  }) as unknown as Parameters<typeof reloadTiming>[0];
  it('splits a cold reload into DNS, connection and server time', () => {
    expect(reloadTiming(response({ startTime: 1, domainLookupStart: 2, domainLookupEnd: 89, connectStart: 89, secureConnectionStart: 101,
      connectEnd: 118, requestStart: 125, responseStart: 222, responseEnd: 240 }, 'Tue, 29 Sep 2026 07:00:00 GMT')))
      .toEqual({ httpStatus: 200, dnsMs: 87, connectMs: 29, requestMs: 125, ttfbMs: 97, serverDate: 'Tue, 29 Sep 2026 07:00:00 GMT' });
  });
  it('leaves out phases the browser did not report', () => {
    expect(reloadTiming(response({ startTime: 1, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1,
      connectEnd: -1, requestStart: 9, responseStart: 173, responseEnd: -1 }))).toEqual({ httpStatus: 200, requestMs: 9, ttfbMs: 164 });
  });
});
