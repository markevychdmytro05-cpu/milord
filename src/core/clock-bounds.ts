import type { Task } from './model';

// What one HTTP response proves about (server clock − local clock), with no statistics involved.
// The server stamped `Date` somewhere between our send and our receipt, and the header is
// truncated down to a whole second, so the true offset lies in
//   [Date − receivedAt, Date + 999 − sentAt].
// A single point estimate inside that range is biased ~500 ms low by the truncation; on 80 live
// samples the point estimate said "server 200–380 ms behind" while every interval agreed the
// server was 9–365 ms ahead. Intervals from several responses intersect into a narrow range.
export interface OffsetBounds { lowMs: number; highMs: number; }

const MAX_OFFSET_MS = 300_000;
// A previous measurement is reused only while both clocks can be trusted not to have moved much.
export const PRIOR_BOUNDS_MAX_AGE_MS = 24 * 60 * 60_000;
const PRIOR_BOUNDS_LIMIT = 20;

export function responseOffsetBounds(date: string | undefined, sentAt: number | undefined, receivedAt: number): OffsetBounds | undefined {
  const server = Date.parse(date || '');
  if (!Number.isFinite(server) || sentAt === undefined || !Number.isFinite(sentAt) || sentAt > receivedAt) return undefined;
  const bounds = { lowMs: Math.round(server - receivedAt), highMs: Math.round(server + 999 - sentAt) };
  return Math.abs(bounds.lowMs) <= MAX_OFFSET_MS && Math.abs(bounds.highMs) <= MAX_OFFSET_MS ? bounds : undefined;
}

// Newest first. A reading that contradicts the ones already accepted (clock step, stale header)
// is skipped instead of emptying the result, so one bad sample can only fail to help.
export function intersectBounds(newestFirst: OffsetBounds[]): OffsetBounds | undefined {
  let result: OffsetBounds | undefined;
  for (const bounds of newestFirst) {
    if (!result) { result = { ...bounds }; continue; }
    const lowMs = Math.max(result.lowMs, bounds.lowMs);
    const highMs = Math.min(result.highMs, bounds.highMs);
    if (lowMs <= highMs) result = { lowMs, highMs };
  }
  return result;
}

// Trust the NTP-synced local clock unless the measurements prove it is off, and then correct by
// exactly the proven amount. A range containing zero therefore yields 0, not a truncated guess.
export function offsetFromBounds(bounds: OffsetBounds): number {
  return Math.min(bounds.highMs, Math.max(bounds.lowMs, 0));
}

// Same profile only: a different proxy may reach a different edge server with its own clock.
export function priorOffsetBounds(tasks: Task[], profileId: string, now: number, excludeTaskId?: string): OffsetBounds[] {
  return tasks
    .filter((task) => task.profileId === profileId && task.id !== excludeTaskId &&
      task.offsetLowMs !== undefined && task.offsetHighMs !== undefined &&
      task.offsetSampledAt !== undefined && now - task.offsetSampledAt <= PRIOR_BOUNDS_MAX_AGE_MS &&
      task.offsetSampledAt <= now)
    .sort((a, b) => b.offsetSampledAt! - a.offsetSampledAt!)
    .slice(0, PRIOR_BOUNDS_LIMIT)
    .map((task) => ({ lowMs: task.offsetLowMs!, highMs: task.offsetHighMs! }));
}
