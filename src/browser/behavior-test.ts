import { randomUUID } from 'node:crypto';
import { type Browser, type BrowserContext, type Page } from 'patchright-core';
import { connectProfile } from './connect';
import { glidePointer, pointerCurve, profileMotionTempo, readingPauseMs, wheelSteps, type BehaviorTestResult } from '../core/pointer-motion';
import { realClock, type Clock } from '../core/ports';
import { ShopRequestGuard, UserFacingError } from '../core/shop-errors';
import { AdsPowerClient, PreparationGate } from './adspower';
import type { NbuLogin } from './nbu-login';

const ORIGIN = 'https://coins.bank.gov.ua';
// Read-only store pages only: products, the home page and other plain .html pages.
// Cart, checkout, account, login, logout, links with actions and links opening new tabs are excluded.
export function behaviorPageState() {
  const targets = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap(link => {
    try {
      const url = new URL(link.href);
      if (url.origin !== 'https://coins.bank.gov.ua' || url.username || url.password ||
        (link.target && link.target !== '_self') || link.hasAttribute('download')) return [];
      const product = /\/p-\d+\.html$/.test(url.pathname) ||
        (url.pathname === '/product_info.php' && /^\d+$/.test(url.searchParams.get('products_id') ?? ''));
      const page = url.pathname === '/' || url.pathname === '/index.php' || (/\.html$/.test(url.pathname) &&
        !/login|logoff|account|cart|checkout|password|create|order|wishlist|compare|address|mail|search/i.test(url.pathname));
      if (!(product || page) ||
        [...url.searchParams.keys()].some(key => !['products_id', 'language', 'page'].includes(key))) return [];
      const box = link.getBoundingClientRect();
      const style = getComputedStyle(link);
      if (!box.width || !box.height || box.bottom < 10 || box.top > innerHeight - 10 || box.right < 10 || box.left > innerWidth - 10 ||
        style.visibility !== 'visible' || style.display === 'none') return [];
      url.hash = '';
      return [{ href: url.href, product, x: Math.max(10, Math.min(innerWidth - 10, (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2)),
        y: Math.max(10, Math.min(innerHeight - 10, (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2)) }];
    } catch { return []; }
  }).slice(0, 150);
  return { width: innerWidth, height: innerHeight, targets, scrollY, maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    login: document.querySelector('a[href*="logoff.php"]') || (document.querySelector<HTMLInputElement>('[name="cid_id"]')?.value)
      ? 'logged-in' as const
      : document.querySelector('a[href*="login.php"], #r_buy_intovar a.login') ? 'logged-out' as const : 'unknown' as const,
    challenge: !!document.querySelector('script[src*=".bunny-shield"], .cf-turnstile:not(.success)') || /Establishing a secure connection/i.test(document.title) };
}
// The link that a click at this point would follow, so the bot never clicks anything else.
export function linkAt({ x, y }: { x: number; y: number }): string | undefined {
  const link = document.elementFromPoint(x, y)?.closest<HTMLAnchorElement>('a[href]');
  if (!link) return undefined;
  const url = new URL(link.href); url.hash = '';
  return url.href;
}
// Opt-in cursor marker for watching the warm-up. It follows the page's own mouse events, so drawing it
// costs no extra round trip per step. Runs in our isolated world; removing the marker stops it.
function installCursor({ id }: { id: string }) {
  if (document.getElementById(id)) return;
  const marker = document.createElement('div'); marker.id = id; marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText = 'position:fixed;left:-40px;top:-40px;z-index:2147483647;width:16px;height:16px;border:2px solid #111;border-radius:50%;background:#ffdc55;box-shadow:0 0 0 4px #ffffff88;pointer-events:none;transform:translate(-50%,-50%)';
  document.documentElement.append(marker);
  const follow = (event: MouseEvent) => {
    if (!marker.isConnected) { document.removeEventListener('mousemove', follow, true); return; }
    marker.style.left = `${event.clientX}px`; marker.style.top = `${event.clientY}px`;
  };
  document.addEventListener('mousemove', follow, true);
}
export interface BehaviorOptions { navigate: boolean; showCursor?: boolean; durationMs?: number; }
type Navigation = { status(): number; ok(): boolean; headers(): Record<string, string> } | null;
export class BehaviorTester {
  constructor(private readonly client: AdsPowerClient, private readonly guard: ShopRequestGuard,
    private readonly gate: PreparationGate, private readonly clock: Clock = realClock, private readonly random = Math.random,
    private readonly login?: NbuLogin) {}
  async run(profileId: string, options: BehaviorOptions, signal: AbortSignal): Promise<BehaviorTestResult> {
    const { navigate, showCursor = false, durationMs } = options;
    let started = this.clock.now();
    let deadline = Infinity;
    const completed = Symbol();
    const result: BehaviorTestResult = { moves: 0, scrolls: 0, navigations: 0, pauses: 0, durationMs: 0, stopped: false, login: 'unknown' };
    const markerId = `nbu-test-${randomUUID()}`;
    let browser: Browser | undefined, page: Page | undefined;
    const check = (url: string) => {
      signal.throwIfAborted();
      if (this.clock.now() >= deadline) throw completed;
      if (!page || page.isClosed() || page.url() !== url) throw new UserFacingError('Прогрів зупинено: вкладка закрита або її адресу змінено.');
    };
    const pause = (ms: number) => this.clock.sleep(Math.min(ms, Math.max(0, deadline - this.clock.now())), signal);
    // Every page load goes through the shared queue and stops the warm-up on 429 or a foreign site.
    const load = (action: () => Promise<Navigation>) => this.gate.run(signal, async () => {
      if (!this.guard.canRetryNow()) throw new UserFacingError('НБУ обмежив запити. Прогрів зупинено до завершення паузи.');
      const response = await action();
      signal.throwIfAborted();
      if (response?.status() === 429) {
        this.guard.block(response.headers()['retry-after']);
        throw new UserFacingError('НБУ відповів 429. Прогрів зупинено; повторних запитів немає.');
      }
      if (response && !response.ok() && response.status() !== 304) throw new UserFacingError(`Прогрів зупинено: НБУ відповів HTTP ${response.status()}.`);
      if (new URL(page!.url()).origin !== ORIGIN) throw new UserFacingError('Прогрів зупинено: сайт перенаправив на іншу адресу.');
      return response;
    });
    try {
      // A closed profile, or AdsPower itself not running, is opened the same way a purchase opens it.
      const endpoint = await this.client.active(profileId, signal).catch(error => {
        if (signal.aborted) throw error;
        return undefined;
      }) ?? await this.client.start(profileId, signal);
      browser = await connectProfile(endpoint, 15_000);
      signal.throwIfAborted();
      const context: BrowserContext | undefined = browser.contexts()[0];
      if (!context) throw new UserFacingError('У профілі AdsPower немає відкритого вікна браузера.');
      const pages = browser.contexts().flatMap(item => item.pages()).filter(candidate => {
        try { return !candidate.isClosed() && new URL(candidate.url()).origin === ORIGIN; } catch { return false; }
      });
      for (const candidate of pages) {
        if (await candidate.evaluate(() => document.visibilityState === 'visible')) { page = candidate; break; }
      }
      page ??= pages[0];
      if (!page) {
        page = await context.newPage();
        await load(() => page!.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 }));
      }
      await page.bringToFront();
      started = this.clock.now();
      deadline = durationMs === undefined ? Infinity : started + durationMs;
      let url = page.url();
      let state = await page.evaluate(behaviorPageState);
      if (state.challenge) throw new UserFacingError('Завершіть перевірку сайту вручну перед прогрівом.');
      result.login = state.login;
      if (state.login === 'logged-out') {
        if (!this.login?.available(profileId)) result.loginNote = 'Профіль не залогінений на НБУ, а збереженого акаунта для автовходу немає.';
        else {
          try {
            await this.login.ensure(context, profileId, signal);
            await page.bringToFront();
            await load(() => page!.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 }));
            url = page.url();
            state = await page.evaluate(behaviorPageState);
            result.login = state.login;
            if (state.login !== 'logged-in') result.loginNote = 'Автовхід не підтвердився на сторінці. Перевірте профіль вручну.';
          } catch (error) {
            if (signal.aborted) throw error;
            result.loginNote = error instanceof UserFacingError ? error.message : 'Не вдалося увійти в НБУ автоматично.';
          }
        }
      }
      let point = { x: state.width * 0.5, y: state.height * 0.45 };
      const tempo = profileMotionTempo(profileId);
      const recent = [url];
      let nextNavigationAt = this.clock.now() + 3000 + this.random() * 4000;
      const cursor = async () => { if (showCursor) await page!.evaluate(installCursor, { id: markerId }); };
      await cursor();
      const moveTo = async (destination: { x: number; y: number }) => {
        point = await glidePointer(pointerCurve(point, destination, state.width, state.height, tempo, this.random),
          async (step) => { check(url); await page!.mouse.move(step.x, step.y); }, this.clock, signal, deadline);
        check(url); // A move cut short by the deadline ends the warm-up here.
        result.moves++;
      };
      const scroll = async (down: boolean) => {
        for (const delta of wheelSteps((160 + this.random() * 330) * (down ? 1 : -1), this.random)) {
          check(url); await page!.mouse.wheel(0, delta);
          await this.clock.sleep(30 + this.random() * 90, signal);
        }
        result.scrolls++;
      };
      const arrived = async (back: boolean) => {
        if (back) recent.pop();
        url = page!.url();
        if (recent.at(-1) !== url) recent.push(url);
        if (recent.length > 4) recent.shift();
        result.navigations++;
        state = await page!.evaluate(behaviorPageState);
        if (state.challenge) throw new UserFacingError('НБУ показав перевірку. Завершіть її вручну; прогрів зупинено.');
        if (state.login !== 'unknown') result.login = state.login;
        await cursor(); // The new page has no marker yet.
      };
      for (let segment = 0; durationMs === undefined ? segment < 8 : this.clock.now() < deadline; segment++) {
        check(url);
        state = await page.evaluate(behaviorPageState);
        if (state.challenge) throw new UserFacingError('Завершіть перевірку сайту вручну перед прогрівом.');
        const target = state.targets[Math.floor(this.random() * state.targets.length)];
        const destination = target && segment % 2 === 0 ? target : {
          x: 30 + this.random() * Math.max(1, state.width - 60), y: 40 + this.random() * Math.max(1, state.height - 80),
        };
        await moveTo(destination);
        const rest = readingPauseMs(tempo, this.random);
        if (rest >= 3000) result.pauses++;
        await pause(rest);
        check(url);
        if (segment % 2 === 1) {
          await scroll(!((state.maxScroll > 0 && state.scrollY >= state.maxScroll - 10) || segment % 8 >= 5));
        }
        if (!navigate || this.clock.now() < nextNavigationAt) continue;
        // Sometimes return to the previous page the way a person does, with the browser's Back.
        if (recent.length > 1 && this.random() < 0.2) {
          nextNavigationAt = this.clock.now() + 20_000 + this.random() * 25_000;
          await this.clock.sleep(300 + this.random() * 600, signal);
          check(url);
          const response = await load(() => page!.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }));
          if (response || page.url() !== url) await arrived(true);
          continue;
        }
        const available = state.targets.filter(t => t.href !== url);
        const unseen = available.filter(t => !recent.includes(t.href));
        const pool = unseen.length ? unseen : available;
        // Mostly products, sometimes the home page or a catalogue page.
        const products = pool.filter(t => t.product), others = pool.filter(t => !t.product);
        const candidates = others.length && (!products.length || this.random() < 0.3) ? others : products;
        const next = candidates[Math.floor(this.random() * candidates.length)];
        // Nothing to follow on screen: look further down the page first.
        if (!next) { await scroll(state.maxScroll > 0 && state.scrollY < state.maxScroll - 10); continue; }
        nextNavigationAt = this.clock.now() + 20_000 + this.random() * 25_000;
        await moveTo(next);
        await pause(250 + this.random() * 600);
        check(url);
        // A real click sends the referrer and user-activation headers that a typed address lacks.
        if (await page.evaluate(linkAt, { x: next.x, y: next.y }) !== next.href) continue;
        const response = await load(async () => {
          const navigation = page!.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
          await page!.mouse.click(next.x, next.y, { delay: 50 + this.random() * 90 });
          return navigation;
        });
        if (!response && page.url() === url) continue; // The page handled the click itself; nothing was loaded.
        await arrived(false);
      }
    } catch (error) {
      if (signal.aborted) result.stopped = true;
      else if (error === completed) { /* Requested duration has elapsed. */ }
      else throw new Error(error instanceof UserFacingError ? error.message : 'Не вдалося виконати прогрів. Перевірте відкритий профіль AdsPower.');
    } finally {
      if (showCursor) await page?.evaluate(id => document.getElementById(id)?.remove(), markerId).catch(() => {});
      await browser?.close().catch(() => {});
      result.durationMs = Math.max(0, this.clock.now() - started);
    }
    return result;
  }
}
