import type { Task } from '../src/core/model';
import type { BrowserProvider, Clock, PageState, ShopSession } from '../src/core/ports';

export const ready: PageState = {
  login: 'logged-in', challenge: false, rateLimited: false, turnstile: false,
  buyAvailable: true, purchasePending: false, inCart: false, queuePosition: '',
};

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: '348a0db9-763a-419a-b670-54d556659a96', url: 'https://coins.bank.gov.ua/test-coin.html',
    profileId: 'abc123', saleAt: 1_000_000, leadMin: 5, retrySec: 5, windowMin: 1,
    mode: 'cart', status: 'scheduled', createdAt: 900_000, updatedAt: 900_000,
    clicks: 0, reloads: 0, offsetMs: 0, note: '', events: [], ...overrides,
  };
}

export class FakeClock implements Clock {
  time = 1_000_000;
  now = () => this.time;
  sleep = async (ms: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    this.time += ms;
  };
}

export function fakeBrowser(clock: FakeClock, state: () => PageState = () => ready) {
  const clicks: number[] = [];
  const reloads: number[] = [];
  let disconnected = false;
  let connections = 0;
  const session: ShopSession = {
    read: async () => state(),
    waitForActionable: async (timeoutMs) => {
      const initial = state();
      if (initial.buyAvailable || initial.inCart || initial.challenge || initial.turnstile || initial.purchasePending ||
          initial.queuePosition || initial.login !== 'logged-in') return initial;
      clock.time += timeoutMs;
      return state();
    },
    serverOffset: async () => 0,
    reload: async () => { reloads.push(clock.now()); },
    clickBuy: async () => { clicks.push(clock.now()); },
    disconnect: async () => { disconnected = true; },
  };
  const provider: BrowserProvider = {
    connect: async () => { connections++; return session; },
  };
  return { session, provider, clicks, reloads, disconnected: () => disconnected, connections: () => connections };
}
