import { expect, it } from 'vitest';
import { CabinetRefreshSchedule, CABINET_AUTO_REFRESH_MS as interval } from '../src/core/cabinet-refresh';
import { persistCabinet, restoreCabinet, defaultCabinetView, type CabinetSavedState } from '../src/core/cabinet-state';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function state(now: number): CabinetSavedState {
  const schedule = new CabinetRefreshSchedule();
  schedule.completed('a', now, false); schedule.completed('b', now, true); schedule.finishRound(now);
  return { details: {}, view: { ...defaultCabinetView }, snapshots: { a: { profileId: 'a', fetchedAt: now, orders: [{ id: '900', detailId: '123', date: '27.08.2026',
    status: 'Оплачено', total: 500, quantity: 2, tracking: '' }], cart: [], wishlist: [], errors: {}, nextOrdersPage: 2 } },
    errors: { b: 'НБУ обмежив запити (429).' }, attemptedAt: { a: now, b: now }, schedule: schedule.snapshot() };
}
it('restores lists and retry deadlines across restarts without refreshing fresh data', () => {
  const disk = storage(), before = state(100_000);
  expect(persistCabinet(disk, 'local-api', ['a', 'b'], before)).toBe(true);
  const restored = restoreCabinet(disk, 'local-api', ['a', 'b']);
  expect(restored).toEqual(before);
  const schedule = new CabinetRefreshSchedule(restored.schedule);
  expect(schedule.due(['a', 'b'], 101_000)).toEqual([]);
  expect(schedule.due(['a', 'b'], 100_000 + interval)).toEqual(['a']);
  expect(schedule.due(['b'], 100_000 + 2 * interval)).toEqual(['b']);
});
it('isolates connections and removes deleted profiles from disk', () => {
  const disk = storage();
  persistCabinet(disk, 'one', ['a', 'b'], state(100_000));
  expect(restoreCabinet(disk, 'two', ['a']).snapshots).toEqual({});
  expect(restoreCabinet(disk, 'one', ['b']).snapshots).toEqual({});
  persistCabinet(disk, 'one', ['b'], state(100_000));
  expect(restoreCabinet(disk, 'one', ['a', 'b']).snapshots).toEqual({});
});
it('can show old data immediately even when its refresh is overdue', () => {
  const disk = storage(); persistCabinet(disk, 'one', ['a'], state(100_000));
  const restored = restoreCabinet(disk, 'one', ['a']);
  expect(restored.snapshots.a?.orders).toHaveLength(1);
  expect(new CabinetRefreshSchedule(restored.schedule).due(['a'], 100_000 + interval)).toEqual(['a']);
});
it('recovers from corrupt cache and reports failed writes without losing the previous cache', () => {
  expect(restoreCabinet({ getItem: () => '{broken' }, 'one', ['a']).snapshots).toEqual({});
  expect(persistCabinet({ setItem: () => { throw Error('quota'); } }, 'one', ['a'], state(100_000))).toBe(false);
});
