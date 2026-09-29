import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { LicenseClient, licenseServerUrl, TEST_LICENSE_KEY } from '../src/main/license-client';
import type { LicenseConfig } from '../src/main/license-client';

const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const KEY = 'ABCD-EFGH-JKLM-NPQR';
const NOW = Date.parse('2026-09-29T14:00:00Z');
const DEVICE = 'device-test-1234';
function fixture(options: Partial<LicenseConfig> = {}) {
  let now = NOW, count = 2, saved = '';
  let reply: (body: Record<string, unknown>) => Response = body => signed(body);
  const vault = {
    load: async () => ({ value: saved, saved: !!saved }),
    save: vi.fn(async (value: string) => { saved = value; }),
    clear: vi.fn(async () => { saved = ''; }),
  };
  const request = vi.fn(async (_url: unknown, init: RequestInit | undefined) => reply(JSON.parse(init!.body as string))) as unknown as typeof fetch;
  const config = { serverUrl: 'http://127.0.0.1:8000', publicKey, deviceId: DEVICE, deviceName: 'Test PC', appVersion: '0.1.0', ...options };
  const make = () => new LicenseClient(config, vault, () => count, request, () => now);
  return { client: make(), make, vault, request, saved: () => saved,
    reply: (next: typeof reply) => { reply = next; }, clock: (next: number) => { now = next; }, usage: (next: number) => { count = next; } };
}
function signed(body: Record<string, unknown>, changes: Record<string, unknown> = {}, status = 200): Response {
  const data = JSON.stringify({ success: true, error: null,
    license: { id: 1, max_accounts: 5, max_devices: 1, expires_at: null },
    server_time: new Date(NOW).toISOString(), valid_until: new Date(NOW + 72 * 3600_000).toISOString(),
    device_id: body.device_id, nonce: body.nonce, ...changes });
  return Response.json({ data, signature: sign(null, Buffer.from(data), pair.privateKey).toString('base64') }, { status });
}

describe('license integration contract', () => {
  it('blocks before activation; activates with a nonce, usage, and no key returned to the renderer', async () => {
    const f = fixture();
    expect(() => f.client.assertAccess()).toThrow('Активуйте');
    await f.client.activate('abcdefghjklmnpqr');
    expect(f.client.state()).toMatchObject({ allowed: true, status: 'active', keySuffix: 'NPQR', maxAccounts: 5 });
    const [, init] = vi.mocked(f.request).mock.calls[0]!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ key: KEY, accounts_used: 2, device_id: DEVICE, app_version: '0.1.0' });
    expect(JSON.parse(init!.body as string).nonce).toMatch(/^[a-f0-9]{48}$/);
    expect(JSON.stringify(f.client.state())).not.toContain(KEY);
  });
  it('validates the cached signature on restart and permits only the remaining grace period', async () => {
    const f = fixture(); await f.client.activate(KEY);
    const restored = f.make(); await restored.load();
    expect(restored.state()).toMatchObject({ status: 'offline', allowed: true });
    f.clock(NOW + 72 * 3600_000);
    expect(restored.state()).toMatchObject({ status: 'expired', allowed: false });
  });
  it('allows a network failure only while the signed grant is valid', async () => {
    const f = fixture(); await f.client.activate(KEY);
    f.reply(() => { throw new Error('connection refused'); });
    await f.client.check(); expect(f.client.state()).toMatchObject({ allowed: true, status: 'offline' });
    f.clock(NOW + 72 * 3600_000);
    await expect(f.client.check()).rejects.toThrow('недоступний');
    expect(f.client.state().allowed).toBe(false);
  });
  it.each([429, 503])('keeps the existing offline grant on transient HTTP %s', async status => {
    const f = fixture(); await f.client.activate(KEY);
    f.reply(() => new Response('temporary', { status }));
    await f.client.check(); expect(f.client.state().status).toBe('offline');
  });
  it.each(['license_revoked', 'license_expired', 'device_limit_reached', 'accounts_limit_exceeded'])('persists signed denial %s and never reuses an older offline grant', async error => {
    const f = fixture(); await f.client.activate(KEY);
    f.reply(body => signed(body, { success: false, error, valid_until: undefined }, 403));
    await expect(f.client.check()).rejects.toThrow();
    expect(f.client.state().allowed).toBe(false);
    const restored = f.make(); await restored.load();
    expect(restored.state()).toMatchObject({ status: 'blocked', allowed: false });
    f.reply(() => { throw new Error('offline'); });
    await expect(restored.check()).rejects.toThrow();
    expect(restored.state().allowed).toBe(false);
  });
  it.each([
    { nonce: 'replayed' }, { device_id: 'another-device' },
    { valid_until: new Date(NOW + 73 * 3600_000).toISOString() },
    { license: { id: 1, max_accounts: 5, max_devices: 1, expires_at: new Date(NOW + 3600_000).toISOString() } },
    { server_time: new Date(NOW - 600_000).toISOString() },
  ])('rejects a signed response for a wrong request or invalid time: %j', async change => {
    const f = fixture(); f.reply(body => signed(body, change));
    await expect(f.client.activate(KEY)).rejects.toThrow('перевірку');
    expect(f.client.state().allowed).toBe(false); expect(f.vault.save).not.toHaveBeenCalled();
  });
  it('rejects a forged response despite a previously valid grant', async () => {
    const f = fixture(); await f.client.activate(KEY);
    f.reply(() => Response.json({ data: '{}', signature: Buffer.alloc(64).toString('base64') }));
    await expect(f.client.check()).rejects.toThrow('перевірку'); expect(f.client.state().allowed).toBe(false);
  });
  it('rejects unsigned responses', async () => {
    const f = fixture(); f.reply(() => Response.json({ data: '{}', signature: null }));
    await expect(f.client.activate(KEY)).rejects.toThrow('перевірку');
  });
  it('enforces the account limit locally without an HTTP call on the purchase path', async () => {
    const f = fixture(); await f.client.activate(KEY);
    f.client.assertAccess(5);
    expect(() => f.client.assertAccess(6)).toThrow('ліміт');
    expect(f.request).toHaveBeenCalledTimes(1);
    f.usage(6); expect(f.client.state().allowed).toBe(false);
    f.usage(2); expect(f.client.state().allowed).toBe(true);
  });
  it('does not allow moving the clock before the signed grant was issued', async () => {
    const f = fixture(); await f.client.activate(KEY); f.clock(NOW - 600_000);
    expect(f.client.state().allowed).toBe(false);
  });
  it('coalesces checks and uses a fresh nonce for the next check', async () => {
    const f = fixture(); await f.client.activate(KEY);
    await Promise.all([f.client.check(), f.client.check(), f.client.check()]);
    expect(f.request).toHaveBeenCalledTimes(2);
    const nonces = vi.mocked(f.request).mock.calls.map(([, init]) => JSON.parse(init!.body as string).nonce);
    expect(new Set(nonces).size).toBe(2);
  });
  it('cannot restore a server grant under a different server configuration', async () => {
    const f = fixture(); await f.client.activate(KEY);
    const changed = new LicenseClient({ serverUrl: 'http://localhost:8001', publicKey, deviceId: DEVICE,
      deviceName: 'Test', appVersion: '0.1.0' }, f.vault, () => 2);
    await changed.load(); expect(changed.state().allowed).toBe(false);
  });
  it('fails closed when secure persistence is unavailable', async () => {
    const f = fixture(); f.vault.save.mockRejectedValue(new Error('unavailable'));
    await expect(f.client.activate(KEY)).rejects.toThrow('зберегти'); expect(f.client.state().allowed).toBe(false);
  });
  it('runs the embedded test key offline, survives restart, and never contacts the server', async () => {
    const f = fixture({ allowTestKey: true });
    f.reply(() => { throw new Error('No server'); });
    await f.client.activate(TEST_LICENSE_KEY); await f.client.check();
    expect(f.client.state()).toMatchObject({ status: 'test', allowed: true, maxAccounts: 200 });
    const restored = f.make(); await restored.load(); await restored.check();
    expect(restored.state().allowed).toBe(true); expect(f.request).not.toHaveBeenCalled();
    await restored.clear(); expect(restored.state().allowed).toBe(false);
  });
  it('a release with test access disabled rejects both activation and a cached test key', async () => {
    const f = fixture({ allowTestKey: true }); await f.client.activate(TEST_LICENSE_KEY);
    const release = new LicenseClient({ serverUrl: 'http://127.0.0.1:8000', publicKey, deviceId: DEVICE,
      deviceName: 'Test', appVersion: '0.1.0', allowTestKey: false }, f.vault, () => 2, f.request);
    await release.load(); expect(release.state().allowed).toBe(false);
    await expect(release.activate(TEST_LICENSE_KEY)).rejects.toThrow('вимкнено');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('clears the stored key and grant together', async () => {
    const f = fixture(); await f.client.activate(KEY); await f.client.clear();
    expect(f.saved()).toBe(''); expect(f.client.state()).toMatchObject({ allowed: false, status: 'unlicensed' });
  });
});

describe('license server URL', () => {
  it.each(['http://127.0.0.1:8000', 'http://localhost:8000', 'https://license.example.com'])('accepts %s', value => {
    expect(licenseServerUrl(value)).toBe(value);
  });
  it.each(['http://license.example.com', 'https://license.example.com/path', 'https://user:secret@license.example.com', 'https://license.example.com/?key=x'])('rejects %s', value => {
    expect(() => licenseServerUrl(value)).toThrow();
  });
});
