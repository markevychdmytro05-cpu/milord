import { mkdtemp, readFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { PreparationGate } from '../src/browser/adspower';
import { LOGIN_RETRY_MS, NbuLogin, type NbuCredentials } from '../src/browser/nbu-login';
import { runTask } from '../src/core/buyer';
import { ShopRequestGuard, UserFacingError } from '../src/core/shop-errors';
import { AccountStore } from '../src/main/account-store';
import type { SecretCipher } from '../src/main/key-store';
import { fakeBrowser, FakeClock, ready, task } from './helpers';

const key = randomBytes(32);
const cipher: SecretCipher = {
  available: () => true,
  encrypt: (value) => {
    const iv = randomBytes(12);
    const aes = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([aes.update(value, 'utf8'), aes.final()]);
    return Buffer.concat([iv, aes.getAuthTag(), encrypted]);
  },
  decrypt: (value) => {
    const aes = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    aes.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([aes.update(value.subarray(28)), aes.final()]).toString('utf8');
  },
};

describe('NBU account store', () => {
  it('keeps passwords encrypted and exposes only e-mails', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'nbu-accounts-')), 'accounts.enc');
    const store = new AccountStore(path, cipher);
    await store.save('p1', { email: 'one@example.com', password: 'secret-pass-1' });
    await store.save('p2', { email: 'two@example.com', password: 'secret-pass-2' });
    expect((await readFile(path)).includes(Buffer.from('secret-pass-1'))).toBe(false);
    const restored = new AccountStore(path, cipher);
    expect(await restored.load()).toBeUndefined();
    expect(restored.emails()).toEqual({ p1: 'one@example.com', p2: 'two@example.com' });
    expect(restored.get('p2')).toEqual({ email: 'two@example.com', password: 'secret-pass-2' });
    await restored.clear('p1');
    expect(new AccountStore(path, cipher).get('p1')).toBeUndefined();
    const reloaded = new AccountStore(path, cipher);
    await reloaded.load();
    expect(reloaded.emails()).toEqual({ p2: 'two@example.com' });
  });
  it('refuses to save without system encryption', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'nbu-accounts-')), 'accounts.enc');
    const store = new AccountStore(path, { ...cipher, available: () => false });
    await expect(store.save('p1', { email: 'one@example.com', password: 'x' })).rejects.toThrow();
    expect(store.get('p1')).toBeUndefined();
  });
});

type After = 'account' | 'form' | 'challenge';
// A login tab double: /login.php shows the form unless already signed in; submitting leads to `after`.
function fakeContext(options: { signedIn?: boolean; after?: After; challengeOnOpen?: boolean } = {}) {
  const log = { opened: 0, closed: 0, submitted: 0, filled: {} as Record<string, string> };
  let view: 'form' | After = options.signedIn ? 'account' : options.challengeOnOpen ? 'challenge' : 'form';
  const context = {
    newPage: async () => {
      log.opened++;
      const field = (name: string) => ({ fill: async (value: string) => { log.filled[name] = value; } });
      return {
        setDefaultTimeout: () => {},
        goto: async () => ({ status: () => 200, headers: () => ({}) }),
        waitForNavigation: async () => ({ status: () => 200, headers: () => ({}) }),
        evaluate: async () => ({ path: view === 'account' ? '/account.php' : '/login.php', loggedIn: view === 'account',
          form: view === 'form', challenge: view === 'challenge' }),
        locator: () => ({ locator: (selector: string) => selector.includes('submit')
          ? { click: async () => { log.submitted++; view = options.after ?? 'account'; } }
          : field(selector.match(/name="(\w+)"/)![1]!) }),
        bringToFront: async () => {},
        close: async () => { log.closed++; },
      };
    },
  } as unknown as BrowserContext;
  return { context, log };
}

describe('automatic NBU login', () => {
  const credentials: NbuCredentials = { email: 'me@example.com', password: 'pw' };
  const setup = (lookup: () => NbuCredentials | undefined = () => credentials) => {
    const clock = new FakeClock();
    return { clock, login: new NbuLogin(lookup, new ShopRequestGuard(clock), new PreparationGate(0), clock) };
  };

  it('fills the saved account once and closes its tab', async () => {
    const { login } = setup();
    const { context, log } = fakeContext();
    await login.ensure(context, 'p1', new AbortController().signal);
    expect(log.filled).toEqual({ email_address: 'me@example.com', password: 'pw' });
    expect(log).toMatchObject({ opened: 1, closed: 1, submitted: 1 });
  });
  it('does not submit when the profile is still signed in', async () => {
    const { login } = setup();
    const { context, log } = fakeContext({ signedIn: true });
    await login.ensure(context, 'p1', new AbortController().signal);
    expect(log.submitted).toBe(0);
  });
  it('shares one login between tabs of a profile', async () => {
    const { login } = setup();
    const { context, log } = fakeContext();
    const signal = new AbortController().signal;
    await Promise.all([login.ensure(context, 'p1', signal), login.ensure(context, 'p1', signal)]);
    await login.ensure(context, 'p1', signal);
    expect(log.submitted).toBe(1);
    expect(login.available('p1')).toBe(true);
  });
  it('stops after a rejected password until the account is saved again', async () => {
    let saved = credentials;
    const { clock, login } = setup(() => saved);
    const { context, log } = fakeContext({ after: 'form' });
    await expect(login.ensure(context, 'p1', new AbortController().signal)).rejects.toThrow(/не прийняв/);
    expect(log.closed).toBe(0); // Left open so the user sees the shop's message.
    clock.time += LOGIN_RETRY_MS;
    expect(login.available('p1')).toBe(false);
    saved = { ...credentials, password: 'new' };
    expect(login.available('p1')).toBe(true);
  });
  it('hands a verification to the user and waits before another attempt', async () => {
    const { clock, login } = setup();
    const { context, log } = fakeContext({ challengeOnOpen: true });
    await expect(login.ensure(context, 'p1', new AbortController().signal)).rejects.toThrow(/перевірку/);
    expect(log.submitted).toBe(0);
    expect(login.available('p1')).toBe(false);
    clock.time += LOGIN_RETRY_MS;
    expect(login.available('p1')).toBe(true);
  });
  it('is unavailable without a saved account', () => {
    expect(setup(() => undefined).login.available('p1')).toBe(false);
  });
});

describe('purchase workflow with automatic login', () => {
  it('signs in once before the sale and then buys', async () => {
    const clock = new FakeClock();
    let signedIn = false;
    const browser = fakeBrowser(clock, () => ({ ...ready, login: signedIn ? 'logged-in' : 'logged-out', inCart: browser.clicks.length > 0 }));
    let logins = 0;
    browser.session.login = async () => { logins++; signedIn = true; return true; };
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(logins).toBe(1);
    expect(input.status).toBe('in_cart');
    expect(input.events.some(event => event.message === 'Виконано автоматичний вхід в акаунт НБУ.')).toBe(true);
  });
  it('shows the login failure and never retries it within the task', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, login: 'logged-out' }));
    let logins = 0;
    browser.session.login = async () => { logins++; throw new UserFacingError('НБУ не прийняв пошту або пароль.'); };
    const input = task();
    const notes: string[] = [];
    await runTask(input, browser.provider, clock, new AbortController().signal, async saved => { notes.push(saved.note); });
    expect(logins).toBe(1);
    expect(browser.clicks).toHaveLength(0);
    expect(notes).toContain('НБУ не прийняв пошту або пароль.');
  });
  it('does not try to sign in behind a verification page', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, login: 'logged-out', turnstile: true }));
    let logins = 0;
    browser.session.login = async () => { logins++; return true; };
    await runTask(task(), browser.provider, clock, new AbortController().signal, async () => {});
    expect(logins).toBe(0);
  });
});
