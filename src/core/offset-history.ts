import type { Task } from './model';

export interface OffsetSample { at: number; offsetMs: number; }

export interface OffsetHistorySummary {
  count: number;
  meanMs: number;
  medianMs: number;
  stdDevMs: number;
  lastMs: number;
  lastAt: number;
  anomaly: boolean;
}

const HISTORY_LIMIT = 20;
// Below this, day-to-day jitter is not worth flagging even with a tight recent history.
const ANOMALY_FLOOR_MS = 1500;
const ANOMALY_SIGMA = 3;

// Only a task that reached readWithRecovery() after connecting carries a real reading;
// a task that failed to connect keeps the schema default of 0, which is not a sample.
// Different profiles ride different network paths (proxy, IP) and measurably carry different
// typical offsets — a live test found a stable ~200ms gap between two profiles. Pooling
// profiles together would inflate the "normal" spread and could hide a real anomaly, so the
// profile is always part of the filter, never an afterthought.
export function offsetSamples(tasks: Task[], profileId: string): OffsetSample[] {
  return tasks
    .filter((task): task is Task & { offsetSampledAt: number } =>
      task.profileId === profileId && task.offsetSampledAt !== undefined)
    .map((task) => ({ at: task.offsetSampledAt, offsetMs: task.offsetMs }))
    .sort((a, b) => a.at - b.at);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stdDev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

// Recent samples reflect the current network path; a year-old drift does not.
export function summarizeOffsetHistory(tasks: Task[], profileId: string, limit = HISTORY_LIMIT): OffsetHistorySummary | undefined {
  const samples = offsetSamples(tasks, profileId).slice(-limit);
  if (!samples.length) return undefined;
  const values = samples.map((sample) => sample.offsetMs);
  const last = samples[samples.length - 1]!;
  const rest = values.slice(0, -1);
  const restMean = rest.length ? mean(rest) : last.offsetMs;
  const restDev = stdDev(rest, restMean);
  // Three prior samples are the minimum for a spread estimate that is not itself noise.
  const anomaly = rest.length >= 3 && Math.abs(last.offsetMs - restMean) > Math.max(ANOMALY_FLOOR_MS, ANOMALY_SIGMA * restDev);
  const avg = mean(values);
  return {
    count: values.length,
    meanMs: Math.round(avg),
    medianMs: Math.round(median(values)),
    stdDevMs: Math.round(stdDev(values, avg)),
    lastMs: last.offsetMs,
    lastAt: last.at,
    anomaly,
  };
}

// One summary per profile that has at least one real measurement, keyed by profileId.
export function summarizeOffsetHistoryByProfile(tasks: Task[], limit = HISTORY_LIMIT): Record<string, OffsetHistorySummary> {
  const profileIds = [...new Set(tasks
    .filter((task) => task.offsetSampledAt !== undefined)
    .map((task) => task.profileId))];
  const result: Record<string, OffsetHistorySummary> = {};
  for (const profileId of profileIds) {
    const summary = summarizeOffsetHistory(tasks, profileId, limit);
    if (summary) result[profileId] = summary;
  }
  return result;
}
