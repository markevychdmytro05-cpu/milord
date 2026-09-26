import { describe, expect, it } from 'vitest';
import { runTask, CLICK_COOLDOWN_MS, MAX_CLICKS } from '../src/core/buyer';
import { fakeBrowser, FakeClock, ready, task } from './helpers';

describe('purchase workflow', () => {
  it('observes a sale without clicking the button', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    const input = task({ mode: 'observe' });
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('observed');
    expect(browser.clicks).toHaveLength(0);
    expect(browser.disconnected()).toBe(true);
  });

  it('records click intent before clicking and confirms cart success', async () => {
    const clock = new FakeClock();
    let storedClicks = 0;
    const browser = fakeBrowser(clock, () => ({ ...ready, inCart: browser.clicks.length > 0 }));
    const click = browser.session.clickBuy;
    browser.session.clickBuy = async () => { expect(storedClicks).toBe(1); await click(); };
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async (saved) => { storedClicks = saved.clicks; });
    expect(input.status).toBe('in_cart');
    expect(browser.clicks).toHaveLength(1);
  });

  it('does not click a product already in the cart', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, inCart: true }));
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('in_cart');
    expect(browser.clicks).toHaveLength(0);
  });

  it('limits retries to five clicks at least eleven seconds apart', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(browser.clicks).toHaveLength(MAX_CLICKS);
    for (let i = 1; i < browser.clicks.length; i++) {
      expect(browser.clicks[i]! - browser.clicks[i - 1]!).toBeGreaterThanOrEqual(CLICK_COOLDOWN_MS);
    }
    expect(input.status).toBe('interrupted');
    expect(browser.reloads).toHaveLength(1);
  });

  it('waits in the store queue without reloading or clicking again', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({
      ...ready, queuePosition: browser.clicks.length ? '12' : '', inCart: clock.now() >= 1_020_000,
    }));
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('in_cart');
    expect(browser.clicks).toHaveLength(1);
    expect(browser.reloads).toHaveLength(1);
    expect(input.events.some((event) => event.message === 'Черга: 12')).toBe(true);
  });

  it('waits for manual challenge completion before clicking', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({
      ...ready, turnstile: clock.now() < 1_005_000, inCart: browser.clicks.length > 0,
    }));
    await runTask(task(), browser.provider, clock, new AbortController().signal, async () => {});
    expect(browser.clicks).toEqual([1_005_000]);
  });

  it('never purchases when login or page recognition is unknown', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, login: 'unknown' }));
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(browser.clicks).toHaveLength(0);
    expect(input.status).toBe('expired');
  });

  it('honors cancellation between journal persistence and the actual click', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    const controller = new AbortController();
    const input = task();
    await runTask(input, browser.provider, clock, controller.signal, async (saved) => {
      if (saved.clicks) controller.abort();
    });
    expect(browser.clicks).toHaveLength(0);
    expect(input.status).toBe('cancelled');
    expect(browser.disconnected()).toBe(true);
  });

  it('does not start expired tasks or replay interrupted tasks', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    const expired = task({ saleAt: 800_000 });
    const interrupted = task({ status: 'interrupted', clicks: 1 });
    await runTask(expired, browser.provider, clock, new AbortController().signal, async () => {});
    await runTask(interrupted, browser.provider, clock, new AbortController().signal, async () => {});
    expect(expired.status).toBe('expired');
    expect(interrupted.status).toBe('interrupted');
    expect(browser.connections()).toBe(0);
  });

  it('does not refresh early even with a positive server offset estimate', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    browser.session.serverOffset = async () => 2000;
    const input = task({ saleAt: 1_010_000, mode: 'observe' });
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(browser.reloads).toEqual([1_010_000]);
    expect(input.offsetMs).toBe(2000);
  });

  it('waits for the conservative server time when the local clock is ahead', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    browser.session.serverOffset = async () => -800;
    await runTask(task({ saleAt: 1_010_000, mode: 'observe' }), browser.provider, clock,
      new AbortController().signal, async () => {});
    expect(browser.reloads).toEqual([1_010_800]);
  });

  it('clicks immediately after a reload exposes the button, without a one-second sleep', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready,
      buyAvailable: browser.reloads.length > 0, inCart: browser.clicks.length > 0,
    }));
    await runTask(task({ saleAt: 1_010_000 }), browser.provider, clock, new AbortController().signal, async () => {});
    expect(browser.reloads).toEqual([1_010_000]);
    expect(browser.clicks).toEqual([1_010_000]);
  });

  it('does not perform disk writes at the sale deadline before the refresh', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    await runTask(task({ saleAt: 1_010_000, mode: 'observe' }), browser.provider, clock,
      new AbortController().signal, async () => { clock.time += 120; });
    expect(browser.reloads).toEqual([1_010_000]);
  });

  it('uses browser-local detection to react between two network refreshes', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready,
      buyAvailable: clock.now() >= 1_000_075, inCart: browser.clicks.length > 0,
    }));
    browser.session.waitForActionable = async () => { clock.time = 1_000_075; return browser.session.read(); };
    await runTask(task(), browser.provider, clock, new AbortController().signal, async () => {});
    expect(browser.clicks).toEqual([1_000_075]);
    expect(browser.reloads).toHaveLength(1);
  });

  it('does not refresh before the sale or use a one-second network burst afterwards', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, buyAvailable: false }));
    await runTask(task({ saleAt: 1_010_000, retrySec: 1 }), browser.provider, clock,
      new AbortController().signal, async () => {});
    expect(browser.reloads[0]).toBe(1_010_000);
    for (let i = 1; i < browser.reloads.length; i++) {
      expect(browser.reloads[i]! - browser.reloads[i - 1]!).toBeGreaterThanOrEqual(5000);
    }
  });

  it('expires without clicking if the machine wakes after the sale window', async () => {
    const clock = new FakeClock();
    clock.sleep = async () => { clock.time += 200_000; };
    const browser = fakeBrowser(clock);
    const input = task({ saleAt: 1_010_000 });
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('expired');
    expect(browser.reloads).toHaveLength(0);
    expect(browser.clicks).toHaveLength(0);
  });

  it('reports an unknown result after a failed click and never blindly retries', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    browser.session.clickBuy = async () => { throw new Error('secret-token must not be logged'); };
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('interrupted');
    expect(input.clicks).toBe(1);
    expect(JSON.stringify(input)).not.toContain('secret-token');
  });

  it('never clicks if durable intent cannot be saved', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    await expect(runTask(task(), browser.provider, clock, new AbortController().signal, async (saved) => {
      if (saved.clicks) throw new Error('disk full');
    })).rejects.toThrow('disk full');
    expect(browser.clicks).toHaveLength(0);
    expect(browser.disconnected()).toBe(true);
  });
});

describe('verification at preparation and the sale boundary', () => {
  it('waits for a preparation widget before time probes or the sale refresh', async () => {
    const clock = new FakeClock();
    const clearedAt = 1_006_000;
    const browser = fakeBrowser(clock, () => ({ ...ready, turnstile: clock.now() < clearedAt }));
    const probes: number[] = [];
    browser.session.serverOffset = async () => { probes.push(clock.now()); return 0; };
    const input = task({ saleAt: 1_003_000, mode: 'observe' });
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(probes).toEqual([clearedAt]);
    expect(browser.reloads).toEqual([clearedAt]);
    expect(input.status).toBe('observed');
  });

  it.each(['turnstile', 'challenge', 'queue', 'logout'] as const)(
    'does not interrupt %s that appears just before the deadline', async (condition) => {
      const clock = new FakeClock();
      const browser = fakeBrowser(clock, () => {
        const blocked = clock.now() >= 1_009_500 && clock.now() < 1_014_000;
        return { ...ready, turnstile: blocked && condition === 'turnstile',
          challenge: blocked && condition === 'challenge', queuePosition: blocked && condition === 'queue' ? '5' : '',
          login: blocked && condition === 'logout' ? 'logged-out' : 'logged-in' };
      });
      const input = task({ saleAt: 1_010_000, mode: 'observe' });
      await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
      expect(browser.reloads).toEqual([1_014_000]);
      expect(input.status).toBe('observed');
    });

  it('expires without a time probe, refresh or click if a preparation widget never clears', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, turnstile: true }));
    let probes = 0;
    browser.session.serverOffset = async () => { probes++; return 0; };
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('expired');
    expect(probes).toBe(0);
    expect(browser.reloads).toHaveLength(0);
    expect(browser.clicks).toHaveLength(0);
  });

  it('never refreshes during a post-click verification or clicks again after confirmed success', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready,
      turnstile: browser.clicks.length > 0 && clock.now() < 1_015_000,
      inCart: clock.now() >= 1_015_000,
    }));
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('in_cart');
    expect(browser.clicks).toEqual([1_000_000]);
    expect(browser.reloads).toEqual([1_000_000]);
  });

  it('does not assume that an earlier successful verification prevents another one', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready,
      turnstile: browser.reloads.length > 0 && clock.now() < 1_007_000,
      inCart: browser.clicks.length > 0,
    }));
    await runTask(task(), browser.provider, clock, new AbortController().signal, async () => {});
    expect(browser.clicks).toEqual([1_007_000]);
    expect(browser.reloads).toHaveLength(1);
  });
});

describe('a submitted purchase awaiting the store response', () => {
  it('replaces a stale captcha status after verification completes without repeating the click', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready,
      turnstile: browser.clicks.length > 0 && clock.now() < 1_003_000,
      purchasePending: browser.clicks.length > 0 && clock.now() < 1_007_000,
      buyAvailable: browser.clicks.length === 0,
      inCart: clock.now() >= 1_007_000,
    }));
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('in_cart');
    expect(browser.clicks).toHaveLength(1);
    expect(browser.reloads).toHaveLength(1);
    expect(input.events.some((event) => event.at === 1_003_000 && event.message.includes('Магазин обробляє'))).toBe(true);
  });

  it('leaves a previously submitted manual purchase intact until its cart confirmation', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready,
      purchasePending: clock.now() < 1_005_000, inCart: clock.now() >= 1_005_000,
    }));
    let probes = 0;
    browser.session.serverOffset = async () => { probes++; return 0; };
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('in_cart');
    expect(browser.clicks).toHaveLength(0);
    expect(browser.reloads).toHaveLength(0);
    expect(probes).toBe(0);
  });

  it.each([true, false])('does not retry a prior manual submission when still pending: %s', async (remainsPending) => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready,
      purchasePending: remainsPending || clock.now() < 1_005_000,
    }));
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('interrupted');
    expect(browser.clicks).toHaveLength(0);
    expect(browser.reloads).toHaveLength(0);
  });

  it('does not reload a manual submission that begins after the initial sale refresh', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready,
      buyAvailable: false, purchasePending: browser.reloads.length > 0,
    }));
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('interrupted');
    expect(browser.reloads).toHaveLength(1);
    expect(browser.clicks).toHaveLength(0);
  });
});

it('uses a ready prepared tab without a redundant sale reload', async () => {
  const clock = new FakeClock();
  const browser = fakeBrowser(clock, () => ({ ...ready, inCart: browser.clicks.length > 0 }));
  browser.session.prepared = true;
  await runTask(task({ saleAt: 1_010_000 }), browser.provider, clock, new AbortController().signal, async () => {});
  expect(browser.reloads).toEqual([]);
  expect(browser.clicks).toEqual([1_010_000]);
});

it('still refreshes a prepared tab at the sale deadline if no button is available', async () => {
  const clock = new FakeClock();
  const browser = fakeBrowser(clock, () => ({ ...ready, buyAvailable: browser.reloads.length > 0,
    inCart: browser.clicks.length > 0 }));
  browser.session.prepared = true;
  await runTask(task({ saleAt: 1_010_000 }), browser.provider, clock, new AbortController().signal, async () => {});
  expect(browser.reloads).toEqual([1_010_000]); expect(browser.clicks).toEqual([1_010_000]);
});

it('recovers 429 automatically before buying and journals the pause', async () => {
  const clock = new FakeClock(); let limited = true;
  const browser = fakeBrowser(clock, () => ({ ...ready, rateLimited: limited, inCart: browser.clicks.length > 0 }));
  browser.session.prepared = true;
  browser.session.recoverRateLimit = async () => { clock.time += 30_000; limited = false; return true; };
  const input = task();
  await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
  expect(input.status).toBe('in_cart'); expect(browser.clicks).toEqual([1_030_000]);
  expect(input.events.some((event) => event.message.includes('429'))).toBe(true);
});

it.each([false, true])('never repeats an uncertain purchase after a 429 refresh (confirmed=%s)', async (confirmed) => {
  const clock = new FakeClock(); let recovered = false;
  const browser = fakeBrowser(clock, () => ({ ...ready,
    rateLimited: browser.clicks.length > 0 && !recovered,
    inCart: recovered && confirmed,
  }));
  browser.session.recoverRateLimit = async () => { clock.time += 30_000; recovered = true; return true; };
  const input = task();
  await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
  expect(input.status).toBe(confirmed ? 'in_cart' : 'interrupted');
  expect(browser.clicks).toHaveLength(1);
});
