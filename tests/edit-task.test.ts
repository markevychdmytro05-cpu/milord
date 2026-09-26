import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Scheduler } from '../src/main/scheduler';
import { Store } from '../src/main/store';
import { task } from './helpers';

const coin = (name: string) => `https://coins.bank.gov.ua/catalog/${name}.html?products_id=${name.length}`;
const DAY = 86_400_000;

async function setup() {
  const path = join(await mkdtemp(join(tmpdir(), 'nbu-edit-')), 'tasks.json');
  const store = new Store(path);
  const scheduler = new Scheduler(store, () => ({ connect: () => new Promise<never>(() => {}) }), () => {}, () => {}, () => {});
  const saleAt = Date.now() + 2 * DAY;
  // Two profiles x two coins, created together as one batch.
  await scheduler.addMany(['a', 'b'].flatMap((profileId) => ['one', 'three'].map((name) => task({ profileId, saleAt, url: coin(name) }))));
  return { path, store, scheduler, saleAt };
}
const of = (store: Store, profileId: string, name: string) => store.tasks().find((item) => item.profileId === profileId && item.url === coin(name))!;

it('changes only the coin of one task and keeps its start time and batch', async () => {
  const { store, scheduler, saleAt } = await setup();
  const before = of(store, 'a', 'one');
  await scheduler.update(before.id, { url: coin('two'), saleAt });
  const after = store.tasks().find((item) => item.id === before.id)!;
  expect(after.url).toBe(coin('two'));
  expect(after.saleAt).toBe(saleAt);
  expect(after.batchId).toBe(before.batchId);
  expect(after.events.at(-1)?.message).toBe('Змінено монету.');
  expect(store.tasks().filter((item) => item.id !== before.id).every((item) => item.saleAt === saleAt)).toBe(true);
});

it('moves the start time of every waiting task in the batch in one write', async () => {
  const { store, scheduler, saleAt, path } = await setup();
  const later = saleAt + 3_600_000;
  await scheduler.update(of(store, 'b', 'three').id, { url: coin('three'), saleAt: later });
  expect(store.tasks().map((item) => item.saleAt)).toEqual([later, later, later, later]);
  const reopened = new Store(path);
  await reopened.load();
  expect(reopened.tasks().map((item) => item.saleAt)).toEqual([later, later, later, later]);
});

it('does nothing and does not journal when nothing changed', async () => {
  const { store, scheduler, saleAt } = await setup();
  const item = of(store, 'a', 'one');
  await scheduler.update(item.id, { url: item.url, saleAt });
  expect(store.tasks().find((entry) => entry.id === item.id)!.events).toEqual(item.events);
});

it('rejects a past time, a bad link, a duplicate coin and an unknown task without changing anything', async () => {
  const { store, scheduler, saleAt } = await setup();
  const item = of(store, 'a', 'one');
  const snapshot = JSON.stringify(store.tasks());
  await expect(scheduler.update(item.id, { url: item.url, saleAt: Date.now() - 1000 })).rejects.toThrow('майбутньому');
  await expect(scheduler.update(item.id, { url: 'https://example.com/x', saleAt })).rejects.toThrow();
  await expect(scheduler.update(item.id, { url: 'https://coins.bank.gov.ua/x.html?products_id=1&action=add', saleAt })).rejects.toThrow();
  await expect(scheduler.update(item.id, { url: coin('three'), saleAt })).rejects.toThrow('вже є');
  await expect(scheduler.update('00000000-0000-4000-8000-000000000000', { url: item.url, saleAt })).rejects.toThrow('не знайдено');
  expect(JSON.stringify(store.tasks())).toBe(snapshot);
});

it('refuses to edit a task that has started, or whose batch is already preparing', async () => {
  const { store, scheduler, saleAt } = await setup();
  const running = of(store, 'a', 'one');
  await store.saveTask({ ...running, status: 'waiting' });
  await expect(scheduler.update(running.id, { url: coin('two'), saleAt })).rejects.toThrow('виконується');
  // A sibling that is waiting also freezes the rest of its batch.
  const sibling = of(store, 'b', 'three');
  await expect(scheduler.update(sibling.id, { url: sibling.url, saleAt: saleAt + 1000 })).rejects.toThrow('виконується');
  await store.saveTask({ ...running, status: 'scheduled' });
  (scheduler as unknown as { prepared: Map<string, unknown> }).prepared.set(JSON.stringify([running.batchId, 'a']), {});
  await expect(scheduler.update(sibling.id, { url: sibling.url, saleAt: saleAt + 1000 })).rejects.toThrow('виконується');
});

it('rejects a new time that collides with another batch on the same profile, and leaves the batch intact', async () => {
  const { store, scheduler, saleAt } = await setup();
  const otherTime = saleAt + DAY;
  await scheduler.add(task({ profileId: 'a', saleAt: otherTime, url: coin('elsewhere') }));
  const item = of(store, 'a', 'one');
  await expect(scheduler.update(item.id, { url: item.url, saleAt: otherTime })).rejects.toThrow('зайнятий');
  expect(store.tasks().filter((entry) => entry.url !== coin('elsewhere')).every((entry) => entry.saleAt === saleAt)).toBe(true);
});
