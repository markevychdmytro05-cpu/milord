import { expect, it, vi } from 'vitest';
import { BehaviorTests } from '../src/main/behavior-tests';
const result = { moves: 1, scrolls: 0, navigations: 0, durationMs: 1000, stopped: true };
it('runs different profiles simultaneously and stops all of them before creating a purchase', async () => {
  const tests = new BehaviorTests(), signals = new Map<string, AbortSignal>();
  const finish = new Map<string, () => void>();
  const runs = ['a', 'b'].map(id => tests.run(id, signal => {
    signals.set(id, signal);
    return new Promise(resolve => { finish.set(id, () => resolve(result)); });
  }));
  await Promise.resolve();
  expect(signals.size).toBe(2);
  await expect(tests.run('a', async () => result)).rejects.toThrow('вже виконується');
  const create = vi.fn(async () => 'created');
  const purchase = tests.beforePurchase(create);
  expect([...signals.values()].every(signal => signal.aborted)).toBe(true);
  expect(create).not.toHaveBeenCalled();
  await expect(tests.run('c', async () => result)).rejects.toThrow('Створюється завдання');
  finish.get('a')!(); finish.get('b')!();
  expect(await purchase).toBe('created');
  await Promise.all(runs);
  await expect(tests.run('c', async () => result)).resolves.toEqual(result);
});
it('cancels only the requested profile on an individual stop', async () => {
  const tests = new BehaviorTests();
  const signals: AbortSignal[] = [];
  const finishes: (() => void)[] = [];
  const runs = ['a', 'b'].map(id => tests.run(id, signal => {
    signals.push(signal); return new Promise(resolve => finishes.push(() => resolve(result)));
  }));
  await Promise.resolve(); tests.stop('a');
  expect(signals.map(s => s.aborted)).toEqual([true, false]);
  finishes.forEach(finish => finish()); await Promise.all(runs);
});
