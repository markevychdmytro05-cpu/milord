import type { OffsetBounds } from './clock-bounds';

export interface PageState {
  login: 'logged-in' | 'logged-out' | 'unknown';
  challenge: boolean;
  rateLimited: boolean;
  turnstile: boolean;
  buyAvailable: boolean;
  purchasePending: boolean;
  inCart: boolean;
  queuePosition: string;
  buyUnavailableReason?: 'missing-form' | 'missing-product' | 'missing-button' | 'hidden-button' | 'disabled-button' | 'blocked-container' | 'limited' | 'pending';
  cartConfirmation?: 'product-page' | 'visible-cart';
  navigationHttpStatus?: number;
  sharedRateLimit?: boolean;
}

export interface ShopSession {
  prepared?: boolean;
  read(): Promise<PageState>;
  recoverRateLimit?(deadline: number): Promise<boolean>;
  waitForActionable(timeoutMs: number): Promise<PageState>;
  reload(): Promise<void>;
  serverOffset(): Promise<number>;
  serverOffsetBounds?(): Promise<OffsetBounds | undefined>;
  // Signs in with the account saved for the profile and reloads the tab. False: no usable account.
  login?(): Promise<boolean>;
  // Development record of the page (HTML, text, the page's own XHR). Never called before the first click
  // in the sale window: a page dump shares the CDP channel with the click.
  capture?(request: CaptureRequest): Promise<void>;
  // Before the sale only: unhurried pointer movement for at most `ms`. Never a click, key, navigation or scroll.
  idle?(ms: number): Promise<void>;
  // Before the sale only: brings the pointer to rest on the buy button within `ms`, scrolling it into view if needed.
  approach?(ms: number): Promise<void>;
  // 'mouse': a real pointer click; 'dom': the fallback DOM click.
  clickBuy(): Promise<'mouse' | 'dom' | void>;
  disconnect(): Promise<void>;
}

export interface CaptureRequest { label: string; saleDeltaMs: number; force?: boolean }

export interface PreparationOptions {
  deadline: number;
  onRateLimit?: () => Promise<void>;
  capture?: { taskId: string; saleAt: number };
}

export interface BrowserProvider {
  connect(profileId: string, url: string, signal: AbortSignal, options?: PreparationOptions): Promise<ShopSession>;
  prepare?(profileId: string, urls: string[], signal: AbortSignal, options?: PreparationOptions): Promise<PreparedProfile>;
}

export interface PreparedProfile extends BrowserProvider {
  disconnect(): Promise<void>;
  // False once the connection to the profile's browser is gone and a fresh preparation is needed.
  alive?(): boolean;
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
