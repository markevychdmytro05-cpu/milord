import { z } from 'zod';
import { localApiUrl, type AdsProfile } from '../core/model';
import type { ProfileClient } from '../core/ports';
import { realClock } from '../core/ports';
import { liveEndpoint, rememberEndpoint } from './endpoint-cache';
import { UserFacingError } from '../core/shop-errors';
import { ProfileStartGate, validateCdpEndpoint } from './adspower';

const PUBLIC_API = 'https://dolphin-anty-api.com';
const PROFILE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

const startResponse = z.object({
  success: z.literal(true),
  automation: z.object({ port: z.number().int().min(1).max(65535), wsEndpoint: z.string().regex(/^\/devtools\/browser\/[\w-]+$/) }),
});

export function dolphinFailure(status: number | undefined, message: string | undefined): UserFacingError {
  const text = (message || '').toLowerCase();
  if (status === 402 || /free plan|upgrade|subscription|plan/.test(text)) {
    return new UserFacingError('Тариф Dolphin Anty не дозволяє автоматизацію (на Free вона недоступна). Потрібен платний тариф.');
  }
  if (status === 401 || /unauthor|token|auth/.test(text)) {
    return new UserFacingError('Dolphin Anty відхилив запит. Перевірте API-токен у налаштуваннях.');
  }
  if (/not.?found|not.?exist|no such/.test(text) || status === 404) {
    return new UserFacingError('Dolphin Anty не знайшов цей профіль. Перевірте ID профілю.');
  }
  if (/limit|too many|rate/.test(text) || status === 429) {
    return new UserFacingError('Dolphin Anty обмежив частоту запитів. Спробуйте за кілька секунд.');
  }
  return new UserFacingError(`Dolphin Anty не зміг запустити профіль${status ? ` (HTTP ${status})` : ''}.`);
}

export class DolphinClient implements ProfileClient {
  private readonly base: string;
  constructor(apiUrl: string, private readonly token: string, private readonly request: typeof fetch = fetch,
    private readonly startGate = new ProfileStartGate(), private readonly launch?: () => Promise<void>) {
    this.base = localApiUrl(apiUrl);
  }

  private async login(signal: AbortSignal): Promise<boolean> {
    if (!this.token) return false;
    const response = await this.request(new URL('/v1.0/auth/login-with-token', this.base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: this.token }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error',
    });
    return response.ok;
  }

  // Opens Dolphin Anty when its Local API is down and waits until it answers.
  private async launchAndWait(signal: AbortSignal): Promise<boolean> {
    if (!this.launch) return false;
    try { await this.launch(); } catch { return false; }
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      try {
        await this.request(new URL('/v1.0/browser_profiles', this.base),
          { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: 'error' });
        return true; // any HTTP answer, even 401, means the Local API is listening
      } catch { if (signal.aborted) throw signal.reason; }
      await realClock.sleep(1000, signal);
    }
    return false;
  }

  async listProfiles(signal: AbortSignal): Promise<AdsProfile[]> {
    if (!this.token) throw new Error('Вкажіть API-токен Dolphin Anty, щоб завантажити профілі.');
    const profiles = new Map<string, AdsProfile>();
    const schema = z.object({ data: z.array(z.object({
      id: z.union([z.string(), z.number()]).transform(String), name: z.string().nullish(),
    })) });
    const limit = 50;
    for (let page = 1; page <= 200; page++) {
      await this.startGate.wait(signal);
      const url = new URL('/browser_profiles', PUBLIC_API);
      url.searchParams.set('page', String(page)); url.searchParams.set('limit', String(limit));
      const response = await this.request(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error',
      });
      if (!response.ok) throw new Error('Dolphin Anty відхилив запит. Перевірте API-токен.');
      const result = schema.safeParse(await response.json());
      if (!result.success) throw new Error('Dolphin Anty не надав список профілів. Перевірте API-токен.');
      const before = profiles.size;
      for (const profile of result.data.data) {
        if (!PROFILE_ID.test(profile.id)) continue;
        profiles.set(profile.id, { id: profile.id, name: profile.name ?? '', number: profile.id });
      }
      if (result.data.data.length < limit || profiles.size === before) return [...profiles.values()];
    }
    throw new Error('Список завеликий. Підтримується до 10 000 профілів.');
  }

  // Dolphin has no "is this profile open" call.
  async active(profileId: string, signal: AbortSignal): Promise<string | undefined> {
    if (!PROFILE_ID.test(profileId)) throw new Error('Invalid profile ID');
    return liveEndpoint(`dolphin|${this.base}|${profileId}`, signal, this.request);
  }

  async start(profileId: string, signal: AbortSignal, deadline = Date.now() + 10_000): Promise<string> {
    if (!PROFILE_ID.test(profileId)) throw new Error('Invalid profile ID');
    await this.startGate.wait(signal);
    const url = new URL(`/v1.0/browser_profiles/${profileId}/start`, this.base);
    url.searchParams.set('automation', '1');
    const send = () => this.request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]), redirect: 'error' });
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      try { response = await send(); }
      catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError') ||
            !await this.launchAndWait(signal)) throw error;
        response = await send();
      }
      // The Local API needs a token login after every Dolphin restart.
      if (response.status === 401 && Date.now() < deadline && await this.login(signal)) response = await send();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new UserFacingError(error instanceof Error && error.name === 'TimeoutError'
        ? 'Dolphin Anty не відповів за 60 секунд. Перевірте, чи запускається профіль вручну.'
        : 'Не вдалося зв’язатися з Dolphin Anty. Запустіть Dolphin Anty і увійдіть в акаунт.');
    }
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    const result = startResponse.safeParse(body);
    if (!result.success) {
      const failure = z.object({ error: z.string().optional(), message: z.string().optional() }).safeParse(body);
      throw dolphinFailure(response.status, failure.data?.error ?? failure.data?.message);
    }
    try {
      const { port, wsEndpoint } = result.data.automation;
      const endpoint = validateCdpEndpoint(`ws://127.0.0.1:${port}${wsEndpoint}`);
      rememberEndpoint(`dolphin|${this.base}|${profileId}`, endpoint);
      return endpoint;
    } catch { throw new UserFacingError('Dolphin Anty повернув некоректну адресу браузера профілю.'); }
  }
}
