import type { BehaviorTestResult } from './pointer-motion';
import type { CabinetSavedState } from './cabinet-state';
import { z } from 'zod';
import type { CabinetSection, CabinetSnapshot, CabinetOrderDetails, CabinetOrdersPage } from './cabinet';
import type { OffsetHistorySummary } from './offset-history';

export function productUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== 'https://coins.bank.gov.ua' || url.username || url.password || url.pathname === '/') {
    throw new Error('Потрібне HTTPS-посилання на товар coins.bank.gov.ua.');
  }
  // Action query parameters can mutate the cart even during a navigation-only preview.
  if ([...url.searchParams.keys()].some((key) => !['products_id', 'language'].includes(key))) {
    throw new Error('Приберіть із посилання зайві параметри; дозволені products_id і language.');
  }
  url.hash = '';
  return url.href;
}

export const taskInputSchema = z.object({
  url: z.string().max(2048).transform(productUrl),
  profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  saleAt: z.number().int().positive().max(8_640_000_000_000_000),
  leadMin: z.number().int().min(1).max(60).default(5),
  retrySec: z.number().int().min(1).max(60).default(1),
  windowMin: z.number().int().min(1).max(30).default(5),
  mode: z.enum(['observe', 'cart']).default('observe'),
});
export type TaskInput = z.infer<typeof taskInputSchema>;

export const statusSchema = z.enum([
  'scheduled', 'preparing', 'waiting', 'firing', 'queued', 'needs_attention',
  'in_cart', 'observed', 'expired', 'cancelled', 'failed', 'interrupted',
]);
export type TaskStatus = z.infer<typeof statusSchema>;
export const FINAL_STATUSES: TaskStatus[] = [
  'in_cart', 'observed', 'expired', 'cancelled', 'failed', 'interrupted',
];
export const isFinal = (status: TaskStatus) => FINAL_STATUSES.includes(status);

export const taskSchema = taskInputSchema.extend({
  id: z.string().uuid(),
  batchId: z.string().uuid().optional(),
  batchIndex: z.number().int().nonnegative().optional(),
  status: statusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  clicks: z.number().int().nonnegative(),
  reloads: z.number().int().nonnegative(),
  offsetMs: z.number().finite(),
  offsetSampledAt: z.number().optional(),
  // Range of (server − local) proven by the measured responses; see core/clock-bounds.ts.
  offsetLowMs: z.number().finite().optional(),
  offsetHighMs: z.number().finite().optional(),
  // Sale timings in ms relative to the sale start by the server clock; the journal may be trimmed.
  startLoadedMs: z.number().finite().optional(),
  buttonSeenMs: z.number().finite().optional(),
  buttonReloads: z.number().int().nonnegative().optional(),
  firstClickMs: z.number().finite().optional(),
  cartMs: z.number().finite().optional(),
  note: z.string(),
  events: z.array(z.object({
    at: z.number(), message: z.string(),
    details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })).max(200),
});
export type Task = z.infer<typeof taskSchema>;

export function localApiUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Local API має бути на localhost, наприклад http://127.0.0.1:50325.');
  }
  return url.origin;
}
export const savedProfileSchema = z.object({
  id: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().trim().max(80).default(''),
});
export type SavedProfile = z.infer<typeof savedProfileSchema>;
export const settingsSchema = z.object({
  apiUrl: z.string().transform(localApiUrl),
  defaultProfileId: z.union([z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), z.literal('')]).default(''),
  defaultProfileIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).max(50).default([]),
  savedProfiles: z.array(savedProfileSchema).max(200).refine(
    (profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length,
    'ID профілів не мають повторюватися.',
  ).default([]),
  leadMin: z.number().int().min(1).max(60).default(5),
  retrySec: z.number().int().min(1).max(60).default(1),
  windowMin: z.number().int().min(1).max(30).default(5),
});
export type Settings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({ apiUrl: 'http://127.0.0.1:50325' });

export interface AppState {
  tasks: Task[];
  settings: Settings;
  hasApiKey: boolean;
  savedApiKey: boolean;
  secretStorageAvailable: boolean;
  secretError?: string;
  // Profile ID → e-mail of the saved NBU account. Passwords never reach the window.
  nbuAccounts: Record<string, string>;
  accountsError?: string;
  offsetHistoryByProfile: Record<string, OffsetHistorySummary>;
}

export interface AdsProfile { id: string; name: string; number: string; }

export interface DesktopApi {
  testBehavior(input: { profileId: string; navigate: boolean; showCursor: boolean; minutes: number }): Promise<BehaviorTestResult>;
  stopBehaviorTest(profileId: string): Promise<void>;
  restoreCabinet(input: { connection: string; legacy?: string }): Promise<CabinetSavedState>;
  saveCabinet(input: { connection: string; state: CabinetSavedState }): Promise<void>;
  loadCabinetOrders(input: { profileId: string; page: number }): Promise<CabinetOrdersPage>;
  openCaptures(): Promise<void>;
  saveNbuAccount(input: { profileId: string; email: string; password: string }): Promise<void>;
  clearNbuAccount(profileId: string): Promise<void>;
  loadCabinet(profileId: string, sections?: CabinetSection[], openProfile?: boolean): Promise<CabinetSnapshot>;
  loadCabinetOrder(input: { profileId: string; orderId: string; detailId?: string }): Promise<CabinetOrderDetails>;
  state(): Promise<AppState>;
  saveSettings(input: Settings & { apiKey?: string }): Promise<void>;
  clearApiKey(): Promise<void>;
  listProfiles(): Promise<AdsProfile[]>;
  addTask(input: TaskInput): Promise<void>;
  addTasks(input: TaskInput[]): Promise<void>;
  cancelTask(id: string): Promise<void>;
  updateTask(input: { id: string; url: string; saleAt: number }): Promise<void>;
  inspectProfile(input: { profileId: string; url: string }): Promise<string>;
}
