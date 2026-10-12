import { z } from 'zod';
import { localApiUrl, type AdsProfile } from '../core/model';
import type { ProfileClient } from '../core/ports';
import { realClock } from '../core/ports';
import { UserFacingError } from '../core/shop-errors';
import { ProfileStartGate, validateCdpEndpoint } from './adspower';
import { liveEndpoint, rememberEndpoint } from './endpoint-cache';

const PROFILE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

const startResponse = z.object({ success: z.literal(true), data: z.object({ ws: z.string() }) });
const failureBody = z.object({ success: z.boolean().optional(), msg: z.string().optional(), message: z.string().optional() });

export function bitBrowserFailure(status: number | undefined, message: string | undefined): UserFacingError {
  const text = (message || '').toLowerCase();
  if (/not.?exist|not.?found|no such|invalid/.test(text) || status === 404) {
    return new UserFacingError('BitBrowser не знайшов цей профіль. Перевірте ID профілю.');
  }
  if (/limit|too many|frequen|rate/.test(text) || status === 429) {
    return new UserFacingError('BitBrowser обмежив частоту запитів. Спробуйте за кілька секунд.');
  }
  if (/plan|upgrade|permission|auth|login/.test(text) || status === 401 || status === 403) {
    return new UserFacingError('BitBrowser відхилив запит. Увійдіть в акаунт BitBrowser і перевірте, що Local API дозволено вашим тарифом.');
  }
  return new UserFacingError(`BitBrowser не зміг запустити профіль${status && status !== 200 ? ` (HTTP ${status})` : ''}.`);
}

// BitBrowser's Local API listens on loopback while the app is open and signed in. A key (X-API-KEY) is only
// needed when "Enable Authentication Control" is switched on in its Local API settings.
export class BitBrowserClient implements ProfileClient {
  private readonly base: string;
  constructor(apiUrl: string, private readonly apiKey = '', private readonly request: typeof fetch = fetch,
    private readonly startGate = new ProfileStartGate(), private readonly launch?: () => Promise<void>) {
    this.base = localApiUrl(apiUrl);
  }

  private post(path: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<Response> {
    return this.request(new URL(path, this.base), {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { 'X-API-KEY': this.apiKey } : {}) }, body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), redirect: 'error',
    });
  }

  private async launchAndWait(signal: AbortSignal): Promise<boolean> {
    if (!this.launch) return false;
    try { await this.launch(); } catch { return false; }
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      try {
        await this.post('/health', {}, signal, 3000);
        return true; // any HTTP answer means the Local API is listening
      } catch { if (signal.aborted) throw signal.reason; }
      await realClock.sleep(1000, signal);
    }
    return false;
  }

  async listProfiles(signal: AbortSignal): Promise<AdsProfile[]> {
    const profiles = new Map<string, AdsProfile>();
    const schema = z.object({ success: z.literal(true), data: z.object({ list: z.array(z.object({
      id: z.string().regex(PROFILE_ID), name: z.string().nullish(), seq: z.union([z.string(), z.number()]).optional(),
    })) }) });
    for (let page = 0; page < 100; page++) {
      await this.startGate.wait(signal);
      const response = await this.post('/browser/list', { page, pageSize: 100 }, signal, 15_000);
      if (!response.ok) throw new Error('Перевірте, що BitBrowser запущено і Local API увімкнено.');
      const result = schema.safeParse(await response.json());
      if (!result.success) throw new Error('BitBrowser не надав список профілів. Увійдіть в акаунт і перевірте Local API.');
      const before = profiles.size;
      for (const profile of result.data.data.list) {
        profiles.set(profile.id, { id: profile.id, name: profile.name ?? '', number: profile.seq === undefined ? '' : String(profile.seq) });
      }
      if (result.data.data.list.length < 100 || profiles.size === before) return [...profiles.values()];
    }
    throw new Error('Список завеликий. Підтримується до 10 000 профілів.');
  }

  async active(profileId: string, signal: AbortSignal): Promise<string | undefined> {
    if (!PROFILE_ID.test(profileId)) throw new Error('Invalid profile ID');
    return liveEndpoint(`bitbrowser|${this.base}|${profileId}`, signal, this.request);
  }

  async start(profileId: string, signal: AbortSignal): Promise<string> {
    if (!PROFILE_ID.test(profileId)) throw new Error('Invalid profile ID');
    await this.startGate.wait(signal);
    const send = () => this.post('/browser/open', { id: profileId }, signal, 60_000);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      try { response = await send(); }
      catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError') ||
            !await this.launchAndWait(signal)) throw error;
        response = await send();
      }
    } catch (error) {
      if (signal.aborted) throw error;
      throw new UserFacingError(error instanceof Error && error.name === 'TimeoutError'
        ? 'BitBrowser не відповів за 60 секунд. Перевірте, чи запускається профіль вручну.'
        : 'Не вдалося зв’язатися з BitBrowser. Запустіть BitBrowser, увійдіть в акаунт і перевірте Local API.');
    }
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    const result = startResponse.safeParse(body);
    if (!result.success) {
      const failure = failureBody.safeParse(body);
      throw bitBrowserFailure(response.status, failure.data?.msg ?? failure.data?.message);
    }
    try {
      const endpoint = validateCdpEndpoint(result.data.data.ws);
      rememberEndpoint(`bitbrowser|${this.base}|${profileId}`, endpoint);
      return endpoint;
    } catch { throw new UserFacingError('BitBrowser повернув некоректну адресу браузера профілю.'); }
  }
}
