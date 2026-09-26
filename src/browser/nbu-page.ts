// Selectors and state recognition adapted from nbu-store-speed-buyer (MIT).
// Copyright (c) 2026 Mykhailo Toporkov. See third-party/nbu-store-speed-buyer/LICENSE.
import type { Page } from 'playwright-core';
import type { PageState } from '../core/ports';

export const BUY_BUTTON = 'form[name="cart_quantity"] #r_buy_intovar button[type="submit"].buy';

// Read the store's rendered cart only. Do not open it, poll an endpoint or alter its queue.
// A hidden popup can be stale, and a row with an expired reservation is not confirmation.
export function readVisibleCartProductIds(): string[] {
  const popup = document.querySelector<HTMLElement>('#modal_cart_popup');
  if (!popup || !popup.getClientRects().length || getComputedStyle(popup).visibility !== 'visible') return [];
  const ids: string[] = [];
  for (const row of popup.querySelectorAll('.cartContent_body')) {
    const id = row.querySelector<HTMLInputElement>('[name="products_id[]"]')?.value;
    const quantity = Number(row.querySelector<HTMLSelectElement>('[name="cart_quantity[]"]')?.value);
    const timer = row.querySelector('.cart-item-timer .timer-numbers')?.textContent?.replace(/\s/g, '');
    const remaining = timer?.match(/^(\d+):(\d{2})$/);
    if (id && /^\d+$/.test(id) && Number.isInteger(quantity) && quantity > 0 && remaining &&
        Number(remaining[1]) * 60 + Number(remaining[2]) > 0) ids.push(id);
  }
  return [...new Set(ids)];
}

// This function runs in the page. Keep it self-contained for Playwright serialization.
export function readNbuPage(click = false): PageState {
  const field = document.querySelector<HTMLInputElement>('[name="cid_id"]');
  const loginLink = document.querySelector('#r_buy_intovar a.login');
  const form = document.querySelector('form[name="cart_quantity"]');
  const container = form?.querySelector('#r_buy_intovar');
  const button = container?.querySelector<HTMLButtonElement>('button[type="submit"].buy');
  const visible = !!button && button.getClientRects().length > 0 && getComputedStyle(button).visibility !== 'hidden';
  const turnstile = [...document.querySelectorAll<HTMLElement>('.cf-turnstile:not(.success)')].some((widget) => {
    const rect = widget.getBoundingClientRect();
    const visibility = getComputedStyle(widget).visibility;
    return rect.width > 0 && rect.height > 0 && visibility !== 'hidden' && visibility !== 'collapse';
  });
  const spinner = container?.querySelector<HTMLElement>('#prodBtnLoadingSpinner');
  const purchasePending = !!button?.classList.contains('clicked') || !!spinner?.getClientRects().length;
  const state: PageState = {
    rateLimited: /(?:помилка\s*429|429\s*(?:помилка|error)|too many requests)/i.test(document.title) ||
      [...document.querySelectorAll('h1, h2')].some((heading) => /(?:\b429\b|too many requests)/i.test(heading.textContent || '')),
    login: loginLink ? 'logged-out' : !field ? 'unknown' : field.value ? 'logged-in' : 'logged-out',
    challenge: !!document.querySelector('script[src*=".bunny-shield"]') ||
      document.title.startsWith('Establishing a secure connection'),
    turnstile,
    purchasePending,
    buyAvailable: !!form?.querySelector('[name="products_id"]') && !!container &&
      !container.classList.contains('pointer_events_none') && !!button && visible &&
      !button.disabled && !purchasePending && !button.classList.contains('limited'),
    inCart: !!document.querySelector('#r_buy_intovar .added2cart, #r_buy_intovar a[href*="shopping_cart"]'),
    queuePosition: document.querySelector('#cart-queue-position')?.textContent?.trim() || '',
  };
  if (!state.buyAvailable) {
    state.buyUnavailableReason = !form ? 'missing-form'
      : !form.querySelector('[name="products_id"]') ? 'missing-product'
      : !button ? 'missing-button' : purchasePending ? 'pending'
      : button.classList.contains('limited') ? 'limited'
      : button.disabled ? 'disabled-button' : !visible ? 'hidden-button' : 'blocked-container';
  }
  if (state.inCart) state.cartConfirmation = 'product-page';
  if (click) {
    if (!state.buyAvailable || state.login !== 'logged-in' || state.inCart ||
        state.rateLimited || state.challenge || state.turnstile || state.purchasePending || state.queuePosition || !button) {
      throw new Error('Page state changed before purchase click');
    }
    // Same native DOM click used by the upstream extension. The site's own handler owns the queue/token.
    button.click();
  }
  return state;
}

export async function waitForActionablePage(page: Page, timeoutMs: number): Promise<PageState> {
  // Only our static function is serialized here; no URL, input, or website text is interpolated as code.
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(1000, timeoutMs)) : 1000;
  const expression = `new Promise((resolve) => {
    const read = ${readNbuPage.toString()};
    let finished = false;
    let timer;
    let frame;
    const observer = new MutationObserver(check);
    function finish(state) {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      resolve(state);
    }
    function check() {
      if (finished) return;
      const state = read();
      if (state.rateLimited || state.inCart || state.buyAvailable || state.challenge || state.turnstile || state.purchasePending ||
          state.queuePosition || state.login !== 'logged-in') finish(state);
    }
    function checkFrame() {
      check();
      if (!finished) frame = requestAnimationFrame(checkFrame);
    }
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(() => finish(read()), ${timeout});
    check();
    if (!finished) frame = requestAnimationFrame(checkFrame);
  })`;
  // DOM mutations wake immediately; animation frames cover CSS-only visibility changes.
  // A bounded timeout releases the observer for cancellation and scheduled network refreshes.
  return page.evaluate<PageState>(expression);
}

export function assertShopPage(page: Page, targetUrl: string): void {
  const actual = new URL(page.url());
  const target = new URL(targetUrl);
  if (actual.origin !== target.origin || actual.pathname !== target.pathname ||
      actual.searchParams.get('products_id') !== target.searchParams.get('products_id')) {
    throw new Error('Browser left the selected product page');
  }
}
