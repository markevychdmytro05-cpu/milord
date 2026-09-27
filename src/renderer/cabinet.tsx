import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CabinetRefreshSchedule } from '../core/cabinet-refresh';
import type { SavedProfile } from '../core/model';
import type { CabinetOrder, CabinetOrderDetails, CabinetProduct, CabinetSection, CabinetSnapshot } from '../core/cabinet';
import { SALE_TIME_ZONE } from '../core/kyiv-time';
import { mergeCabinetSnapshot, appendCabinetOrders } from '../core/cabinet-pages';
import { emptyCabinetState } from '../core/cabinet-state';
import './cabinet.css';

const SECTIONS: CabinetSection[] = ['wishlist', 'cart', 'orders'];
const LABELS = { wishlist: 'Бажане', cart: 'Кошик', orders: 'Замовлення' };
const money = (value: number | null | undefined) => value == null ? '–' : `${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value)} грн`;
const errorText = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') : 'Не вдалося завантажити дані.';
const time = (at: number) => new Date(at).toLocaleString('uk-UA', { timeZone: SALE_TIME_ZONE });
const orderKey = (profileId: string, id: string) => `${profileId}:${id}`;

export function Cabinet({ profiles, now, active, connection }: { profiles: SavedProfile[]; now: number; active: boolean; connection: string }) {
  const [restored] = useState(emptyCabinetState);
  const [cacheReady, setCacheReady] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [cacheError, setCacheError] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(() => localStorage.getItem('cabinet-auto-refresh') !== 'off');
  const autoSchedule = useRef(new CabinetRefreshSchedule(restored.schedule));
  const autoAllowed = useRef(false);
  autoAllowed.current = active && autoRefresh;
  const refreshCurrent = useRef<(automatic: boolean) => Promise<void>>(async () => {});
  const [section, setSection] = useState<CabinetSection>('orders');
  const [profile, setProfile] = useState('');
  const [query, setQuery] = useState('');
  const [pageNumber, setPageNumber] = useState(1);
  const [snapshots, setSnapshots] = useState<Record<string, CabinetSnapshot>>(restored.snapshots);
  const [errors, setErrors] = useState<Record<string, string>>(restored.errors);
  const [attemptedAt, setAttemptedAt] = useState<Record<string, number>>(restored.attemptedAt);
  const [loading, setLoading] = useState('');
  const [refreshingProfile, setRefreshingProfile] = useState<string>();
  const busy = useRef(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [details, setDetails] = useState<Record<string, CabinetOrderDetails>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const lastDetailButton = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const profileName = (id: string) => profiles.find(p => p.id === id)?.name || id;
  const scope = profile && profiles.some(p => p.id === profile) ? profiles.filter(p => p.id === profile) : profiles;
  const visible = scope.map(p => snapshots[p.id]).filter((s): s is CabinetSnapshot => !!s);
  const orders = visible.flatMap(snapshot => (snapshot.orders ?? []).map(order => ({ ...order, profileId: snapshot.profileId })));
  const selected = orders.find(order => orderKey(order.profileId, order.id) === selectedId);
  const selectedDetails = selectedId ? details[selectedId] : undefined;
  const normalized = query.trim().toLocaleLowerCase('uk-UA');
  const matches = (text: string) => text.toLocaleLowerCase('uk-UA').includes(normalized);
  const shownOrders = orders.filter(order => matches(`${order.id} ${order.status} ${profileName(order.profileId)} ${(details[orderKey(order.profileId, order.id)]?.products ?? []).map(p => p.name).join(' ')}`));
  const products = (name: 'wishlist' | 'cart') => visible.flatMap(s => (s[name] ?? []).map(p => ({ ...p, profileId: s.profileId })))
    .filter(p => matches(`${p.name} ${profileName(p.profileId)}`));
  const loaded = (name: CabinetSection) => scope.length > 0 && scope.every(p => snapshots[p.id]?.[name] !== undefined);
  const count = (name: CabinetSection) => {
    const total = visible.reduce((sum, snapshot) => sum + (snapshot[name]?.length ?? 0), 0);
    return loaded(name) && !(name === 'orders' && visible.some(s => s.nextOrdersPage)) ? String(total) : total ? `${total}+` : '–';
  };
  const eligible = scope.filter(p => now - (attemptedAt[p.id] ?? 0) >= 60_000);
  const coolingDown = scope.length > 0 && !eligible.length;
  const waitSeconds = coolingDown ? Math.min(60, Math.max(1, Math.ceil(Math.min(...scope.map(p => (attemptedAt[p.id] ?? 0) + 60_000 - now)) / 1000))) : 0;
  const nextAutoAt = autoSchedule.current.nextAt(scope.map(p => p.id));
  const pageSize = 10;
  const pageCount = (name: CabinetSection) => Math.max(1, Math.ceil((name === 'orders' ? shownOrders.length : products(name).length) / pageSize));
  const currentPage = (name: CabinetSection) => Math.min(pageNumber, pageCount(name));
  const pageItems = <T,>(items: T[], name: CabinetSection) => items.slice((currentPage(name) - 1) * pageSize, currentPage(name) * pageSize);
  function changePage(next: number) {
    setPageNumber(next); setSelectedId(undefined);
    document.querySelector(`#cabinet-panel-${section} .cabinet-list`)?.scrollTo({ top: 0 });
  }

  async function refresh(automatic = false) {
    const due = autoSchedule.current.due(scope.map(p => p.id), Date.now());
    const targets = automatic ? eligible.filter(p => due.includes(p.id)) : eligible;
    if (!cacheReady || busy.current || !targets.length) return;
    busy.current = true;
    if (!automatic) setSelectedId(undefined);
    try {
      for (const item of targets) {
        if (automatic && (!autoAllowed.current || document.visibilityState !== 'visible')) break;
        setLoading(`${automatic ? 'Оновлення' : 'Підключення й оновлення'}: ${profileName(item.id)}…`);
        setRefreshingProfile(item.id);
        setErrors(current => ({ ...current, [item.id]: '' }));
        let failed = true;
        try {
          const snapshot = await window.desktop.loadCabinet(item.id, automatic ? ['cart'] : undefined, !automatic);
          failed = Object.keys(snapshot.errors).length > 0;
          setSnapshots(current => ({ ...current, [item.id]: mergeCabinetSnapshot(current[item.id], snapshot) }));
          setErrors(current => ({ ...current, [item.id]: '' }));
          setDetails(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${item.id}:`) || (automatic && key === selectedId))));
        } catch (error) { setErrors(current => ({ ...current, [item.id]: errorText(error) })); }
        finally {
          setRefreshingProfile(undefined);
          autoSchedule.current.completed(item.id, Date.now(), failed);
          setAttemptedAt(current => ({ ...current, [item.id]: Date.now() }));
        }
      }
    } finally { autoSchedule.current.finishRound(Date.now()); busy.current = false; setLoading(''); }
  }
  refreshCurrent.current = refresh;
  const profileIds = JSON.stringify(profiles.map(p => p.id));
  useEffect(() => {
    let alive = true;
    setRestoreError('');
    void window.desktop.restoreCabinet({ connection, legacy: localStorage.getItem('cabinet-data-v1') ?? undefined }).then(saved => {
      if (!alive) return;
      autoSchedule.current = new CabinetRefreshSchedule(saved.schedule);
      setSnapshots(saved.snapshots); setErrors(saved.errors); setAttemptedAt(saved.attemptedAt); setDetails(saved.details);
      setSection(saved.view.section); setProfile(saved.view.profile); setQuery(saved.view.query); setPageNumber(saved.view.page);
      setCacheReady(true);
      localStorage.removeItem('cabinet-data-v1');
    }).catch(error => { if (alive) setRestoreError(errorText(error)); });
    return () => { alive = false; };
  }, [connection, restoreAttempt]);
  useEffect(() => {
    if (!cacheReady) return;
    let alive = true;
    void window.desktop.saveCabinet({ connection, state: {
      snapshots, errors, attemptedAt, details, view: { section, profile, query, page: pageNumber }, schedule: autoSchedule.current.snapshot(),
    } }).then(() => { if (alive) setCacheError(false); }).catch(() => { if (alive) setCacheError(true); });
    return () => { alive = false; };
  }, [cacheReady, connection, profileIds, snapshots, errors, attemptedAt, details, section, profile, query, pageNumber, loading]);
  useEffect(() => { localStorage.setItem('cabinet-auto-refresh', autoRefresh ? 'on' : 'off'); }, [autoRefresh]);
  useEffect(() => {
    if (cacheReady && active && autoRefresh && document.visibilityState === 'visible') void refreshCurrent.current(true);
  }, [cacheReady, active, autoRefresh, now]);
  async function showOrder(order: CabinetOrder & { profileId: string }, button: HTMLButtonElement) {
    if (order.mergedInto) return;
    const key = orderKey(order.profileId, order.id);
    lastDetailButton.current = button; setSelectedId(key);
    requestAnimationFrame(() => closeButton.current?.focus());
    if (details[key] || busy.current) return;
    busy.current = true; setLoading(`Деталі замовлення ${order.id}…`);
    setDetailErrors(current => ({ ...current, [key]: '' }));
    try {
      const result = await window.desktop.loadCabinetOrder({ profileId: order.profileId, orderId: order.id, detailId: order.detailId });
      setDetails(current => ({ ...current, [key]: result }));
    } catch (error) { setDetailErrors(current => ({ ...current, [key]: errorText(error) })); }
    finally { busy.current = false; setLoading(''); }
  }
  async function loadMore(profileId: string, page: number) {
    if (busy.current) return;
    busy.current = true; setLoading(`Ще замовлення: ${profileName(profileId)}…`);
    try {
      const result = await window.desktop.loadCabinetOrders({ profileId, page });
      setSnapshots(current => {
        const previous = current[profileId];
        if (!previous) return current;
        return { ...current, [profileId]: appendCabinetOrders(previous, result) };
      });
      setErrors(current => ({ ...current, [profileId]: '' }));
    } catch (error) { setErrors(current => ({ ...current, [profileId]: errorText(error) })); }
    finally { busy.current = false; setLoading(''); }
  }
  function changeSection(next: CabinetSection) { setSection(next); setSelectedId(undefined); setQuery(''); setPageNumber(1); }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1
      : (SECTIONS.indexOf(section) + (event.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length;
    const next = SECTIONS[index]!;
    changeSection(next); document.getElementById(`cabinet-tab-${next}`)?.focus();
  }
  function closeDetails() { setSelectedId(undefined); lastDetailButton.current?.focus(); }
  return <section className="cabinet" aria-label="Кабінет НБУ" aria-busy={!!loading}>
    <div className="cabinet-toolbar">
      <label className="cabinet-profile">
        <select value={scope.length === 1 && profile ? scope[0]!.id : ''} onChange={event => {
          setProfile(event.target.value); setSelectedId(undefined); setPageNumber(1);
        }} aria-label="Профіль кабінету" disabled={!!loading}>
          <option value="">Усі профілі</option>
          {profiles.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
        </select>
      </label>
      <button type="button" className="ghost" disabled={!cacheReady || !!loading || !scope.length || coolingDown} onClick={() => void refresh()}>
        {loading ? 'Завантаження…' : coolingDown ? `Оновити через ${waitSeconds} с` : 'Оновити кабінет'}
      </button>
    </div>
    <div className="cabinet-meta">
      <label className="cabinet-auto" title="Автоматично оновлює лише кошик, поки відкритий кабінет"><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />
        Автооновлення кошика · 15 хв
      </label>
      <details className="cabinet-sync-details">
        <summary>{visible.length ? `Оновлено: ${time(Math.min(...visible.map(snapshot => snapshot.fetchedAt)))}` : 'Про оновлення'}</summary>
        <div className="cabinet-sync-info">
          {visible.map(snapshot => <p key={snapshot.profileId}>{profileName(snapshot.profileId)} · {time(snapshot.fetchedAt)}</p>)}
          <p>Ручне оновлення за потреби запускає AdsPower, профіль і вкладку НБУ. Автооновлення працює з відкритими профілями. Час за Києвом.</p>
          {autoRefresh && <p>Кошик оновлюється, поки відкритий кабінет. Після помилок пауза збільшується.
            {nextAutoAt && nextAutoAt > now ? ` Наступне оновлення: ${time(nextAutoAt)}.` : ''}</p>}
        </div>
      </details>
    </div>
    {(!cacheReady || loading || !scope.length) && <div className="cabinet-notice" role="status">
      {!cacheReady ? (restoreError || 'Відновлюємо збережений кабінет…') : loading || 'Додайте профілі AdsPower у налаштуваннях.'}
    </div>}
    {restoreError && <button type="button" className="ghost" onClick={() => setRestoreAttempt(attempt => attempt + 1)}>Повторити читання збереженого кабінету</button>}
    {cacheError && <p className="field-error" role="alert">Не вдалося зберегти кабінет на диску. Після закриття програми ці дані можуть бути втрачені.</p>}
    {scope.map(item => <div key={item.id} className="cabinet-profile-state">
      {refreshingProfile !== item.id && (errors[item.id] || snapshots[item.id]?.errors[section]) && <p className="field-error" role="alert">
        {profileName(item.id)}: {errors[item.id] || snapshots[item.id]?.errors[section]}
        {snapshots[item.id]?.[section] && ' Показано попередньо завантажені дані.'}
      </p>}
    </div>)}
    <div className="cabinet-tabs" role="tablist" aria-label="Розділи кабінету">
      {SECTIONS.map(name => <button key={name} type="button" role="tab" id={`cabinet-tab-${name}`}
        aria-selected={section === name} aria-controls={`cabinet-panel-${name}`} tabIndex={section === name ? 0 : -1}
        onClick={() => changeSection(name)} onKeyDown={moveTab}>
        {LABELS[name]} <span className="cabinet-count">{count(name)}</span>
      </button>)}
    </div>
    <div className="cabinet-search">
      <input type="search" aria-label="Пошук у кабінеті" placeholder={section === 'orders' ? 'Номер, статус або профіль' : 'Назва монети або профіль'}
        value={query} onChange={event => { setQuery(event.target.value); setSelectedId(undefined); setPageNumber(1); }} />
      {!loaded(section) && <span className="hint">Завантажено не всі профілі</span>}
    </div>
    {SECTIONS.map(name => <div key={name} role="tabpanel" id={`cabinet-panel-${name}`} aria-labelledby={`cabinet-tab-${name}`} hidden={section !== name}>
      <CabinetPagination page={currentPage(name)} pages={pageCount(name)} total={name === 'orders' ? shownOrders.length : products(name).length}
        onChange={changePage} />
      {name === 'orders' ? <div className={`cabinet-layout${selected ? ' with-detail' : ''}`}>
        <div className="cabinet-list" aria-label="Список замовлень">
          {pageItems(shownOrders, name).map(order => <article className={`order-card${selectedId === orderKey(order.profileId, order.id) ? ' selected' : ''}`} key={orderKey(order.profileId, order.id)}>
            <div className="row-between"><h2>{order.id}</h2><span className="hint">{profileName(order.profileId)}</span></div>
            <dl className="order-facts">
              <div><dt>Дата</dt><dd>{order.date}</dd></div>
              <div><dt>Сума</dt><dd className="order-total">{money(order.total)}</dd></div>
              <div><dt>Статус</dt><dd>{order.status}</dd></div>
              <div><dt>Шт.</dt><dd>{order.quantity ?? '–'}</dd></div>
              <div className="order-tracking"><dt>ТТН</dt><dd>{order.tracking || '–'}</dd></div>
            </dl>
            {order.mergedInto ? <p className="hint">Деталі – у замовленні №{order.mergedInto}</p> : <button type="button" className="ghost order-view" disabled={!!loading} aria-label={`Дивитись замовлення ${order.id} · ${profileName(order.profileId)}`}
              aria-expanded={selectedId === orderKey(order.profileId, order.id)} aria-controls="order-details"
              onClick={event => void showOrder(order, event.currentTarget)}>Дивитись</button>}
          </article>)}
          {currentPage(name) === pageCount(name) && visible.filter(snapshot => snapshot.nextOrdersPage).map(snapshot => <button key={snapshot.profileId} type="button" className="ghost cabinet-more"
            disabled={!!loading} onClick={() => void loadMore(snapshot.profileId, snapshot.nextOrdersPage!)}>Ще замовлення · {profileName(snapshot.profileId)}</button>)}
          {!shownOrders.length && <CabinetEmpty title={loaded('orders') ? (query ? 'Замовлень не знайдено' : 'Замовлень немає') : 'Замовлення ще не завантажені'}
            text={loaded('orders') ? (query ? 'Змініть пошуковий запит.' : 'У вибраних профілів немає замовлень.') : 'Натисніть «Оновити кабінет», щоб прочитати дані з профілів AdsPower.'} />}
        </div>
        {selected && <aside id="order-details" className="order-details" aria-label={`Замовлення ${selected.id}`} onKeyDown={event => {
          if (event.key === 'Escape') { event.stopPropagation(); closeDetails(); }
        }}>
          <header><h2>Замовлення {selected.id}</h2><button type="button" className="ghost" ref={closeButton}
            aria-label="Закрити деталі замовлення" onClick={closeDetails}>×</button></header>
          {selectedId && detailErrors[selectedId] && <p className="field-error cabinet-detail-message" role="alert">{detailErrors[selectedId]}</p>}
          {!selectedDetails && loading && <p className="hint cabinet-detail-message">Завантажуємо деталі…</p>}
          {selectedDetails && <div className="order-details-scroll">
            <section><h3>Доставка</h3><strong>{selectedDetails.delivery || '–'}</strong><p className="hint">{selectedDetails.deliveryCost}</p><p>{selectedDetails.address || '–'}</p>
              {selected.tracking && <p className="hint">ТТН: {selected.tracking}</p>}</section>
            <section><h3>Оплата</h3><strong>{selectedDetails.payment || '–'}</strong><p className="hint">{selected.status}</p></section>
            <section><h3>Товари</h3>{selectedDetails.products.map((product, index) => <div className="order-product" key={`${product.id}:${index}`}>
              <p><span className="muted">{product.quantity ?? '–'}×</span> {product.name}</p><strong>{money(product.total)}</strong>
            </div>)}<div className="order-product order-sum"><span>Разом</span><strong>{money(selectedDetails.total ?? selected.total)}</strong></div></section>
            <section><h3>Історія</h3><ol className="order-timeline">{selectedDetails.history.map((event, index) => <li key={index}>
              <time>{event.at}</time><p>{event.status}</p>
            </li>)}</ol></section>
          </div>}
        </aside>}
      </div> : <div className="cabinet-list">
        {pageItems(products(name), name).map((product, index) => <ProductCard key={`${product.profileId}:${product.id}:${index}`} product={product} profileName={profileName(product.profileId)} cart={name === 'cart'} />)}
        {!products(name).length && <CabinetEmpty title={loaded(name)
          ? (query ? 'Монет не знайдено' : name === 'cart' ? 'Кошик порожній' : 'Бажане порожнє')
          : name === 'cart' ? 'Кошик ще не завантажений' : 'Бажане ще не завантажене'}
          text={loaded(name) ? (query ? 'Змініть пошуковий запит.' : 'У вибраних профілях немає товарів у цьому розділі.') : 'Натисніть «Оновити кабінет», щоб прочитати дані з профілів AdsPower.'} />}
      </div>}
    </div>)}
  </section>;
}
function CabinetPagination({ page, pages, total, onChange }: { page: number; pages: number; total: number; onChange: (page: number) => void }) {
  if (!total) return null;
  const numbers = Array.from({ length: pages }, (_, index) => index + 1).filter(n => n === 1 || n === pages || Math.abs(n - page) <= 1);
  return <nav className="cabinet-pagination" aria-label="Сторінки кабінету">
    <span className="hint">{(page - 1) * 10 + 1}–{Math.min(page * 10, total)} із {total} завантажених</span>
    <button type="button" className="ghost" disabled={page === 1} onClick={() => onChange(page - 1)}>Назад</button>
    {numbers.map((n, index) => <span key={n} className="cabinet-page-number">
      {index > 0 && n - numbers[index - 1]! > 1 && <span aria-hidden="true">…</span>}
      <button type="button" className="ghost" aria-label={`Сторінка ${n}`} aria-current={n === page ? 'page' : undefined} onClick={() => onChange(n)}>{n}</button>
    </span>)}
    <button type="button" className="ghost" disabled={page === pages} onClick={() => onChange(page + 1)}>Далі</button>
  </nav>;
}
function ProductCard({ product, profileName, cart }: { product: CabinetProduct; profileName: string; cart: boolean }) {
  return <article className="wishlist-card">
    <ProductImage key={product.imageUrl} source={product.imageUrl} name={product.name} />
    <div className="product-description"><span className="cap">{profileName}</span><h2>{product.name}</h2>
    {cart && <p className="hint">Кількість: {product.quantity ?? '–'} · ціна: {money(product.price)}</p>}
    {cart && product.reservedUntil && <p className="hint">Резерв за даними НБУ до {product.reservedUntil} за Києвом</p>}
  </div><strong>{money(cart ? product.total : product.price)}</strong></article>;
}
function ProductImage({ source, name }: { source?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  let safeSource: string | undefined;
  try {
    const url = new URL(source ?? '');
    if (['https://coins.bank.gov.ua', 'https://cdn-nbu.solomono.net'].includes(url.origin) && !url.username && !url.password) safeSource = url.href;
  } catch { /* Older cached products may have no photo. */ }
  return <div className="product-image">
    {safeSource && !failed ? <img src={safeSource} alt={name} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : <span className="product-image-empty" role="img" aria-label="Фото відсутнє">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" />
        </svg>
      </span>}
  </div>;
}
function CabinetEmpty({ title, text }: { title: string; text: string }) {
  return <div className="cabinet-empty"><span className="cabinet-empty-mark" aria-hidden="true">N</span><h2>{title}</h2><p>{text}</p></div>;
}
