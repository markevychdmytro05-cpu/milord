export interface ClockSync {
  offsetMs: number;      // UTC minus this computer's clock.
  uncertaintyMs: number; // Estimated error around offsetMs, including disagreement between servers.
  at: number;            // Local time of the measurement.
  servers: number;       // Servers that agreed.
}

// The background sampler runs every minute; tolerate one missed round, not ten minutes of drift.
export const CLOCK_SYNC_MAX_AGE_MS = 120_000;

export function isFreshClockSync(sync: ClockSync | undefined, now: number): sync is ClockSync {
  return !!sync && Number.isFinite(sync.offsetMs) && Number.isFinite(sync.uncertaintyMs) &&
    sync.uncertaintyMs >= 0 && Number.isFinite(sync.at) && now >= sync.at &&
    now - sync.at <= CLOCK_SYNC_MAX_AGE_MS && Number.isInteger(sync.servers) && sync.servers >= 2;
}
