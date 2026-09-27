import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTask } from '../src/core/buyer';
import { ShopRateLimitError } from '../src/core/shop-errors';
import { summarizeSales } from '../src/core/sale-summary';
import { HISTORY_MAX_AGE_MS, HISTORY_MAX_FINISHED, pruneHistory, Store } from '../src/main/store';
import { fakeBrowser, FakeClock, ready, task } from './helpers';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('sale timings', () => {
  it('records when the button appeared, the first click and the cart, relative to the sale start', async () => {
    const clock = new FakeClock();
    // No button until 1.3 s after the start; the click is confirmed 4 s later.
    let clickedAt = 0;
    const browser = fakeBrowser(clock, () => ({ ...ready,
      buyAvailable: clock.now() >= 1_001_300 && !clickedAt,
      inCart: !!clickedAt && clock.now() >= clickedAt + 4000 }));
    const click = browser.session.clickBuy;
    browser.session.clickBuy = async () => { clickedAt = clock.now(); await click(); };
    const input = task({ retrySec: 1 });
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.status).toBe('in_cart');
    expect(input.startLoadedMs).toBe(0);
    expect(input.buttonSeenMs).toBeGreaterThanOrEqual(1300);
    expect(input.buttonSeenMs).toBeLessThan(2100);
    expect(input.buttonReloads).toBeGreaterThanOrEqual(2);
    expect(input.firstClickMs).toBe(input.buttonSeenMs);
    expect(input.cartMs! - input.firstClickMs!).toBeGreaterThanOrEqual(4000);
  });
  it('does not claim a cart time for a coin that was already in the cart', async () => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock, () => ({ ...ready, inCart: true }));
    const input = task();
    await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
    expect(input.cartMs).toBeUndefined();
  });

  it('measures the acknowledged click after the durable intent and browser dispatch', async () => {
    const clock = new FakeClock();
    const input = task();
    let intentSaved = false;
    const browser = fakeBrowser(clock, () => ({ ...ready, inCart: browser.clicks.length > 0 }));
    const click = browser.session.clickBuy;
    browser.session.clickBuy = async () => {
      expect(intentSaved).toBe(true);
      expect(input.firstClickMs).toBeUndefined();
      clock.time += 30;
      await click();
      clock.time += 5; // Browser acknowledgement arrives after the actual event.
    };
    await runTask(input, browser.provider, clock, new AbortController().signal, async saved => {
      if (saved.clicks === 1 && !intentSaved) {
        expect(saved.firstClickMs).toBeUndefined();
        clock.time += 120; // Slow disk must be included in the reported latency.
        intentSaved = true;
      }
    });
    expect(input.firstClickMs).toBe(155);
    expect(input.firstClickMs! - input.buttonSeenMs!).toBe(155);
    expect(browser.clicks[0]! - input.saleAt).toBe(150);
    expect(input.status).toBe('in_cart');
  });

  it.each(['cancel', 'disk', 'browser', 'rate-limit'])('does not report an unsent or unconfirmed click after %s', async failure => {
    const clock = new FakeClock();
    const browser = fakeBrowser(clock);
    const input = task();
    const controller = new AbortController();
    let rejectedSave = false;
    if (failure === 'browser') browser.session.clickBuy = async () => { throw new Error('Disconnected'); };
    if (failure === 'rate-limit') browser.session.clickBuy = async () => {
      controller.abort(); // Stop after the provider refuses dispatch; no second attempt.
      throw new ShopRateLimitError();
    };
    await runTask(input, browser.provider, clock, controller.signal, async saved => {
      if (!saved.clicks) return;
      if (failure === 'cancel') controller.abort();
      if (failure === 'disk' && !rejectedSave) { rejectedSave = true; throw new Error('Disk full'); }
    });
    expect(input.firstClickMs).toBeUndefined();
    expect(browser.clicks).toHaveLength(0);
  });
});

describe('sale summary', () => {
  it('groups tasks by sale start and reports who got the coin, how fast, and why not', () => {
    const tasks = [
      task({ id: id(1), profileId: 'a', status: 'in_cart', buttonSeenMs: 1200, firstClickMs: 1210, cartMs: 7000 }),
      task({ id: id(2), profileId: 'b', status: 'in_cart', buttonSeenMs: 900, firstClickMs: 905, cartMs: 5000 }),
      task({ id: id(3), profileId: 'c', status: 'expired', note: 'Час очікування кнопки покупки вичерпано.' }),
      task({ id: id(4), profileId: 'd', status: 'cancelled' }),
      task({ id: id(5), profileId: 'a', saleAt: 500_000, status: 'observed', buttonSeenMs: 300 }),
      task({ id: id(6), profileId: 'a', saleAt: 9_000_000 }), // Future sale: not summarized yet.
    ];
    const [latest, earlier, ...rest] = summarizeSales(tasks, 2_000_000);
    expect(rest).toEqual([]);
    expect(latest).toMatchObject({ saleAt: 1_000_000, total: 3, inCart: 2, earliestButtonMs: 900, medianButtonMs: 1050, medianCartMs: 6000, finished: true });
    expect(latest!.rows.map(row => row.profileId)).toEqual(['b', 'a', 'c']);
    expect(latest!.rows[2]!.note).toBe('Час очікування кнопки покупки вичерпано.');
    expect(earlier).toMatchObject({ saleAt: 500_000, inCart: 0, earliestButtonMs: 300 });
  });
});

describe('history retention', () => {
  const now = 100 * 24 * 60 * 60_000;
  it('drops finished tasks older than a month but never active ones', () => {
    const old = now - HISTORY_MAX_AGE_MS - 1;
    const tasks = [
      task({ id: id(1), status: 'in_cart', saleAt: old, updatedAt: old }),
      task({ id: id(2), status: 'scheduled', saleAt: old, updatedAt: old }),
      task({ id: id(3), status: 'failed', saleAt: now - 1000, updatedAt: now - 1000 }),
    ];
    expect(pruneHistory(tasks, now).map(item => item.id)).toEqual([id(2), id(3)]);
  });
  it('keeps only the newest finished tasks beyond the count limit', () => {
    const tasks = Array.from({ length: HISTORY_MAX_FINISHED + 3 }, (_, n) =>
      task({ id: id(n), status: 'expired', saleAt: now - n * 1000, updatedAt: now - n * 1000 }));
    const kept = pruneHistory(tasks, now);
    expect(kept).toHaveLength(HISTORY_MAX_FINISHED);
    expect(kept.some(item => item.id === id(HISTORY_MAX_FINISHED))).toBe(false);
  });
  it('cleans the stored file on load', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'nbu-history-')), 'tasks.json');
    const old = Date.now() - HISTORY_MAX_AGE_MS - 60_000;
    const store = new Store(path);
    await store.saveTask(task({ id: id(1), status: 'scheduled', saleAt: old, updatedAt: old }));
    await store.saveTask(task({ id: id(2), status: 'scheduled', saleAt: Date.now() + 60_000 }));
    await store.saveTask({ ...store.tasks()[0]!, status: 'in_cart' }); // Finishing it prunes it at once.
    expect(store.tasks().map(item => item.id)).toEqual([id(2)]);
    const restored = new Store(path);
    await restored.load();
    expect(restored.tasks().map(item => item.id)).toEqual([id(2)]);
    expect(JSON.parse(await readFile(path, 'utf8')).taskIds).toEqual([id(2)]);
    expect(await readdir(join(dirname(path), 'tasks'))).toEqual([`${id(2)}.json`]);
  });
});
