import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright-core';
import { pointerPath, profileMotionTempo, type BehaviorTestResult } from '../core/pointer-motion';
import { realClock, type Clock } from '../core/ports';
import { ShopRequestGuard, UserFacingError } from '../core/shop-errors';
import { AdsPowerClient, PreparationGate } from './adspower';

const ORIGIN = 'https://coins.bank.gov.ua';
// Read-only product URLs only: cart, checkout, login, logout and action links are excluded.
export function behaviorPageState() {
  const targets = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap(link => {
    try {
      const url = new URL(link.href);
      if (url.origin !== 'https://coins.bank.gov.ua' || url.username || url.password ||
        !(/\/p-\d+\.html$/.test(url.pathname) || (url.pathname === '/product_info.php' && /^\d+$/.test(url.searchParams.get('products_id') ?? ''))) ||
        [...url.searchParams.keys()].some(key => !['products_id', 'language'].includes(key))) return [];
      const box = link.getBoundingClientRect();
      const style = getComputedStyle(link);
      if (!box.width || !box.height || box.bottom < 10 || box.top > innerHeight - 10 || box.right < 10 || box.left > innerWidth - 10 ||
        style.visibility !== 'visible' || style.display === 'none') return [];
      url.hash = '';
      return [{ href: url.href, x: Math.max(10, Math.min(innerWidth - 10, (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2)),
        y: Math.max(10, Math.min(innerHeight - 10, (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2)) }];
    } catch { return []; }
  }).slice(0, 100);
  return { width: innerWidth, height: innerHeight, targets, scrollY, maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    challenge: !!document.querySelector('script[src*=".bunny-shield"], .cf-turnstile:not(.success)') || /Establishing a secure connection/i.test(document.title) };
}
function overlay({ id, x, y }: { id: string; x: number; y: number }) {
  let marker = document.getElementById(id);
  if (!marker) {
    marker = document.createElement('div'); marker.id = id; marker.setAttribute('aria-hidden', 'true');
    marker.style.cssText = 'position:fixed;z-index:2147483647;width:16px;height:16px;border:2px solid #111;border-radius:50%;background:#ffdc55;box-shadow:0 0 0 4px #ffffff88;pointer-events:none;transform:translate(-50%,-50%)';
    document.documentElement.append(marker);
  }
  marker.style.left = `${x}px`; marker.style.top = `${y}px`;
}
export class BehaviorTester {
  constructor(private readonly client: AdsPowerClient, private readonly guard: ShopRequestGuard,
    private readonly gate: PreparationGate, private readonly clock: Clock = realClock, private readonly random = Math.random) {}
  async run(profileId: string, navigate: boolean, signal: AbortSignal, durationMs?: number): Promise<BehaviorTestResult> {
    let started = this.clock.now();
    let deadline = Infinity;
    const completed = Symbol();
    const result: BehaviorTestResult = { moves: 0, scrolls: 0, navigations: 0, durationMs: 0, stopped: false };
    const markerId = `nbu-test-${randomUUID()}`;
    let browser: Browser | undefined, page: Page | undefined;
    const check = (url: string) => {
      signal.throwIfAborted();
      if (this.clock.now() >= deadline) throw completed;
      if (!page || page.isClosed() || page.url() !== url) throw new UserFacingError('Тест зупинено: вкладка закрита або її адресу змінено.');
    };
    try {
      const endpoint = await this.client.active(profileId, signal);
      if (!endpoint) throw new UserFacingError('Відкрийте профіль в AdsPower перед тестом.');
      browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
      signal.throwIfAborted();
      const pages = browser.contexts().flatMap(context => context.pages()).filter(candidate => {
        try { return !candidate.isClosed() && new URL(candidate.url()).origin === ORIGIN; } catch { return false; }
      });
      for (const candidate of pages) {
        if (await candidate.evaluate(() => document.visibilityState === 'visible')) { page = candidate; break; }
      }
      page ??= pages[0];
      if (!page) throw new UserFacingError('Відкрийте сторінку НБУ в цьому профілі перед тестом.');
      await page.bringToFront();
      started = this.clock.now();
      deadline = durationMs === undefined ? Infinity : started + durationMs;
      let url = page.url();
      let state = await page.evaluate(behaviorPageState);
      let point = { x: state.width * 0.5, y: state.height * 0.45 };
      const tempo = profileMotionTempo(profileId);
      const recent = [url];
      let nextNavigationAt = this.clock.now() + 3000 + this.random() * 4000;
      const moveTo = async (destination: { x: number; y: number }) => {
        for (const step of pointerPath(point, destination, state.width, state.height, tempo, this.random)) {
          check(url);
          await page!.mouse.move(step.x, step.y);
          await page!.evaluate(overlay, { id: markerId, x: step.x, y: step.y });
          await this.clock.sleep(Math.min(step.waitMs, Math.max(0, deadline - this.clock.now())), signal);
        }
        point = { x: destination.x, y: destination.y }; result.moves++;
      };
      for (let segment = 0; durationMs === undefined ? segment < 8 : this.clock.now() < deadline; segment++) {
        check(url);
        state = await page.evaluate(behaviorPageState);
        if (state.challenge) throw new UserFacingError('Завершіть перевірку сайту вручну перед тестом.');
        const target = state.targets[Math.floor(this.random() * state.targets.length)];
        const destination = target && segment % 2 === 0 ? target : {
          x: 30 + this.random() * Math.max(1, state.width - 60), y: 40 + this.random() * Math.max(1, state.height - 80),
        };
        await moveTo(destination);
        await this.clock.sleep(Math.min((400 + this.random() * 1200) * tempo, Math.max(0, deadline - this.clock.now())), signal);
        check(url);
        if (segment % 2 === 1) {
          const amount = (160 + this.random() * 330) * ((state.maxScroll > 0 && state.scrollY >= state.maxScroll - 10) || segment % 8 >= 5 ? -1 : 1);
          for (let step = 0; step < 5; step++) {
            check(url); await page.mouse.wheel(0, amount / 5);
            await this.clock.sleep(40 + this.random() * 60, signal);
          }
          result.scrolls++;
        }
        if (navigate && this.clock.now() >= nextNavigationAt) {
          nextNavigationAt = this.clock.now() + 20_000 + this.random() * 25_000;
          const available = (await page.evaluate(behaviorPageState)).targets.filter(t => t.href !== url);
          const unseen = available.filter(t => !recent.slice(-3).includes(t.href));
          const candidates = unseen.length ? unseen : available;
          const next = candidates[Math.floor(this.random() * candidates.length)];
          if (!next) continue;
          await moveTo(next);
          await this.clock.sleep(500 + this.random() * 700, signal);
          await this.gate.run(signal, async () => {
            check(url);
            if (!this.guard.canRetryNow()) throw new UserFacingError('НБУ обмежив запити. Тест переходів зупинено до завершення паузи.');
            const response = await page!.goto(next.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
            signal.throwIfAborted();
            if (response?.status() === 429) {
              this.guard.block(response.headers()['retry-after']);
              throw new UserFacingError('НБУ відповів 429. Тест зупинено; повторних запитів немає.');
            }
            if (response && !response.ok()) throw new UserFacingError(`Тест зупинено: НБУ відповів HTTP ${response.status()}.`);
            if (new URL(page!.url()).origin !== ORIGIN) throw new UserFacingError('Тест зупинено: сайт перенаправив на іншу адресу.');
          });
          url = page.url(); recent.push(url); if (recent.length > 3) recent.shift(); result.navigations++;
          nextNavigationAt = this.clock.now() + 20_000 + this.random() * 25_000;
        }
      }
    } catch (error) {
      if (signal.aborted) result.stopped = true;
      else if (error === completed) { /* Requested duration has elapsed. */ }
      else throw new Error(error instanceof UserFacingError ? error.message : 'Не вдалося виконати тест. Перевірте відкритий профіль AdsPower.');
    } finally {
      await page?.evaluate(id => document.getElementById(id)?.remove(), markerId).catch(() => {});
      await browser?.close().catch(() => {});
      result.durationMs = Math.max(0, this.clock.now() - started);
    }
    return result;
  }
}
