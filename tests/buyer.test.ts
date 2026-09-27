import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTask, reloadIntervalMs, jitterMs, CLICK_COOLDOWN_MS, MAX_CLICKS, SALE_START_MARGIN_MS } from '../src/core/buyer';
import { fakeBrowser, FakeClock, ready, task } from './helpers';

describe('purchase workflow', () => {
  afterEach(() => { vi.restoreAllMocks(); });

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

  it('refreshes fast while the sale opens, then backs off after each completed load', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, buyAvailable: false }));
    const reload = browser.session.reload;
    browser.session.reload = async () => { await reload(); clock.time += 250; };
    await runTask(task({ saleAt: 1_010_000, retrySec: 1, windowMin: 5 }), browser.provider, clock,
      new AbortController().signal, async () => {});
    expect(browser.reloads[0]).toBe(1_010_000);
    for (let i = 1; i < browser.reloads.length; i++) {
      const loadedAt = browser.reloads[i - 1]! + 250;
      expect(browser.reloads[i]! - loadedAt).toBe(reloadIntervalMs(loadedAt - 1_010_000, 1));
    }
    expect(browser.reloads.slice(0, 3)).toEqual([1_010_000, 1_010_450, 1_010_900]);
    // The old fixed 1 s cadence made ~240 full reloads here. The 200 ms opening burst adds ~10 in its first 5 s.
    expect(browser.reloads.length).toBeLessThan(70);
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

it('recovers when another tab reports 429 between persisted intent and the actual click', async () => {
  const { ShopRateLimitError } = await import('../src/core/shop-errors');
  const clock = new FakeClock(); let limited = false; let refused = false;
  const browser = fakeBrowser(clock, () => ({ ...ready, rateLimited: limited, inCart: browser.clicks.length > 0 }));
  const click = browser.session.clickBuy;
  browser.session.clickBuy = async () => {
    if (!refused) { refused = true; limited = true; throw new ShopRateLimitError(); }
    await click();
  };
  browser.session.recoverRateLimit = async () => { clock.time += 30_000; limited = false; return true; };
  const input = task();
  await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
  expect(input.status).toBe('in_cart'); expect(input.clicks).toBe(1); expect(browser.clicks).toHaveLength(1);
});

describe('reload interval', () => {
  it('uses 200 ms for the first five seconds, then backs off', () => {
    expect([0, 4_999, 5_000, 19_999, 20_000, 59_999, 60_000, 119_999, 120_000, 299_000]
      .map((elapsed) => reloadIntervalMs(elapsed, 1)))
      .toEqual([200, 200, 1000, 1000, 3000, 3000, 5000, 5000, 10_000, 10_000]);
  });

  it('never shortens a slower interval the user chose', () => {
    expect(reloadIntervalMs(0, 5)).toBe(5000);
    expect(reloadIntervalMs(30_000, 5)).toBe(5000);
    expect(reloadIntervalMs(200_000, 5)).toBe(10_000);
    expect(reloadIntervalMs(200_000, 30)).toBe(30_000);
  });

  it('spreads each interval by at most 10%', () => {
    expect(jitterMs(1000, () => 0)).toBe(900);
    expect(jitterMs(1000, () => 0.5)).toBe(1000);
    expect(jitterMs(1000, () => 0.999999)).toBe(1100);
  });
});

describe('pointer before the sale', () => {
  it('moves the pointer while waiting, parks it on the button before the sale and never during it', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, inCart: browser.clicks.length > 0 }));
    const idles: Array<[number, number]> = [];
    const approaches: Array<[number, number]> = [];
    browser.session.idle = async (ms) => { idles.push([clock.now(), ms]); clock.time += ms / 2; };
    browser.session.approach = async (ms) => { approaches.push([clock.now(), ms]); clock.time += ms; };
    const input = task({ saleAt: clock.time + 20_000 });
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('in_cart');
    expect(idles.length).toBeGreaterThan(5);
    for (const [at, ms] of idles) expect(at + ms).toBeLessThanOrEqual(input.saleAt - 3000);
    expect(approaches).toHaveLength(1);
    const [at, ms] = approaches[0]!;
    expect(at + ms).toBeLessThanOrEqual(input.saleAt - 1000);
    expect(Math.max(...idles.map(([time]) => time))).toBeLessThan(at);
    expect(browser.clicks[0]).toBeGreaterThanOrEqual(input.saleAt);
  });

  it('keeps buying when pointer movement fails', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, inCart: browser.clicks.length > 0 }));
    browser.session.idle = async () => { throw new Error('page closed'); };
    browser.session.approach = async () => { throw new Error('page closed'); };
    const input = task({ saleAt: clock.time + 10_000 });
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('in_cart');
    expect(browser.clicks).toHaveLength(1);
  });
});

describe('sale start by atomic time', () => {
  const run = async (atomic: number | undefined, bounds = { lowMs: -500, highMs: 500 }) => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, buyAvailable: browser.reloads.length > 0, inCart: browser.clicks.length > 0 }));
    browser.session.serverOffsetBounds = async () => bounds;
    const input = task({ saleAt: clock.time + 30_000 });
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {}, () => [], () => atomic);
    return { input, firstReload: browser.reloads[0]! };
  };
  it('fires the first refresh 40 ms after the start by atomic time when the local clock is fast', async () => {
    // Local clock 300 ms ahead of UTC: the refresh waits for true UTC, plus the safety margin.
    const { input, firstReload } = await run(-300);
    expect(input.offsetMs).toBe(-300);
    expect(firstReload + input.offsetMs).toBeGreaterThanOrEqual(input.saleAt + SALE_START_MARGIN_MS);
    expect(firstReload + input.offsetMs).toBeLessThan(input.saleAt + SALE_START_MARGIN_MS + 60);
  });
  it('corrects a slow local clock only to atomic time plus the margin', async () => {
    const { input, firstReload } = await run(120);
    expect(firstReload + 120).toBeGreaterThanOrEqual(input.saleAt + SALE_START_MARGIN_MS);
    expect(firstReload + 120).toBeLessThan(input.saleAt + SALE_START_MARGIN_MS + 60);
  });
  it('keeps the conservative local rule without atomic time, or when the shop contradicts it', async () => {
    const plain = await run(undefined);
    expect(plain.firstReload).toBeGreaterThanOrEqual(plain.input.saleAt);
    // The shop proves its clock is at least 200 ms ahead; an atomic reading of 0 disagrees and is not trusted.
    const contradicted = await run(0, { lowMs: 200, highMs: 900 });
    expect(contradicted.input.offsetMs).toBe(200);
    expect(contradicted.firstReload).toBeGreaterThanOrEqual(contradicted.input.saleAt);
  });
});
