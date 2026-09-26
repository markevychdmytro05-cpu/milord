import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CabinetStore } from '../src/main/cabinet-store';
import { emptyCabinetState } from '../src/core/cabinet-state';

const directories: string[] = [];
async function path() { const dir = await mkdtemp(join(tmpdir(), 'cabinet-store-')); directories.push(dir); return join(dir, 'cabinet-cache.json'); }
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const saved = () => ({ ...emptyCabinetState(), snapshots: { a: { profileId: 'a', fetchedAt: 100, errors: {}, cart: [], orders: [] } },
  view: { section: 'orders' as const, profile: 'a', query: '', page: 2 },
  details: { 'a:100': { id: '100', delivery: 'Пошта', deliveryCost: '', address: 'Тестова адреса', payment: 'Оплачено', total: 100, products: [], history: [] } } });
it('restores lists, details and the current page using only the application file after restart', async () => {
  const file = await path(); const store = new CabinetStore(file);
  await store.save('api', ['a'], saved());
  expect(await new CabinetStore(file).load('api', ['a'])).toEqual(saved());
  expect(JSON.parse(await readFile(file, 'utf8')).details['a:100'].address).toBe('Тестова адреса');
});
it('migrates the old browser cache once and prefers the file afterward', async () => {
  const file = await path(), store = new CabinetStore(file);
  const legacy = JSON.stringify({ version: 1, connection: 'api', ...saved(), details: undefined, view: undefined });
  expect((await store.load('api', ['a'], legacy)).snapshots.a?.orders).toEqual([]);
  await store.save('api', ['a'], saved());
  expect(await new CabinetStore(file).load('api', ['a'], legacy)).toEqual(saved());
});
it('serializes pending writes before a reload and excludes deleted profiles', async () => {
  const file = await path(), store = new CabinetStore(file);
  const first = store.save('api', ['a'], saved());
  const last = store.save('api', [], saved());
  const reloaded = await store.load('api', ['a']);
  await Promise.all([first, last]);
  expect(reloaded.snapshots).toEqual({}); expect(reloaded.details).toEqual({});
});
it('does not silently replace an unreadable cache with empty data', async () => {
  const file = await path(); await writeFile(file, '{broken');
  await expect(new CabinetStore(file).load('api', ['a'])).rejects.toThrow('Файл залишено без змін');
  expect(await readFile(file, 'utf8')).toBe('{broken');
});
