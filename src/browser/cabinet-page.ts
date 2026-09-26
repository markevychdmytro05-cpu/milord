import type { CabinetOrder, CabinetOrderDetails, CabinetProduct, CabinetSection } from '../core/cabinet';

export interface CabinetPageResult {
  error?: 'login' | 'challenge' | 'rate-limit' | 'unrecognized';
  orders?: CabinetOrder[];
  products?: CabinetProduct[];
  details?: CabinetOrderDetails;
  nextPage?: number;
}

// Serialized into the profile browser. Parse response HTML in an inert document: no scripts,
// checkout buttons, quantity controls or cart expiry handlers are executed.
export function readCabinetPage(input: { section: CabinetSection | 'detail'; html?: string; orderId?: string; page?: number }): CabinetPageResult {
  const doc = input.html === undefined ? document : new DOMParser().parseFromString(input.html, 'text/html');
  const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0,2000);
  const price = (value: string): number | null => {
    const match = value.replace(/[\s\u00a0\u202f]/g, '').match(/\d[\d.,]*/);
    if (!match) return null;
    let numeric = match[0];
    if (numeric.includes(',') && numeric.includes('.')) numeric = numeric.replace(/\./g, '').replace(',', '.');
    else numeric = numeric.replace(',', '.');
    const number = Number(numeric);
    return Number.isFinite(number) ? number : null;
  };
  const quantity = (value: string): number | null => {
    const match = value.match(/\d+/); return match ? Number(match[0]) : null;
  };
  const links = [...doc.querySelectorAll<HTMLAnchorElement>('a[href]')];
  const pathOf = (a: HTMLAnchorElement) => {
    try { return new URL(a.getAttribute('href')!, 'https://coins.bank.gov.ua/'); } catch { return undefined; }
  };
  const title = text(doc.querySelector('title'));
  if (/429|too many requests/i.test(title) || [...doc.querySelectorAll('h1,h2')].some(h => /\b429\b|too many requests/i.test(text(h)))) return { error: 'rate-limit' };
  if (doc.querySelector('script[src*=".bunny-shield"], .cf-turnstile:not(.success)') || /Establishing a secure connection/i.test(title)) return { error: 'challenge' };
  if (doc.querySelector('input[type="password"], form[name="login"]')) return { error: 'login' };
  const authenticated = links.some(a => pathOf(a)?.pathname === '/logoff.php');
  const root = doc.querySelector('.col-account-content');
  if (input.section !== 'cart' && !authenticated) return { error: 'login' };
  if (input.section === 'orders') {
    const table = doc.querySelector('#account_history_table');
    if (!table) {
      if (root && /(?:немає|нема|не маєте|жодного).{0,60}замовлен|не (?:робили|здійснювали).{0,40}замовлен/i.test(text(root))) return { orders: [] };
      return { error: 'unrecognized' };
    }
    const orders: CabinetOrder[] = [];
    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = [...row.querySelectorAll('td')];
      const link = row.querySelector<HTMLAnchorElement>('a[href*="account_history_info.php"]');
      const detailUrl = link ? pathOf(link) : undefined;
      const detailId = detailUrl?.origin === 'https://coins.bank.gov.ua' && detailUrl.pathname === '/account_history_info.php'
        ? detailUrl.searchParams.get('order_id') : undefined;
      const id = text(cells[0]);
      const status = text(cells[4]);
      const mergedInto = row.classList.contains('sum-account-ttn-row') ? row.getAttribute('data-id') : undefined;
      const merged = !link && mergedInto && /^\d+$/.test(mergedInto)
        && /^Об[’'ʼ]?єднано\s+в\s*№\s*\d+$/i.test(status)
        && status.match(/\d+$/)?.[0] === mergedInto;
      if (!/^\d+$/.test(id) || cells.length < 6 || (!merged && (!detailId || !/^\d+$/.test(detailId)))) return { error: 'unrecognized' };
      const trackingLink = cells[5]?.querySelector<HTMLAnchorElement>('a[href*="tracking"], a[href*="novaposhta"], a[href*="barcode"]');
      const tracking = text(trackingLink) || text(cells[5]).replace(/Квитанція/g, '').trim();
      orders.push({ id, ...(merged ? { mergedInto } : detailId !== id ? { detailId: detailId! } : {}),
        date: text(cells[1]), quantity: quantity(text(cells[2])), total: price(text(cells[3])), status, tracking });
    }
    const nextPage = links.map(pathOf).filter(url => url?.origin === 'https://coins.bank.gov.ua' && url.pathname === '/account_history.php')
      .map(url => Number(url!.searchParams.get('page'))).filter(page => Number.isSafeInteger(page) && page > (input.page ?? 1)).sort((a,b) => a-b)[0];
    return { orders, nextPage };
  }
  if (input.section === 'detail') {
    const info = doc.querySelector('#account_order_info');
    const headingId = text(root?.querySelector('h1')).match(/#\s*(\d+)/)?.[1];
    if (!info || !headingId || headingId !== input.orderId) return { error: 'unrecognized' };
    const headingValue = (label: string) => {
      const heading = [...info.querySelectorAll('h2')].find(h => text(h) === label);
      return text(heading?.nextElementSibling);
    };
    const shipping = [...info.querySelectorAll('.account_delivery_method')].map(row => [...row.children].map(text))
      .find(cells => !/^(?:Сума|Всього|Разом)/i.test(cells[0] ?? '') && cells.length >= 2);
    const products: CabinetProduct[] = [...info.querySelectorAll('.account_product')].map((row, index) => {
      const name = row.querySelector('.qty-text')?.cloneNode(true) as Element | undefined;
      name?.querySelector('.qty')?.remove();
      const count = quantity(text(row.querySelector('.qty')));
      const total = price(text(row.querySelector('.currency-value-text')));
      return { id: String(index), name: text(name), quantity: count, total, price: total !== null && count ? total / count : null };
    });
    if (!products.length || products.some(p => !p.name)) return { error: 'unrecognized' };
    return { details: { id: headingId, delivery: shipping?.[0]?.replace(/:\s*$/, '') ?? '', deliveryCost: shipping?.[1] ?? '',
      address: headingValue('Адреса доставки'), payment: text(info.querySelector('.payment-method-text')) || headingValue('Спосіб оплати'),
      total: price(text(info.querySelector('#ot_sum'))), products,
      history: [...doc.querySelectorAll('#account_history_table tbody tr')].map(row => {
        const cells = row.querySelectorAll('td'); return { at: text(cells[0]), status: text(cells[1]) };
      }) } };
  }
  if (input.section === 'cart') {
    const rows = [...doc.querySelectorAll('.cartContent_body')];
    if (!rows.length) {
      if (/кошик\s*(?:поки\s*)?порожній|у (?:вашому )?кошику немає|cart is empty/i.test(text(doc.body))) return { products: [] };
      return { error: 'unrecognized' };
    }
    const products = rows.map((row): CabinetProduct => {
      const id = row.querySelector<HTMLInputElement>('[name="products_id[]"]')?.value ?? '';
      const link = row.querySelector<HTMLAnchorElement>('.product_name a');
      const count = quantity(row.querySelector<HTMLSelectElement>('[name="cart_quantity[]"]')?.value ?? '');
      return { id, name: text(link), quantity: count, price: price(text(row.querySelector('.product_price'))),
        total: price(text(row.querySelector('.product_total'))), url: link ? pathOf(link)?.href : undefined,
        reservedUntil: row.querySelector('.cart-item-timer')?.getAttribute('data-expired') ?? undefined };
    });
    return products.some(p => !p.id || !p.name || p.quantity === null) ? { error: 'unrecognized' } : { products };
  }
  const wishlist = doc.querySelector('.content-wishList-wrap');
  if (!wishlist) return { error: 'unrecognized' };
  if (wishlist.querySelector('.none-customers-wishlist')) return { products: [] };
  const products = new Map<string, CabinetProduct>();
  for (const link of wishlist.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const url = pathOf(link);
    if (url?.origin !== 'https://coins.bank.gov.ua' || url.searchParams.has('action')) continue;
    const id = url.pathname.match(/\/p-(\d+)\.html$/)?.[1] ?? url.searchParams.get('products_id');
    if (!id || !/^\d+$/.test(id) || !text(link)) continue;
    // Wishlist templates vary; product links identify rows without depending on button text.
    let row: Element = link;
    while (row.parentElement && row.parentElement !== wishlist) {
      const ids = new Set([...row.parentElement.querySelectorAll<HTMLAnchorElement>('a[href]')].map(a => {
        const u = pathOf(a); return u?.pathname.match(/\/p-(\d+)\.html$/)?.[1] ?? u?.searchParams.get('products_id');
      }).filter(Boolean));
      if (ids.size > 1) break;
      row = row.parentElement;
    }
    const amount = price(text(row.querySelector('.new_price, .product_price, .price, .price_value, .wishlist-price')));
    products.set(id, { id, name: text(link), quantity: 1, price: amount, total: amount, url: url.href });
  }
  return products.size ? { products: [...products.values()] } : { error: 'unrecognized' };
}
