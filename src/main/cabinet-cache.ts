// Repeated clicks and concurrent IPC calls share one request. Failures are cached too:
// an unavailable profile or a 429 must not trigger a burst of retries.
export const CABINET_CACHE_MS = 60_000;
export class CabinetCache {
  private entries = new Map<string, { expiresAt: number; promise: Promise<unknown> }>();
  constructor(private readonly now = Date.now) {}
  get<T>(key: string, action: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > this.now()) return existing.promise as Promise<T>;
    for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(key);
    const entry = { expiresAt: Infinity, promise: Promise.resolve() as Promise<unknown> };
    entry.promise = Promise.resolve().then(action).finally(() => { entry.expiresAt = this.now() + CABINET_CACHE_MS; });
    this.entries.set(key, entry);
    return entry.promise as Promise<T>;
  }
  clear(): void { this.entries.clear(); }
}
