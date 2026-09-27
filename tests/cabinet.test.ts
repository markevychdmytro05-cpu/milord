import { JSDOM } from 'jsdom';
import { chromium, type Browser } from 'patchright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCabinetPage } from '../src/browser/cabinet-page';
import { CabinetReader, fetchCabinetDocument } from '../src/browser/cabinet';
import { AdsPowerClient, AdsPowerConnectionError, PreparationGate } from '../src/browser/adspower';
import { ShopRequestGuard, UserFacingError } from '../src/core/shop-errors';
import { CabinetCache } from '../src/main/cabinet-cache';

const login = '<a href="logoff.php">Вийти</a>';
const orders = `${login}<div class="col-account-content"><table id="account_history_table"><tbody><tr>
<td>123</td><td>27.08.2026</td><td>2</td><td>1 234,50 грн</td><td>Оплачено</td>
<td><a href="print_my_invoice.php?order_id=123">Квитанція</a><a href="https://track.ukrposhta.ua/tracking_UA.html?barcode=123456">123456</a></td>
<td><a href="account_history_info.php?order_id=123">Дивитись</a></td></tr></tbody></table>
<a href="account_history.php?page=2">2</a><a href="https://evil.invalid/account_history.php?page=3">3</a></div>`;
const wishlist = `${login}<div class="content-wishList-wrap"><div class="none-customers-wishlist">Немає продукції, доданої до бажаного</div></div>`;
const cart = `<form id="popup_cart_form"><div class="cartContent_body"><input name="products_id[]" value="42">
<div class="product_name"><a href="coin/p-42.html">Монета</a></div><div class="product_price">1 000 грн</div>
<select name="cart_quantity[]"><option value="2" selected>2 шт</option></select><div class="product_total">2 000 грн</div>
<div class="cart-item-timer" data-expired="2026-09-26 12:30:00"></div><button onclick="throw Error('must not click')">Видалити</button></div></form>`;
let dom: JSDOM;
beforeEach(() => { dom = new JSDOM(''); vi.stubGlobal('DOMParser', dom.window.DOMParser); });
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('cabinet DOM extraction', () => {
  it('reads order summaries and pagination without receipt actions or foreign links', () => {
    expect(readCabinetPage({ section: 'orders', html: orders })).toEqual({ orders: [{ id: '123', date: '27.08.2026',
      quantity: 2, total: 1234.5, status: 'Оплачено', tracking: '123456' }], nextPage: 2 });
  });
  it('reads cart quantities, prices and reservation timestamps without submitting the form', () => {
    expect(readCabinetPage({ section: 'cart', html: cart }).products?.[0]).toMatchObject({ id: '42', name: 'Монета',
      quantity: 2, price: 1000, total: 2000, reservedUntil: '2026-09-26 12:30:00' });
  });
  it('extracts cart photos and normalizes relative and lazy image URLs', () => {
    for (const image of ['<img src="images/coin.jpg">', '<img src="data:image/gif;base64,AAAA" data-src="/images/coin.jpg">', '<img data-original="//coins.bank.gov.ua/images/coin.jpg">']) {
      const html = cart.replace('<div class="product_name">', image + '<div class="product_name">');
      expect(readCabinetPage({ section: 'cart', html }).products?.[0]?.imageUrl).toBe('https://coins.bank.gov.ua/images/coin.jpg');
    }
  });
  it('keeps products without photos and ignores external or invalid photo URLs', () => {
    for (const source of ['https://example.org/coin.jpg', 'javascript:alert(1)', 'file:///tmp/coin.jpg', 'https://coins.bank.gov.ua.evil.invalid/a.jpg', 'http://[']) {
      const html = cart.replace('<div class="product_name">', `<img src="${source}"><div class="product_name">`);
      const result = readCabinetPage({ section: 'cart', html });
      expect(result.products).toHaveLength(1);
      expect(result.products?.[0]?.imageUrl).toBeUndefined();
    }
  });
  it('associates wishlist photos with the correct product', () => {
    const html = `${login}<div class="content-wishList-wrap">${[42, 43].map(id => `<div>
      <a href="coin/p-${id}.html"><img src="/images/${id}.jpg"></a>
      <a href="coin/p-${id}.html">Монета ${id}</a><span class="new_price">50 грн</span></div>`).join('')}</div>`;
    expect(readCabinetPage({ section: 'wishlist', html }).products?.map(p => [p.id, p.imageUrl])).toEqual([
      ['42', 'https://coins.bank.gov.ua/images/42.jpg'], ['43', 'https://coins.bank.gov.ua/images/43.jpg'],
    ]);
  });
  it('distinguishes recognized empty lists from broken HTML and login/challenge pages', () => {
    expect(readCabinetPage({ section: 'wishlist', html: wishlist })).toEqual({ products: [] });
    expect(readCabinetPage({ section: 'cart', html: '<h1>Ваш кошик порожній</h1>' })).toEqual({ products: [] });
    expect(readCabinetPage({ section: 'orders', html: login + '<main>Something changed</main>' }).error).toBe('unrecognized');
    expect(readCabinetPage({ section: 'orders', html: '<input type="password">' }).error).toBe('login');
    expect(readCabinetPage({ section: 'orders', html: '<title>Establishing a secure connection</title>' }).error).toBe('challenge');
    expect(readCabinetPage({ section: 'cart', html: '<h1>429 Too Many Requests</h1>' }).error).toBe('rate-limit');
  });
  it('reads wishlist product links while ignoring action links', () => {
    const html = `${login}<div class="content-wishList-wrap"><div><a href="coin/p-42.html">Монета</a><span class="new_price">50 грн</span>
      <a href="coin/p-42.html?action=add_product">Купити</a></div></div>`;
    expect(readCabinetPage({ section: 'wishlist', html }).products).toEqual([
      { id: '42', name: 'Монета', price: 50, total: 50, quantity: 1, url: 'https://coins.bank.gov.ua/coin/p-42.html' },
    ]);
  });
  it('reads the live NBU wishlist table with CDN lazy photos and unlabelled price cells', () => {
    const html = `${login}<div class="content-wishList-wrap"><div class="table-responsive">
      <table id="wishlist_table" class="typical_table"><thead><tr><th>Зображення</th><th>Назва</th><th>Вартість</th><th></th></tr></thead>
      <tbody>${[1126, 1127].map((id, i) => `<tr>
        <td class="productListing-data"><a href="arhistratig-mihajil-c-/p-${id}.html">
          <img class="lazyload" src="https://cdn-nbu.solomono.net/bank/images/pixel_trans.png"
            data-src="https://cdn-nbu.solomono.net/bank/images/cache/100x100/coin-${id}.png"></a></td>
        <td class="productListing-data"><a href="arhistratig-mihajil-c-/p-${id}.html">Архістратиг Михаїл ${id}</a></td>
        <td class="productListing-data">${i ? '5 000' : '4   969'} грн</td>
        <td><a href="wishlist.php?delete_prod=${id}">Видалити</a><button data-id="${id}">Купити</button></td>
      </tr>`).join('')}</tbody></table></div></div>`;
    expect(readCabinetPage({ section: 'wishlist', html }).products?.map(p => [p.id, p.price, p.imageUrl])).toEqual([
      ['1126', 4969, 'https://cdn-nbu.solomono.net/bank/images/cache/100x100/coin-1126.png'],
      ['1127', 5000, 'https://cdn-nbu.solomono.net/bank/images/cache/100x100/coin-1127.png'],
    ]);
    const cartHtml = cart.replace('<div class="product_name">', '<img data-src="https://cdn-nbu.solomono.net/bank/images/coin.png"><div class="product_name">');
    expect(readCabinetPage({ section: 'cart', html: cartHtml }).products?.[0]?.imageUrl).toBe('https://cdn-nbu.solomono.net/bank/images/coin.png');
  });
  it('reads detail fields and row totals, and refuses a different order ID', () => {
    const html = `${login}<div class="col-account-content"><h1>Замовлення #123</h1><div id="account_order_info">
      <h2>Адреса доставки</h2><h4>Тестова адреса</h4><span class="payment-method-text">LiqPay</span>
      <div class="account_delivery_method"><div>Сума:</div><div>100 грн</div></div>
      <div class="account_delivery_method"><div>Укрпошта:</div><div>За тарифами перевізника</div></div>
      <div id="ot_sum">100 грн</div><div class="account_product"><div class="qty-text"><span class="qty">2 x </span>Монета</div>
      <strong class="currency-value-text">100 грн</strong></div></div>
      <table id="account_history_table"><tbody><tr><td>2026-08-27 10:00:00</td><td>Оплачено</td></tr></tbody></table></div>`;
    expect(readCabinetPage({ section: 'detail', orderId: '123', html }).details).toMatchObject({ id: '123', total: 100,
      address: 'Тестова адреса', payment: 'LiqPay', delivery: 'Укрпошта', products: [{ quantity: 2, price: 50, total: 100 }],
      history: [{ at: '2026-08-27 10:00:00', status: 'Оплачено' }] });
    expect(readCabinetPage({ section: 'detail', orderId: '999', html }).error).toBe('unrecognized');
  });
});

describe('cabinet request cache', () => {
  it('deduplicates concurrent reads and retains successes for a minute after completion', async () => {
    let now = 0; const cache = new CabinetCache(() => now);
    const read = vi.fn(async () => ({ count: 3 }));
    const [a, b] = await Promise.all([cache.get('profile', read), cache.get('profile', read)]);
    expect(a).toEqual(b); expect(read).toHaveBeenCalledTimes(1);
    now = 59_999; await cache.get('profile', read); expect(read).toHaveBeenCalledTimes(1);
    now = 60_000; await cache.get('profile', read); expect(read).toHaveBeenCalledTimes(2);
  });
  it('caches failures too and isolates different profiles', async () => {
    const cache = new CabinetCache(() => 0); const read = vi.fn(async () => { throw Error('429'); });
    await expect(cache.get('a', read)).rejects.toThrow('429');
    await expect(cache.get('a', read)).rejects.toThrow('429');
    expect(read).toHaveBeenCalledTimes(1);
    await expect(cache.get('b', async () => 2)).resolves.toBe(2);
  });
});

function browserFixture(firstHtml = orders, limited = false, openProfile = false) {
  const paths: string[] = [];
  const shopPage = {
    goto: vi.fn(), reload: vi.fn(), isClosed: () => false,
    url: () => 'https://coins.bank.gov.ua/coin/p-42.html',
    bringToFront: vi.fn(), close: vi.fn(),
    evaluate: vi.fn(async (fn: unknown, input: any) => {
      if (fn === readCabinetPage) return readCabinetPage(input);
      if (fn !== fetchCabinetDocument) return;
      paths.push(input.path);
      return { status: limited && input.path === '/wishlist.php' ? 429 : 200,
        path: input.path.split('?')[0], retryAfter: '60',
        html: input.path.startsWith('/account_history') ? firstHtml : input.path === '/wishlist.php' ? wishlist : cart };
    }),
  };
  const foreignPage = { close: vi.fn(), goto: vi.fn(), isClosed: () => false, url: () => 'https://example.org/' };
  const close = vi.fn(async () => {}), newPage = vi.fn();
  const pages = [foreignPage, shopPage];
  vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue({ contexts: () => [{ newPage, pages: () => pages, on: vi.fn() }], close } as unknown as Browser);
  const client = new AdsPowerClient('http://localhost:50325', '');
  const active = vi.spyOn(client, 'active').mockResolvedValue('ws://localhost:54321/devtools/browser/test');
  const start = vi.spyOn(client, 'start');
  const guard = new ShopRequestGuard();
  const reader = new CabinetReader(client, guard, new PreparationGate(0), undefined, openProfile);
  return { reader, shopPage, foreignPage, close, guard, paths, active, start, newPage, pages };
}
it('reads three documents through the existing session without starting, navigating, focusing or closing tabs', async () => {
  const { reader, paths, shopPage, foreignPage, close, newPage, start } = browserFixture();
  const result = await reader.load('a', new AbortController().signal);
  expect(result.orders).toHaveLength(1); expect(result.nextOrdersPage).toBe(2);
  expect(result.cart).toHaveLength(1); expect(result.wishlist).toEqual([]);
  expect(paths).toEqual(['/account_history.php?page=1', '/wishlist.php', '/popup_cart.php']);
  for (const operation of [shopPage.goto, shopPage.reload, shopPage.close, shopPage.bringToFront,
    foreignPage.close, foreignPage.goto, newPage, start]) expect(operation).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
it('makes a single cart request for a background refresh', async () => {
  const { reader, paths } = browserFixture();
  const result = await reader.load('a', new AbortController().signal, ['cart']);
  expect(paths).toEqual(['/popup_cart.php']);
  expect(result.cart).toHaveLength(1);
  expect(result.orders).toBeUndefined(); expect(result.wishlist).toBeUndefined();
});
it('stops making requests after 429 and preserves the already loaded order list', async () => {
  const { reader, paths, guard } = browserFixture(orders, true);
  const result = await reader.load('a', new AbortController().signal);
  expect(result.orders).toHaveLength(1); expect(result.cart).toBeUndefined();
  expect(result.errors.wishlist).toContain('429'); expect(result.errors.cart).toContain('429');
  expect(paths).toEqual(['/account_history.php?page=1', '/wishlist.php']); expect(guard.isBlocked()).toBe(true);
});
it('reports login without navigating or focusing the existing tab', async () => {
  const { reader, shopPage, paths } = browserFixture('<input type="password">');
  await expect(reader.load('a', new AbortController().signal)).rejects.toThrow('Увійдіть');
  expect(paths).toEqual(['/account_history.php?page=1']);
  expect(shopPage.close).not.toHaveBeenCalled(); expect(shopPage.bringToFront).not.toHaveBeenCalled();
  expect(shopPage.goto).not.toHaveBeenCalled();
});
it('does not launch a closed profile or create a missing shop tab', async () => {
  const { reader, active, start, pages, newPage, paths } = browserFixture();
  active.mockResolvedValueOnce(undefined);
  await expect(reader.load('a', new AbortController().signal)).rejects.toThrow('Профіль закритий');
  expect(chromium.connectOverCDP).not.toHaveBeenCalled();
  pages.pop();
  await expect(reader.load('a', new AbortController().signal)).rejects.toThrow('Відкрийте вкладку');
  expect(start).not.toHaveBeenCalled(); expect(newPage).not.toHaveBeenCalled(); expect(paths).toEqual([]);
});
it('uses only allowed GET paths and the existing cookies, cleaning up its abort controller', async () => {
  vi.stubGlobal('location', { origin: 'https://coins.bank.gov.ua' });
  const request = vi.fn().mockResolvedValue({ status: 200, url: 'https://coins.bank.gov.ua/popup_cart.php',
    headers: new Headers(), text: async () => cart });
  vi.stubGlobal('fetch', request);
  const args = { path: '/popup_cart.php', ajax: true, requestKey: '__cabinet_test' };
  expect((await fetchCabinetDocument(args)).html).toBe(cart);
  expect(request).toHaveBeenCalledWith('/popup_cart.php', expect.objectContaining({ method: 'GET', credentials: 'same-origin',
    headers: { 'X-Requested-With': 'XMLHttpRequest' } }));
  expect(Reflect.has(globalThis, args.requestKey)).toBe(false);
  for (const path of ['/checkout.php', '/popup_cart.php?action=update_product', 'https://example.org/', '/account_history.php?page=1&action=delete']) {
    await expect(fetchCabinetDocument({ ...args, path })).rejects.toThrow('Unsupported');
  }
  vi.stubGlobal('location', { origin: 'https://example.org' });
  await expect(fetchCabinetDocument(args)).rejects.toThrow('changed origin');
  expect(request).toHaveBeenCalledTimes(1);
});
it('cancels only its own in-flight read', async () => {
  vi.stubGlobal('location', { origin: 'https://coins.bank.gov.ua' });
  vi.stubGlobal('fetch', vi.fn((_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
  })));
  const requestKey = '__cabinet_cancel';
  const pending = fetchCabinetDocument({ path: '/wishlist.php', ajax: false, requestKey });
  Reflect.get(globalThis, requestKey).abort();
  await expect(pending).rejects.toThrow('cancelled');
  expect(Reflect.has(globalThis, requestKey)).toBe(false);
});

it('reads combined orders and their component rows without detail links', () => {
  const parent = orders.replace('<td>123</td>', '<td>900</td>');
  const component = `<tr class="sum-account-ttn-row" data-id="900"><td>901</td><td>27.08.2026</td>
    <td>1</td><td>500 грн</td><td>Об'єднано в №900</td><td></td><td></td></tr>`;
  const result = readCabinetPage({ section: 'orders', html: parent.replace('</tbody>', component + '</tbody>') });
  expect(result.error).toBeUndefined();
  expect(result.orders).toHaveLength(2);
  expect(result.orders?.[0]).toMatchObject({ id: '900', detailId: '123' });
  expect(result.orders?.[1]).toEqual({ id: '901', mergedInto: '900', date: '27.08.2026', quantity: 1,
    total: 500, status: "Об'єднано в №900", tracking: '' });
  expect(result.nextPage).toBe(2);
});
it('still rejects unknown rows and mismatched combined-order markers', () => {
  const row = `<tr class="sum-account-ttn-row" data-id="900"><td>901</td><td>27.08.2026</td>
    <td>1</td><td>500 грн</td><td>Об’єднано в №999</td><td></td><td></td></tr>`;
  expect(readCabinetPage({ section: 'orders', html: orders.replace('</tbody>', row + '</tbody>') }).error).toBe('unrecognized');
  expect(readCabinetPage({ section: 'orders', html: orders.replace('account_history_info.php?order_id=123', '/unknown.php') }).error).toBe('unrecognized');
});
it('fetches combined details by their URL ID while verifying the displayed order number', async () => {
  const html = `${login}<div class="col-account-content"><h1>Замовлення #900</h1><div id="account_order_info">
    <div class="account_product"><span class="qty-text"><span class="qty">1 x </span>Монета</span>
    <span class="currency-value-text">500 грн</span></div></div></div>`;
  const { reader, paths } = browserFixture(html);
  expect((await reader.order('a', '900', new AbortController().signal, '123')).id).toBe('900');
  expect(paths).toEqual(['/account_history_info.php?order_id=123']);
  await expect(reader.order('a', '999', new AbortController().signal, '123')).rejects.toThrow('Не вдалося розпізнати');
});

it('manual refresh starts a closed profile and opens the shop in a new tab', async () => {
  const { reader, active, start, pages, newPage, shopPage, foreignPage, close } = browserFixture(orders, false, true);
  active.mockResolvedValueOnce(undefined);
  start.mockResolvedValueOnce('ws://localhost:54321/devtools/browser/test');
  pages.pop(); newPage.mockResolvedValueOnce(shopPage);
  expect((await reader.load('a', new AbortController().signal)).cart).toHaveLength(1);
  expect(start).toHaveBeenCalledOnce(); expect(newPage).toHaveBeenCalledOnce();
  expect(shopPage.goto).toHaveBeenCalledWith('https://coins.bank.gov.ua/', expect.objectContaining({ waitUntil: 'domcontentloaded' }));
  expect(foreignPage.goto).not.toHaveBeenCalled(); expect(shopPage.close).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
it('manual refresh uses the launch-capable start path when AdsPower is unavailable', async () => {
  const { reader, active, start } = browserFixture(orders, false, true);
  active.mockRejectedValueOnce(new AdsPowerConnectionError('Local API недоступний'));
  start.mockResolvedValueOnce('ws://localhost:54321/devtools/browser/test');
  expect((await reader.load('a', new AbortController().signal)).orders).toHaveLength(1);
  expect(start).toHaveBeenCalledOnce();
});
it('manual refresh reuses an open profile and shop tab', async () => {
  const { reader, start, newPage, shopPage } = browserFixture(orders, false, true);
  await reader.load('a', new AbortController().signal);
  expect(start).not.toHaveBeenCalled(); expect(newPage).not.toHaveBeenCalled();
  expect(shopPage.goto).not.toHaveBeenCalled(); expect(shopPage.bringToFront).not.toHaveBeenCalled();
});
it('does not try to start a profile after an API authorization error', async () => {
  const { reader, active, start } = browserFixture(orders, false, true);
  active.mockRejectedValueOnce(new UserFacingError('Перевірте API-ключ'));
  await expect(reader.load('a', new AbortController().signal)).rejects.toThrow('API-ключ');
  expect(start).not.toHaveBeenCalled();
});
it('does not launch AdsPower during a background refresh', async () => {
  const { reader, active, start } = browserFixture();
  active.mockRejectedValueOnce(new AdsPowerConnectionError('Local API недоступний'));
  await expect(reader.load('a', new AbortController().signal, ['cart'])).rejects.toThrow('Local API');
  expect(start).not.toHaveBeenCalled();
});
it('respects a rate limit when opening a missing shop tab', async () => {
  const { reader, pages, newPage, shopPage, paths, guard } = browserFixture(orders, false, true);
  pages.pop(); newPage.mockResolvedValueOnce(shopPage);
  shopPage.goto.mockResolvedValueOnce({ status: () => 429, headers: () => ({ 'retry-after': '60' }) });
  await expect(reader.load('a', new AbortController().signal)).rejects.toThrow('429');
  expect(guard.isBlocked()).toBe(true); expect(paths).toEqual([]);
});
it('does not start a profile if cancellation arrives during the active check', async () => {
  const { reader, active, start } = browserFixture(orders, false, true);
  const controller = new AbortController();
  active.mockImplementationOnce(async () => { controller.abort(); throw new AdsPowerConnectionError('Local API'); });
  await expect(reader.load('a', controller.signal)).rejects.toThrow('зупинено');
  expect(start).not.toHaveBeenCalled();
});
