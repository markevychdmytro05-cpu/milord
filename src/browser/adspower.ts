import { chromium, type Browser, type Page, type Response } from 'playwright-core';
import { z } from 'zod';
import { localApiUrl, productUrl, type AdsProfile } from '../core/model';
import type { BrowserProvider, PreparedProfile, PreparationOptions, ShopSession } from '../core/ports';
import { realClock } from '../core/ports';
import { ShopRequestGuard, UserFacingError } from '../core/shop-errors';
import { assertShopPage, readNbuPage, readVisibleCartProductIds, waitForActionablePage } from './nbu-page';

const startResponse = z.object({
  code: z.literal(0),
  data: z.object({ ws: z.object({ puppeteer: z.string() }) }),
});

export function validateCdpEndpoint(value: string): string {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('AdsPower returned a non-local browser endpoint');
  }
  return url.href;
}

// Shared across profiles: space Local API launches during preparation, never sale clicks.
export class ProfileStartGate {
  private tail: Promise<void> = Promise.resolve();
  private nextAt = 0;
  wait(signal: AbortSignal): Promise<void> {
    const turn = this.tail.then(async () => {
      signal.throwIfAborted();
      const delay = this.nextAt - Date.now();
      if (delay > 0) await realClock.sleep(delay, signal);
      signal.throwIfAborted();
      this.nextAt = Date.now() + 1100;
    });
    this.tail = turn.catch(() => {});
    return turn;
  }
}

// Translate AdsPower's own error text into fixed messages. The raw text is never shown or saved.
export function adsPowerFailure(code: number | undefined, message: string | undefined): UserFacingError {
  const text = (message || '').toLowerCase();
  if (/not.?exist|not.?found|no such|invalid.?user|user.?id/.test(text)) {
    return new UserFacingError('AdsPower не знайшов цей профіль. Перевірте ID профілю.');
  }
  if (/too many|frequen|rate/.test(text)) {
    return new UserFacingError('AdsPower обмежив частоту запитів. Спробуйте за кілька секунд.');
  }
  if (/api.?key|auth|token|permission|unauthori|forbidden/.test(text)) {
    return new UserFacingError('AdsPower відхилив запит. Перевірте API-ключ у налаштуваннях.');
  }
  return new UserFacingError(`AdsPower не зміг запустити профіль${Number.isInteger(code) ? ` (код ${code})` : ''}.`);
}

export class AdsPowerClient {
  private readonly base: string;
  constructor(apiUrl: string, private readonly apiKey: string, private readonly request: typeof fetch = fetch,
    private readonly startGate = new ProfileStartGate()) {
    this.base = localApiUrl(apiUrl);
  }

  async listProfiles(signal: AbortSignal): Promise<AdsProfile[]> {
    const profiles = new Map<string, AdsProfile>();
    const schema = z.object({ code: z.literal(0), data: z.object({ list: z.array(z.object({
      user_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().default(''),
      serial_number: z.union([z.string(), z.number()]).transform(String),
    })) }) });
    for (let page = 1; page <= 100; page++) {
      await this.startGate.wait(signal);
      const url = new URL('/api/v1/user/list', this.base);
      url.searchParams.set('page', String(page)); url.searchParams.set('page_size', '100');
      const response = await this.request(url, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error',
      });
      if (!response.ok) throw new Error('Перевірте ключ і доступ до Local API в AdsPower.');
      const result = schema.safeParse(await response.json());
      if (!result.success) throw new Error('AdsPower не надав список профілів. Перевірте ключ і доступ до API у вашому тарифі.');
      for (const profile of result.data.data.list) {
        profiles.set(profile.user_id, { id: profile.user_id, name: profile.name, number: profile.serial_number });
      }
      if (result.data.data.list.length < 100) return [...profiles.values()];
    }
    throw new Error('Список завеликий. Підтримується до 10 000 профілів.');
  }

  async start(profileId: string, signal: AbortSignal): Promise<string> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profileId)) throw new Error('Invalid profile ID');
    await this.startGate.wait(signal);
    const url = new URL('/api/v1/browser/start', this.base);
    url.searchParams.set('user_id', profileId);
    // Use documented API v1, supported by AdsPower's JavaScript Playwright example.
    // Do not restore unrelated historical tabs or open the IP test page.
    url.searchParams.set('open_tabs', '1');
    url.searchParams.set('ip_tab', '0');
    let response: Awaited<ReturnType<typeof fetch>>; // not Playwright's Response, which is imported here
    try {
      response = await this.request(url, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        redirect: 'error',
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new UserFacingError(error instanceof Error && error.name === 'TimeoutError'
        ? 'AdsPower не відповів за 60 секунд. Перевірте, чи запускається профіль вручну.'
        : 'Не вдалося зв’язатися з AdsPower. Запустіть AdsPower і перевірте, що Local API увімкнено.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new UserFacingError('AdsPower відхилив запит. Перевірте API-ключ у налаштуваннях.');
    }
    if (!response.ok) throw new UserFacingError(`AdsPower Local API відповів помилкою (HTTP ${response.status}).`);
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new UserFacingError('AdsPower відповів у незрозумілому форматі. Оновіть AdsPower.'); }
    const result = startResponse.safeParse(body);
    if (!result.success) {
      const failure = z.object({ code: z.number().optional(), msg: z.string().optional() }).safeParse(body);
      throw adsPowerFailure(failure.data?.code, failure.data?.msg);
    }
    try { return validateCdpEndpoint(result.data.data.ws.puppeteer); }
    catch { throw new UserFacingError('AdsPower повернув некоректну адресу браузера профілю.'); }
  }
}

// Space preparation navigations globally; this gate never drives sale-time clicks.
export class PreparationGate {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  constructor(private readonly intervalMs = 5000) {}
  run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      signal.throwIfAborted();
      const delay = this.nextAt - Date.now();
      if (delay > 0) await realClock.sleep(delay, signal);
      signal.throwIfAborted();
      try { return await action(); }
      finally { this.nextAt = Date.now() + this.intervalMs; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}

export function responseClockOffset(date: string | undefined, receivedAt: number): number {
  const offset = Date.parse(date || '') - receivedAt;
  return Number.isFinite(offset) && Math.abs(offset) <= 300_000 ? Math.round(offset) : 0;
}

export class AdsPowerProvider implements BrowserProvider {
  constructor(private readonly client: AdsPowerClient,
    private readonly guard = new ShopRequestGuard(),
    private readonly preparationGate = new PreparationGate()) {}

  async connect(profileId: string, url: string, signal: AbortSignal, options?: PreparationOptions): Promise<ShopSession> {
    const prepared = await this.prepare(profileId, [url], signal, options);
    try {
      const session = await prepared.connect(profileId, url, signal);
      return { ...session, disconnect: () => prepared.disconnect() };
    } catch (error) { await prepared.disconnect(); throw error; }
  }

  async prepare(profileId: string, urls: string[], signal: AbortSignal, options?: PreparationOptions): Promise<PreparedProfile> {
    const targets = [...new Set(urls.map(productUrl))];
    if (!targets.length) throw new Error('No product pages to prepare');
    signal.throwIfAborted();
    const endpoint = await this.client.start(profileId, signal);
    signal.throwIfAborted();
    let browser: Browser | undefined;
    const listeners: Array<{ page: Page; handler: (response: Response) => void }> = [];
    const offsets = new Map<Page, number>();
    const pages = new Map<string, Page>();
    const deadline = options?.deadline ?? Date.now() + 300_000;
    const seenResponses = new WeakSet<Response>();
    const readState = async (page: Page) => {
      const state = await page.evaluate(readNbuPage, false);
      if (state.rateLimited && !this.guard.isBlocked()) this.guard.block();
      // Parallel store submissions may be finalized together, while only one tab updates
      // its button. The visible cart in another prepared tab can confirm this exact product.
      if (!state.inCart && state.login === 'logged-in' && pages.size) {
        const url = new URL(page.url());
        const id = url.pathname.match(/\/p-(\d+)\.html$/)?.[1] ?? url.searchParams.get('products_id');
        if (id && /^\d+$/.test(id)) {
          const carts = await Promise.all([...pages.values()].filter((candidate) => !candidate.isClosed() &&
            new URL(candidate.url()).origin === url.origin)
            .map((candidate) => candidate.evaluate(readVisibleCartProductIds).catch((): string[] => [])));
          state.inCart = carts.some((ids) => ids.includes(id));
        }
      }
      return { ...state, rateLimited: !state.inCart && (state.rateLimited || this.guard.isBlocked()) };
    };
    const observeResponse = (page: Page, response: Response) => {
      if (seenResponses.has(response)) return;
      seenResponses.add(response);
      if (new URL(response.url()).origin !== 'https://coins.bank.gov.ua') return;
      if (response.status() === 429) this.guard.block(response.headers()['retry-after']);
      if (response.request().isNavigationRequest() && response.request().frame() === page.mainFrame() && response.ok()) {
        offsets.set(page, responseClockOffset(response.headers().date, Date.now()));
      }
    };
    const recover = async (page: Page, recoverySignal: AbortSignal, until: number) => {
      let reloaded = false;
      await this.guard.retry(recoverySignal, until, async () => {
        const state = await page.evaluate(readNbuPage, false);
        if (!state.rateLimited && !this.guard.isBlocked()) return true;
        // Do not interrupt an in-flight purchase or a human verification on a healthy tab.
        if (!state.rateLimited && (state.purchasePending || state.queuePosition || state.challenge || state.turnstile)) {
          await realClock.sleep(Math.min(1000, Math.max(1, until - Date.now())), recoverySignal);
          return false;
        }
        return this.preparationGate.run(recoverySignal, async () => {
          await this.guard.wait(recoverySignal, until);
          reloaded = true;
          const response = await page.reload({ waitUntil: 'domcontentloaded' });
          if (response) observeResponse(page, response);
          const next = await page.evaluate(readNbuPage, false);
          if (next.rateLimited) this.guard.block();
          return response?.status() !== 429 && !next.rateLimited;
        });
      });
      return reloaded;
    };
    const ensurePrepared = async (page: Page) => {
      while ((await readState(page)).rateLimited) {
        await options?.onRateLimit?.();
        await recover(page, signal, deadline);
      }
    };
    try {
      try { browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 }); }
      catch (error) {
        if (signal.aborted) throw error;
        throw new UserFacingError('Не вдалося підключитися до браузера профілю. Закрийте профіль в AdsPower і спробуйте знову.');
      }
      signal.throwIfAborted();
      const context = browser.contexts()[0];
      if (!context) throw new UserFacingError('У профілі AdsPower немає відкритого вікна браузера.');
      const shopPages = context.pages().filter((page) => {
        try { return new URL(page.url()).origin === 'https://coins.bank.gov.ua'; } catch { return false; }
      });
      // Only tabs that already show a requested product are adopted. Every other store tab, for example
      // one left after an earlier purchase, is left exactly as it is: not closed, navigated, reloaded or
      // reused. The bot opens its own tab instead, so a finished purchase never blocks the next one.
      const ours = shopPages.filter((page) => targets.includes(page.url()));
      const foreign = shopPages.filter((page) => !targets.includes(page.url()));
      const observe = (page: Page) => {
        if (listeners.some((listener) => listener.page === page)) return;
        const handler = (response: Response) => observeResponse(page, response);
        page.on('response', handler);
        listeners.push({ page, handler });
      };
      for (const page of ours) {
        observe(page);
        pages.set(page.url(), page);
      }
      // A purchase still in flight in another store tab must finish first. This only reads the page:
      // it neither reloads it nor counts its 429 page against our own shared cooldown.
      for (const page of foreign) {
        const other = await page.evaluate(readNbuPage, false).catch(() => undefined);
        if (other && !other.inCart && (other.purchasePending || other.queuePosition)) {
          throw new UserFacingError('В іншій вкладці НБУ ще триває покупка. Дочекайтеся її завершення.');
        }
      }
      for (const page of ours) {
        await ensurePrepared(page);
        const state = await readState(page);
        if (!state.inCart && (state.purchasePending || state.queuePosition) && (targets.length > 1 || page.url() !== targets[0])) {
          throw new UserFacingError('У профілі вже триває покупка іншої монети. Дочекайтеся її завершення.');
        }
      }
      const used = new Set<Page>();
      for (const target of targets) {
        signal.throwIfAborted();
        const matching = ours.find((page) => page.url() === target && !used.has(page));
        const page = matching ?? await context.newPage();
        used.add(page);
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(20_000);
        observe(page);
        if (page.url() !== target) {
          if (this.guard.isBlocked()) await options?.onRateLimit?.();
          await this.guard.retry(signal, deadline, () => this.preparationGate.run(signal, async () => {
            await this.guard.wait(signal, deadline);
            const response = await page.goto(target, { waitUntil: 'domcontentloaded' });
            if (response) observeResponse(page, response);
            const state = await page.evaluate(readNbuPage, false);
            if (state.rateLimited) this.guard.block();
            return response?.status() !== 429 && !state.rateLimited;
          }));
        }
        await ensurePrepared(page);
        pages.set(target, page);
      }
      const connection = browser;
      let disconnected = false;
      await pages.get(targets[0]!)!.bringToFront();
      return {
        connect: async (requestedProfile, url, taskSignal) => {
          if (disconnected || requestedProfile !== profileId) throw new Error('Prepared profile is unavailable');
          const target = productUrl(url);
          const page = pages.get(target);
          if (!page || page.isClosed()) throw new UserFacingError('Вкладку монети закрито. Не закривайте її до кінця завдання.');
          const check = () => { taskSignal.throwIfAborted(); };
          check();
          await page.bringToFront();
          // Handoff reuses the prepared tab: no AdsPower start, new tab or goto.
          return {
            prepared: true,
            read: async () => {
              check(); const state = await readState(page); check(); assertShopPage(page, target); return state;
            },
            recoverRateLimit: async (until) => {
              check(); assertShopPage(page, target); return recover(page, taskSignal, until);
            },
            waitForActionable: async (timeoutMs) => {
              check(); assertShopPage(page, target);
              const state = await waitForActionablePage(page, Math.min(1000, timeoutMs));
              if (state.rateLimited && !this.guard.isBlocked()) this.guard.block();
              check(); assertShopPage(page, target);
              return { ...state, rateLimited: state.rateLimited || this.guard.isBlocked() };
            },
            // Reuse the Date header of the ordinary document response. No HEAD probes.
            serverOffset: async () => { check(); return offsets.get(page) ?? 0; },
            reload: async () => {
              check(); assertShopPage(page, target);
              if (this.guard.isBlocked()) return; // The buyer will enter the shared recovery loop.
              const response = await page.reload({ waitUntil: 'domcontentloaded' });
              if (response) observeResponse(page, response);
              check(); await readState(page);
            },
            clickBuy: async () => {
              check(); this.guard.check(); assertShopPage(page, target); await page.evaluate(readNbuPage, true);
            },
            disconnect: async () => {}, // Batch owns the CDP connection until its last task.
          };
        },
        disconnect: async () => {
          if (disconnected) return;
          disconnected = true;
          for (const { page, handler } of listeners) page.off('response', handler);
          await connection.close(); // Disconnect CDP only; leave the user's browser and tabs open.
        },
      };
    } catch (error) {
      for (const { page, handler } of listeners) page.off('response', handler);
      await browser?.close().catch(() => {});
      throw error;
    }
  }
}
