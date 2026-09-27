// Background refresh reads the cart only; orders and wishlist load when the user asks.
export const CABINET_AUTO_REFRESH_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
// Each profile's interval drifts by up to ±10%, and background refreshes of different
// profiles are separated by a random 30–90 s pause, so cabinets never refresh in lockstep.
const INTERVAL_JITTER = 0.1;
const MIN_GAP_MS = 30_000;
const GAP_SPREAD_MS = 60_000;
export interface CabinetRefreshState {
  nextRoundAt: number;
  profiles: Record<string, { nextAt: number; failures: number }>;
}

// One refresh at a time; late timers never replay missed rounds after sleep.
export class CabinetRefreshSchedule {
  private nextRoundAt = 0;
  private profiles = new Map<string, { nextAt: number; failures: number }>();
  constructor(saved?: CabinetRefreshState, private readonly random = Math.random) {
    if (saved) { this.nextRoundAt = saved.nextRoundAt; this.profiles = new Map(Object.entries(saved.profiles)); }
  }
  snapshot(): CabinetRefreshState { return { nextRoundAt: this.nextRoundAt, profiles: Object.fromEntries(this.profiles) }; }
  due(ids: string[], now: number): string[] {
    if (now < this.nextRoundAt) return [];
    const nextAt = (id: string) => this.profiles.get(id)?.nextAt ?? 0;
    return ids.filter(id => now >= nextAt(id)).sort((a, b) => nextAt(a) - nextAt(b));
  }
  completed(id: string, now: number, failed: boolean): void {
    const failures = failed ? (this.profiles.get(id)?.failures ?? 0) + 1 : 0;
    const delay = failed ? Math.min(MAX_BACKOFF_MS, CABINET_AUTO_REFRESH_MS * 2 ** Math.min(failures, 3)) : CABINET_AUTO_REFRESH_MS;
    const drift = (this.random() * 2 - 1) * INTERVAL_JITTER;
    this.profiles.set(id, { nextAt: now + Math.round(delay * (1 + drift)), failures });
  }
  // Holds the next profile back for a short random gap after any refresh.
  finishRound(now: number): void { this.nextRoundAt = now + MIN_GAP_MS + Math.round(this.random() * GAP_SPREAD_MS); }
  nextAt(ids: string[]): number | undefined {
    if (!ids.length) return undefined;
    return Math.max(this.nextRoundAt, Math.min(...ids.map(id => this.profiles.get(id)?.nextAt ?? 0)));
  }
}

// Profiles with nothing loaded yet are fetched together, so the cabinet is not empty for minutes on
// first entry. Every later background refresh takes one profile at a time, the most overdue first.
export function autoRefreshTargets(due: string[], hasData: (id: string) => boolean): string[] {
  const empty = due.filter(id => !hasData(id));
  return empty.length ? empty : due.slice(0, 1);
}
