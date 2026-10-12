import { describe, expect, it, vi } from 'vitest';
import { BitBrowserClient, bitBrowserFailure } from '../src/browser/bitbrowser';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const opened = (port = 53325) => json({ success: true, data: { ws: `ws://127.0.0.1:${port}/devtools/browser/857b2d0d-aae6-4852-ab3c-0784f0b2c1fb`, http: `127.0.0.1:${port}` } });
const signal = () => new AbortController().signal;

describe('BitBrowser Local API adapter', () => {
  it('opens a profile by id and returns its CDP endpoint', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(opened());
    const endpoint = await new BitBrowserClient('http://127.0.0.1:54345', '', request).start('abc123', signal());
    expect(endpoint).toBe('ws://127.0.0.1:53325/devtools/browser/857b2d0d-aae6-4852-ab3c-0784f0b2c1fb');
    expect(String(request.mock.calls[0]![0])).toBe('http://127.0.0.1:54345/browser/open');
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({ id: 'abc123' });
  });

  it('sends X-API-KEY only when a key is set', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => opened());
    await new BitBrowserClient('http://127.0.0.1:54345', 'k', request).start('1', signal());
    await new BitBrowserClient('http://127.0.0.1:54345', '', request).start('1', signal());
    expect((request.mock.calls[0]![1]?.headers as Record<string, string>)['X-API-KEY']).toBe('k');
    expect((request.mock.calls[1]![1]?.headers as Record<string, string>)['X-API-KEY']).toBeUndefined();
  });

  it('rejects a non-local endpoint and shows a fixed message without raw text', async () => {
    const foreign = vi.fn<typeof fetch>().mockResolvedValue(json({ success: true, data: { ws: 'ws://evil.com:1/devtools/browser/x' } }));
    await expect(new BitBrowserClient('http://127.0.0.1:54345', '', foreign).start('1', signal())).rejects.toThrow('некоректну');
    const failed = vi.fn<typeof fetch>().mockResolvedValue(json({ success: false, msg: 'secret internals' }));
    const error = await new BitBrowserClient('http://127.0.0.1:54345', '', failed).start('1', signal()).catch((e: Error) => e);
    expect((error as Error).message).not.toContain('secret');
  });

  it('lists profiles with a zero-based page and remembers open ones', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ success: true, data: { page: 0, pageSize: 100, totalNum: 2, list: [{ id: 'a1', name: 'X', seq: 1 }, { id: 'b2', name: null, seq: 2 }] } }));
    const profiles = await new BitBrowserClient('http://127.0.0.1:54345', '', request).listProfiles(signal());
    expect(profiles).toEqual([{ id: 'a1', name: 'X', number: '1' }, { id: 'b2', name: '', number: '2' }]);
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({ page: 0, pageSize: 100 });
  });

  it('reports a profile as active only while its debug port answers', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(opened(53400))
      .mockResolvedValueOnce(json({ Browser: 'Chrome' })).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new BitBrowserClient('http://127.0.0.1:54346', '', request);
    expect(await client.active('p9', signal())).toBeUndefined();
    const endpoint = await client.start('p9', signal());
    expect(await client.active('p9', signal())).toBe(endpoint);
    expect(await client.active('p9', signal())).toBeUndefined();
  });

  it('maps failures and refuses unsafe input', async () => {
    expect(bitBrowserFailure(429, undefined).message).toContain('частоту');
    expect(() => new BitBrowserClient('http://example.com:54345')).toThrow();
    await expect(new BitBrowserClient('http://127.0.0.1:54345', '', vi.fn()).start('../x', signal())).rejects.toThrow('Invalid profile ID');
  });
});
