import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Scheduler } from '../src/main/scheduler';
import { Store } from '../src/main/store';
import { task } from './helpers';

async function setup() {
  const path = join(await mkdtemp(join(tmpdir(), 'nbu-scheduler-')), 'tasks.json');
  const store = new Store(path);
  const signals = new Map<string, AbortSignal>();
  const provider = { connect: vi.fn((id: string, _url: string, signal: AbortSignal) => {
    signals.set(id, signal);
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
    expect(calls.filter((call) => call.startsWith('a:'))).toEqual(['a:one.html', 'a:two.html']);
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
    expect(order).toEqual(['prepared', 'https://coins.bank.gov.ua/one.html', 'https://coins.bank.gov.ua/two.html']);
    expect(provider.prepare).toHaveBeenCalledTimes(1); expect(provider.connect).not.toHaveBeenCalled();
  } finally { await scheduler.stop(); }
});

it('shares pending preparation and cancelling one coin keeps the other connected', async () => {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'nbu-parallel-')), 'tasks.json'));
  const { ready } = await import('./helpers');
  let release!: () => void;
  let preparationSignal!: AbortSignal;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const disconnect = vi.fn(async () => {});
  const pool = { disconnect, connect: vi.fn(async () => ({
    read: async () => ({ ...ready, inCart: true }), waitForActionable: async () => ready,
    reload: async () => {}, serverOffset: async () => 0, clickBuy: async () => {}, disconnect: async () => {},
  })) };
  const provider = { connect: vi.fn(), prepare: vi.fn(async (_profile: string, _urls: string[], signal: AbortSignal) => {
    preparationSignal = signal; await gate; return pool;
  }) };
  const scheduler = new Scheduler(store, () => provider, () => {}, () => {}, () => {});
  try {
    await scheduler.addMany(['one', 'two'].map((coin) => task({ saleAt: Date.now() + 60_000,
      url: `https://coins.bank.gov.ua/${coin}.html` })));
    await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalledTimes(1));
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
