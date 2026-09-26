import { describe, expect, it } from 'vitest';
import {
  intersectBounds, offsetFromBounds, priorOffsetBounds, PRIOR_BOUNDS_MAX_AGE_MS, responseOffsetBounds,
} from '../src/core/clock-bounds';
import { runTask } from '../src/core/buyer';
import { FakeClock, fakeBrowser, task } from './helpers';

const second = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toUTCString();

describe('response offset bounds', () => {
  it('always contains the true offset, whatever the truncation phase and latency', () => {
    for (const trueOffset of [-1700, -250, 0, 42, 365, 2400]) {
      for (let sentAt = 1_000_000; sentAt < 1_002_000; sentAt += 37) {
        const stampedAt = sentAt + 120; // server stamps mid-flight
        const receivedAt = sentAt + 310;
        const bounds = responseOffsetBounds(second(stampedAt + trueOffset), sentAt, receivedAt)!;
        expect(bounds.lowMs).toBeLessThanOrEqual(trueOffset);
        expect(bounds.highMs).toBeGreaterThanOrEqual(trueOffset);
      }
    }
  });

  it('rejects missing, reversed or absurd readings', () => {
    expect(responseOffsetBounds(undefined, 1, 2)).toBeUndefined();
    expect(responseOffsetBounds(second(1_000_000), undefined, 1_000_000)).toBeUndefined();
    expect(responseOffsetBounds(second(1_000_000), 1_000_500, 1_000_000)).toBeUndefined();
    expect(responseOffsetBounds(second(1_000_000_000), 1_000, 1_100)).toBeUndefined();
  });

  it('narrows to the true offset as readings with different phases are intersected', () => {
    const trueOffset = 180;
    const readings = Array.from({ length: 12 }, (_, i) => {
      const sentAt = 1_000_000 + i * 4_321;
      return responseOffsetBounds(second(sentAt + 140 + trueOffset), sentAt, sentAt + 290)!;
    });
    const combined = intersectBounds(readings.reverse())!;
    expect(combined.lowMs).toBeLessThanOrEqual(trueOffset);
    expect(combined.highMs).toBeGreaterThanOrEqual(trueOffset);
    expect(combined.highMs - combined.lowMs).toBeLessThan(readings[0]!.highMs - readings[0]!.lowMs);
  });

  it('skips a reading that contradicts newer ones instead of emptying the range', () => {
    expect(intersectBounds([{ lowMs: 0, highMs: 400 }, { lowMs: 2000, highMs: 3000 }, { lowMs: 100, highMs: 900 }]))
      .toEqual({ lowMs: 100, highMs: 400 });
  });

  it('keeps the local clock when it is consistent, and corrects only by the proven amount otherwise', () => {
    expect(offsetFromBounds({ lowMs: -600, highMs: 400 })).toBe(0);
    expect(offsetFromBounds({ lowMs: 42, highMs: 365 })).toBe(42);
    expect(offsetFromBounds({ lowMs: -1900, highMs: -700 })).toBe(-700);
  });
});

describe('prior bounds', () => {
  const now = 50_000_000;
  const sampled = (profileId: string, at: number, lowMs = 0, highMs = 500) =>
    task({ profileId, offsetSampledAt: at, offsetLowMs: lowMs, offsetHighMs: highMs });

  it('uses only recent readings of the same profile, newest first', () => {
    const tasks = [
      sampled('a', now - 5000, 10, 300),
      sampled('a', now - 1000, 20, 200),
      sampled('b', now - 1000, -900, -100),
      sampled('a', now - PRIOR_BOUNDS_MAX_AGE_MS - 1),
      task({ profileId: 'a', offsetSampledAt: now - 10 }), // no bounds (older build)
    ];
    expect(priorOffsetBounds(tasks, 'a', now)).toEqual([{ lowMs: 20, highMs: 200 }, { lowMs: 10, highMs: 300 }]);
  });

  it('excludes the running task itself', () => {
    const own = sampled('a', now - 10);
    expect(priorOffsetBounds([own], 'a', now, own.id)).toEqual([]);
  });
});

describe('sale start with measured bounds', () => {
  it('starts on the local clock when the measurement cannot prove it wrong (old code waited for the truncated Date)', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    browser.session.serverOffset = async () => -450; // what the point estimate used to say
    browser.session.serverOffsetBounds = async () => ({ lowMs: -600, highMs: 400 });
    const input = task({ saleAt: 1_010_000, mode: 'observe' });
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(browser.reloads).toEqual([1_010_000]);
    expect(input.offsetMs).toBe(0);
    expect([input.offsetLowMs, input.offsetHighMs]).toEqual([-600, 400]);
  });

  it('still waits when the range proves the local clock is ahead of the server', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    browser.session.serverOffsetBounds = async () => ({ lowMs: -1500, highMs: -300 });
    await runTask(task({ saleAt: 1_010_000, mode: 'observe' }), browser.provider, clock,
      new AbortController().signal, async () => {});
    expect(browser.reloads).toEqual([1_010_300]);
  });

  it('narrows the range with earlier readings of the same profile', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    browser.session.serverOffsetBounds = async () => ({ lowMs: -1200, highMs: 100 });
    const input = task({ saleAt: 1_010_000, mode: 'observe' });
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {},
      () => [{ lowMs: -900, highMs: -250 }]);
    expect(input.offsetMs).toBe(-250);
    expect(browser.reloads).toEqual([1_010_250]);
    // Only this session's own range is stored, so a wrong prior can never become permanent.
    expect([input.offsetLowMs, input.offsetHighMs]).toEqual([-1200, 100]);
  });

  it('never lets a positive proven offset start the refresh early', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    browser.session.serverOffsetBounds = async () => ({ lowMs: 42, highMs: 365 });
    await runTask(task({ saleAt: 1_010_000, mode: 'observe' }), browser.provider, clock,
      new AbortController().signal, async () => {});
    expect(browser.reloads).toEqual([1_010_000]);
  });
});
