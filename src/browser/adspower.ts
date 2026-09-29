import { type Browser, type Page, type Response } from 'patchright-core';
import { connectProfile } from './connect';
import { z } from 'zod';
import { localApiUrl, productUrl, type AdsProfile } from '../core/model';
import { intersectBounds, responseOffsetBounds, type OffsetBounds } from '../core/clock-bounds';
import type { BrowserProvider, PageState, PreparedProfile, PreparationOptions, ReloadTiming, ShopSession } from '../core/ports';
import { realClock } from '../core/ports';
import { glidePointer, pointerCurve, profileMotionTempo, wheelSteps } from '../core/pointer-motion';
import { ShopRequestGuard, UserFacingError } from '../core/shop-errors';
import type { NbuLogin } from './nbu-login';
import type { PageRecorder } from './page-recorder';
import { assertShopPage, BUY_BUTTON, clickBuyButton, prepareClickWorld, readNbuPage, readVisibleCartProductIds, waitForActionablePage, warmConnection } from './nbu-page';

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

export class AdsPowerConnectionError extends UserFacingError {}

export class AdsPowerClient {
  private readonly base: string;
  constructor(apiUrl: string, private readonly apiKey: string, private readonly request: typeof fetch = fetch,
    private readonly startGate = new ProfileStartGate(), private readonly launch?: () => Promise<void>) {
    this.base = localApiUrl(apiUrl);
  }

  // Opens AdsPower when its Local API is down and waits until the API answers.
  private async launchAndWait(signal: AbortSignal): Promise<boolean> {
    if (!this.launch) return false;
    try { await this.launch(); } catch { return false; }
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      try {
        const response = await this.request(new URL('/status', this.base),
          { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), redirect: 'error' });
        if (response.ok) return true;
      } catch { if (signal.aborted) throw signal.reason; }
      await realClock.sleep(1000, signal);
    }
    return false;
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

  // Query only. Callers explicitly decide whether an inactive profile should be started.
  async active(profileId: string, signal: AbortSignal): Promise<string | undefined> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profileId)) throw new Error('Invalid profile ID');
    await this.startGate.wait(signal);
    const url = new URL('/api/v1/browser/active', this.base);
    url.searchParams.set('user_id', profileId);
    try {
      const response = await this.request(url, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'error',
      });
      if (response.status === 401 || response.status === 403) throw new UserFacingError('AdsPower відхилив запит. Перевірте API-ключ у налаштуваннях.');
      if (!response.ok) throw new UserFacingError(`AdsPower Local API відповів помилкою (HTTP ${response.status}).`);
      const result = z.object({ code: z.literal(0), data: z.object({ status: z.enum(['Active', 'Inactive']),
        ws: z.object({ puppeteer: z.string() }).optional(),
      }) }).safeParse(await response.json());
      if (!result.success) throw new UserFacingError('AdsPower не надав стан профілю. Перевірте ID профілю та доступ до Local API.');
      if (result.data.data.status === 'Inactive') return undefined;
      if (!result.data.data.ws) throw new UserFacingError('AdsPower не надав адресу відкритого профілю.');
      try { return validateCdpEndpoint(result.data.data.ws.puppeteer); }
      catch { throw new UserFacingError('AdsPower повернув некоректну адресу браузера профілю.'); }
    } catch (error) {
      if (signal.aborted || error instanceof UserFacingError) throw error;
      throw new AdsPowerConnectionError('Не вдалося перевірити відкритий профіль. Перевірте AdsPower і Local API.');
    }
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
    const send = () => this.request(url, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      redirect: 'error',
    });
    let response: Awaited<ReturnType<typeof fetch>>; // not Playwright's Response, which is imported here
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

// The Date header reflects the server's clock when it started building the response, not when
// we received it. Assuming a symmetric round trip, the midpoint of the request is a closer match
// than the raw receipt time. No extra request: this reuses the navigation we already made.
export function compensateForLatency(receivedAt: number, sentAt: number | undefined): number {
  if (sentAt === undefined || !Number.isFinite(sentAt)) return receivedAt;
  const rtt = Math.max(0, receivedAt - sentAt);
  return receivedAt - rtt / 2;
}

// Where the time of a reload went, from what the browser already recorded. Unknown phases are left out.
export function reloadTiming(response: Pick<Response, 'status' | 'headers' | 'request'>): ReloadTiming {
  const timing: ReloadTiming = { httpStatus: response.status() };
  try {
    const t = response.request().timing();
    const span = (from: number, to: number) => from >= 0 && to >= from ? Math.round(to - from) : undefined;
    const values = { dnsMs: span(t.domainLookupStart, t.domainLookupEnd), connectMs: span(t.connectStart, t.connectEnd),
      requestMs: t.requestStart >= 0 ? Math.round(t.requestStart) : undefined, ttfbMs: span(t.requestStart, t.responseStart) };
    for (const [key, value] of Object.entries(values)) if (value !== undefined) timing[key as keyof typeof values] = value;
  } catch {}
  const date = response.headers().date;
  if (date) timing.serverDate = date;
  return timing;
}

export class AdsPowerProvider implements BrowserProvider {
  constructor(private readonly client: AdsPowerClient,
    private readonly guard = new ShopRequestGuard(),
    private readonly preparationGate = new PreparationGate(),
    private readonly login?: NbuLogin,
    private readonly recorder?: PageRecorder) {}

  async connect(profileId: string, url: string, signal: AbortSignal, options?: PreparationOptions): Promise<ShopSession> {
    const prepared = await this.prepare(profileId, [url], signal, options);
    try {
      const session = await prepared.connect(profileId, url, signal, options);
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
    const detachRecorders: Array<() => void> = [];
    const offsets = new Map<Page, number>();
    const offsetBounds = new Map<Page, OffsetBounds>();
    const navigationStatuses = new Map<Page, number>();
    const navigationSentAt = new Map<Page, number>();
    const goto = (page: Page, url: string) => { navigationSentAt.set(page, Date.now()); return page.goto(url, { waitUntil: 'domcontentloaded' }); };
    const reload = (page: Page) => { navigationSentAt.set(page, Date.now()); return page.reload({ waitUntil: 'domcontentloaded' }); };
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
          if (state.inCart) state.cartConfirmation = 'visible-cart';
        }
      }
      return { ...state, navigationHttpStatus: navigationStatuses.get(page), sharedRateLimit: this.guard.isBlocked(),
        rateLimited: !state.inCart && (state.rateLimited || this.guard.isBlocked()) };
    };
    const observeResponse = (page: Page, response: Response) => {
      if (seenResponses.has(response)) return;
      seenResponses.add(response);
      if (new URL(response.url()).origin !== 'https://coins.bank.gov.ua') return;
      if (response.status() === 429) this.guard.block(response.headers()['retry-after']);
      if (response.request().isNavigationRequest() && response.request().frame() === page.mainFrame()) {
        navigationStatuses.set(page, response.status());
      }
      if (response.request().isNavigationRequest() && response.request().frame() === page.mainFrame() && response.ok()) {
        const receivedAt = Date.now();
        offsets.set(page, responseClockOffset(response.headers().date,
          compensateForLatency(receivedAt, navigationSentAt.get(page))));
        const bounds = responseOffsetBounds(response.headers().date, navigationSentAt.get(page), receivedAt);
        const previous = offsetBounds.get(page);
        if (bounds) offsetBounds.set(page, intersectBounds(previous ? [bounds, previous] : [bounds])!);
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
          const response = await reload(page);
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
      try { browser = await connectProfile(endpoint, 20_000); }
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
            const response = await goto(page, target);
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
        connect: async (requestedProfile, url, taskSignal, taskOptions) => {
          if (disconnected || requestedProfile !== profileId) throw new Error('Prepared profile is unavailable');
          const target = productUrl(url);
          const check = () => { taskSignal.throwIfAborted(); };
          let page = pages.get(target);
          if (!page || page.isClosed()) {
            if (!connection.isConnected()) throw new Error('Browser connection closed');
            // The coin's tab was closed or crashed: open it again rather than give up the sale.
            const fresh = await context.newPage();
            fresh.setDefaultTimeout(5000);
            fresh.setDefaultNavigationTimeout(20_000);
            observe(fresh);
            check();
            const response = await goto(fresh, target);
            if (response) observeResponse(fresh, response);
            pages.set(target, fresh);
            page = fresh;
          }
          check();
          await page.bringToFront();
          // Opened now, before the sale, so the click does not pay for it.
          const cdp = await context.newCDPSession(page);
          await prepareClickWorld(cdp).catch(() => {});
          check();
          const tempo = profileMotionTempo(profileId);
          let pointer: { x: number; y: number } | undefined;
          // Moves along a human-like path, stopping early (mid-path) when the time budget runs out.
          const glide = async (to: { x: number; y: number }, view: { width: number; height: number }, until: number) => {
            const from = pointer ?? { x: view.width * (0.3 + Math.random() * 0.4), y: view.height * (0.3 + Math.random() * 0.4) };
            pointer = await glidePointer(pointerCurve(from, to, view.width, view.height, tempo), async (step) => {
              check(); assertShopPage(page, target);
              await page.mouse.move(step.x, step.y);
            }, realClock, taskSignal, until);
          };
          const recording = taskOptions?.capture && this.recorder?.forTask(taskOptions.capture.taskId, taskOptions.capture.saleAt);
          if (recording) detachRecorders.push(recording.attach(page));
          // Under heavy load a read can land exactly while the document is being replaced, a reload can
          // outlast its timeout, and a dropped connection leaves Chrome's own error page in the tab. None
          // of these is a reason to give up the sale: the buyer sees "no button yet" and reloads on schedule.
          const errorPage = () => page.url().startsWith('chrome-error://');
          const onTarget = () => { if (!errorPage()) assertShopPage(page, target); };
          const transient = (error: unknown) => !taskSignal.aborted && error instanceof Error &&
            /Execution context was destroyed|Cannot find context|navigat|Timeout|net::ERR_|frame was detached/i.test(error.message);
          // A request the shop never answers keeps the tab "loading": a page read then waits for a document
          // that never arrives. Stopping the load returns the tab to the page it had, so the buyer can read it
          // and reload on schedule. The stop is a DevTools command that needs no page script.
          const stopLoading = () => cdp.send('Page.stopLoading').then(() => {}, () => {});
          const READ_WATCHDOG_MS = 4000;
          const stalled = Symbol('stalled');
          const watched = async <T>(action: () => Promise<T>): Promise<T | typeof stalled> => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([action(), new Promise<typeof stalled>((resolve) => { timer = setTimeout(() => resolve(stalled), READ_WATCHDOG_MS); })]);
            } finally { clearTimeout(timer); }
          };
          // What the buyer sees when the tab has no readable page: no shop page, no button. Never a click.
          const unreadable = (): PageState => ({ login: 'unknown', challenge: false, rateLimited: this.guard.isBlocked(), turnstile: false,
            buyAvailable: false, purchasePending: false, inCart: false, queuePosition: '', sharedRateLimit: this.guard.isBlocked(),
            navigationHttpStatus: navigationStatuses.get(page) });
          const settled = async (action: () => Promise<PageState>): Promise<PageState> => {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const state = await watched(action);
                if (state !== stalled) return state;
                await stopLoading();
              } catch (error) {
                if (!transient(error)) throw error;
                await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(stopLoading);
              }
            }
            return unreadable();
          };
          // Slow but working answers must still get through: each timeout in a row allows 5 s more.
          let reloadTimeouts = 0;
          // Chrome drops an unused warmed connection after about 10 s. While reloads wait for a late button,
          // the hints are renewed so the Turnstile host is still warm when the click finally comes.
          let warmedAt = 0;
          const renewWarmth = () => {
            if (!warmedAt || Date.now() - warmedAt < 5000) return;
            warmedAt = Date.now();
            void warmConnection(cdp).catch(() => {});
          };
          // Handoff reuses the prepared tab: no AdsPower start, new tab or goto.
          return {
            prepared: true,
            read: async () => {
              check(); const state = await settled(() => readState(page)); check(); onTarget(); return state;
            },
            recoverRateLimit: async (until) => {
              check(); assertShopPage(page, target); return recover(page, taskSignal, until);
            },
            waitForActionable: async (timeoutMs) => {
              check(); onTarget();
              const state = await settled(() => waitForActionablePage(page, Math.min(1000, timeoutMs)));
              if (state.rateLimited && !this.guard.isBlocked()) this.guard.block();
              check(); onTarget();
              return { ...state, navigationHttpStatus: navigationStatuses.get(page), sharedRateLimit: this.guard.isBlocked(),
                rateLimited: state.rateLimited || this.guard.isBlocked() };
            },
            // Reuse the Date header of the ordinary document response, latency-compensated. No HEAD probes.
            serverOffset: async () => { check(); return offsets.get(page) ?? 0; },
            serverOffsetBounds: async () => { check(); return offsetBounds.get(page); },
            reload: async () => {
              check(); onTarget();
              if (this.guard.isBlocked()) return { outcome: 'rate-limited', elapsedMs: 0 }; // The buyer will enter recovery.
              const timeout = Math.min(25_000, 10_000 + reloadTimeouts * 5000);
              const startedAt = Date.now();
              let timing: ReloadTiming = { outcome: 'loaded', timeoutMs: timeout };
              try {
                // Chrome's error page cannot be reloaded into the shop: open the coin's address again.
                navigationSentAt.set(page, Date.now());
                const response = errorPage() ? await page.goto(target, { waitUntil: 'domcontentloaded', timeout })
                  : await page.reload({ waitUntil: 'domcontentloaded', timeout });
                if (response) { observeResponse(page, response); navigationStatuses.set(page, response.status()); }
                reloadTimeouts = 0;
                if (response) timing = { ...timing, ...reloadTiming(response) };
              } catch (error) {
                if (!transient(error)) throw error;
                timing.outcome = error instanceof Error && /Timeout/i.test(error.message) ? 'timeout' : 'navigation-error';
                if (timing.outcome === 'timeout') { reloadTimeouts++; await stopLoading(); }
                navigationStatuses.delete(page); // Unanswered or dropped: no status to report.
              }
              void prepareClickWorld(cdp).catch(() => {}); // The reload destroyed the previous world.
              renewWarmth();
              check(); // The buyer reads the fresh page next; a second read here only delays the click.
              return { ...timing, elapsedMs: Date.now() - startedAt };
            },
            login: async () => {
              check(); assertShopPage(page, target);
              if (!this.login?.available(profileId)) return false;
              await this.login.ensure(context, profileId, taskSignal);
              check(); assertShopPage(page, target);
              await this.guard.wait(taskSignal, deadline);
              const response = await reload(page);
              if (response) observeResponse(page, response);
              void prepareClickWorld(cdp).catch(() => {});
              check();
              return true;
            },
            capture: async (request) => {
              if (!recording || page.isClosed()) return;
              await recording.snapshot(page, request);
            },
            idle: async (ms) => {
              const until = Date.now() + ms;
              check(); assertShopPage(page, target);
              const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, visible: document.visibilityState === 'visible' }));
              // Only the tab in front moves; a person holds one pointer. Often the hand simply rests.
              if (!view.visible || Math.random() < 0.4) return;
              await glide({ x: view.width * (0.1 + Math.random() * 0.8), y: view.height * (0.12 + Math.random() * 0.76) }, view, until);
            },
            approach: async (ms) => {
              const until = Date.now() + ms;
              check(); assertShopPage(page, target);
              const box = await page.evaluate((selector) => {
                const element = document.querySelector(selector) ?? document.querySelector('#r_buy_intovar');
                const rect = element?.getBoundingClientRect();
                return { width: innerWidth, height: innerHeight, rect: rect && rect.width && rect.height
                  ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined };
              }, BUY_BUTTON);
              if (!box.rect) return;
              let { top } = box.rect;
              // Scroll now, well before the sale, rather than at the moment of the click.
              if ((top < 0 || top + box.rect.height > box.height) && Date.now() + 800 < until) {
                const distance = top + box.rect.height / 2 - box.height / 2;
                for (const delta of wheelSteps(distance)) {
                  check(); await page.mouse.wheel(0, delta);
                  await realClock.sleep(30 + Math.random() * 60, taskSignal);
                }
                await realClock.sleep(150, taskSignal);
                top -= distance;
              }
              const spot = { x: box.rect.left + box.rect.width * (0.3 + Math.random() * 0.4), y: top + box.rect.height * (0.3 + Math.random() * 0.4) };
              await glide(spot, box, until);
            },
            warmConnection: async () => {
              check(); assertShopPage(page, target); warmedAt = Date.now(); await warmConnection(cdp);
            },
            clickBuy: async () => {
              check(); this.guard.check(); assertShopPage(page, target); return clickBuyButton(cdp, page);
            },
            // Batch owns the browser connection until its last task; only this task's channel closes.
            disconnect: async () => { await cdp.detach().catch(() => {}); },
          };
        },
        alive: () => !disconnected && connection.isConnected(),
        disconnect: async () => {
          if (disconnected) return;
          disconnected = true;
          for (const { page, handler } of listeners) page.off('response', handler);
          for (const detach of detachRecorders) detach();
          await connection.close(); // Disconnect CDP only; leave the user's browser and tabs open.
        },
      };
    } catch (error) {
      for (const { page, handler } of listeners) page.off('response', handler);
      for (const detach of detachRecorders) detach();
      await browser?.close().catch(() => {});
      throw error;
    }
  }
}
