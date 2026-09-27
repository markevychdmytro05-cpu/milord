import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'patchright-core';
import { BehaviorTester, behaviorPageState, linkAt } from '../src/browser/behavior-test';
import type { NbuLogin } from '../src/browser/nbu-login';
import { AdsPowerClient, PreparationGate } from '../src/browser/adspower';
import { ShopRequestGuard } from '../src/core/shop-errors';
import { glidePointer, pointerCurve, pointerPath, profileMotionTempo, readingPauseMs, wheelSteps } from '../src/core/pointer-motion';

const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
it('uses bounded smooth paths that arrive at the target and vary by profile and gesture', () => {
  const from = { x: 20, y: 40 }, to = { x: 600, y: 400 };
  const a = pointerPath(from, to, 800, 600, profileMotionTempo('a'), () => 0.2);
  const b = pointerPath(from, to, 800, 600, profileMotionTempo('b'), () => 0.8);
  expect(a.at(-1)).toMatchObject(to); expect(b.at(-1)).toMatchObject(to);
  expect(a).not.toEqual(b);
  for (const step of [...a, ...b]) {
    expect(step.x).toBeGreaterThanOrEqual(1); expect(step.x).toBeLessThan(800);
    expect(step.y).toBeGreaterThanOrEqual(1); expect(step.y).toBeLessThan(600);
    expect(step.waitMs).toBeGreaterThan(0);
  }
});
function fixture(status = 200, { login = 'logged-in' as 'logged-in' | 'logged-out', pages = 1 } = {}) {
  let url = 'https://coins.bank.gov.ua/start/p-1.html', now = 0;
  const targets = [
    { href: 'https://coins.bank.gov.ua/coin/p-2.html', product: true, x: 200, y: 200 },
    { href: 'https://coins.bank.gov.ua/coin/p-3.html', product: true, x: 400, y: 300 },
    { href: 'https://coins.bank.gov.ua/', product: false, x: 100, y: 30 },
  ];
  let loggedIn = login === 'logged-in';
  let settle: ((value: unknown) => void) | undefined;
  const response = () => ({ status: () => status, ok: () => status === 200, headers: () => ({ 'retry-after': '60' }) });
  const page = {
    isClosed: () => false, url: () => url, bringToFront: vi.fn(async () => {}), close: vi.fn(),
    mouse: { move: vi.fn(async (_x: number, _y: number) => {}), wheel: vi.fn(async (_x: number, _y: number) => {}),
      click: vi.fn(async (x: number, y: number) => {
        const target = targets.find(t => t.x === x && t.y === y);
        if (target) { url = target.href; settle?.(response()); }
      }) },
    evaluate: vi.fn(async (fn: unknown, arg?: { x: number; y: number }) => fn === behaviorPageState
      ? { width: 800, height: 600, challenge: false, scrollY: 0, maxScroll: 1000, login: loggedIn ? 'logged-in' : 'logged-out', targets }
      : fn === linkAt ? targets.find(t => t.x === arg!.x && t.y === arg!.y)?.href : true),
    waitForNavigation: vi.fn(() => new Promise(resolve => { settle = resolve; })),
    goto: vi.fn(async (next: string) => { url = next; return response(); }),
    goBack: vi.fn(async () => response()),
    reload: vi.fn(async () => response()),
  };
  const close = vi.fn(async () => {});
  const newPage = vi.fn(async () => page);
  vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue({ contexts: () => [{ pages: () => pages ? [page] : [], newPage, on: vi.fn() }], close } as unknown as Browser);
  const client = new AdsPowerClient('http://localhost:50325', '');
  const active = vi.spyOn(client, 'active').mockResolvedValue('ws://localhost:1234/devtools/browser/test');
  const start = vi.spyOn(client, 'start');
  const guard = new ShopRequestGuard();
  const nbuLogin = { available: vi.fn(() => true), ensure: vi.fn(async () => { loggedIn = true; }) };
  const tester = new BehaviorTester(client, guard, new PreparationGate(0), { now: () => now,
    sleep: async (ms, abort) => { abort.throwIfAborted(); now += ms; } }, () => 0.4, nbuLogin as unknown as NbuLogin);
  return { tester, page, close, newPage, active, start, guard, nbuLogin };
}
describe('behavior test browser controls', () => {
  it('moves and scrolls on an open profile without clicks, navigation, tabs or browser starts', async () => {
    const { tester, page, close, newPage, start } = fixture();
    const result = await tester.run('a', { navigate: false }, signal());
    expect(result).toMatchObject({ moves: 8, scrolls: 4, navigations: 0, stopped: false, login: 'logged-in' });
    expect(page.mouse.move).toHaveBeenCalled(); expect(page.mouse.wheel).toHaveBeenCalled();
    for (const operation of [page.goto, page.mouse.click, page.close, newPage, start]) expect(operation).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it('follows links by clicking them, never by typing addresses', async () => {
    const { tester, page } = fixture();
    expect((await tester.run('a', { navigate: true }, signal())).navigations).toBeGreaterThan(0);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.mouse.click).toHaveBeenCalled();
  });
  it('does not draw a cursor on the page unless asked', async () => {
    const { tester, page } = fixture();
    const drawn = () => page.evaluate.mock.calls.some(([, arg]) => typeof arg === 'object' && arg !== null && 'id' in arg);
    await tester.run('a', { navigate: false }, signal());
    expect(drawn()).toBe(false);
    await tester.run('a', { navigate: false, showCursor: true }, signal());
    expect(drawn()).toBe(true);
  });
  it('does not click when something else is under the pointer', async () => {
    const { tester, page } = fixture();
    page.evaluate.mockImplementation(async (fn: unknown) => fn === behaviorPageState
      ? { width: 800, height: 600, challenge: false, scrollY: 0, maxScroll: 1000, login: 'logged-in',
        targets: [{ href: 'https://coins.bank.gov.ua/coin/p-2.html', product: true, x: 200, y: 200 }] }
      : fn === linkAt ? 'https://coins.bank.gov.ua/shopping_cart.php' : true);
    await tester.run('a', { navigate: true }, signal());
    expect(page.mouse.click).not.toHaveBeenCalled();
  });
  it('signs a logged-out profile in with the saved account before warming up', async () => {
    const { tester, page, nbuLogin } = fixture(200, { login: 'logged-out' });
    const result = await tester.run('a', { navigate: false }, signal());
    expect(nbuLogin.ensure).toHaveBeenCalledOnce(); expect(page.reload).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ login: 'logged-in' }); expect(result.loginNote).toBeUndefined();
  });
  it('reports a logged-out profile when there is no saved account', async () => {
    const { tester, nbuLogin } = fixture(200, { login: 'logged-out' });
    nbuLogin.available.mockReturnValue(false);
    const result = await tester.run('a', { navigate: false }, signal());
    expect(result.login).toBe('logged-out'); expect(result.loginNote).toContain('не залогінений');
    expect(nbuLogin.ensure).not.toHaveBeenCalled();
  });
  it('opens the NBU home page itself when the profile has no NBU tab', async () => {
    const { tester, page, newPage } = fixture(200, { pages: 0 });
    await tester.run('a', { navigate: false }, signal());
    expect(newPage).toHaveBeenCalledOnce(); expect(page.goto).toHaveBeenCalledWith('https://coins.bank.gov.ua/', expect.anything());
  });
  it('stops on cancellation and disconnects without closing the tab', async () => {
    const { tester, page, close } = fixture();
    const controller = new AbortController();
    page.mouse.move.mockImplementationOnce(async () => { controller.abort(); });
    expect((await tester.run('a', { navigate: true }, controller.signal)).stopped).toBe(true);
    expect(page.mouse.click).not.toHaveBeenCalled(); expect(page.close).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
  it('stops on 429 and sets the shared cooldown without another navigation', async () => {
    const { tester, page, guard } = fixture(429);
    await expect(tester.run('a', { navigate: true }, signal())).rejects.toThrow('429');
    expect(guard.isBlocked()).toBe(true); expect(page.mouse.click).toHaveBeenCalledOnce();
  });
  it('opens a closed profile, or AdsPower itself, before warming up', async () => {
    const { tester, active, start } = fixture();
    start.mockResolvedValue('ws://localhost:1234/devtools/browser/started');
    active.mockResolvedValueOnce(undefined);
    await tester.run('a', { navigate: false }, signal());
    active.mockRejectedValueOnce(new Error('AdsPower is not running'));
    await tester.run('a', { navigate: false }, signal());
    expect(start).toHaveBeenCalledTimes(2);
    expect(chromium.connectOverCDP).toHaveBeenLastCalledWith('ws://localhost:1234/devtools/browser/started', expect.anything());
  });
});

it('keeps making randomized transitions throughout the requested duration', async () => {
  const { tester, page } = fixture();
  const result = await tester.run('a', { navigate: true, durationMs: 120_000 }, signal());
  expect(result.stopped).toBe(false);
  expect(result.durationMs).toBeGreaterThanOrEqual(120_000);
  expect(result.durationMs).toBeLessThan(120_500);
  expect(result.moves).toBeGreaterThan(8);
  expect(page.mouse.click.mock.calls.length).toBeGreaterThan(2);
  expect(page.mouse.click.mock.calls.length).toBeLessThanOrEqual(6);
});

it('splits a wheel gesture into uneven notches and mixes short and long pauses', () => {
  const steps = wheelSteps(300, () => 0.7);
  expect(steps.length).toBeGreaterThanOrEqual(3); expect(steps.length).toBeLessThanOrEqual(8);
  expect(steps.reduce((sum, step) => sum + step, 0)).toBeCloseTo(300);
  expect(readingPauseMs(1, () => 0.01)).toBeGreaterThanOrEqual(15_000);
  expect(readingPauseMs(1, () => 0.9)).toBeLessThan(2000);
});

it('glides by elapsed time at a steady frame rate, even when the browser answers slowly', async () => {
  let now = 0;
  const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  const curve = pointerCurve({ x: 10, y: 10 }, { x: 700, y: 500 }, 800, 600, 1, () => 0.5);
  const sent: Array<{ at: number; x: number; y: number }> = [];
  // Every move takes 11 ms to be acknowledged; the gesture must not get longer or uneven because of it.
  const end = await glidePointer(curve, async (point) => { sent.push({ at: now, ...point }); now += 11; }, clock, signal());
  expect(end).toMatchObject({ x: 700, y: 500 });
  const gaps = sent.slice(1).map((item, index) => item.at - sent[index]!.at);
  expect(new Set(gaps.slice(0, -1))).toEqual(new Set([16]));
  expect(sent.at(-1)!.at).toBeLessThanOrEqual(curve.durationMs + 16);
  let cut = 0;
  await glidePointer(curve, async () => { cut++; now += 1; }, clock, signal(), now + 100);
  expect(cut).toBeLessThanOrEqual(8);
});
