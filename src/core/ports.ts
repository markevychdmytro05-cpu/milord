export interface PageState {
  login: 'logged-in' | 'logged-out' | 'unknown';
  challenge: boolean;
  rateLimited: boolean;
  turnstile: boolean;
  buyAvailable: boolean;
  purchasePending: boolean;
  inCart: boolean;
  queuePosition: string;
}

export interface ShopSession {
  prepared?: boolean;
  read(): Promise<PageState>;
  recoverRateLimit?(deadline: number): Promise<boolean>;
  waitForActionable(timeoutMs: number): Promise<PageState>;
  reload(): Promise<void>;
  serverOffset(): Promise<number>;
  clickBuy(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface PreparationOptions {
  deadline: number;
  onRateLimit?: () => Promise<void>;
}

export interface BrowserProvider {
  connect(profileId: string, url: string, signal: AbortSignal, options?: PreparationOptions): Promise<ShopSession>;
  prepare?(profileId: string, urls: string[], signal: AbortSignal, options?: PreparationOptions): Promise<PreparedProfile>;
}

export interface PreparedProfile extends BrowserProvider {
  disconnect(): Promise<void>;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  }),
};
