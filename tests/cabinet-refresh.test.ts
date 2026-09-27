import { expect, it } from 'vitest';
import { mergeCabinetSnapshot } from '../src/core/cabinet-pages';
import { autoRefreshTargets, CabinetRefreshSchedule, CABINET_AUTO_REFRESH_MS as interval } from '../src/core/cabinet-refresh';

const even = () => 0.5;
it('refreshes once on entry, then each profile after its own interval', () => {
  const schedule = new CabinetRefreshSchedule(undefined, even);
  expect(schedule.due(['a', 'b'], 0)).toEqual(['a', 'b']);
  schedule.completed('a', 10_000, false);
  schedule.completed('b', 20_000, false);
  schedule.finishRound(20_000);
  expect(schedule.due(['a', 'b'], interval + 9_999)).toEqual([]);
  expect(schedule.nextAt(['a', 'b'])).toBe(interval + 10_000);
  expect(schedule.due(['a', 'b'], interval + 10_000)).toEqual(['a']);
  expect(schedule.due(['b', 'a'], interval + 20_000)).toEqual(['a', 'b']);
});
it('separates background refreshes of different profiles by a random 30–90 s gap', () => {
  for (const [roll, gap] of [[0, 30_000], [0.5, 60_000], [1, 90_000]] as const) {
    const schedule = new CabinetRefreshSchedule(undefined, () => roll);
    schedule.completed('a', 0, false); schedule.finishRound(0);
    expect(schedule.due(['b'], gap - 1)).toEqual([]);
    expect(schedule.due(['b'], gap)).toEqual(['b']);
  }
});
it('drifts each profile interval by at most 10%', () => {
  const low = new CabinetRefreshSchedule(undefined, () => 0), high = new CabinetRefreshSchedule(undefined, () => 1);
  low.completed('a', 0, false); high.completed('a', 0, false);
  expect(low.nextAt(['a'])).toBe(13.5 * 60_000);
  expect(high.nextAt(['a'])).toBe(16.5 * 60_000);
});
it('backs off failures per profile for 30, then at most 60 minutes and resets after success', () => {
  const schedule = new CabinetRefreshSchedule(undefined, even);
  let now = 0;
  for (const delay of [2 * interval, 4 * interval, 4 * interval, 4 * interval]) {
    schedule.completed('a', now, true);
    schedule.completed('b', now, false);
    schedule.finishRound(now);
    expect(schedule.due(['a', 'b'], now + interval)).toEqual(['b']);
    expect(schedule.due(['a'], now + delay - 1)).toEqual([]);
    expect(schedule.due(['a'], now + delay)).toEqual(['a']);
    now += delay;
  }
  schedule.completed('a', now, false);
  expect(schedule.nextAt(['a'])).toBe(now + interval);
});
it('does not accumulate missed rounds or poll without profiles', () => {
  const schedule = new CabinetRefreshSchedule();
  expect(schedule.due([], 0)).toEqual([]);
  expect(schedule.nextAt([])).toBeUndefined();
  const wake = 24 * 60 * 60_000;
  expect(schedule.due(['a'], wake)).toEqual(['a']);
  schedule.completed('a', wake, false); schedule.finishRound(wake);
  expect(schedule.due(['a'], wake + 1)).toEqual([]);
});
it('refreshes in the background every 15 minutes', () => { expect(interval).toBe(15 * 60_000); });
it('keeps the full-refresh time when only the cart was refreshed', () => {
  const full = { profileId: 'a', fetchedAt: 1000, orders: [], wishlist: [], cart: [], errors: {} };
  const merged = mergeCabinetSnapshot(full, { profileId: 'a', fetchedAt: 9000, cart: [], errors: {} });
  expect(merged.fetchedAt).toBe(1000);
  expect(merged.orders).toEqual([]); expect(merged.wishlist).toEqual([]);
});
it('loads every profile without data at once, then refreshes one profile at a time', () => {
  const loaded = new Set(['b']);
  expect(autoRefreshTargets(['a', 'b', 'c'], id => loaded.has(id))).toEqual(['a', 'c']);
  expect(autoRefreshTargets(['c', 'a', 'b'], () => true)).toEqual(['c']);
  expect(autoRefreshTargets([], () => false)).toEqual([]);
});
