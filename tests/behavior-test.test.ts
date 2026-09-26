import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { BehaviorTester, behaviorPageState } from '../src/browser/behavior-test';
import { AdsPowerClient, PreparationGate } from '../src/browser/adspower';
import { ShopRequestGuard } from '../src/core/shop-errors';
import { pointerPath, profileMotionTempo } from '../src/core/pointer-motion';

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
function fixture(status = 200) {
  let url = 'https://coins.bank.gov.ua/start/p-1.html', now = 0;
  const page = {
    isClosed: () => false, url: () => url, bringToFront: vi.fn(async () => {}), close: vi.fn(),
    mouse: { move: vi.fn(async (_x: number, _y: number) => {}), wheel: vi.fn(async () => {}), click: vi.fn() },
    evaluate: vi.fn(async (fn: unknown) => fn === behaviorPageState ? { width: 800, height: 600, challenge: false,
      targets: [2, 3].map(id => ({ href: `https://coins.bank.gov.ua/coin/p-${id}.html`, x: 200, y: 200 })) } : true),
    goto: vi.fn(async (next: string) => { url = next; return { status: () => status, ok: () => status === 200, headers: () => ({ 'retry-after': '60' }) }; }),
  };
  const close = vi.fn(async () => {}), newPage = vi.fn();
  vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue({ contexts: () => [{ pages: () => [page], newPage }], close } as unknown as Browser);
  const client = new AdsPowerClient('http://localhost:50325', '');
  const active = vi.spyOn(client, 'active').mockResolvedValue('ws://localhost:1234/devtools/browser/test');
  const start = vi.spyOn(client, 'start');
  const guard = new ShopRequestGuard();
  const tester = new BehaviorTester(client, guard, new PreparationGate(0), { now: () => now,
    sleep: async (ms, abort) => { abort.throwIfAborted(); now += ms; } }, () => 0.4);
  return { tester, page, close, newPage, active, start, guard };
}
describe('behavior test browser controls', () => {
  it('moves and scrolls on the existing page without clicks, navigation, tabs or browser starts', async () => {
    const { tester, page, close, newPage, start } = fixture();
    const result = await tester.run('a', false, signal());
    expect(result).toMatchObject({ moves: 8, scrolls: 4, navigations: 0, stopped: false });
    expect(page.mouse.move).toHaveBeenCalled(); expect(page.mouse.wheel).toHaveBeenCalled();
    for (const operation of [page.goto, page.mouse.click, page.close, newPage, start]) expect(operation).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it('visits product pages after randomized pauses and never clicks cart buttons', async () => {
    const { tester, page } = fixture();
    expect((await tester.run('a', true, signal())).navigations).toBeGreaterThan(0);
    expect(page.goto.mock.calls.length).toBeLessThanOrEqual(2); expect(page.mouse.click).not.toHaveBeenCalled();
    expect(new Set(page.goto.mock.calls.map(call => call[0])).size).toBe(page.goto.mock.calls.length);
  });
  it('stops on cancellation and disconnects without closing the tab', async () => {
    const { tester, page, close } = fixture();
    const controller = new AbortController();
    page.mouse.move.mockImplementationOnce(async () => { controller.abort(); });
    expect((await tester.run('a', true, controller.signal)).stopped).toBe(true);
    expect(page.goto).not.toHaveBeenCalled(); expect(page.close).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
  it('stops on 429 and sets the shared cooldown without another navigation', async () => {
    const { tester, page, guard } = fixture(429);
    await expect(tester.run('a', true, signal())).rejects.toThrow('429');
    expect(guard.isBlocked()).toBe(true); expect(page.goto).toHaveBeenCalledOnce();
  });
  it('leaves closed profiles closed', async () => {
    const { tester, active, start } = fixture(); active.mockResolvedValue(undefined);
    await expect(tester.run('a', true, signal())).rejects.toThrow('Відкрийте профіль');
    expect(start).not.toHaveBeenCalled(); expect(chromium.connectOverCDP).not.toHaveBeenCalled();
  });
});

it('keeps making randomized product transitions throughout the requested duration', async () => {
  const { tester, page } = fixture();
  const result = await tester.run('a', true, signal(), 120_000);
  expect(result.stopped).toBe(false);
  expect(result.durationMs).toBeGreaterThanOrEqual(120_000);
  expect(result.durationMs).toBeLessThan(120_500);
  expect(result.moves).toBeGreaterThan(8);
  expect(page.goto.mock.calls.length).toBeGreaterThan(2);
  expect(page.goto.mock.calls.length).toBeLessThanOrEqual(6);
});
