import { describe, expect, it } from 'vitest';
import { retryAfterMs, ShopRateLimitError, ShopRequestGuard } from '../src/core/shop-errors';
import { FakeClock } from './helpers';

const signal = () => new AbortController().signal;
describe('shared 429 cooldown', () => {
  it('parses both Retry-After formats and ignores invalid values', () => {
    expect(retryAfterMs('90', 0)).toBe(90_000);
    expect(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 30_000)).toBe(90_000);
    expect(retryAfterMs('invalid', 0)).toBe(0);
  });
  it('backs off 30, 60, 120 seconds when the server provides no delay', async () => {
    const clock = new FakeClock(); const guard = new ShopRequestGuard(clock);
    const times: number[] = [];
    guard.block();
    for (let i = 0; i < 3; i++) await guard.retry(signal(), 2_000_000, async () => {
      times.push(clock.now()); guard.block(); return false;
    });
    expect(times).toEqual([1_030_000, 1_090_000, 1_210_000]);
  });
  it('honors a longer server delay and clears the pause only on success', async () => {
    const clock = new FakeClock(); const guard = new ShopRequestGuard(clock);
    guard.block('90');
    await guard.retry(signal(), 2_000_000, async () => {
      expect(clock.now()).toBe(1_090_000); return true;
    });
    expect(guard.isBlocked()).toBe(false);
  });
  it('expires without issuing a request when Retry-After exceeds the task window', async () => {
    const clock = new FakeClock(); const guard = new ShopRequestGuard(clock);
    guard.block('600'); let requests = 0;
    await expect(guard.retry(signal(), 1_060_000, async () => { requests++; return true; }))
      .rejects.toBeInstanceOf(ShopRateLimitError);
    expect(requests).toBe(0); expect(clock.now()).toBe(1_060_000);
  });
  it('cancels during cooldown without a request', async () => {
    const clock = new FakeClock(); const guard = new ShopRequestGuard(clock);
    const controller = new AbortController(); guard.block(); controller.abort();
    await expect(guard.retry(controller.signal, 2_000_000, async () => { throw Error('Request issued'); })).rejects.toThrow();
    expect(clock.now()).toBe(1_000_000);
  });
  it('serializes concurrent retries and preserves a new 429 from another tab', async () => {
    const clock = new FakeClock(); const guard = new ShopRequestGuard(clock);
    guard.block(); let active = 0;
    const order: number[] = [];
    await Promise.all([1, 2].map((id) => guard.retry(signal(), 2_000_000, async () => {
      expect(active++).toBe(0); order.push(clock.now());
      if (id === 1) guard.block();
      await Promise.resolve(); active--; return true;
    })));
    expect(order).toEqual([1_030_000, 1_090_000]);
    expect(guard.isBlocked()).toBe(false);
  });
});
