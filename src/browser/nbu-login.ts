import type { BrowserContext, Page } from 'patchright-core';
import { realClock, type Clock } from '../core/ports';
import { ShopRequestGuard, UserFacingError } from '../core/shop-errors';
import type { PreparationGate } from './adspower';

export interface NbuCredentials { email: string; password: string }

const LOGIN_URL = 'https://coins.bank.gov.ua/login.php';
// A failed or unfinished login is not retried at once: repeated submissions look like guessing.
export const LOGIN_RETRY_MS = 10 * 60_000;

// Runs in the page. Keep it self-contained for Playwright serialization.
export function readLoginPage() {
  const form = document.querySelector('form[name="login"]');
  return {
    path: location.pathname,
    loggedIn: !!document.querySelector('a[href*="logoff.php"]'),
    form: !!form?.querySelector('input[name="email_address"]') && !!form.querySelector('input[name="password"]'),
    challenge: !!document.querySelector('script[src*=".bunny-shield"], .cf-turnstile:not(.success), iframe[src*="turnstile"], .g-recaptcha, iframe[src*="recaptcha"], .h-captcha') ||
      document.title.startsWith('Establishing a secure connection'),
  };
}

// Signs a profile back in to NBU with the account saved for it. It fills the ordinary login form once;
// a verification, captcha or rejected password stops here and is left to the user.
export class NbuLogin {
  private rejected = new WeakSet<NbuCredentials>();
  private attemptedAt = new Map<string, number>();
  private succeededAt = new Map<string, number>();
  private running = new Map<string, Promise<void>>();
  constructor(private readonly lookup: (profileId: string) => NbuCredentials | undefined,
    private readonly guard: ShopRequestGuard, private readonly gate: PreparationGate,
    private readonly clock: Clock = realClock) {}

  private recent(map: Map<string, number>, profileId: string): boolean {
    return this.clock.now() - (map.get(profileId) ?? -Infinity) < LOGIN_RETRY_MS;
  }

  // Tabs of one profile share cookies: a login in progress or just finished serves all of them.
  available(profileId: string): boolean {
    const credentials = this.lookup(profileId);
    return !!credentials && !this.rejected.has(credentials) && (this.running.has(profileId) ||
      this.recent(this.succeededAt, profileId) || !this.recent(this.attemptedAt, profileId));
  }

  ensure(context: BrowserContext, profileId: string, signal: AbortSignal): Promise<void> {
    const pending = this.running.get(profileId);
    if (pending) return pending;
    if (this.recent(this.succeededAt, profileId)) return Promise.resolve();
    const operation = this.run(context, profileId, signal).finally(() => this.running.delete(profileId));
    this.running.set(profileId, operation);
    return operation;
  }

  private async run(context: BrowserContext, profileId: string, signal: AbortSignal): Promise<void> {
    const credentials = this.lookup(profileId);
    if (!credentials) throw new UserFacingError('Для профілю не збережено акаунт НБУ. Додайте його в налаштуваннях біля профілю.');
    if (this.rejected.has(credentials)) throw new UserFacingError('НБУ раніше не прийняв збережені пошту або пароль. Оновіть їх у налаштуваннях біля профілю.');
    if (this.recent(this.attemptedAt, profileId)) throw new UserFacingError('Автоматичний вхід уже пробували нещодавно. Увійдіть вручну або зачекайте 10 хвилин.');
    this.attemptedAt.set(profileId, this.clock.now());
    let page: Page | undefined;
    let keepOpen = false;
    const navigate = (action: () => Promise<unknown>) => this.gate.run(signal, async () => {
      signal.throwIfAborted();
      if (!this.guard.canRetryNow()) throw new UserFacingError('НБУ обмежив запити (429). Вхід відкладено.');
      const response = await action() as { status(): number; headers(): Record<string, string> } | null;
      signal.throwIfAborted();
      if (response?.status() === 429) {
        this.guard.block(response.headers()['retry-after']);
        throw new UserFacingError('НБУ обмежив запити (429). Вхід відкладено.');
      }
    });
    const needsUser = (message: string) => {
      keepOpen = true;
      void page?.bringToFront().catch(() => {});
      return new UserFacingError(message);
    };
    try {
      page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await navigate(() => page!.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 }));
      let state = await page.evaluate(readLoginPage);
      if (state.loggedIn) { this.succeededAt.set(profileId, this.clock.now()); return; } // Session was still valid.
      if (state.challenge) throw needsUser('НБУ показав перевірку на сторінці входу. Завершіть вхід вручну у відкритій вкладці.');
      if (!state.form) throw new UserFacingError('Не вдалося розпізнати сторінку входу НБУ. Увійдіть вручну.');
      const form = page.locator('form[name="login"]');
      await form.locator('input[name="email_address"]').fill(credentials.email);
      await form.locator('input[name="password"]').fill(credentials.password);
      await navigate(() => Promise.all([
        page!.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }),
        form.locator('button[type="submit"]').click(),
      ]).then(([response]) => response));
      state = await page.evaluate(readLoginPage);
      if (state.loggedIn) { this.succeededAt.set(profileId, this.clock.now()); return; }
      if (state.challenge) throw needsUser('НБУ показав перевірку після входу. Завершіть вхід вручну у відкритій вкладці.');
      if (state.path === '/login.php' && state.form) {
        this.rejected.add(credentials);
        throw needsUser('НБУ не прийняв пошту або пароль. Перевірте вхід НБУ в налаштуваннях; автовхід вимкнено до повторного збереження.');
      }
      throw needsUser('Після входу НБУ показав незнайому сторінку. Перевірте вкладку й увійдіть вручну.');
    } catch (error) {
      if (signal.aborted || error instanceof UserFacingError) throw error;
      throw new UserFacingError('Не вдалося виконати автоматичний вхід у НБУ. Увійдіть вручну.');
    } finally {
      if (!keepOpen) await page?.close().catch(() => {});
    }
  }
}
