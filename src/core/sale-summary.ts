import { isFinal, type Task, type TaskStatus } from './model';

export interface SaleRow {
  taskId: string;
  profileId: string;
  url: string;
  status: TaskStatus;
  note: string;
  mode: Task['mode'];
  startLoadedMs?: number;
  buttonSeenMs?: number;
  buttonReloads?: number;
  firstClickMs?: number;
  cartMs?: number;
  reloads: number;
  clicks: number;
}
export interface SaleSummary {
  saleAt: number;
  rows: SaleRow[];
  total: number;
  inCart: number;
  // Across profiles: when the button was first seen after the start, and how fast carts were confirmed.
  earliestButtonMs?: number;
  medianButtonMs?: number;
  medianCartMs?: number;
  finished: boolean;
}

const median = (values: number[]) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};

// One summary per sale start, newest first. Tasks planned for the same moment form one sale.
export function summarizeSales(tasks: Task[], now: number, limit = 10): SaleSummary[] {
  const sales = new Map<number, Task[]>();
  for (const task of tasks) {
    if (task.saleAt > now || task.status === 'cancelled') continue;
    sales.set(task.saleAt, [...(sales.get(task.saleAt) ?? []), task]);
  }
  return [...sales.entries()].sort(([a], [b]) => b - a).slice(0, limit).map(([saleAt, group]) => {
    const rows: SaleRow[] = group.map(task => ({
      taskId: task.id, profileId: task.profileId, url: task.url, status: task.status, note: task.note, mode: task.mode,
      startLoadedMs: task.startLoadedMs, buttonSeenMs: task.buttonSeenMs, buttonReloads: task.buttonReloads,
      firstClickMs: task.firstClickMs, cartMs: task.cartMs, reloads: task.reloads, clicks: task.clicks,
    })).sort((a, b) => Number(b.status === 'in_cart') - Number(a.status === 'in_cart') ||
      (a.cartMs ?? a.buttonSeenMs ?? Infinity) - (b.cartMs ?? b.buttonSeenMs ?? Infinity));
    const buttons = rows.flatMap(row => row.buttonSeenMs === undefined ? [] : [row.buttonSeenMs]);
    const carts = rows.flatMap(row => row.cartMs === undefined ? [] : [row.cartMs]);
    return {
      saleAt, rows, total: rows.length, inCart: rows.filter(row => row.status === 'in_cart').length,
      earliestButtonMs: buttons.length ? Math.min(...buttons) : undefined,
      medianButtonMs: median(buttons), medianCartMs: median(carts),
      finished: group.every(task => isFinal(task.status)),
    };
  });
}
