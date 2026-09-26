import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/main/store';
import { tasksOverlap } from '../src/main/scheduler';
import { task } from './helpers';

async function storePath() { return join(await mkdtemp(join(tmpdir(), 'nbu-store-test-')), 'tasks.json'); }

describe('persistent scheduler state', () => {
  it('keeps future schedules but marks previously running tasks interrupted', async () => {
    const path = await storePath();
    const store = new Store(path);
    await store.saveTask(task({ status: 'firing', clicks: 1 }));
    await store.saveTask(task({ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', status: 'scheduled' }));
    const reopened = new Store(path);
    await reopened.load();
    expect(reopened.tasks().map((item) => item.status)).toEqual(['interrupted', 'scheduled']);
    expect(reopened.tasks()[0]?.clicks).toBe(1);
  });

  it('serializes concurrent writes so the latest state is retained', async () => {
    const path = await storePath();
    const store = new Store(path);
    await Promise.all([store.saveTask(task()), store.saveTask(task({ clicks: 1, status: 'firing' }))]);
    const data = JSON.parse(await readFile(path, 'utf8'));
    expect(data.tasks[0].clicks).toBe(1);
  });

  it('preserves a malformed file instead of silently replacing tasks', async () => {
    const path = await storePath();
    await writeFile(path, '{broken');
    await expect(new Store(path).load()).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });

  it('reserves preparation and post-click observation time for the profile', () => {
    expect(tasksOverlap(task(), task({ saleAt: 1_100_000 }))).toBe(true);
    expect(tasksOverlap(task(), task({ saleAt: 3_000_000 }))).toBe(false);
    expect(tasksOverlap(task(), task({ profileId: 'different' }))).toBe(false);
  });
});

it('migrates old settings and retains a batch during concurrent task updates', async () => {
  const path = await storePath();
  await writeFile(path, JSON.stringify({ version: 1, settings: { apiUrl: 'http://localhost:50325' }, tasks: [] }));
  const store = new Store(path); await store.load();
  expect(store.settings()).toMatchObject({ defaultProfileIds: [], leadMin: 5, retrySec: 1 });
  await store.saveTask(task());
  await Promise.all([
    store.addTasks([task({ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', profileId: 'other' })]),
    store.saveTask(task({ clicks: 1, status: 'firing' })),
  ]);
  const reopened = new Store(path); await reopened.load();
  expect(reopened.tasks()).toHaveLength(2);
  expect(reopened.tasks().find((item) => item.profileId === 'abc123')?.clicks).toBe(1);
});

it('migrates remembered IDs once and persists an explicitly emptied profile list', async () => {
  const path = await storePath();
  await writeFile(path, JSON.stringify({ version: 1, settings: { apiUrl: 'http://localhost:50325', defaultProfileIds: ['p7', 'p8'] }, tasks: [] }));
  const store = new Store(path); await store.load();
  expect(store.settings().savedProfiles).toEqual([{ id: 'p7', name: '' }, { id: 'p8', name: '' }]);
  await store.saveSettings({ ...store.settings(), savedProfiles: [{ id: 'p7', name: 'Основний' }] });
  const reopened = new Store(path); await reopened.load();
  expect(reopened.settings().savedProfiles).toEqual([{ id: 'p7', name: 'Основний' }]);
  await reopened.saveSettings({ ...reopened.settings(), savedProfiles: [] });
  const empty = new Store(path); await empty.load();
  expect(empty.settings().savedProfiles).toEqual([]);
});

it('rejects duplicate profile IDs without changing previously saved settings', async () => {
  const store = new Store(await storePath());
  await store.saveSettings({ ...store.settings(), savedProfiles: [{ id: 'p7', name: 'Основний' }] });
  await expect(store.saveSettings({ ...store.settings(), savedProfiles: [{ id: 'p7', name: 'A' }, { id: ' p7 ', name: 'B' }] })).rejects.toThrow();
  expect(store.settings().savedProfiles).toEqual([{ id: 'p7', name: 'Основний' }]);
});

it('migrates the old five-second interval once for settings and scheduled tasks only', async () => {
  const path = await storePath();
  await writeFile(path, JSON.stringify({ version: 1, settings: { apiUrl: 'http://localhost:50325', retrySec: 5 },
    tasks: [task(), task({ id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', status: 'in_cart', updatedAt: Date.now() }),
      task({ id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', retrySec: 7 })] }));
  const store = new Store(path); await store.load();
  expect(store.settings().retrySec).toBe(1);
  expect(store.tasks().map(item => item.retrySec)).toEqual([1, 5, 7]);
  expect(store.tasks()[0]?.events.at(-1)?.message).toContain('з 5 до 1 с');
  // An explicit choice of five seconds after migration must survive future restarts.
  await store.saveSettings({ ...store.settings(), retrySec: 5 });
  await store.saveTask({ ...store.tasks()[0]!, retrySec: 5 });
  const reopened = new Store(path); await reopened.load();
  expect(reopened.settings().retrySec).toBe(5);
  expect(reopened.tasks()[0]?.retrySec).toBe(5);
});

it('preserves a custom interval during migration', async () => {
  const path = await storePath();
  await writeFile(path, JSON.stringify({ version: 1, settings: { apiUrl: 'http://localhost:50325', retrySec: 7 }, tasks: [] }));
  const store = new Store(path); await store.load();
  expect(store.settings().retrySec).toBe(7);
});
