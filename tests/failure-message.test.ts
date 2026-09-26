import { describe, expect, it } from 'vitest';
import { runTask } from '../src/core/buyer';
import { UserFacingError } from '../src/core/shop-errors';
import type { BrowserProvider } from '../src/core/ports';
import { fakeBrowser, FakeClock, task } from './helpers';

const failing = (error: Error): BrowserProvider => ({ connect: async () => { throw error; } });
const run = async (provider: BrowserProvider) => {
  const current = task();
  await runTask(current, provider, new FakeClock(), new AbortController().signal, async () => {});
  return current;
};

describe('failure text shown in the task card', () => {
  it('shows the specific message of a user-facing error and marks the task failed', async () => {
    const result = await run(failing(new UserFacingError('AdsPower не знайшов цей профіль. Перевірте ID профілю.')));
    expect(result.status).toBe('failed');
    expect(result.note).toBe('AdsPower не знайшов цей профіль. Перевірте ID профілю.');
    expect(result.events.at(-1)?.message).toBe(result.note);
  });

  it('never persists the text of an ordinary provider error, which may hold an endpoint or key', async () => {
    const result = await run(failing(new Error('connect ws://127.0.0.1:57278/devtools/browser/secret-token failed')));
    expect(result.status).toBe('failed');
    expect(result.note).toContain('Не вдалося виконати завдання');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('adds a cart warning when a user-facing error follows a click', async () => {
    const clock = new FakeClock();
    const { session } = fakeBrowser(clock);
    const current = task();
    const provider: BrowserProvider = {
      connect: async () => ({ ...session, clickBuy: async () => { throw new UserFacingError('Вкладку монети закрито.'); } }),
    };
    await runTask(current, provider, clock, new AbortController().signal, async () => {});
    expect(current.clicks).toBe(1);
    expect(current.status).toBe('interrupted');
    expect(current.note).toContain('Вкладку монети закрито.');
    expect(current.note).toContain('Перевірте кошик');
  });
});
