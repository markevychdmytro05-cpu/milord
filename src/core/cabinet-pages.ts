import type { CabinetOrder, CabinetOrdersPage, CabinetSnapshot } from './cabinet';

function flatten(pages: Record<string, CabinetOrder[]>): CabinetOrder[] {
  const orders = new Map<string, CabinetOrder>();
  for (const page of Object.keys(pages).map(Number).sort((a, b) => a - b)) {
    for (const order of pages[page] ?? []) if (!orders.has(order.id)) orders.set(order.id, order);
  }
  return [...orders.values()];
}
export function mergeCabinetSnapshot(previous: CabinetSnapshot | undefined, fresh: CabinetSnapshot): CabinetSnapshot {
  // A failed section must retain its last successful data. Reading page one must
  // also preserve already loaded history pages while the server still has more.
  const orderPages = fresh.orders ? { ...(fresh.nextOrdersPage ? previous?.orderPages : {}), 1: fresh.orders } : previous?.orderPages;
  const hasOlderPages = orderPages && Object.keys(orderPages).some(page => Number(page) > 1);
  return { ...previous, ...fresh,
    // A cart-only background refresh must not make older orders look freshly loaded.
    fetchedAt: fresh.orders !== undefined || !previous ? fresh.fetchedAt : previous.fetchedAt,
    wishlist: fresh.wishlist ?? previous?.wishlist, cart: fresh.cart ?? previous?.cart,
    orders: orderPages ? flatten(orderPages) : fresh.orders ?? previous?.orders,
    orderPages, nextOrdersPage: hasOlderPages ? previous?.nextOrdersPage : fresh.nextOrdersPage };
}
export function appendCabinetOrders(previous: CabinetSnapshot, page: CabinetOrdersPage): CabinetSnapshot {
  const orderPages = { ...(previous.orderPages ?? { 1: previous.orders ?? [] }), [page.page]: page.orders };
  return { ...previous, orderPages, orders: flatten(orderPages), nextOrdersPage: page.nextPage };
}
