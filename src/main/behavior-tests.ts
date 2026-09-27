import type { BehaviorTestResult } from '../core/pointer-motion';

// Tests may run on different profiles together. Creating a purchase takes priority
// over every test, including requests arriving while cancellation is in progress.
export class BehaviorTests {
  private entries = new Map<string, { controller: AbortController; done: Promise<BehaviorTestResult> }>();
  private purchases = 0;
  run(profileId: string, action: (signal: AbortSignal) => Promise<BehaviorTestResult>): Promise<BehaviorTestResult> {
    if (this.purchases) return Promise.reject(new Error('Створюється завдання покупки. Дочекайтеся завершення.'));
    if (this.entries.has(profileId)) return Promise.reject(new Error('Прогрів цього профілю вже виконується.'));
    const controller = new AbortController();
    const done = Promise.resolve().then(() => action(controller.signal)).finally(() => { this.entries.delete(profileId); });
    this.entries.set(profileId, { controller, done });
    return done;
  }
  stop(profileId: string): void { this.entries.get(profileId)?.controller.abort(); }
  async beforePurchase<T>(action: () => Promise<T>): Promise<T> {
    this.purchases++;
    try {
      const active = [...this.entries.values()];
      for (const entry of active) entry.controller.abort();
      await Promise.allSettled(active.map(entry => entry.done));
      return await action();
    } finally { this.purchases--; }
  }
}
