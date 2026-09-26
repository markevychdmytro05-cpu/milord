import { describe, expect, it } from 'vitest';
import { offsetSamples, summarizeOffsetHistory, summarizeOffsetHistoryByProfile } from '../src/core/offset-history';
import { task } from './helpers';

const PROFILE = 'abc123'; // matches the task() helper's default profileId

describe('offset history', () => {
  it('ignores tasks that never reached a real measurement', () => {
    const tasks = [task({ offsetMs: 0 }), task({ offsetMs: 500 })];
    expect(offsetSamples(tasks, PROFILE)).toHaveLength(0);
    expect(summarizeOffsetHistory(tasks, PROFILE)).toBeUndefined();
  });

  it('summarizes a single sample', () => {
    const tasks = [task({ offsetMs: -180, offsetSampledAt: 1_000_000 })];
    const summary = summarizeOffsetHistory(tasks, PROFILE);
    expect(summary).toEqual({
      count: 1, meanMs: -180, medianMs: -180, stdDevMs: 0, lastMs: -180, lastAt: 1_000_000, anomaly: false,
    });
  });

  it('sorts samples by measurement time, not task order', () => {
    const tasks = [
      task({ id: 'b', offsetMs: 300, offsetSampledAt: 2_000_000 }),
      task({ id: 'a', offsetMs: 100, offsetSampledAt: 1_000_000 }),
    ];
    expect(offsetSamples(tasks, PROFILE).map((sample) => sample.offsetMs)).toEqual([100, 300]);
    expect(summarizeOffsetHistory(tasks, PROFILE)?.lastMs).toBe(300);
  });

  it('computes mean, median and spread over several samples', () => {
    const tasks = [100, 120, 80, 110].map((offsetMs, i) => task({ offsetMs, offsetSampledAt: 1_000_000 + i }));
    const summary = summarizeOffsetHistory(tasks, PROFILE)!;
    expect(summary.count).toBe(4);
    expect(summary.meanMs).toBe(103);
    expect(summary.medianMs).toBe(105);
    expect(summary.stdDevMs).toBeGreaterThan(0);
    expect(summary.anomaly).toBe(false);
  });

  it('flags a last sample that breaks sharply from a stable history', () => {
    const stable = [100, 105, 98, 102].map((offsetMs, i) => task({ offsetMs, offsetSampledAt: 1_000_000 + i }));
    const spike = task({ offsetMs: 9000, offsetSampledAt: 2_000_000 });
    expect(summarizeOffsetHistory([...stable, spike], PROFILE)?.anomaly).toBe(true);
  });

  it('does not flag ordinary jitter within a noisy history', () => {
    const noisy = [100, -300, 500, -100].map((offsetMs, i) => task({ offsetMs, offsetSampledAt: 1_000_000 + i }));
    const next = task({ offsetMs: 400, offsetSampledAt: 2_000_000 });
    expect(summarizeOffsetHistory([...noisy, next], PROFILE)?.anomaly).toBe(false);
  });

  it('never flags an anomaly with fewer than three prior samples', () => {
    const tasks = [50, 4000].map((offsetMs, i) => task({ offsetMs, offsetSampledAt: 1_000_000 + i }));
    expect(summarizeOffsetHistory(tasks, PROFILE)?.anomaly).toBe(false);
  });

  it('keeps only the most recent samples up to the limit', () => {
    const tasks = Array.from({ length: 5 }, (_, i) => task({ offsetMs: i, offsetSampledAt: 1_000_000 + i }));
    const summary = summarizeOffsetHistory(tasks, PROFILE, 3)!;
    expect(summary.count).toBe(3);
    expect(summary.meanMs).toBe(3);
    expect(summary.lastMs).toBe(4);
  });
});

describe('offset history across profiles', () => {
  it('never mixes samples from a different profile', () => {
    const tasks = [
      task({ profileId: 'profile-a', offsetMs: 100, offsetSampledAt: 1_000_000 }),
      task({ profileId: 'profile-b', offsetMs: -900, offsetSampledAt: 1_000_001 }),
    ];
    expect(offsetSamples(tasks, 'profile-a')).toEqual([{ at: 1_000_000, offsetMs: 100 }]);
    expect(summarizeOffsetHistory(tasks, 'profile-a')?.meanMs).toBe(100);
    expect(summarizeOffsetHistory(tasks, 'profile-b')?.meanMs).toBe(-900);
  });

  // A live test found two real profiles with stable means ~200ms apart; pooling them would
  // have inflated the "normal" spread enough to hide a real per-profile anomaly.
  it('does not let one profile\'s baseline flag a normal reading on another profile', () => {
    const profileA = [90, 105, 95, 110].map((offsetMs, i) => task({ profileId: 'a', offsetMs, offsetSampledAt: 1_000_000 + i }));
    const profileB = [-540, -560, -520, -550].map((offsetMs, i) => task({ profileId: 'b', offsetMs, offsetSampledAt: 1_000_000 + i }));
    const nextOnA = task({ profileId: 'a', offsetMs: 100, offsetSampledAt: 2_000_000 });
    expect(summarizeOffsetHistory([...profileA, ...profileB, nextOnA], 'a')?.anomaly).toBe(false);
  });

  it('builds one summary per profile that has a real measurement', () => {
    const tasks = [
      task({ profileId: 'a', offsetMs: 100, offsetSampledAt: 1_000_000 }),
      task({ profileId: 'b', offsetMs: -500, offsetSampledAt: 1_000_001 }),
      task({ profileId: 'c', offsetMs: 0 }), // never sampled: excluded
    ];
    const byProfile = summarizeOffsetHistoryByProfile(tasks);
    expect(Object.keys(byProfile).sort()).toEqual(['a', 'b']);
    expect(byProfile.a?.lastMs).toBe(100);
    expect(byProfile.b?.lastMs).toBe(-500);
  });
});
