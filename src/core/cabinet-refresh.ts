// Background refresh reads the cart only; orders and wishlist load when the user asks.
export const CABINET_AUTO_REFRESH_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
export interface CabinetRefreshState {
  nextRoundAt: number;
  profiles: Record<string, { nextAt: number; failures: number }>;
}

// One sequential round at a time; late timers never replay missed rounds after sleep.
export class CabinetRefreshSchedule {
  private nextRoundAt = 0;
  private profiles = new Map<string, { nextAt: number; failures: number }>();
  constructor(saved?: CabinetRefreshState) {
    if (saved) { this.nextRoundAt = saved.nextRoundAt; this.profiles = new Map(Object.entries(saved.profiles)); }
  }
  snapshot(): CabinetRefreshState { return { nextRoundAt: this.nextRoundAt, profiles: Object.fromEntries(this.profiles) }; }
  due(ids: string[], now: number): string[] {
    if (now < this.nextRoundAt) return [];
    return ids.filter(id => now >= (this.profiles.get(id)?.nextAt ?? 0));
  }
  completed(id: string, now: number, failed: boolean): void {
    const failures = failed ? (this.profiles.get(id)?.failures ?? 0) + 1 : 0;
    const delay = failed ? Math.min(MAX_BACKOFF_MS, CABINET_AUTO_REFRESH_MS * 2 ** Math.min(failures, 3)) : CABINET_AUTO_REFRESH_MS;
    this.profiles.set(id, { nextAt: now + delay, failures });
  }
  finishRound(now: number): void { this.nextRoundAt = now + CABINET_AUTO_REFRESH_MS; }
  nextAt(ids: string[]): number | undefined {
    if (!ids.length) return undefined;
    return Math.max(this.nextRoundAt, Math.min(...ids.map(id => this.profiles.get(id)?.nextAt ?? 0)));
  }
}
