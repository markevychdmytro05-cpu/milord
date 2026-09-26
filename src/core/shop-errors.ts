import { realClock, type Clock } from './ports';

export class ShopRateLimitError extends Error {
  constructor() {
    super('НБУ обмежив запити (429). Час очікування повторної спроби вичерпано.');
    this.name = 'ShopRateLimitError';
  }
}

// The message is written by us and is safe to show and save. Never build one from AdsPower or store text:
// those can carry keys, addresses or cookies.
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function retryAfterMs(value: string | undefined, now: number): number {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

// All profiles share a cooldown. One retry at a time prevents a burst when it ends.
export class ShopRequestGuard {
  private until = 0;
  private attempts = 0;
  private pending = false;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly clock: Clock = realClock) {}
  block(retryAfter?: string): void {
    this.generation++;
    const now = this.clock.now();
    const serverDelay = retryAfterMs(retryAfter, now);
    if (!this.pending || now >= this.until) {
      this.until = now + Math.max(serverDelay, Math.min(300_000, 30_000 * 2 ** this.attempts));
      this.attempts = Math.min(this.attempts + 1, 4);
    } else this.until = Math.max(this.until, now + serverDelay);
    this.pending = true;
  }
  isBlocked(): boolean { return this.pending; }
  check(): void { if (this.pending) throw new ShopRateLimitError(); }
  async wait(signal: AbortSignal, deadline: number): Promise<void> {
    while (this.clock.now() < this.until) {
      signal.throwIfAborted();
      if (this.clock.now() >= deadline) throw new ShopRateLimitError();
      await this.clock.sleep(Math.min(this.until - this.clock.now(), deadline - this.clock.now(), 1000), signal);
    }
    signal.throwIfAborted();
    if (this.clock.now() >= deadline) throw new ShopRateLimitError();
  }
  retry(signal: AbortSignal, deadline: number, action: () => Promise<boolean>): Promise<void> {
    const result = this.tail.then(async () => {
      await this.wait(signal, deadline);
      const generation = this.generation;
      if (await action() && generation === this.generation) { this.pending = false; this.attempts = 0; this.until = 0; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
