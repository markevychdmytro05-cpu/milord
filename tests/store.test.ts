import { mkdtemp, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HISTORY_MAX_AGE_MS, Store } from '../src/main/store';
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
    const data = JSON.parse(await readFile(join(dirname(path), 'tasks', `${task().id}.json`), 'utf8'));
    expect(data.clicks).toBe(1);
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

describe('one file per task', () => {
  const other = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const taskFile = (path: string, id: string) => join(dirname(path), 'tasks', `${id}.json`);

  it('migrates the single-file layout into per-task files', async () => {
    const path = await storePath();
    await writeFile(path, JSON.stringify({ version: 1, retryIntervalVersion: 1, settings: { apiUrl: 'http://localhost:50325' },
      tasks: [task(), task({ id: other, profileId: 'other' })] }));
    const store = new Store(path); await store.load();
    const index = JSON.parse(await readFile(path, 'utf8'));
    expect(index).toMatchObject({ version: 2, taskIds: [task().id, other] });
    expect(index.tasks).toBeUndefined();
    expect(JSON.parse(await readFile(taskFile(path, other), 'utf8')).profileId).toBe('other');
    const reopened = new Store(path); await reopened.load();
    expect(reopened.tasks().map((item) => item.id)).toEqual([task().id, other]);
  });

  it('rewrites only the saved task, leaving the index and other tasks untouched', async () => {
    const path = await storePath();
    const store = new Store(path);
    await store.addTasks([task(), task({ id: other, profileId: 'other' })]);
    const [indexBefore, otherBefore] = await Promise.all([stat(path), stat(taskFile(path, other))]);
    await store.saveTask(task({ status: 'firing', clicks: 1 }));
    const [indexAfter, otherAfter] = await Promise.all([stat(path), stat(taskFile(path, other))]);
    expect(indexAfter.mtimeMs).toBe(indexBefore.mtimeMs);
    expect(otherAfter.mtimeMs).toBe(otherBefore.mtimeMs);
    expect(JSON.parse(await readFile(taskFile(path, task().id), 'utf8')).clicks).toBe(1);
  });

  it('ignores and removes a task file that no committed index lists', async () => {
    const path = await storePath();
    const store = new Store(path);
    await store.saveTask(task());
    await writeFile(taskFile(path, other), JSON.stringify(task({ id: other })));
    const reopened = new Store(path); await reopened.load();
    expect(reopened.tasks().map((item) => item.id)).toEqual([task().id]);
    expect(await readdir(join(dirname(path), 'tasks'))).toEqual([`${task().id}.json`]);
  });

  it('refuses to load when a listed task file is missing, keeping the index as is', async () => {
    const path = await storePath();
    const store = new Store(path);
    await store.addTasks([task(), task({ id: other })]);
    await unlink(taskFile(path, other));
    const index = await readFile(path, 'utf8');
    await expect(new Store(path).load()).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(index);
  });

  it('keeps a batch added while finished history is being pruned', async () => {
    const path = await storePath();
    const store = new Store(path);
    const old = Date.now() - HISTORY_MAX_AGE_MS - 60_000;
    await store.saveTask(task({ saleAt: old, updatedAt: old }));
    const fresh = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    await Promise.all([
      store.saveTask(task({ status: 'in_cart', saleAt: old, updatedAt: old })),
      store.addTasks([task({ id: fresh, profileId: 'fresh' })]),
    ]);
    const reopened = new Store(path); await reopened.load();
    expect(reopened.tasks().map((item) => item.id)).toEqual([fresh]);
  });
});
