import { expect, it } from 'vitest';
import { appendCabinetOrders, mergeCabinetSnapshot } from '../src/core/cabinet-pages';
import type { CabinetOrder, CabinetSnapshot } from '../src/core/cabinet';
const order = (id: string, status = 'Оплачено'): CabinetOrder => ({ id, status, date: '', tracking: '', quantity: 1, total: 100 });
const first = (): CabinetSnapshot => ({ profileId: 'a', fetchedAt: 100, orders: [order('1')], nextOrdersPage: 2,
  cart: [{ id: '1', name: 'Монета', price: 100, total: 100, quantity: 1 }], wishlist: [], errors: {} });
it('keeps loaded older pages and their cursor when auto-refresh replaces page one', () => {
  const loaded = appendCabinetOrders(first(), { profileId: 'a', page: 2, orders: [order('2')], nextPage: 3, fetchedAt: 200 });
  const fresh = mergeCabinetSnapshot(loaded, { ...first(), fetchedAt: 300, orders: [order('1', 'Отримано')] });
  expect(fresh.orders?.map(o => [o.id, o.status])).toEqual([['1', 'Отримано'], ['2', 'Оплачено']]);
  expect(fresh.nextOrdersPage).toBe(3);
  expect(mergeCabinetSnapshot(loaded, { ...first(), nextOrdersPage: undefined }).orders).toHaveLength(1);
});
it('deduplicates overlapping server pages and retains data when a section fails', () => {
  const loaded = appendCabinetOrders(first(), { profileId: 'a', page: 2, orders: [order('1'), order('2')], fetchedAt: 200 });
  const refreshed = mergeCabinetSnapshot(loaded, { ...first(), cart: undefined, errors: { cart: '429' } });
  expect(refreshed.orders).toHaveLength(2); expect(refreshed.nextOrdersPage).toBeUndefined();
  expect(refreshed.cart).toEqual(first().cart); expect(refreshed.errors.cart).toBe('429');
});
