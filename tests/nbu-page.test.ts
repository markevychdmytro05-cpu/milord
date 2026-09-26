import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readNbuPage, assertShopPage, waitForActionablePage } from '../src/browser/nbu-page';
import type { Page } from 'playwright-core';

let dom: JSDOM | undefined;
function page(markup = '') {
  dom = new JSDOM(`<form name="cart_quantity"><input name="products_id" value="42" />
    <input name="cid_id" value="17" /><div id="r_buy_intovar"><button type="submit" class="buy">Купити</button>
    ${markup}</div></form>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  const button = dom.window.document.querySelector('button')!;
  vi.spyOn(button, 'getClientRects').mockReturnValue([{ width: 100, height: 20 }] as unknown as DOMRectList);
  return dom.window.document;
}
afterEach(() => { vi.unstubAllGlobals(); dom?.window.close(); });

describe('NBU page recognition from the ported selectors', () => {
  it('recognizes a logged-in customer and available button', () => {
    page();
    expect(readNbuPage()).toMatchObject({ login: 'logged-in', buyAvailable: true, inCart: false });
  });
  it.each(['clicked', 'limited'])('does not reuse a %s button', (className) => {
    page().querySelector('button')!.classList.add(className);
    expect(readNbuPage()).toMatchObject({ buyAvailable: false, buyUnavailableReason: className === 'clicked' ? 'pending' : 'limited' });
  });
  it.each([
    ['form', 'missing-form'], ['[name="products_id"]', 'missing-product'], ['button', 'missing-button'],
  ])('explains missing purchase elements: %s', (selector, reason) => {
    page().querySelector(selector)!.remove();
    expect(readNbuPage()).toMatchObject({ buyAvailable: false, buyUnavailableReason: reason });
  });
  it('distinguishes a disabled button from a hidden one', () => {
    const button = page().querySelector('button')!;
    button.disabled = true;
    expect(readNbuPage().buyUnavailableReason).toBe('disabled-button');
    button.disabled = false;
    button.style.visibility = 'hidden';
    expect(readNbuPage().buyUnavailableReason).toBe('hidden-button');
  });
  it('recognizes a login link and a cart confirmation', () => {
    page('<a class="login">Увійти</a><a href="shopping_cart.php">Кошик</a>');
    expect(readNbuPage()).toMatchObject({ login: 'logged-out', inCart: true });
  });
  it('does not block on an empty invisible Turnstile placeholder', () => {
    page('<div class="cf-turnstile"></div>');
    expect(readNbuPage().turnstile).toBe(false);
  });
  it('recognizes a visible verification widget', () => {
    const document = page('<div class="cf-turnstile"></div>');
    vi.spyOn(document.querySelector('.cf-turnstile')!, 'getBoundingClientRect')
      .mockReturnValue({ width: 300, height: 65 } as DOMRect);
    expect(readNbuPage().turnstile).toBe(true);
  });
  it('validates and dispatches exactly one native click in the same page operation', () => {
    const document = page();
    const clicked = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('button')!.addEventListener('click', clicked);
    readNbuPage(true);
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it('wakes the browser observer on a button change without clicking it', async () => {
    const document = page();
    const button = document.querySelector('button')!;
    button.disabled = true;
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    const browserPage = { evaluate: (expression: string) => dom!.window.eval(expression) } as unknown as Page;
    const result = waitForActionablePage(browserPage, 200);
    button.disabled = false;
    expect((await result).buyAvailable).toBe(true);
    expect(clicked).not.toHaveBeenCalled();
  });
  it('releases the observer on timeout without a reload or click', async () => {
    const document = page();
    document.querySelector('button')!.disabled = true;
    const browserPage = { evaluate: (expression: string) => dom!.window.eval(expression) } as unknown as Page;
    expect((await waitForActionablePage(browserPage, 5)).buyAvailable).toBe(false);
  });
  it.each(['<a href="shopping_cart.php">Кошик</a>', '<span id="cart-queue-position">12</span>',
    '<a class="login">Увійти</a>'])('refuses a click when page state changed: %s', (markup) => {
    const document = page(markup);
    const clicked = vi.fn();
    document.querySelector('button')!.addEventListener('click', clicked);
    expect(() => readNbuPage(true)).toThrow('Page state changed');
    expect(clicked).not.toHaveBeenCalled();
  });
  it('rejects navigation to a different product sharing the same PHP path', () => {
    const fake = { url: () => 'https://coins.bank.gov.ua/product_info.php?products_id=2' } as Page;
    expect(() => assertShopPage(fake, 'https://coins.bank.gov.ua/product_info.php?products_id=1')).toThrow();
  });
});

it('detects a visible second widget even when the first placeholder is hidden', () => {
  const document = page('<div class="cf-turnstile"></div><div class="cf-turnstile" id="active-verification"></div>');
  vi.spyOn(document.querySelector('#active-verification')!, 'getBoundingClientRect')
    .mockReturnValue({ width: 300, height: 65 } as DOMRect);
  expect(readNbuPage().turnstile).toBe(true);
  const clicked = vi.fn();
  document.querySelector('button')!.addEventListener('click', clicked);
  expect(() => readNbuPage(true)).toThrow('Page state changed');
  expect(clicked).not.toHaveBeenCalled();
});

it('stops treating a widget as completed when the site removes its success state', () => {
  const document = page('<div class="cf-turnstile success"></div>');
  const widget = document.querySelector('.cf-turnstile')!;
  vi.spyOn(widget, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 65 } as DOMRect);
  expect(readNbuPage().turnstile).toBe(false);
  widget.classList.remove('success');
  expect(readNbuPage().turnstile).toBe(true);
  expect(() => readNbuPage(true)).toThrow('Page state changed');
});

it('distinguishes a successful verification from a submitted purchase still pending', () => {
  const document = page('<div class="cf-turnstile success"></div>');
  document.querySelector('button')!.classList.add('clicked');
  expect(readNbuPage()).toMatchObject({ turnstile: false, purchasePending: true, buyAvailable: false, inCart: false });
});

it('does not repeat a purchase while its visible loading spinner remains', () => {
  const document = page('<div id="prodBtnLoadingSpinner"></div>');
  vi.spyOn(document.querySelector('#prodBtnLoadingSpinner')!, 'getClientRects')
    .mockReturnValue([{ width: 20, height: 20 }] as unknown as DOMRectList);
  expect(readNbuPage()).toMatchObject({ purchasePending: true, buyAvailable: false });
  expect(() => readNbuPage(true)).toThrow('Page state changed');
});

it.each(['<h1>429 Помилка</h1>', '<title>Помилка 429 - Національний банк</title>',
  '<h2>Too Many Requests</h2>'])('recognizes rate limiting and refuses a purchase: %s', (markup) => {
  page(markup);
  expect(readNbuPage().rateLimited).toBe(true);
  expect(() => readNbuPage(true)).toThrow('Page state changed');
});

it('confirms exact product IDs and quantities in the visible, unexpired cart only', async () => {
  const { readVisibleCartProductIds } = await import('../src/browser/nbu-page');
  const row = (id: string, quantity: string, timer: string) => `<div class="cartContent_body">
    <input name="products_id[]" value="${id}"><select name="cart_quantity[]"><option>${quantity}</option></select>
    <div class="cart-item-timer"><div class="timer-numbers">${timer}</div></div></div>`;
  const document = page(`<div id="modal_cart_popup">${row('1126', '1', '29 : 30')}${row('885', '1', '00:15')}
    ${row('123', '0', '28:00')}${row('456', '1', '00:00')}${row('789', '1', '')}</div>`);
  const popup = document.querySelector('#modal_cart_popup')!;
  const rects = vi.spyOn(popup, 'getClientRects').mockReturnValue([{ width: 500, height: 300 }] as unknown as DOMRectList);
  expect(readVisibleCartProductIds()).toEqual(['1126', '885']);
  rects.mockReturnValue([] as unknown as DOMRectList);
  expect(readVisibleCartProductIds()).toEqual([]);
});
