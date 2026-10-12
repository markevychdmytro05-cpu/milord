import { describe, expect, it, vi } from 'vitest';
import { DolphinClient, dolphinFailure } from '../src/browser/dolphin';
import { settingsSchema } from '../src/core/model';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const started = (port = 50568) => json({ success: true, automation: { port, wsEndpoint: '/devtools/browser/c71c1a9d-f07c-4dd9-84a9-53a4c6df9969' } });
const signal = () => new AbortController().signal;

describe('Dolphin Anty Local API adapter', () => {
  it('starts a profile with automation enabled and builds the CDP endpoint', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(started());
    const client = new DolphinClient('http://127.0.0.1:3001', 'tok', request);
    expect(await client.start('12345', signal())).toBe('ws://127.0.0.1:50568/devtools/browser/c71c1a9d-f07c-4dd9-84a9-53a4c6df9969');
    const url = new URL(String(request.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v1.0/browser_profiles/12345/start');
    expect(url.searchParams.get('automation')).toBe('1');
  });

  it('logs in with the token after a 401 and retries the start', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(started(50570));
    const client = new DolphinClient('http://127.0.0.1:3001', 'tok', request);
    expect(await client.start('777', signal())).toContain(':50570/');
    expect(String(request.mock.calls[1]![0])).toContain('/v1.0/auth/login-with-token');
    expect(JSON.parse(String(request.mock.calls[1]![1]?.body))).toEqual({ token: 'tok' });
  });

  it('shows a fixed token message when login does not help', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ error: 'secret details' }, 401));
    const error = await new DolphinClient('http://127.0.0.1:3001', 'bad', request).start('1', signal()).catch((e: Error) => e);
    expect((error as Error).message).toContain('API-токен');
    expect((error as Error).message).not.toContain('secret');
  });

  it('rejects a non-numeric port or foreign wsEndpoint', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ success: true, automation: { port: 1, wsEndpoint: '@evil.com/x' } }));
    await expect(new DolphinClient('http://127.0.0.1:3001', 't', request).start('1', signal())).rejects.toThrow();
  });

  it('refuses a non-local API address and bad profile ids', async () => {
    expect(() => new DolphinClient('http://example.com:3001', 't')).toThrow();
    await expect(new DolphinClient('http://127.0.0.1:3001', 't', vi.fn()).start('../x', signal())).rejects.toThrow('Invalid profile ID');
  });

  it('reports a profile as active only while its browser answers', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(started(50600))
      .mockResolvedValueOnce(json({ Browser: 'Chrome' })).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new DolphinClient('http://127.0.0.1:3002', 't', request);
    expect(await client.active('9', signal())).toBeUndefined();
    const endpoint = await client.start('9', signal());
    expect(await client.active('9', signal())).toBe(endpoint);
    expect(await client.active('9', signal())).toBeUndefined();
  });

  it('lists profiles from the cloud API with the bearer token', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ data: [{ id: 5, name: 'A' }, { id: 6, name: null }] }));
    const profiles = await new DolphinClient('http://127.0.0.1:3001', 'tok', request).listProfiles(signal());
    expect(profiles).toEqual([{ id: '5', name: 'A', number: '5' }, { id: '6', name: '', number: '6' }]);
    expect(String(request.mock.calls[0]![0])).toContain('dolphin-anty-api.com/browser_profiles');
    expect((request.mock.calls[0]![1]?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('maps failures to fixed messages', () => {
    expect(dolphinFailure(402, 'On free plan you can\'t use automation').message).toContain('тариф');
    expect(dolphinFailure(429, undefined).message).toContain('частоту');
    expect(dolphinFailure(404, undefined).message).toContain('не знайшов');
  });
});

describe('browser setting', () => {
  it('defaults old settings files to AdsPower', () => {
    expect(settingsSchema.parse({ apiUrl: 'http://127.0.0.1:50325' }).browser).toBe('adspower');
    expect(settingsSchema.parse({ apiUrl: 'http://127.0.0.1:3001', browser: 'dolphin' }).browser).toBe('dolphin');
  });

  it('keeps the inactive browser address and profiles apart from the active ones', () => {
    const parsed = settingsSchema.parse({
      apiUrl: 'http://127.0.0.1:3001', browser: 'dolphin', savedProfiles: [{ id: '111', name: 'D' }],
      stash: { adspower: { apiUrl: 'http://127.0.0.1:50325', savedProfiles: [{ id: 'kabc', name: 'A' }] } },
    });
    expect(parsed.savedProfiles.map(p => p.id)).toEqual(['111']);
    expect(parsed.stash.adspower?.savedProfiles.map(p => p.id)).toEqual(['kabc']);
    expect(() => settingsSchema.parse({ apiUrl: 'http://127.0.0.1:3001', stash: { adspower: { apiUrl: 'http://evil.com' } } })).toThrow();
  });
});
