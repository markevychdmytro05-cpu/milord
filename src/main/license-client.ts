import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import type { LicenseState } from '../core/license';
import type { KeyStore } from './key-store';

export const licenseKeySchema = z.string().trim().min(1).max(64).transform(value => {
  const chars = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[2-9A-HJ-NP-Z]{16}$/.test(chars)) throw new Error('Ключ ліцензії має формат XXXX-XXXX-XXXX-XXXX.');
  return chars.match(/.{4}/g)!.join('-');
});
const envelopeSchema = z.object({ data: z.string().max(16_384), signature: z.string().max(128) });
const limitsSchema = z.object({ id: z.number().int().positive(), max_accounts: z.number().int().nonnegative(),
  max_devices: z.number().int().nonnegative(), expires_at: z.iso.datetime({ offset: true }).nullable() });
const payloadSchema = z.object({ success: z.boolean(), error: z.string().nullable(), license: limitsSchema.nullable(),
  valid_until: z.iso.datetime({ offset: true }).optional(), device_id: z.string(), nonce: z.string().nullable(),
  server_time: z.iso.datetime({ offset: true }) });
type Envelope = z.infer<typeof envelopeSchema>;
type Payload = z.infer<typeof payloadSchema>;
export const TEST_LICENSE_KEY = 'NBU2-TEST-FRND-2626';
const vaultSchema = z.union([
  z.object({ kind: z.literal('server'), key: licenseKeySchema, serverUrl: z.string(), envelope: envelopeSchema }),
  z.object({ kind: z.literal('test'), key: z.literal(TEST_LICENSE_KEY) }),
]);
const errors: Record<string, string> = {
  license_not_found: 'Ліцензійний ключ не знайдено.', license_revoked: 'Ліцензію відкликано.',
  license_expired: 'Термін ліцензії закінчився.', device_not_activated: 'Активуйте ключ на цьому пристрої.',
  device_limit_reached: 'Досягнуто ліміт пристроїв. Зверніться до адміністратора ліцензій.',
  accounts_limit_exceeded: 'Перевищено ліміт акаунтів. Зменште кількість збережених профілів або змініть тариф.',
};
export interface LicenseConfig { serverUrl: string; publicKey: string; deviceId: string; deviceName: string; appVersion: string; allowTestKey?: boolean; }

export function licenseServerUrl(value: string): string {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') throw new Error('Сервер ліцензій потребує HTTPS або локальної HTTP-адреси.');
  return url.origin;
}

export class LicenseClient {
  private readonly publicKey: KeyObject;
  private key = '';
  private test = false;
  private payload?: Payload;
  private offline = true;
  private problem?: string;
  private timer?: ReturnType<typeof setInterval>;
  private operations: Promise<unknown> = Promise.resolve();
  private checking?: Promise<void>;

  constructor(private readonly config: LicenseConfig, private readonly vault: Pick<KeyStore, 'load' | 'save' | 'clear'>,
    private readonly accountsUsed: () => number, private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now) {
    config.serverUrl = licenseServerUrl(config.serverUrl);
    const raw = Buffer.from(config.publicKey, 'base64');
    if (raw.length !== 32) throw new Error('Некоректний публічний ключ сервера ліцензій.');
    this.publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  }

  async load(): Promise<void> {
    const saved = await this.vault.load();
    if (saved.error) { this.problem = 'Не вдалося відкрити збережену ліцензію. Активуйте ключ повторно.'; return; }
    if (!saved.value) return;
    try {
      const record = vaultSchema.parse(JSON.parse(saved.value));
      if (record.kind === 'test') {
        if (!this.config.allowTestKey) throw new Error('Test access disabled');
        this.key = record.key; this.test = true; return;
      }
      if (record.serverUrl !== this.config.serverUrl) throw new Error('Server changed');
      const payload = this.verify(record.envelope);
      this.key = record.key; this.payload = payload;
    } catch { this.problem = 'Збережена ліцензія не пройшла перевірку. Активуйте ключ повторно.'; }
  }

  start(): void {
    void this.check().catch(() => {});
    this.timer = setInterval(() => { void this.check().catch(() => {}); }, 15 * 60_000);
    this.timer.unref();
  }
  async stop(): Promise<void> { clearInterval(this.timer); await this.operations; }

  state(count = this.accountsUsed()): LicenseState {
    const base = { serverUrl: this.config.serverUrl, deviceId: this.config.deviceId, accountsUsed: count,
      ...(this.key ? { keySuffix: this.key.slice(-4) } : {}),
      ...(this.payload?.license ? { maxAccounts: this.payload.license.max_accounts, maxDevices: this.payload.license.max_devices,
        expiresAt: this.payload.license.expires_at } : {}), ...(this.payload?.valid_until ? { validUntil: this.payload.valid_until } : {}) };
    const result = (status: LicenseState['status'], allowed: boolean, message: string): LicenseState => ({ ...base, status, allowed, message });
    if (this.problem) return result('error', false, this.problem);
    if (this.test) return { ...result(count <= 200 ? 'test' : 'blocked', count <= 200, count <= 200
      ? 'Тестовий доступ. Сервер ліцензій не потрібен.' : errors.accounts_limit_exceeded!), maxAccounts: 200 };
    if (!this.payload) return result('unlicensed', false, 'Активуйте ліцензію в налаштуваннях.');
    if (!this.payload.success) return result('blocked', false, errors[this.payload.error ?? ''] ?? 'Сервер відхилив ліцензію.');
    if (this.now() < Date.parse(this.payload.server_time) - 5 * 60_000) return result('error', false, 'Перевірте дату й час комп’ютера.');
    if (this.now() >= Date.parse(this.payload.valid_until!)) return result('expired', false, 'Потрібна нова перевірка ліцензії. Підключіть сервер і натисніть «Перевірити ліцензію».');
    if (count > this.payload.license!.max_accounts) return result('blocked', false, errors.accounts_limit_exceeded!);
    return result(this.offline ? 'offline' : 'active', true, this.offline
      ? 'Офлайн-доступ за останньою підтвердженою ліцензією.' : 'Ліцензія активна.');
  }
  assertAccess(count = this.accountsUsed()): void {
    const state = this.state(count);
    if (!state.allowed) throw new Error(state.message);
  }

  activate(value: string): Promise<void> {
    const key = licenseKeySchema.parse(value);
    return this.serial(async () => {
      if (key === TEST_LICENSE_KEY) {
        if (!this.config.allowTestKey) throw new Error('Тестовий ключ вимкнено в цій збірці.');
        await this.vault.save(JSON.stringify({ kind: 'test', key }));
        this.key = key; this.test = true; this.payload = undefined; this.problem = undefined;
        return;
      }
      const { envelope, payload } = await this.call('activate', key);
      if (!payload.success) throw new Error(errors[payload.error ?? ''] ?? 'Сервер відхилив ліцензію.');
      await this.save(key, envelope, payload);
    });
  }
  check(): Promise<void> {
    if (this.checking) return this.checking;
    const operation = this.serial(async () => {
      if (!this.key || this.test) return;
      try {
        const { envelope, payload } = await this.call('check', this.key);
        await this.save(this.key, envelope, payload);
        if (!payload.success) throw new Error(errors[payload.error ?? ''] ?? 'Сервер відхилив ліцензію.');
      } catch (error) {
        if (error instanceof LicenseUnavailable) {
          this.offline = true;
          if (this.state().allowed) return;
          throw new Error('Сервер ліцензій недоступний; чинного офлайн-дозволу немає.');
        }
        throw error;
      }
    });
    const pending = operation.finally(() => { if (this.checking === pending) this.checking = undefined; });
    this.checking = pending;
    return pending;
  }
  clear(): Promise<void> {
    return this.serial(async () => { await this.vault.clear(); this.key = ''; this.test = false; this.payload = undefined; this.problem = undefined; });
  }

  private verify(envelope: Envelope, nonce?: string): Payload {
    const signature = Buffer.from(envelope.signature, 'base64');
    if (signature.length !== 64 || !verify(null, Buffer.from(envelope.data), this.publicKey, signature)) throw new Error('Signature');
    const payload = payloadSchema.parse(JSON.parse(envelope.data));
    if (payload.device_id !== this.config.deviceId || (nonce !== undefined && payload.nonce !== nonce)) throw new Error('Request mismatch');
    if (payload.success) {
      if (payload.error !== null || !payload.license || !payload.valid_until) throw new Error('Missing grant');
      const issued = Date.parse(payload.server_time), until = Date.parse(payload.valid_until);
      if (until <= issued || until > issued + 72 * 3600_000 ||
          (payload.license.expires_at && until > Date.parse(payload.license.expires_at))) throw new Error('Invalid grant expiry');
    } else if (!payload.error) throw new Error('Missing denial');
    if (nonce !== undefined && Math.abs(this.now() - Date.parse(payload.server_time)) > 5 * 60_000) throw new Error('Clock mismatch');
    return payload;
  }
  private async call(action: 'activate' | 'check', key: string): Promise<{ envelope: Envelope; payload: Payload }> {
    const nonce = randomBytes(24).toString('hex');
    let response: Response;
    try {
      response = await this.request(`${this.config.serverUrl}/api/v1/license/${action}`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ key, device_id: this.config.deviceId, device_name: this.config.deviceName,
          app_version: this.config.appVersion, accounts_used: this.accountsUsed(), nonce }), signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 429 || response.status >= 500) throw new LicenseUnavailable();
    } catch { throw new LicenseUnavailable(); }
    let text: string;
    try { text = await response.text(); } catch { throw new LicenseUnavailable(); }
    try {
      if (text.length > 20_000) throw new Error('Oversized response');
      const envelope = envelopeSchema.parse(JSON.parse(text));
      const payload = this.verify(envelope, nonce);
      if (payload.success !== response.ok) throw new Error('Status mismatch');
      return { envelope, payload };
    } catch {
      this.problem = 'Відповідь сервера ліцензій не пройшла перевірку підпису, запиту або часу.';
      throw new Error(this.problem);
    }
  }
  private async save(key: string, envelope: Envelope, payload: Payload): Promise<void> {
    try { await this.vault.save(JSON.stringify({ kind: 'server', key, serverUrl: this.config.serverUrl, envelope })); }
    catch { this.problem = 'Не вдалося зберегти ліцензію в системному сховищі.'; throw new Error(this.problem); }
    this.key = key; this.test = false; this.payload = payload; this.offline = false; this.problem = undefined;
  }
  private serial(action: () => Promise<void>): Promise<void> {
    const operation = this.operations.then(action); this.operations = operation.catch(() => {}); return operation;
  }
}
class LicenseUnavailable extends Error {}
