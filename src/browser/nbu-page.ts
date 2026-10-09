// Selectors and state recognition adapted from nbu-store-speed-buyer (MIT).
// Copyright (c) 2026 Mykhailo Toporkov. See third-party/nbu-store-speed-buyer/LICENSE.
import type { CDPSession, Page } from 'patchright-core';
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

// Aims at the buy button with the same checks as readNbuPage(true), but does not click. Returns a probe
// object that records whether the next click on the button came from the real mouse. Nothing is left on
// the page: the probe lives only as a DevTools object reference, and the listener runs once.
const aimExpression = () => `(() => {
  const read = ${readNbuPage.toString()};
  const state = read(false);
  const button = document.querySelector(${JSON.stringify(BUY_BUTTON)});
  if (!state.buyAvailable || state.login !== 'logged-in' || state.inCart || state.rateLimited || state.challenge ||
      state.turnstile || state.purchasePending || state.queuePosition || !button) return { ready: false };
  let box = button.getBoundingClientRect();
  if (box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth) {
    button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    box = button.getBoundingClientRect();
  }
  // A slightly different spot each time, never at the very edge.
  const x = box.left + box.width * (0.3 + Math.random() * 0.4), y = box.top + box.height * (0.3 + Math.random() * 0.4);
  const hit = document.elementFromPoint(x, y);
  const probe = { ready: true, aimed: !!hit && (hit === button || button.contains(hit)), x, y, trusted: false };
  if (probe.aimed) button.addEventListener('click', (event) => { probe.trusted = event.isTrusted; }, { once: true, capture: true });
  return probe;
})()`;

type Preview = { properties?: Array<{ name: string; value?: string }> };
// Our own JavaScript world in the tab: it shares the DOM with the site but none of its globals or
// prototypes, so the site can neither see nor intercept our code. A navigation destroys it; the
// provider recreates it after each reload, off the click path.
const worlds = new WeakMap<CDPSession, Promise<number>>();
export function prepareClickWorld(cdp: CDPSession): Promise<number> {
  const world = (async () => {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, grantUniveralAccess: true });
    return executionContextId;
  })();
  worlds.set(cdp, world);
  world.catch(() => { if (worlds.get(cdp) === world) worlds.delete(cdp); });
  return world;
}
async function evaluateInWorld(cdp: CDPSession, expression: string) {
  const run = async (contextId: number) => cdp.send('Runtime.evaluate', { expression, contextId, generatePreview: true });
  try { return await run(await (worlds.get(cdp) ?? prepareClickWorld(cdp))); }
  catch { return run(await prepareClickWorld(cdp)); } // The page navigated since the world was made.
}
// The shop's own buy handler loads the Turnstile script from here after the click (its
// cloud_flare_js_url). The page never contacts this host before, so its connection is always cold.
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

// Runs in the page: Turnstile's iframe may sit inside one or more shadow roots.
export function isFrameUnobstructed(element: Element, point: { x: number; y: number }): boolean {
  let target = element;
  for (;;) {
    const root = target.getRootNode();
    if (root instanceof ShadowRoot) {
      if (root.elementFromPoint(point.x, point.y) !== target) return false;
      target = root.host;
    } else return document.elementFromPoint(point.x, point.y) === target;
  }
}

// Click the actual checkbox inside a visible, standard-size Turnstile widget. The iframe can
// scale with browser zoom, so a fixed offset from its edge can miss the checkbox itself.
export async function clickVisibleTurnstileCheckbox(page: Page, signal?: AbortSignal): Promise<boolean> {
  // Locator waits follow the iframe and its cross-origin checkbox as they appear. One bounded
  // wait avoids returning to the buyer's outer loop while the widget is still loading.
  const frames = page.locator('iframe[src^="https://challenges.cloudflare.com/"]:visible');
  const until = Date.now() + 1800;
  if (!await frames.count()) {
    try { await frames.first().waitFor({ state: 'visible', timeout: Math.max(1, until - Date.now()) }); }
    catch { signal?.throwIfAborted(); return false; }
  }
  for (let index = 0, count = await frames.count(); index < count; index++) {
    signal?.throwIfAborted();
    const frame = frames.nth(index);
    try {
      if (!await frame.isVisible()) continue;
      await frame.scrollIntoViewIfNeeded({ timeout: Math.max(1, Math.min(1000, until - Date.now())) });
    } catch { signal?.throwIfAborted(); continue; } // The widget can replace its iframe while loading.
    const checkbox = frame.contentFrame().getByRole('checkbox');
    let rect;
    let box;
    let viewport;
    try {
      if (await checkbox.count() !== 1 || !await checkbox.isVisible()) {
        await checkbox.waitFor({ state: 'visible', timeout: Math.max(1, until - Date.now()) });
      }
      signal?.throwIfAborted();
      if (await checkbox.count() !== 1 || !await checkbox.isVisible() || await checkbox.isChecked({ timeout: 1000 })) continue;
      [rect, box] = await Promise.all([
        frame.boundingBox({ timeout: 1000 }), checkbox.boundingBox({ timeout: 1000 }),
      ]);
      viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    } catch { signal?.throwIfAborted(); continue; } // Retry later if Turnstile refreshed between reads.
    if (!rect || rect.width < 250 || rect.width > 400 || rect.height < 50 || rect.height > 110 ||
        rect.x < 0 || rect.y < 0 || rect.x + rect.width > viewport.width ||
        rect.y + rect.height > viewport.height) continue;
    if (!box || box.width < 18 || box.height < 18 || box.height > 40 ||
        box.x < rect.x || box.y < rect.y || box.x + box.width > rect.x + rect.width ||
        box.y + box.height > rect.y + rect.height) continue;
    // The input also covers its label. Aim at the centre of its square on the left.
    const x = box.x + Math.min(12, box.height / 2);
    const y = box.y + box.height / 2;
    // A completed challenge or an overlay can move during the wait. Never click through it.
    try {
      const [state, unobstructed] = await Promise.all([
        page.evaluate(readNbuPage, false),
        frame.evaluate(isFrameUnobstructed, { x, y }),
      ]);
      if (!state.turnstile || state.inCart || state.challenge || !unobstructed ||
          x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) continue;
    } catch { signal?.throwIfAborted(); continue; }
    signal?.throwIfAborted();
    await page.mouse.move(x, y);
    signal?.throwIfAborted();
    await page.mouse.click(x, y, { delay: 120 });
    return true;
  }
  return false;
}

// Connection hints: Chrome resolves DNS and opens TCP/TLS, without any request. A hint starts on
// insertion, so each element is removed at once. Measured through a profile's proxy after 2.5 min idle:
// the next reload sent its request after 5 ms instead of 495–731 ms.
export async function warmConnection(cdp: CDPSession): Promise<void> {
  await evaluateInWorld(cdp, `(() => {
    for (const origin of [location.origin, ${JSON.stringify(TURNSTILE_ORIGIN)}]) {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      (document.head || document.documentElement).appendChild(link);
      link.remove();
    }
  })()`);
}

// A real mouse click on the buy button: one DevTools round trip to aim, then move, press and release are
// sent back to back without waiting on each other. Falls back to the DOM click if the mouse missed,
// so a covered or zoomed button never costs the 11 s click cooldown.
export async function clickBuyButton(cdp: CDPSession, page: Page): Promise<'mouse' | 'dom'> {
  const { result } = await evaluateInWorld(cdp, aimExpression());
  const fields = Object.fromEntries(((result.preview as Preview | undefined)?.properties ?? []).map((item) => [item.name, item.value]));
  const release = () => { if (result.objectId) void cdp.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {}); };
  if (fields.ready !== 'true') { release(); throw new Error('Page state changed before purchase click'); }
  if (fields.aimed === 'true') {
    const x = Number(fields.x), y = Number(fields.y);
    await Promise.all([
      cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }),
      cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }),
      cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }),
    ]);
    // Input events are acknowledged after the page handled them, so the listener has already run.
    const check = await cdp.send('Runtime.callFunctionOn', { objectId: result.objectId,
      functionDeclaration: 'function () { return this.trusted; }', returnByValue: true }).catch(() => undefined);
    release();
    if (check?.result.value === true) return 'mouse';
  } else release();
  try { await page.evaluate(readNbuPage, true); }
  catch (error) {
    // The page already reacted to the mouse (pending, queue or cart): that click counted.
    if (fields.aimed === 'true' && error instanceof Error && error.message.includes('Page state changed')) return 'mouse';
    throw error;
  }
  return 'dom';
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

export async function waitForPurchaseChangePage(page: Page, timeoutMs: number): Promise<PageState> {
  // The buy handler changes this page when Turnstile, the queue or the cart is ready. Observe
  // those changes locally; an already pending button must not release the waiter immediately.
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(1000, timeoutMs)) : 1000;
  const expression = `new Promise((resolve) => {
    const read = ${readNbuPage.toString()};
    let finished = false;
    let timer;
    const observer = new MutationObserver(check);
    function finish(state) {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(state);
    }
    function check() {
      if (finished) return;
      const state = read();
      if (state.rateLimited || state.inCart || state.challenge || state.turnstile || state.queuePosition ||
          state.login !== 'logged-in') finish(state);
    }
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(() => finish(read()), ${timeout});
    check();
  })`;
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
