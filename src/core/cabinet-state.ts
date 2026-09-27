import { z } from 'zod';
import type { CabinetOrderDetails, CabinetSection, CabinetSnapshot } from './cabinet';
import type { CabinetRefreshState } from './cabinet-refresh';

const STORAGE_KEY = 'cabinet-data-v1';
const timestamp = z.number().finite().nonnegative();
const id = z.string().regex(/^\d{1,20}$/);
const text = z.string().max(4096);
const amount = z.number().finite().nullable();
const order = z.object({ id, detailId: id.optional(), mergedInto: id.optional(), date: text,
  status: text, total: amount, quantity: amount, tracking: text });
const product = z.object({ id: text, name: text, quantity: amount, price: amount, total: amount,
  url: text.optional(), imageUrl: text.optional(), reservedUntil: text.optional() });
const details = z.object({ id, delivery: text, deliveryCost: text, address: text, payment: text, total: amount,
  products: z.array(product), history: z.array(z.object({ at: text, status: text })) });
export const defaultCabinetView = { section: 'orders' as CabinetSection, profile: '', query: '', page: 1 };
const view = z.object({ section: z.enum(['orders', 'wishlist', 'cart']), profile: text, query: text, page: z.number().int().min(1) });
const snapshot = z.object({ profileId: text, fetchedAt: timestamp, orders: z.array(order).optional(),
  orderPages: z.record(z.string(), z.array(order)).optional(),
  cart: z.array(product).optional(), wishlist: z.array(product).optional(), nextOrdersPage: z.number().int().min(2).optional(),
  errors: z.object({ orders: text.optional(), cart: text.optional(), wishlist: text.optional() }) });
export const cabinetDocumentSchema = z.object({ version: z.literal(1), connection: text,
  details: z.record(z.string(), details).default({}), view: view.default(defaultCabinetView),
  snapshots: z.record(z.string(), snapshot), errors: z.record(z.string(), text),
  attemptedAt: z.record(z.string(), timestamp),
  schedule: z.object({ nextRoundAt: timestamp,
    profiles: z.record(z.string(), z.object({ nextAt: timestamp, failures: z.number().int().nonnegative() })) }),
});
export interface CabinetSavedState {
  details: Record<string, CabinetOrderDetails>;
  view: typeof defaultCabinetView;
  snapshots: Record<string, CabinetSnapshot>;
  errors: Record<string, string>;
  attemptedAt: Record<string, number>;
  schedule: CabinetRefreshState;
}
export const emptyCabinetState = (): CabinetSavedState => ({ details: {}, view: { ...defaultCabinetView }, snapshots: {}, errors: {}, attemptedAt: {}, schedule: { nextRoundAt: 0, profiles: {} } });
function selected<T>(values: Record<string, T>, ids: string[]): Record<string, T> {
  const allowed = new Set(ids);
  return Object.fromEntries(Object.entries(values).filter(([id]) => allowed.has(id)));
}
export function filterCabinetProfiles(state: CabinetSavedState, ids: string[]): CabinetSavedState {
  return { details: Object.fromEntries(Object.entries(state.details).filter(([key]) => ids.some(id => key.startsWith(`${id}:`)))),
    view: { ...state.view, profile: ids.includes(state.view.profile) ? state.view.profile : '' },
    snapshots: selected(state.snapshots, ids), errors: selected(state.errors, ids), attemptedAt: selected(state.attemptedAt, ids),
    schedule: { ...state.schedule, profiles: selected(state.schedule.profiles, ids) } };
}
// Legacy browser storage is read once when migrating to the application cache file.
export function restoreCabinet(storage: Pick<Storage, 'getItem'>, connection: string, ids: string[]): CabinetSavedState {
  try {
    const saved = cabinetDocumentSchema.parse(JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null'));
    if (saved.connection !== connection) return emptyCabinetState();
    for (const [id, snapshot] of Object.entries(saved.snapshots)) if (snapshot.profileId !== id) return emptyCabinetState();
    return filterCabinetProfiles(saved, ids);
  } catch { return emptyCabinetState(); }
}
export function persistCabinet(storage: Pick<Storage, 'setItem'>, connection: string, ids: string[], state: CabinetSavedState): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, connection, ...filterCabinetProfiles(state, ids) }));
    return true;
  } catch { return false; }
}
