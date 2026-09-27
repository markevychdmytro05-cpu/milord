import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Scheduler, UNEXPECTED_TASK_NOTE } from '../src/main/scheduler';
import { z } from 'zod';
import { Store } from '../src/main/store';
import { task } from './helpers';
import type { PreparationOptions } from '../src/core/ports';

async function setup() {
  const path = join(await mkdtemp(join(tmpdir(), 'nbu-scheduler-')), 'tasks.json');
  const store = new Store(path);
  const signals = new Map<string, AbortSignal>();
  const provider = { connect: vi.fn((id: string, _url: string, signal: AbortSignal) => {
    signals.set(id, signal);
    signal.throwIfAborted();
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
    });
  }) };
  const scheduler = new Scheduler(store, () => provider, () => {}, () => {}, () => {});
  return { path, store, scheduler, provider, signals };
}
it('starts distinct profiles concurrently and cancels one independently', async () => {
  const { store, scheduler, provider, signals } = await setup();
  try {
    const saleAt = Date.now() + 60_000;
    await scheduler.addMany(['profile_a', 'profile_b'].map((profileId) => task({ profileId, saleAt })));
    await vi.waitFor(() => expect(provider.connect).toHaveBeenCalledTimes(2));
    await scheduler.cancel(store.tasks().find((task) => task.profileId === 'profile_a')!.id);
    expect(signals.get('profile_a')!.aborted).toBe(true);
    expect(signals.get('profile_b')!.aborted).toBe(false);
    expect(store.tasks().find((task) => task.profileId === 'profile_a')!.status).toBe('cancelled');
  } finally { await scheduler.stop(); }
});
it('rejects the whole batch on a conflict or duplicate profile and persists valid batches', async () => {
  const { store, scheduler, path } = await setup();
  const saleAt = Date.now() + 86_400_000;
  await scheduler.add(task({ profileId: 'busy', saleAt }));
  await expect(scheduler.addMany(['free', 'busy'].map((profileId) => task({ profileId, saleAt })))).rejects.toThrow();
  expect(store.tasks()).toHaveLength(1);
  await expect(scheduler.addMany([task({ saleAt }), task({ saleAt })])).rejects.toThrow();
  expect(store.tasks()).toHaveLength(1);
  await scheduler.addMany(['a', 'b'].map((profileId) => task({ profileId, saleAt })));
  const reopened = new Store(path);
  await reopened.load();
  expect(reopened.tasks().map((task) => task.profileId)).toEqual(['busy', 'a', 'b']);
  await scheduler.stop();
});

it('starts another coin in the same profile before the first coin finishes', async () => {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'nbu-sequence-')), 'tasks.json'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const active = new Map<string, number>();
  const calls: string[] = [];
  const provider = { connect: vi.fn(async (profileId: string, url: string) => {
    active.set(profileId, (active.get(profileId) ?? 0) + 1); calls.push(`${profileId}:${url.split('/').pop()}`);
    const state = { login: 'logged-in' as const, challenge: false, rateLimited: false, turnstile: false, purchasePending: false,
      buyAvailable: false, inCart: true, queuePosition: '' };
    return {
      read: async () => { if (profileId === 'a' && url.endsWith('one.html')) await gate; return state; },
      waitForActionable: async () => state, serverOffset: async () => 0, reload: async () => {},
      clickBuy: async () => { throw Error('Already in cart; no click expected'); },
      disconnect: async () => { active.set(profileId, 0); },
    };
  }) };
  const scheduler = new Scheduler(store, () => provider, () => {}, () => {}, () => {});
  try {
    const saleAt = Date.now() + 60_000;
    await scheduler.addMany(['a', 'b'].flatMap((profileId) => ['one', 'two'].map((coin) =>
      task({ profileId, saleAt, url: `https://coins.bank.gov.ua/${coin}.html` }))));
    await vi.waitFor(() => expect(calls).toContain('b:two.html'));
    expect(calls).toContain('a:two.html');
    expect(store.tasks().find((t) => t.profileId === 'a' && t.url.endsWith('one.html'))?.status).toBe('preparing');
    release();
    await vi.waitFor(() => expect(store.tasks().every((task) => task.status === 'in_cart')).toBe(true));
    expect(calls.filter((call) => call.startsWith('a:')).sort()).toEqual(['a:one.html', 'a:two.html']);
  } finally { release(); await scheduler.stop(); }
});

it('keeps each coin failure independent and preserves the batch on disk', async () => {
  const { scheduler, store, provider, path } = await setup();
  provider.connect.mockRejectedValue(Error('Browser disconnected'));
  try {
    await scheduler.addMany(['one', 'two'].map((coin) => task({ saleAt: Date.now() + 60_000,
      url: `https://coins.bank.gov.ua/${coin}.html` })));
    await vi.waitFor(() => expect(store.tasks().map((task) => task.status)).toEqual(['failed', 'failed']));
    expect(provider.connect).toHaveBeenCalledTimes(2);
    const reopened = new Store(path); await reopened.load();
    expect(reopened.tasks()[0]?.batchId).toBe(reopened.tasks()[1]?.batchId);
    expect(reopened.tasks().map((task) => task.batchIndex)).toEqual([0, 1]);
  } finally { await scheduler.stop(); }
});

it('does not replay an interrupted purchase but starts another scheduled coin after restart', async () => {
  const { scheduler, store, provider, path } = await setup();
  const batchId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  await store.saveTask(task({ status: 'firing', clicks: 1, batchId, batchIndex: 0 }));
  await store.saveTask(task({ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', batchId, batchIndex: 1,
    saleAt: Date.now() + 60_000, url: 'https://coins.bank.gov.ua/two.html' }));
  await store.load();
  try {
    scheduler.start();
    await vi.waitFor(() => expect(provider.connect).toHaveBeenCalledTimes(1));
    expect(store.tasks()[0]?.status).toBe('interrupted');
    expect(provider.connect.mock.calls[0]?.[1]).toContain('two.html');
  } finally { await scheduler.stop(); }
});

it('prepares all batch URLs before the first coin and reuses one pool through completion', async () => {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'nbu-prepared-')), 'tasks.json'));
  const { ready } = await import('./helpers');
  const order: string[] = [];
  const disconnect = vi.fn(async () => {});
  const pool = { disconnect, connect: vi.fn(async (_id: string, url: string) => {
    order.push(url);
    return { read: async () => ({ ...ready, inCart: true }), waitForActionable: async () => ready,
      reload: async () => {}, serverOffset: async () => 0, clickBuy: async () => {}, disconnect: async () => {} };
  }) };
  const provider = { connect: vi.fn(), prepare: vi.fn(async (_id: string, urls: string[]) => {
    expect(urls).toEqual(['https://coins.bank.gov.ua/one.html', 'https://coins.bank.gov.ua/two.html']);
    expect(order).toEqual([]); order.push('prepared'); return pool;
  }) };
  const scheduler = new Scheduler(store, () => provider, () => {}, () => {}, () => {});
  try {
    await scheduler.addMany(['one', 'two'].map((coin) => task({ saleAt: Date.now() + 60_000,
      url: `https://coins.bank.gov.ua/${coin}.html` })));
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(store.tasks().map((task) => task.status)).toEqual(['in_cart', 'in_cart']);
    // Coins no longer share a disk queue, so their hand-off order is free; both follow the preparation.
    expect(order[0]).toBe('prepared');
    expect(order.slice(1).sort()).toEqual(['https://coins.bank.gov.ua/one.html', 'https://coins.bank.gov.ua/two.html']);
    expect(provider.prepare).toHaveBeenCalledTimes(1); expect(provider.connect).not.toHaveBeenCalled();
  } finally { await scheduler.stop(); }
});

it('shares pending preparation and cancelling one coin keeps the other connected', async () => {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'nbu-parallel-')), 'tasks.json'));
  const { ready } = await import('./helpers');
  let release!: () => void;
  let preparationSignal!: AbortSignal;
  let preparationOptions: PreparationOptions | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const disconnect = vi.fn(async () => {});
  const pool = { disconnect, connect: vi.fn(async () => ({
    read: async () => ({ ...ready, inCart: true }), waitForActionable: async () => ready,
    reload: async () => {}, serverOffset: async () => 0, clickBuy: async () => {}, disconnect: async () => {},
  })) };
  const provider = { connect: vi.fn(), prepare: vi.fn(async (_profile: string, _urls: string[], signal: AbortSignal, options?: PreparationOptions) => {
    preparationOptions = options;
    preparationSignal = signal; await gate; return pool;
  }) };
  const scheduler = new Scheduler(store, () => provider, () => {}, () => {}, () => {});
  try {
    await scheduler.addMany(['one', 'two'].map((coin) => task({ saleAt: Date.now() + 60_000,
      url: `https://coins.bank.gov.ua/${coin}.html` })));
    await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalledTimes(1));
    await preparationOptions?.onRateLimit?.();
    expect(store.tasks().every(item => item.events.some(event => event.message.includes('429')))).toBe(true);
    await scheduler.cancel(store.tasks()[0]!.id);
    expect(preparationSignal.aborted).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(store.tasks().map(t => t.status)).toEqual(['cancelled', 'in_cart']));
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(pool.connect).toHaveBeenCalledTimes(1);
  } finally { release(); await scheduler.stop(); }
});

it('aborts shared preparation when the last waiting coin is cancelled', async () => {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'nbu-cancel-pool-')), 'tasks.json'));
  let preparationSignal!: AbortSignal;
  const provider = { connect: vi.fn(), prepare: vi.fn((_id: string, _urls: string[], signal: AbortSignal) => {
    preparationSignal = signal;
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('cancelled preparation')), { once: true });
    });
  }) };
  const scheduler = new Scheduler(store, () => provider, () => {}, () => {}, () => {});
  try {
    await scheduler.addMany(['one', 'two'].map((coin) => task({ saleAt: Date.now() + 60_000,
      url: `https://coins.bank.gov.ua/${coin}.html` })));
    await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalledTimes(1));
    await scheduler.cancel(store.tasks()[0]!.id);
    expect(preparationSignal.aborted).toBe(false);
    await scheduler.cancel(store.tasks()[1]!.id);
    expect(preparationSignal.aborted).toBe(true);
    expect(store.tasks().map(t => t.status)).toEqual(['cancelled', 'cancelled']);
  } finally { await scheduler.stop(); }
});

it('reserves cabinet reads and refuses them near a sale or during active purchase work', async () => {
  const { store, scheduler } = await setup();
  const read = vi.fn(async () => 'cabinet');
  await store.saveTask(task({ saleAt: Date.now() + 60_000 }));
  await expect(scheduler.readProfile('abc123', read)).rejects.toThrow('зайнятий');
  expect(read).not.toHaveBeenCalled();
  await store.saveTask(task({ saleAt: Date.now() + 86_400_000 }));
  await expect(scheduler.readProfile('abc123', read)).resolves.toBe('cabinet');
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = scheduler.readProfile('abc123', signal => new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); started();
  }));
  const result = expect(pending).rejects.toThrow('cancelled');
  await ready;
  await expect(scheduler.readProfile('abc123', read)).rejects.toThrow('зайнятий');
  expect(scheduler.hasRunningWork()).toBe(true);
  await scheduler.stop(); await result;
  expect(scheduler.hasRunningWork()).toBe(false);
});

it('interrupts a long profile test when a previously scheduled purchase reaches preparation time', async () => {
  vi.useFakeTimers();
  const { scheduler, provider } = await setup();
  try {
    const start = Date.now();
    await scheduler.add(task({ profileId: 'a', saleAt: start + 300_000, leadMin: 1 }));
    scheduler.start();
    let testSignal!: AbortSignal;
    const test = scheduler.readProfile('a', signal => new Promise<string>(resolve => {
      testSignal = signal;
      signal.addEventListener('abort', () => resolve('stopped'), { once: true });
    }), 600_000);
    await Promise.resolve();
    vi.setSystemTime(start + 180_000); await vi.advanceTimersByTimeAsync(500);
    expect(testSignal.aborted).toBe(false);
    expect(provider.connect).not.toHaveBeenCalled();
    vi.setSystemTime(start + 240_000); await vi.advanceTimersByTimeAsync(1000);
    expect(await test).toBe('stopped');
    await vi.waitFor(() => expect(provider.connect).toHaveBeenCalledOnce());
  } finally { await scheduler.stop(); vi.useRealTimers(); }
});

it('bounds a profile check with a timeout and releases the profile afterwards', async () => {
  const { scheduler, store, signals } = await setup();
  try {
    await expect(scheduler.inspect('slow', 'https://coins.bank.gov.ua/p-1.html', 50)).rejects.toThrow('не завершилася');
    expect(signals.get('slow')!.aborted).toBe(true);
    await scheduler.add(task({ profileId: 'slow', saleAt: Date.now() + 86_400_000 }));
    expect(store.tasks()).toHaveLength(1);
  } finally { await scheduler.stop(); }
});
it('aborts a running profile check when the scheduler stops', async () => {
  const { scheduler, signals } = await setup();
  const check = scheduler.inspect('p', 'https://coins.bank.gov.ua/p-1.html');
  const outcome = expect(check).rejects.toThrow('зупинено');
  await vi.waitFor(() => expect(signals.get('p')).toBeDefined());
  await scheduler.stop();
  await outcome;
  expect(signals.get('p')!.aborted).toBe(true);
});

it('ends only the broken task on a non-disk failure and keeps scheduling others', async () => {
  const { store, scheduler, provider } = await setup();
  const onError = vi.fn();
  const guarded = new Scheduler(store, () => provider, () => {}, () => {}, onError);
  await scheduler.stop();
  const saveTask = store.saveTask.bind(store);
  vi.spyOn(store, 'saveTask').mockImplementation(async (next) => {
    if (next.profileId === 'broken' && next.note !== UNEXPECTED_TASK_NOTE) throw new z.ZodError([]);
    return saveTask(next);
  });
  try {
    const saleAt = Date.now() + 60_000;
    await guarded.addMany(['broken', 'healthy'].map((profileId) => task({ profileId, saleAt })));
    guarded.start();
    await vi.waitFor(() => expect(store.tasks().find((item) => item.profileId === 'broken')!.status).toBe('failed'));
    expect(store.tasks().find((item) => item.profileId === 'broken')!.note).toBe(UNEXPECTED_TASK_NOTE);
    await vi.waitFor(() => expect(provider.connect).toHaveBeenCalledWith('healthy', expect.anything(), expect.anything(), expect.anything()));
    expect(onError).not.toHaveBeenCalled();
    await guarded.add(task({ profileId: 'later', saleAt: Date.now() + 86_400_000 }));
  } finally { await guarded.stop(); }
});
it('still stops everything when the task journal cannot be written to disk', async () => {
  const { store, provider } = await setup();
  const onError = vi.fn();
  const scheduler = new Scheduler(store, () => provider, () => {}, () => {}, onError);
  const saveTask = store.saveTask.bind(store);
  vi.spyOn(store, 'saveTask').mockImplementation(async (next) => {
    if (next.status !== 'scheduled') throw Object.assign(Error('disk full'), { code: 'ENOSPC' });
    return saveTask(next);
  });
  try {
    await scheduler.add(task({ saleAt: Date.now() + 60_000 }));
    scheduler.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('Планувальник зупинено')));
  } finally { await scheduler.stop(); }
});

it('reconnects a batch whose browser connection dropped before the click, and prepares it afresh', async () => {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'nbu-reconnect-')), 'tasks.json'));
  const { ready } = await import('./helpers');
  let pools = 0;
  const provider = { connect: vi.fn(), prepare: vi.fn(async () => {
    const first = ++pools === 1;
    return {
      alive: () => !first, disconnect: vi.fn(async () => {}),
      connect: vi.fn(async () => ({
        read: async () => { if (first) throw new Error('Target page, context or browser has been closed'); return { ...ready, inCart: true }; },
        waitForActionable: async () => ready, reload: async () => {}, serverOffset: async () => 0,
        clickBuy: async () => {}, disconnect: async () => {},
      })),
    };
  }) };
  const scheduler = new Scheduler(store, () => provider, () => {}, () => {}, () => {});
  try {
    await scheduler.addMany([task({ saleAt: Date.now() + 60_000 })]);
    await vi.waitFor(() => expect(store.tasks()[0]!.status).toBe('in_cart'));
    expect(provider.prepare).toHaveBeenCalledTimes(2);
    expect(store.tasks()[0]!.events.some((event) => event.message.startsWith('Зв’язок із браузером втрачено до кліку'))).toBe(true);
  } finally { await scheduler.stop(); }
});

it('gives up reconnecting after three attempts', async () => {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'nbu-reconnect-limit-')), 'tasks.json'));
  const { ready } = await import('./helpers');
  const provider = { connect: vi.fn(), prepare: vi.fn(async () => ({
    alive: () => false, disconnect: vi.fn(async () => {}),
    connect: vi.fn(async () => ({
      read: async () => { throw new Error('Target page, context or browser has been closed'); },
      waitForActionable: async () => ready, reload: async () => {}, serverOffset: async () => 0,
      clickBuy: async () => {}, disconnect: async () => {},
    })),
  })) };
  const scheduler = new Scheduler(store, () => provider, () => {}, () => {}, () => {});
  try {
    await scheduler.addMany([task({ saleAt: Date.now() + 60_000 })]);
    await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(store.tasks()[0]!.status).toBe('failed'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(provider.prepare).toHaveBeenCalledTimes(4);
  } finally { await scheduler.stop(); }
});
