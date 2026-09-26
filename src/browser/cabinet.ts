import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { CabinetOrderDetails, CabinetOrdersPage, CabinetSection, CabinetSnapshot } from '../core/cabinet';
import { ShopRateLimitError, ShopRequestGuard, UserFacingError } from '../core/shop-errors';
import { AdsPowerClient, PreparationGate } from './adspower';
import { readCabinetPage, type CabinetPageResult } from './cabinet-page';
import type { NbuLogin } from './nbu-login';

const ORIGIN = 'https://coins.bank.gov.ua';
const messages = {
  login: 'Увійдіть в акаунт НБУ у профілі AdsPower або додайте «Вхід НБУ» біля профілю в налаштуваннях.',
  challenge: 'Завершіть перевірку НБУ у профілі AdsPower. Кабінет не змінює відкриті вкладки.',
  'rate-limit': 'НБУ обмежив запити (429). Зачекайте та повторіть завантаження.',
  unrecognized: 'Не вдалося розпізнати дані сторінки НБУ. Список не вважається порожнім; повторіть завантаження.',
};
export function cabinetError(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return 'Завантаження кабінету зупинено або вичерпано час очікування.';
  if (error instanceof ShopRateLimitError) return messages['rate-limit'];
  return error instanceof UserFacingError ? error.message
    : 'Не вдалося прочитати кабінет. Перевірте AdsPower, вхід у НБУ та з’єднання.';
}

class LoginRequiredError extends UserFacingError {}

export class CabinetReader {
  constructor(private readonly client: AdsPowerClient, private readonly guard: ShopRequestGuard,
    private readonly gate: PreparationGate, private readonly login?: NbuLogin) {}

  // Each section is one request to the shop; background refreshes ask for the cart only.
  load(profileId: string, signal: AbortSignal, sections: CabinetSection[] = ['orders', 'wishlist', 'cart']): Promise<CabinetSnapshot> {
    const [first, ...rest] = [...new Set(sections)];
    if (!first) return Promise.reject(new UserFacingError('Не вибрано розділ кабінету.'));
    return this.withPage(profileId, signal, { section: first }, async (page, initial, fetchPage) => {
      const result: CabinetSnapshot = { profileId, fetchedAt: Date.now(), errors: {} };
      if (first === 'orders') {
        result.orders = initial.orders;
        result.nextOrdersPage = initial.nextPage;
      } else result[first] = initial.products;
      for (const section of rest) {
        signal.throwIfAborted();
        try {
          const next = await fetchPage(section);
          if (section === 'orders') { result.orders = next.orders; result.nextOrdersPage = next.nextPage; }
          else result[section] = next.products;
        }
        catch (error) { result.errors[section] = cabinetError(error, signal); }
      }
      result.fetchedAt = Date.now();
      return result;
    });
  }

  order(profileId: string, orderId: string, signal: AbortSignal, detailId = orderId): Promise<CabinetOrderDetails> {
    if (![orderId, detailId].every(id => /^\d{1,20}$/.test(id))) return Promise.reject(new UserFacingError('Некоректний номер замовлення.'));
    return this.withPage(profileId, signal, { section: 'detail', orderId, detailId }, async (_page, initial) => initial.details!);
  }

  ordersPage(profileId: string, pageNumber: number, signal: AbortSignal): Promise<CabinetOrdersPage> {
    return this.withPage(profileId, signal, { section: 'orders', page: pageNumber }, async (_page, initial) => ({
      profileId, page: pageNumber, orders: initial.orders!, nextPage: initial.nextPage, fetchedAt: Date.now(),
    }));
  }

  private async readOnce<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (!this.guard.canRetryNow()) throw new UserFacingError(messages['rate-limit']);
    let result!: T;
    // One request only. Any later refresh must also respect the shared cooldown.
    await this.guard.retry(signal, Date.now() + 25_000, async () => { result = await action(); return true; });
    return result;
  }

  private async withPage<T>(profileId: string, signal: AbortSignal, request: { section: CabinetSection | 'detail'; orderId?: string; detailId?: string; page?: number },
    action: (page: Page, initial: CabinetPageResult,
      fetchPage: (section: CabinetSection, pageNumber?: number) => Promise<CabinetPageResult>) => Promise<T>): Promise<T> {
    let browser: Browser | undefined;
    let page: Page | undefined;
    const requestKey = `__nbuCabinet_${randomUUID()}`;
    const abort = () => {
      // Abort just our own fetch. Never close or navigate the user's tab.
      void page?.evaluate(key => Reflect.get(globalThis, key)?.abort(), requestKey).catch(() => {});
    };
    const checkGuard = () => {
      signal.throwIfAborted();
      if (!this.guard.canRetryNow()) throw new UserFacingError(messages['rate-limit']);
    };
    const assertOrigin = () => {
      if (!page || page.isClosed() || new URL(page.url()).origin !== ORIGIN) {
        throw new UserFacingError('Вкладка НБУ закрита або змінила адресу. Відкрийте магазин у цьому профілі.');
      }
    };
    try {
      checkGuard();
      const endpoint = await this.client.active(profileId, signal);
      if (!endpoint) throw new UserFacingError('Профіль закритий. Відкрийте його в AdsPower; кабінет сам не запускає браузер.');
      signal.throwIfAborted();
      browser = await chromium.connectOverCDP(endpoint, { timeout: 20_000 });
      signal.throwIfAborted();
      page = browser.contexts()[0]?.pages().find(candidate => {
        try { return !candidate.isClosed() && new URL(candidate.url()).origin === ORIGIN; } catch { return false; }
      });
      if (!page) throw new UserFacingError('Відкрийте вкладку coins.bank.gov.ua у цьому профілі. Кабінет не відкриває вкладок автоматично.');
      signal.addEventListener('abort', abort, { once: true });
      const fetchPage = async (section: CabinetSection | 'detail', pageNumber = 1, orderId?: string, detailId = orderId) =>
        this.gate.run(signal, () => this.readOnce(signal, async () => {
          checkGuard(); assertOrigin();
          const path = section === 'detail' ? `/account_history_info.php?order_id=${detailId}`
            : section === 'cart' ? '/popup_cart.php' : section === 'wishlist' ? '/wishlist.php' : `/account_history.php?page=${pageNumber}`;
          const response = await page!.evaluate(fetchCabinetDocument, { path, ajax: section === 'cart', requestKey });
          signal.throwIfAborted(); assertOrigin();
          if (response.status === 429) { this.guard.block(response.retryAfter ?? undefined); throw new UserFacingError(messages['rate-limit']); }
          if (response.path === '/login.php') throw new LoginRequiredError(messages.login);
          if (response.path !== path.split('?')[0]) throw new UserFacingError(messages.unrecognized);
          const parsed = await page!.evaluate(readCabinetPage, { section, page: pageNumber, orderId, html: response.html });
          if (parsed.error) {
            if (parsed.error === 'rate-limit' && !this.guard.isBlocked()) this.guard.block();
            throw new (parsed.error === 'login' ? LoginRequiredError : UserFacingError)(messages[parsed.error]);
          }
          if (response.status < 200 || response.status >= 300) throw new UserFacingError(`НБУ відповів помилкою (HTTP ${response.status}).`);
          return parsed;
        }));
      const first = () => fetchPage(request.section, request.page, request.orderId, request.detailId);
      let initial: CabinetPageResult;
      try { initial = await first(); }
      catch (error) {
        // Signed out: sign in once in a separate tab with the saved account, then repeat the same read.
        if (!(error instanceof LoginRequiredError) || !this.login?.available(profileId)) throw error;
        await this.login.ensure(page.context(), profileId, signal);
        initial = await first();
      }
      return await action(page, initial, fetchPage);
    } catch (error) { throw new UserFacingError(cabinetError(error, signal)); }
    finally {
      signal.removeEventListener('abort', abort);
      await browser?.close().catch(() => {}); // Disconnect CDP only; all tabs remain untouched.
    }
  }
}

// Runs in an existing shop tab. The HTML remains inert and no page navigation occurs.
export async function fetchCabinetDocument({ path, ajax, requestKey }: { path: string; ajax: boolean; requestKey: string }) {
  if (location.origin !== 'https://coins.bank.gov.ua') throw new Error('Shop tab changed origin');
  if (!/^\/(?:account_history\.php\?page=\d+|account_history_info\.php\?order_id=\d+|wishlist\.php|popup_cart\.php)$/.test(path)) {
    throw new Error('Unsupported cabinet request');
  }
  const controller = new AbortController();
  Reflect.set(globalThis, requestKey, controller);
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}, signal: controller.signal });
    const html = await response.text();
    return { status: response.status, path: new URL(response.url).pathname, retryAfter: response.headers.get('retry-after'),
      html: html.length <= 5_000_000 ? html : '' };
  } finally { clearTimeout(timeout); Reflect.deleteProperty(globalThis, requestKey); }
}
