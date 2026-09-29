import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { isFinal, localApiUrl, productUrl, type AdsProfile, type AppState, type DesktopApi, type SavedProfile, type Task, type TaskStatus } from '../core/model';
import { kyivDateTimeInput, nextKyivSale, parseKyivDateTime, SALE_TIME_ZONE } from '../core/kyiv-time';
import { isFreshClockSync } from '../core/clock-sync';
import '@fontsource-variable/inter/index.css';
import './style.css';
import { summarizeSales } from '../core/sale-summary';
import { Cabinet } from './cabinet';
import { NbuAccountEditor, NbuAccountToggle } from './nbu-account';
import { BehaviorTest } from './behavior-test';
import { LicensePanel } from './license-panel';

declare global { interface Window { desktop: DesktopApi } }

type Tone = 'idle' | 'live' | 'attention' | 'good' | 'bad' | 'muted';
const labels: Record<TaskStatus, string> = {
  scheduled: 'Заплановано', preparing: 'Відкриваємо профіль', waiting: 'Чекаємо старту', firing: 'Виконується',
  queued: 'У черзі на сайті', needs_attention: 'Потрібна ваша дія', in_cart: 'У кошику', observed: 'Кнопку знайдено',
  expired: 'Час вичерпано', cancelled: 'Скасовано', failed: 'Помилка', interrupted: 'Перервано, перевірте кошик',
};
const tones: Record<TaskStatus, Tone> = {
  scheduled: 'idle', preparing: 'live', waiting: 'live', firing: 'live', queued: 'live', needs_attention: 'attention',
  in_cart: 'good', observed: 'good', expired: 'muted', cancelled: 'muted', failed: 'bad', interrupted: 'attention',
};
const PROFILE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;
const HISTORY_PREVIEW = 5;
const NAV_TABS = ['cabinet', 'tasks', 'settings'] as const;
const NAV_LABELS = { cabinet: 'Кабінет', tasks: 'Завдання', settings: 'Налаштування' };

const human = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message.replace(IPC_PREFIX, '').trim() || fallback : fallback;
const plural = (n: number, one: string, few: string, many: string) => {
  const last = n % 10, tail = n % 100;
  return last === 1 && tail !== 11 ? one : last >= 2 && last <= 4 && (tail < 12 || tail > 14) ? few : many;
};
const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (t: number) => new Date(t).toLocaleDateString('sv-SE', { timeZone: SALE_TIME_ZONE });
const clock = (t: number) => new Date(t).toLocaleTimeString('uk-UA', { timeZone: SALE_TIME_ZONE, hour: '2-digit', minute: '2-digit' });
const stamp = (t: number) => new Date(t).toLocaleTimeString('uk-UA', { timeZone: SALE_TIME_ZONE });
function when(t: number, now: number): string {
  const key = dayKey(t);
  if (key === dayKey(now)) return `сьогодні, ${clock(t)}`;
  if (key === dayKey(now + 86_400_000)) return `завтра, ${clock(t)}`;
  if (key === dayKey(now - 86_400_000)) return `вчора, ${clock(t)}`;
  return `${new Date(t).toLocaleDateString('uk-UA', { timeZone: SALE_TIME_ZONE, day: 'numeric', month: 'long' })}, ${clock(t)}`;
}
function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  if (d > 0) return `${d} д ${h} год`;
  if (h > 0) return `${h} год ${m} хв`;
  return `${pad(m)}:${pad(s % 60)}`;
}
function coinTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const slug = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '').replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim();
    const id = parsed.searchParams.get('products_id');
    return slug || (id ? `Товар ${id}` : parsed.hostname);
  } catch { return url; }
}
function urlProblem(value: string): string {
  if (!value.trim()) return 'Вставте посилання на монету.';
  try { productUrl(value.trim()); return ''; }
  catch (error) {
    return error instanceof TypeError ? 'Це не схоже на посилання. Скопіюйте його з адресного рядка сайту НБУ.' : human(error, 'Некоректне посилання.');
  }
}
const rangeProblem = (value: string, min: number, max: number) => {
  const n = Number(value);
  return value.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? '' : `Ціле число від ${min} до ${max}.`;
};

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    {children}
    {error ? <p className="field-error" id={`${id}-error`} role="alert">{error}</p>
      : hint ? <p className="hint" id={`${id}-hint`}>{hint}</p> : null}
  </div>;
}

const ICONS = {
  cabinet: <><rect x="5" y="5" width="14" height="16" rx="2" /><path d="M9 5V3h6v2M9 10h6M9 14h6" /></>,
  list: <path d="M4 6h16M4 12h16M4 18h10" />,
  sliders: <><path d="M4 7h9M19 7h1M4 17h1M11 17h9" /><circle cx="16" cy="7" r="2.2" /><circle cx="8" cy="17" r="2.2" /></>,
  link: <><circle cx="6" cy="12" r="2.4" /><circle cx="18" cy="6" r="2.4" /><circle cx="18" cy="18" r="2.4" /><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M16 5.4a3 3 0 010 5.2M18 14.4c1.8.8 3 2.6 3 5.6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
  sync: <><path d="M4 4v6h6M20 20v-6h-6" /><path d="M5.5 9A7 7 0 0118 8M18.5 15A7 7 0 016 16" /></>,
  play: <path d="M8 5l11 7-11 7z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
} as const;
function Icon({ name, size = 18 }: { name: keyof typeof ICONS; size?: number }) {
  return <svg className="icon" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">{ICONS[name]}</svg>;
}
interface CardProps {
  task: Task; now: number; profileName: string; confirming: boolean; busy: boolean; batchSize: number;
  onAsk: (id: string | null) => void; onStop: (id: string) => void;
  onSave: (id: string, url: string, saleAt: number) => Promise<boolean>;
  onReplan: (task: Task) => void;
}
// A task that has not been picked up yet can be edited in place. One that is already running
// is stopped first and its details move to the new-task form.
const REPLANNABLE: TaskStatus[] = ['preparing', 'waiting', 'needs_attention', 'queued'];
function TaskCard({ task, now, profileName, confirming, busy, batchSize, onAsk, onStop, onSave, onReplan }: CardProps) {
  const tone = tones[task.status];
  const upcoming = ['scheduled', 'preparing', 'waiting'].includes(task.status) && task.saleAt > now;
  const showNote = !!task.note && (task.status !== 'scheduled' || (task.batchIndex ?? 0) > 0);
  const stop = () => task.status === 'scheduled' ? onStop(task.id) : onAsk(task.id);
  const initialSale = kyivDateTimeInput(task.saleAt).slice(0, 16);
  const [mode, setMode] = useState<'view' | 'edit' | 'replan'>('view');
  const [collapsed, setCollapsed] = useState(false);
  const [draftUrl, setDraftUrl] = useState(task.url);
  const [draftSale, setDraftSale] = useState(initialSale);
  const [problems, setProblems] = useState<{ url?: string; sale?: string }>({});
  const canEdit = task.status === 'scheduled';
  const canReplan = REPLANNABLE.includes(task.status) && task.clicks === 0;
  const openEdit = () => { setDraftUrl(task.url); setDraftSale(initialSale); setProblems({}); setMode('edit'); };
  async function save() {
    const found: { url?: string; sale?: string } = {};
    const urlError = urlProblem(draftUrl);
    if (urlError) found.url = urlError;
    let saleAt = task.saleAt;
    try {
      if (draftSale !== initialSale) saleAt = parseKyivDateTime(draftSale);
      if (saleAt <= Date.now()) found.sale = 'Цей час уже минув. Оберіть майбутній.';
    } catch (error) { found.sale = human(error, 'Вкажіть дату й час початку.'); }
    setProblems(found);
    if (found.url || found.sale) return;
    if (await onSave(task.id, draftUrl.trim(), saleAt)) setMode('view');
  }
  return <article className={`task ${tone}${collapsed ? ' collapsed' : ''}`}>
    <div className="task-top">
      <span className={`pill ${tone}`}>{labels[task.status]}</span>
      <div className="task-identity">
        <h3 className="task-title" title={task.url}>{coinTitle(task.url)}</h3>
        <p className="meta">{when(task.saleAt, now)} за Києвом · {profileName}</p>
      </div>
      {upcoming && <span className="countdown"><span className="cap">до старту</span> <strong>{span(task.saleAt - now)}</strong></span>}
      <button type="button" className="ghost task-toggle" aria-expanded={!collapsed} aria-controls={`task-body-${task.id}`}
        onClick={() => setCollapsed(value => !value)}>{collapsed ? 'Розгорнути' : 'Згорнути'}</button>
    </div>
    <div className="task-body" id={`task-body-${task.id}`} hidden={collapsed}>
    {task.mode === 'observe' && <span className="mode-tag">Спостереження</span>}
    {showNote && <p className="note">{task.note}</p>}
    {(task.reloads > 0 || task.clicks > 0) && <p className="hint">Оновлень: {task.reloads} · Натискань: {task.clicks}</p>}
    {mode === 'edit' && canEdit ? <div className="edit-form" role="group" aria-label="Зміна завдання">
      <Field id={`edit-url-${task.id}`} label="Посилання на монету" error={problems.url}>
        <input id={`edit-url-${task.id}`} type="url" value={draftUrl} aria-invalid={!!problems.url} autoComplete="off"
          onChange={(e) => setDraftUrl(e.target.value)} />
      </Field>
      <Field id={`edit-sale-${task.id}`} label="Початок продажу, за київським часом" error={problems.sale}
        hint={batchSize > 1 ? `Час зміниться для всіх ${batchSize} завдань, створених разом.` : undefined}>
        <input id={`edit-sale-${task.id}`} type="datetime-local" step={60} value={draftSale} aria-invalid={!!problems.sale}
          onChange={(e) => setDraftSale(e.target.value)} />
      </Field>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void save()}>Зберегти</button>
        <button type="button" className="ghost" onClick={() => setMode('view')}>Скасувати</button>
      </div>
    </div>
    : mode === 'replan' && canReplan ? <div className="confirm" role="group" aria-label="Підтвердження зміни">
      <p>Щоб змінити, завдання треба зупинити. Дані перенесуться у форму «Нове завдання».</p>
      <div className="actions">
        <button type="button" className="danger" disabled={busy} onClick={() => { setMode('view'); onReplan(task); }}>Зупинити й змінити</button>
        <button type="button" className="ghost" onClick={() => setMode('view')}>Ні</button>
      </div>
    </div>
    : !isFinal(task.status) && (confirming
      ? <div className="confirm" role="group" aria-label="Підтвердження зупинки">
        <p>Зупинити завдання?{task.clicks > 0 && ' Товар, який уже в кошику, не буде видалено.'}</p>
        <div className="actions">
          <button type="button" className="danger" disabled={busy} onClick={() => onStop(task.id)}>Так, зупинити</button>
          <button type="button" className="ghost" onClick={() => onAsk(null)}>Ні</button>
        </div>
      </div>
      : <div className="actions">
        {canEdit && <button type="button" className="ghost" disabled={busy} onClick={openEdit}>Змінити</button>}
        {canReplan && <button type="button" className="ghost" disabled={busy} onClick={() => setMode('replan')}>Змінити</button>}
        <button type="button" className="ghost" disabled={busy} onClick={stop}>Зупинити</button>
      </div>)}
    <Journal task={task} />
    </div>
  </article>;
}
function downloadJournal(task: Task) {
  const report = { exportedAt: new Date().toISOString(), timeZone: SALE_TIME_ZONE, retainedEvents: 200, ...task };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `nbu-journal-${task.profileId}-${task.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Journal({ task }: { task: Task }) {
  const consoleRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const latest = task.events.at(-1);
  const scrollToLatest = () => {
    const console = consoleRef.current;
    if (console && followLatest.current) console.scrollTop = console.scrollHeight;
  };
  useEffect(scrollToLatest, [task.events.length, latest?.at, latest?.message]);
  return <details className="journal" open onToggle={scrollToLatest}>
    <summary>Журнал ({task.events.length})</summary>
    <div className="log-console" ref={consoleRef} role="log" aria-label={`Логи ${coinTitle(task.url)} · ${task.profileId}`}
      aria-live="off" tabIndex={0} onScroll={(event) => {
        const console = event.currentTarget;
        followLatest.current = console.scrollHeight - console.scrollTop - console.clientHeight < 24;
      }}>
      {!task.events.length && <p className="log-empty">Очікуємо першу подію…</p>}
      {task.events.map((entry, i) => <div className={`log-line log-${entry.details?.status ?? 'info'}`} key={i}>
        <time dateTime={new Date(entry.at).toISOString()}>{dayKey(entry.at)} {stamp(entry.at)}.{String(entry.at % 1000).padStart(3, '0')}</time>
        <span className="log-message">{entry.message}</span>
        {entry.details && <details className="journal-data"><summary>
          {entry.details.phase} · спроб: {entry.details.clicks} · оновлень: {entry.details.reloads}
        </summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details>}
      </div>)}
    </div>
    <div className="journal-tools">
      <p className="hint">Останні 200 подій · час за Києвом</p>
      <button type="button" className="ghost" onClick={() => downloadJournal(task)}>Завантажити журнал</button>
    </div>
  </details>;
}

function HistoryRow({ task, now, profileName }: { task: Task; now: number; profileName: string }) {
  const tone = tones[task.status];
  return <details className={`hist ${tone}`}>
    <summary>
      <span className="hist-line"><span className={`pill ${tone}`}>{labels[task.status]}</span>
        <span className="hist-title">{profileName} · {coinTitle(task.url)}</span><span className="disclosure" aria-hidden="true">⌄</span></span>
    </summary>
    <div className="hist-body">
      <p className="meta">{when(task.saleAt, now)} · {profileName}{task.mode === 'observe' && ' · Спостереження'} · за Києвом</p>
      {task.note && <p className="note">{task.note}</p>}
      <p className="hint url">{task.url}</p>
      <p className="hint">Кнопка: {offsetSec(task.buttonSeenMs)} · клік: {offsetSec(task.firstClickMs)} · кошик: {offsetSec(task.cartMs)}</p>
      {(task.reloads > 0 || task.clicks > 0) && <p className="hint">Оновлень: {task.reloads} · Натискань: {task.clicks}</p>}
      <Journal task={task} />
    </div>
  </details>;
}

// Seconds from the sale start by the server clock, e.g. "+1,24 с".
const offsetSec = (ms: number | undefined) => ms === undefined ? '–'
  : `${ms < 0 ? '−' : '+'}${(Math.abs(ms) / 1000).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} с`;
function SaleHistoryView({ tasks, now, profileName }: { tasks: Task[]; now: number; profileName: (id: string) => string }) {
  const sale = summarizeSales(tasks, now, 1)[0];
  const inCart = tasks.filter(task => task.status === 'in_cart').length;
  const errors = tasks.filter(task => task.status === 'failed' || task.status === 'interrupted').length;
  return <details className="sale">
    <summary>
      <span className="hist-line"><span className="hist-title">Продаж {when(tasks[0]!.saleAt, now)}</span>
        <span className={`pill ${inCart ? 'good' : errors ? 'bad' : 'muted'}`}>{inCart}/{tasks.length} у кошику</span>
        <span className="disclosure" aria-hidden="true">⌄</span></span>
      <span className="hint">{tasks.length} {plural(tasks.length, 'завдання', 'завдання', 'завдань')}{errors > 0 && ` · помилок: ${errors}`}</span>
    </summary>
    {sale && (sale.earliestButtonMs !== undefined || sale.medianCartMs !== undefined) && <p className="sale-stats">
      Кнопка вперше: <b>{offsetSec(sale.earliestButtonMs)}</b>{sale.medianButtonMs !== undefined && <> · медіана {offsetSec(sale.medianButtonMs)}</>}
      {sale.medianCartMs !== undefined && <> · кошик, медіана: <b>{offsetSec(sale.medianCartMs)}</b></>}
    </p>}
    <div className="sale-tasks">{tasks.map(task => <HistoryRow key={task.id} task={task} now={now} profileName={profileName(task.profileId)} />)}</div>
    <p className="hint sale-hint"><button type="button" className="link" onClick={() => void window.desktop.openCaptures().catch(() => {})}>Записи сторінок</button></p>
  </details>;
}

function App() {
  const [state, setState] = useState<AppState>();
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState<typeof NAV_TABS[number]>('tasks');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'info' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState('');
  // Task form
  const [url, setUrl] = useState('');
  const [extraUrls, setExtraUrls] = useState<string[]>([]);
  const [saleAt, setSaleAt] = useState(nextKyivSale());
  const [selected, setSelected] = useState<string[]>([]);
  const [profileDrafts, setProfileDrafts] = useState<SavedProfile[]>([]);
  const [profileSearch, setProfileSearch] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Profiles from AdsPower
  const [available, setAvailable] = useState<AdsProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profilesError, setProfilesError] = useState('');
  const [profilesNote, setProfilesNote] = useState('');
  // Settings form
  const [apiUrl, setApiUrl] = useState('');
  const [nums, setNums] = useState({ leadMin: '', retrySec: '', windowMin: '' });
  const [apiKey, setApiKey] = useState('');
  const [urlOpen, setUrlOpen] = useState(false);
  const [settingsErrors, setSettingsErrors] = useState<Record<string, string>>({});
  // Task list
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [taskView, setTaskView] = useState<'active' | 'history'>('active');
  const [accountOpen, setAccountOpen] = useState('');

  useEffect(() => {
    let alive = true;
    void window.desktop.state().then((next) => {
      if (!alive) return;
      setState(next);
      setApiUrl(next.settings.apiUrl);
      setNums({ leadMin: String(next.settings.leadMin), retrySec: String(next.settings.retrySec), windowMin: String(next.settings.windowMin) });
      setProfileDrafts(next.settings.savedProfiles);
      const previous = next.settings.defaultProfileIds.length ? next.settings.defaultProfileIds
        : next.settings.defaultProfileId ? [next.settings.defaultProfileId] : [];
      setSelected(previous.filter((id) => next.settings.savedProfiles.some((profile) => profile.id === id)));
    }).catch(() => { if (alive) setNotice({ kind: 'error', text: 'Не вдалося прочитати стан програми. Перезапустіть NBU Desktop.' }); });
    const interval = setInterval(() => {
      setNow(Date.now());
      void window.desktop.state().then((next) => { if (alive) setState(next); }).catch(() => {});
    }, 1000);
    return () => { alive = false; clearInterval(interval); };
  }, []);
  useEffect(() => {
    if (notice?.kind !== 'ok') return;
    const timer = setTimeout(() => setNotice(undefined), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function refreshProfiles() {
    setProfilesLoading(true); setProfilesError(''); setProfilesNote('');
    try { setAvailable(await window.desktop.listProfiles()); }
    catch (error) {
      const text = human(error, 'Не вдалося завантажити профілі.');
      if (text.startsWith('Оновіть список')) setProfilesNote('Список оновиться, коли завершиться активне виконання.');
      else setProfilesError(text);
    } finally { setProfilesLoading(false); }
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setNotice(undefined);
    try { await action(); setState(await window.desktop.state()); }
    catch (error) { setNotice({ kind: 'error', text: human(error, 'Операція не вдалася.') }); }
    finally { setBusy(false); }
  }

  const coinUrls = [url, ...extraUrls];
  const options = state?.settings.savedProfiles ?? [];
  const profiles = selected.filter((id) => options.some((profile) => profile.id === id));
  const profileName = (id: string) => {
    const profile = options.find((item) => item.id === id);
    return profile?.name || id;
  };
  const shownProfiles = options.filter((profile) =>
    `${profile.name} ${profile.id}`.toLowerCase().includes(profileSearch.trim().toLowerCase()));

  function validate(needTime: boolean): { errors: Record<string, string>; saleAtMs: number } {
    const found: Record<string, string> = {};
    let saleAtMs = 0;
    const problem = urlProblem(url);
    if (problem) found.url = problem;
    extraUrls.forEach((value, index) => { const error = urlProblem(value); if (error) found[`coin${index + 2}`] = error; });
    if (!problem && !Object.keys(found).some((key) => key.startsWith('coin'))) {
      const normalized = coinUrls.map((value) => productUrl(value.trim()));
      if (new Set(normalized).size !== normalized.length) found.url = 'Монета повторюється у списку. Приберіть однакове посилання.';
    }
    if (coinUrls.length * profiles.length > 200) found.profiles = 'Максимум 200 завдань: кількість монет × кількість профілів.';
    if (needTime) {
      try {
        saleAtMs = parseKyivDateTime(saleAt);
        if (saleAtMs <= Date.now()) found.saleAt = 'Цей час уже минув. Оберіть майбутній.';
      } catch (error) { found.saleAt = human(error, 'Вкажіть дату й час початку.'); }
    }
    const bad = profiles.find((id) => !PROFILE_ID.test(id));
    if (!profiles.length) found.profiles = 'Оберіть хоча б один профіль AdsPower.';
    else if (profiles.length > 50) found.profiles = 'Для одного запуску оберіть не більше 50 профілів.';
    else if (bad) found.profiles = `ID «${bad}» не підходить: лише латиниця, цифри, «-» та «_».`;
    setErrors(found);
    const first = ['url', ...extraUrls.map((_, i) => `coin${i + 2}`), 'saleAt', 'profiles'].find((key) => found[key]);
    if (first) document.getElementById(first.startsWith('coin') ? `task-${first}` : { url: 'task-url', saleAt: 'task-sale', profiles: 'task-profiles' }[first]!)?.focus();
    return { errors: found, saleAtMs };
  }
  function schedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state) return;
    const { errors: found, saleAtMs } = validate(true);
    if (Object.keys(found).length) return;
    const { leadMin, retrySec, windowMin, defaultProfileIds } = state.settings;
    void perform(async () => {
      await window.desktop.addTasks(profiles.flatMap((profileId) => coinUrls.map((coinUrl) => ({
        url: coinUrl.trim(), profileId, saleAt: saleAtMs, leadMin, retrySec, windowMin, mode: 'cart' as const,
      }))));
      setTaskView('active');
      setNotice({ kind: 'ok', text: `Заплановано: ${profiles.length * coinUrls.length} ${plural(profiles.length * coinUrls.length, 'завдання', 'завдання', 'завдань')}. Залиште NBU Desktop і AdsPower відкритими.` });
      setUrl(''); setExtraUrls([]); setErrors({});
      // Remember the last used profiles; this is best-effort and must never fail the scheduling.
      if (profiles.length <= 50 && profiles.join() !== defaultProfileIds.join()) {
        await window.desktop.saveSettings({ ...state.settings, defaultProfileId: '', defaultProfileIds: profiles }).catch(() => {});
      }
    });
  }
  function inspect() {
    if (Object.keys(validate(false).errors).length) return;
    void perform(async () => {
      const lines: string[] = [];
      try {
        for (const [index, profileId] of profiles.entries()) {
          setInspecting(`Перевірка ${index + 1} з ${profiles.length}…`);
          try { lines.push(`${profileName(profileId)} – ${await window.desktop.inspectProfile({ profileId, url: url.trim() })}`); }
          catch (error) { lines.push(`${profileName(profileId)} – ${human(error, 'не вдалося перевірити.')}`); }
        }
      } finally { setInspecting(''); }
      setNotice({ kind: 'info', text: lines.join('\n') });
    });
  }
  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state) return;
    const found: Record<string, string> = {};
    try { localApiUrl(apiUrl.trim()); }
    catch (error) {
      found.apiUrl = error instanceof TypeError || !(error instanceof Error) ? 'Вкажіть адресу, наприклад http://127.0.0.1:50325.' : error.message;
    }
    const ranges = { leadMin: [1, 60], retrySec: [1, 60], windowMin: [1, 30] } as const;
    for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
      const problem = rangeProblem(nums[key], ranges[key][0], ranges[key][1]);
      if (problem) found[key] = problem;
    }
    const savedProfiles = profileDrafts.map((profile) => ({ id: profile.id.trim(), name: profile.name.trim() }));
    if (savedProfiles.length > 200) found.profiles = 'Можна зберегти до 200 профілів.';
    else if (savedProfiles.some((profile) => !PROFILE_ID.test(profile.id))) found.profiles = 'Вкажіть коректний ID у кожному рядку: латиниця, цифри, «-» та «_».';
    else if (savedProfiles.some((profile) => profile.name.length > 80)) found.profiles = 'Назва профілю – до 80 символів.';
    else if (new Set(savedProfiles.map((profile) => profile.id)).size !== savedProfiles.length) found.profiles = 'Цей ID уже є у списку. Приберіть повтор.';
    setSettingsErrors(found);
    if (found.apiUrl) setUrlOpen(true);
    const first = ['profiles', 'apiUrl', 'leadMin', 'retrySec', 'windowMin'].find((key) => found[key]);
    if (first) { setTimeout(() => document.getElementById(`set-${first}`)?.focus(), 0); return; }
    void perform(async () => {
      await window.desktop.saveSettings({
        apiUrl: apiUrl.trim(), savedProfiles, defaultProfileId: '',
        defaultProfileIds: selected.filter((id) => savedProfiles.some((profile) => profile.id === id)),
        leadMin: Number(nums.leadMin), retrySec: Number(nums.retrySec), windowMin: Number(nums.windowMin),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setApiKey(''); setProfileDrafts(savedProfiles);
      setSelected((current) => current.filter((id) => savedProfiles.some((profile) => profile.id === id)));
      setNotice({ kind: 'ok', text: 'Налаштування збережено.' });
    });
  }
  async function updateTask(id: string, taskUrl: string, saleAtMs: number): Promise<boolean> {
    let saved = false;
    await perform(async () => {
      await window.desktop.updateTask({ id, url: taskUrl, saleAt: saleAtMs });
      setNotice({ kind: 'ok', text: 'Завдання змінено.' });
      saved = true;
    });
    return saved;
  }
  // Stop a running task and put its details back into the form so they can be corrected and planned again.
  function replanTask(item: Task) {
    setConfirmStop(null);
    void perform(async () => {
      await window.desktop.cancelTask(item.id);
      setUrl(item.url); setExtraUrls([]); setErrors({}); setSaleAt(kyivDateTimeInput(item.saleAt).slice(0, 16));
      if (options.some((profile) => profile.id === item.profileId)) setSelected([item.profileId]);
      setNotice({ kind: 'info', text: 'Завдання зупинено. Змініть дані у формі й заплануйте знову.' });
      setTimeout(() => document.getElementById('task-url')?.focus(), 0);
    });
  }
  function stopTask(id: string) {
    setConfirmStop(null);
    void perform(() => window.desktop.cancelTask(id));
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
    const next = NAV_TABS[(NAV_TABS.indexOf(tab) + direction + NAV_TABS.length) % NAV_TABS.length]!;
    setTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  }

  const tasks = state?.tasks ?? [];
  const attention = tasks.filter((task) => task.status === 'needs_attention').sort((a, b) => a.saleAt - b.saleAt);
  const upcoming = tasks.filter((task) => !isFinal(task.status) && task.status !== 'needs_attention').sort((a, b) => a.saleAt - b.saleAt);
  const history = tasks.filter((task) => isFinal(task.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  const historyBySale = new Map<number, Task[]>();
  for (const task of history) {
    const group = historyBySale.get(task.saleAt) ?? [];
    group.push(task);
    historyBySale.set(task.saleAt, group);
  }
  const sales = [...historyBySale.entries()].sort(([a], [b]) => b - a);
  const shownSales = showAllHistory ? sales : sales.slice(0, HISTORY_PREVIEW);
  const open = attention.length + upcoming.length;
  const keyStatus = state?.savedApiKey ? 'Ключ збережено' : state?.hasApiKey ? 'Ключ із середовища' : 'Ключ не задано';
  const today = tasks.filter((task) => dayKey(task.saleAt) === dayKey(now));
  const todayStats = {
    planned: today.length,
    cart: today.filter((task) => task.status === 'in_cart').length,
    errors: today.filter((task) => task.status === 'failed' || task.status === 'interrupted').length,
  };
  const settled = tasks.filter((task) => ['in_cart', 'failed', 'expired', 'interrupted'].includes(task.status));
  const successRate = settled.length ? Math.round(tasks.filter((task) => task.status === 'in_cart').length / settled.length * 100) : null;
  const apiDot = profilesError ? 'bad' : state?.hasApiKey ? 'good' : 'idle';
  const apiText = profilesError ? 'Помилка' : state?.savedApiKey ? 'Ключ є' : state?.hasApiKey ? 'З середовища' : 'Немає ключа';
  // Different profiles ride different network paths and carry different typical offsets
  // (a live test found a stable ~200ms gap between two profiles) — never pooled together.
  // With many saved profiles a row-per-profile list would swallow the whole sidebar, so this
  // stays one row: the freshest reading plus a "+N" hint, red if ANY profile looks anomalous
  // (never masked by a fine-looking recent one), full per-profile breakdown in the tooltip.
  const offsetEntries = Object.entries(state?.offsetHistoryByProfile ?? {})
    .sort(([, a], [, b]) => b.lastAt - a.lastAt);
  const [, topOffset] = offsetEntries[0] ?? [];
  const offsetDot = !offsetEntries.length ? 'idle' : offsetEntries.some(([, s]) => s.anomaly) ? 'bad' : 'good';
  const offsetText = !topOffset ? '–'
    : `${topOffset.lastMs > 0 ? '+' : ''}${topOffset.lastMs} мс${offsetEntries.length > 1 ? ` +${offsetEntries.length - 1}` : ''}`;
  const offsetTitle = !offsetEntries.length ? 'Замір з’являється після першого підключення до сторінки монети.'
    : offsetEntries.map(([id, s]) => `${profileName(id)}: ${s.lastMs > 0 ? '+' : ''}${s.lastMs} мс · ` +
      `середнє ${s.meanMs} мс · замірів ${s.count} · останній ${when(s.lastAt, now)}${s.anomaly ? ' · АНОМАЛІЯ' : ''}`).join('\n');
  const kyivClock = new Date(now).toLocaleTimeString('uk-UA', { timeZone: SALE_TIME_ZONE });
  const sync = state?.clockSync;
  const syncFresh = isFreshClockSync(sync, now);
  const syncDot = !syncFresh ? 'idle' : Math.abs(sync!.offsetMs) >= 1000 ? 'bad' : Math.abs(sync!.offsetMs) >= 200 ? 'attention' : 'good';
  const syncText = !sync ? '–' : Math.abs(sync.offsetMs) < 1 ? 'точний'
    : `${sync.offsetMs > 0 ? 'відстає' : 'поспішає'} ${Math.abs(sync.offsetMs)} мс`;
  const syncTitle = !sync ? 'Звірка з атомним часом (NTP) ще не вдалася. Перевірте інтернет.'
    : `Годинник комп’ютера ${syncText} від атомного часу (±${sync.uncertaintyMs} мс, серверів: ${sync.servers}, ${when(sync.at, now)}). ` +
      (syncFresh ? 'Перед стартом свіжий замір звіряється з часом магазину; його похибка додається до запасу на старті.'
        : 'Замір застарілий або не підтверджений двома серверами. Для старту використовується обережний розрахунок часу.');
  const preview = (() => {
    try {
      const t = parseKyivDateTime(saleAt);
      return t > now ? `${when(t, now)} за Києвом · через ${span(t - now)}` : 'Цей час уже минув';
    } catch { return ''; }
  })();

  return <div className="app">
    <aside className="side">
      <div className="brand"><span className="mark" aria-hidden="true">N</span><span className="brand-name">NBU Desktop</span></div>
      <nav aria-label="Розділи додатка"><div role="tablist" aria-orientation="vertical">
        {NAV_TABS.map((name) => <button key={name} id={`tab-${name}`} role="tab" type="button"
          aria-selected={tab === name} aria-controls={`panel-${name}`} tabIndex={tab === name ? 0 : -1}
          onKeyDown={moveTab} onClick={() => setTab(name)}>
          <Icon name={name === 'cabinet' ? 'cabinet' : name === 'tasks' ? 'list' : 'sliders'} />
          <span className="tab-label">{NAV_LABELS[name]}</span>
          {name === 'tasks' && open > 0 && <span className={`count ${attention.length ? 'attention' : ''}`}>{open}</span>}
        </button>)}
      </div></nav>
        <section className="side-block diagnostics" aria-labelledby="diagnostics-title"><h2 id="diagnostics-title">Діагностика</h2>
          <div className="sys-row"><Icon name="link" /><span>AdsPower API</span><span className="sys-val"><i className={`dot ${apiDot}`} />{apiText}</span></div>
          <div className="sys-row"><Icon name="users" /><span>Профілі</span><span className="sys-val">{options.length}</span></div>
          <div className="sys-row"><Icon name="clock" /><span>Київ</span><span className="sys-val">{kyivClock}</span></div>
          <div className="sys-row" title={syncTitle}><Icon name="clock" /><span>Годинник ПК</span><span className="sys-val"><i className={`dot ${syncDot}`} />{syncText}</span></div>
          <div className="sys-row" title={offsetTitle}><Icon name="sync" /><span>Зсув сервера</span><span className="sys-val"><i className={`dot ${offsetDot}`} />{offsetText}</span></div>
          <details className="diagnostic-details"><summary>Заміри за профілями</summary><p className="hint">{offsetTitle}</p></details>
          <div className="diagnostic-stats"><h3>Сьогодні</h3><p className="hint">Завдань: {todayStats.planned} · у кошику: {todayStats.cart} · помилок: {todayStats.errors}</p>
            <p className="hint">Успішних за весь час: {successRate === null ? '–' : `${successRate}%`}</p></div>
        </section>
    </aside>
    <main>
    <header className="strip">
      <h1>{NAV_LABELS[tab]}</h1>
    </header>
    {state?.secretError && <div className="banner" role="alert">{state.secretError}</div>}
    {state?.accountsError && <div className="banner" role="alert">{state.accountsError}</div>}
    {state && !state.license.allowed && tab !== 'settings' && <div className="banner" role="alert">
      {state.license.message} <button type="button" className="link" onClick={() => setTab('settings')}>Відкрити налаштування ліцензії</button>
    </div>}

    <div id="panel-tasks" role="tabpanel" aria-labelledby="tab-tasks" hidden={tab !== 'tasks'}>
      <div className="workspace">
        <div className="task-tools">
        <section className="composer" aria-labelledby="new-task"><h2 id="new-task">Нове завдання</h2>
          <form noValidate onSubmit={schedule}>
            <Field id="task-url" label="Посилання на монету" error={errors.url}>
              <input id="task-url" type="url" value={url} placeholder="https://coins.bank.gov.ua/…" autoComplete="off"
                aria-invalid={!!errors.url} aria-describedby={errors.url ? 'task-url-error' : undefined}
                onChange={(e) => setUrl(e.target.value)} />
            </Field>
            {extraUrls.map((value, index) => <Field key={index} id={`task-coin${index + 2}`} label={`Монета ${index + 2}`} error={errors[`coin${index + 2}`]}>
              <div className="input-wrap">
                <input id={`task-coin${index + 2}`} type="url" value={value} placeholder="https://coins.bank.gov.ua/…"
                  aria-invalid={!!errors[`coin${index + 2}`]} onChange={(e) => setExtraUrls((current) => current.map((item, i) => i === index ? e.target.value : item))} />
                <button type="button" className="clear-btn" aria-label={`Прибрати монету ${index + 2}`} title="Прибрати"
                  onClick={() => setExtraUrls((current) => current.filter((_, i) => i !== index))}><Icon name="cross" size={14} /></button>
              </div>
            </Field>)}
            <button type="button" className="link add-coin" onClick={() => setExtraUrls((current) => [...current, ''])}>+ Ще монета</button>
            {extraUrls.length > 0 && <p className="hint coin-order">Кожна монета запускається незалежно у своїй вкладці. Спільне вікно очікування: {state?.settings.windowMin ?? 5} хв після старту.</p>}
            <Field id="task-sale" label="Початок продажу, за київським часом" hint={preview} error={errors.saleAt}>
              <input id="task-sale" name="saleAt" type="datetime-local" step={60} value={saleAt}
                aria-invalid={!!errors.saleAt} aria-describedby={errors.saleAt ? 'task-sale-error' : 'task-sale-hint'}
                onChange={(e) => setSaleAt(e.target.value)} />
            </Field>

            <div className="field" role="group" id="task-profiles" tabIndex={-1} aria-labelledby="profiles-label">
              <div className="row-between">
                <span className="label" id="profiles-label">Профілі{profiles.length > 0 && <span className="muted"> · обрано {profiles.length}</span>}</span>
              </div>
              {options.length > 0 && <div className="picker">
                <label className="check check-select-all">
                  <input type="checkbox" checked={profiles.length === options.length}
                    ref={node => { if (node) node.indeterminate = profiles.length > 0 && profiles.length < options.length; }}
                    onChange={event => setSelected(event.target.checked ? options.map(profile => profile.id) : [])} />
                  <span>Вибрати всі</span>
                </label>
                {options.length > 6 && <input aria-label="Пошук профілів" placeholder="Пошук за назвою або ID" value={profileSearch}
                  onChange={(e) => setProfileSearch(e.target.value)} />}
                <div className="checklist" role="group" aria-label="Профілі AdsPower">
                  {shownProfiles.map((profile) => <label className="check" key={profile.id}>
                    <input type="checkbox" checked={selected.includes(profile.id)} onChange={(e) => setSelected((current) =>
                      e.target.checked ? [...current, profile.id] : current.filter((id) => id !== profile.id))} />
                    <span>{profile.name || profile.id}{profile.name && <small className="profile-id">{profile.id}</small>}</span></label>)}
                  {!shownProfiles.length && <p className="hint">Нічого не знайдено.</p>}
                </div>
              </div>}
              {!options.length && <p className="hint">Додайте профілі в налаштуваннях – вони з’являться тут для вибору.</p>}
              {errors.profiles && <p className="field-error" role="alert">{errors.profiles}</p>}
            </div>

            {profiles.length > 0 && (profiles.length > 1 || extraUrls.length > 0) && <p className="summary">Буде створено {profiles.length * coinUrls.length} {plural(profiles.length * coinUrls.length, 'завдання', 'завдання', 'завдань')}: {coinUrls.length} монет × {profiles.length} профілів.</p>}
            <div className="actions pair">
              <button type="submit" disabled={busy || !state?.license.allowed}>Запланувати</button>
              <button type="button" className="ghost" disabled={busy || !state?.license.allowed}
                title="Відкриє профіль і перевірить, чи він бачить сторінку монети та чи виконано вхід. Нічого не купує."
                onClick={inspect}>{inspecting || 'Перевірити профілі'}</button>
            </div>
          </form>
        </section>
        <BehaviorTest profiles={options} now={now} enabled={!!state?.license.allowed} />
        </div>

        <section className="board" aria-labelledby="tasks-title">
          <h2 id="tasks-title">Черга завдань</h2>
          <div className="task-tabs" role="tablist" aria-label="Список завдань">
            {(['active', 'history'] as const).map(view => <button key={view} type="button" role="tab" id={`task-tab-${view}`}
              aria-selected={taskView === view} aria-controls={`task-panel-${view}`} tabIndex={taskView === view ? 0 : -1}
              onClick={() => setTaskView(view)} onKeyDown={event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === 'Home' ? 'active' : event.key === 'End' ? 'history' : view === 'active' ? 'history' : 'active';
                setTaskView(next); document.getElementById(`task-tab-${next}`)?.focus();
              }}>{view === 'active' ? 'Активні' : 'Історія'} <span className="tab-total">{view === 'active' ? open : history.length}</span>
              {view === 'active' && attention.length > 0 && <span className="attention-indicator" title="Потрібна ваша дія" aria-label="Потрібна ваша дія" />}
            </button>)}
          </div>
          <div role="tabpanel" id="task-panel-active" aria-labelledby="task-tab-active" hidden={taskView !== 'active'}>
          {!open && <div className="empty"><p><strong>Активних завдань немає</strong></p>
            <p>Створіть нове завдання: додайте монету, час продажу та профілі.</p></div>}
          {attention.length > 0 && <div className="group"><h3 className="group-title attention">Потрібна ваша дія</h3>
            {attention.map((task) => <TaskCard key={task.id} task={task} now={now} profileName={profileName(task.profileId)} busy={busy}
              confirming={confirmStop === task.id} onAsk={setConfirmStop} onStop={stopTask}
              batchSize={task.batchId ? tasks.filter((item) => item.batchId === task.batchId && item.status === 'scheduled').length : 1}
              onSave={updateTask} onReplan={replanTask} />)}</div>}
          {upcoming.length > 0 && <div className="group"><h3 className="group-title">Наступні</h3>
            {upcoming.map((task) => <TaskCard key={task.id} task={task} now={now} profileName={profileName(task.profileId)} busy={busy}
              confirming={confirmStop === task.id} onAsk={setConfirmStop} onStop={stopTask}
              batchSize={task.batchId ? tasks.filter((item) => item.batchId === task.batchId && item.status === 'scheduled').length : 1}
              onSave={updateTask} onReplan={replanTask} />)}</div>}
          </div>
          <div role="tabpanel" id="task-panel-history" aria-labelledby="task-tab-history" hidden={taskView !== 'history'}>
            {!sales.length && <div className="empty"><p><strong>Історія порожня</strong></p><p>Тут з’являться завершені та скасовані завдання.</p></div>}
            {sales.length > 0 && <div className="group">
              <div className="history">{shownSales.map(([saleAt, saleTasks]) => <SaleHistoryView key={saleAt} tasks={saleTasks} now={now} profileName={profileName} />)}</div>
              {sales.length > HISTORY_PREVIEW && <button type="button" className="link" onClick={() => setShowAllHistory(!showAllHistory)}>
                {showAllHistory ? 'Показати менше' : `Усі продажі · ${sales.length}`}</button>}
            </div>}
          </div>
        </section>
      </div>
    </div>

    <div id="panel-cabinet" role="tabpanel" aria-labelledby="tab-cabinet" hidden={tab !== 'cabinet'}>
      {state && <Cabinet key={state.settings.apiUrl} connection={state.settings.apiUrl} profiles={options} now={now} active={tab === 'cabinet'} enabled={state.license.allowed} />}
    </div>

    <div id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden={tab !== 'settings'}>
      <form noValidate onSubmit={saveSettings} className="settings">
        <LicensePanel license={state?.license} refresh={async () => setState(await window.desktop.state())} />
        <section className="saved-profiles" aria-labelledby="saved-profiles-title">
          <div className="row-between"><h2 id="saved-profiles-title">Збережені профілі</h2>
            <button type="button" className="ghost" disabled={busy} onClick={() => {
              setProfileDrafts((current) => [...current, { id: '', name: '' }]);
            }}>Додати профіль</button></div>
          <div id="set-profiles" tabIndex={-1}>
            {profileDrafts.map((profile, index) => {
              const id = profile.id.trim();
              const saved = !!id && options.some((item) => item.id === id);
              return <div className="profile-editor" key={index}>
              <Field id={`profile-name-${index}`} label="Назва">
                <input id={`profile-name-${index}`} placeholder="Назва для зручності" maxLength={80} value={profile.name}
                  onChange={(e) => setProfileDrafts((current) => current.map((row, i) => i === index ? { ...row, name: e.target.value } : row))} />
              </Field>
              <Field id={`profile-id-${index}`} label="ID профілю">
                <input id={`profile-id-${index}`} placeholder="ID з таблиці профілів AdsPower" value={profile.id} autoComplete="off" maxLength={80}
                  onChange={(e) => setProfileDrafts((current) => current.map((row, i) => i === index ? { ...row, id: e.target.value } : row))} />
              </Field>
              <button type="button" className="profile-remove" title="Видалити профіль" aria-label={`Видалити профіль ${profile.name || profile.id || index + 1}`}
                onClick={() => setProfileDrafts((current) => current.filter((_, i) => i !== index))}><Icon name="cross" /></button>
              <NbuAccountToggle email={state?.nbuAccounts[id]} saved={saved} open={saved && accountOpen === id}
                onToggle={() => setAccountOpen((current) => current === id ? '' : id)} />
              {saved && accountOpen === id && <NbuAccountEditor profileId={id} email={state?.nbuAccounts[id]}
                onClose={() => { setAccountOpen(''); void window.desktop.state().then(setState).catch(() => {}); }} />}
            </div>; })}
            {!profileDrafts.length && <p className="hint">Додайте ID з AdsPower. Назву можна задати для зручності. API-ключ для цього не потрібен.</p>}
          </div>
          {settingsErrors.profiles && <p className="field-error" role="alert">{settingsErrors.profiles}</p>}
          <details className="profile-import"><summary>Імпорт через API AdsPower</summary>
            <button type="button" className="link" disabled={profilesLoading || busy} onClick={() => void refreshProfiles()}>
              {profilesLoading ? 'Завантаження…' : 'Завантажити профілі'}</button>
            {profilesError && <p className="hint warn">{profilesError} Можна додати профілі вручну вище.</p>}
            {profilesNote && <p className="hint">{profilesNote}</p>}
            {available.map((profile) => <div className="row-between" key={profile.id}>
              <span>{profile.number ? `№${profile.number} · ` : ''}{profile.name || profile.id}</span>
              <button type="button" className="link" disabled={profileDrafts.some((row) => row.id.trim() === profile.id)}
                onClick={() => setProfileDrafts((current) => [...current, { id: profile.id, name: profile.name || (profile.number ? `Профіль ${profile.number}` : '') }])}>
                {profileDrafts.some((row) => row.id.trim() === profile.id) ? 'Додано' : 'Додати'}</button>
            </div>)}
          </details>
        </section>
        <section aria-labelledby="conn-title"><h2 id="conn-title">Підключення до AdsPower</h2>
          <div className="field">
            <div className="row-between"><label htmlFor="set-apiKey">API-ключ</label>
              <span className={`pill ${state?.hasApiKey ? 'good' : 'attention'}`}>{keyStatus}</span></div>
            <input id="set-apiKey" type="password" autoComplete="off" value={apiKey}
              placeholder={state?.hasApiKey ? 'Вставте новий ключ, щоб замінити' : 'Вставте ключ з налаштувань AdsPower'}
              onChange={(e) => setApiKey(e.target.value)} />
            <p className="hint">Ключ береться в AdsPower: розділ Local API. Зберігається на цьому комп’ютері в зашифрованому вигляді.</p>
            {state && !state.secretStorageAvailable && <p className="hint warn">Системне сховище ключів недоступне, тому новий ключ зберегти не вдасться.</p>}
            {state?.savedApiKey && <button type="button" className="link danger-text" disabled={busy} onClick={() => void perform(async () => {
              await window.desktop.clearApiKey(); setApiKey(''); setNotice({ kind: 'ok', text: 'Збережений ключ видалено.' });
            })}>Видалити збережений ключ</button>}
          </div>
          <details className="advanced" open={urlOpen} onToggle={(e) => setUrlOpen(e.currentTarget.open)}>
            <summary>Адреса Local API: <code>{state?.settings.apiUrl ?? '…'}</code></summary>
            <Field id="set-apiUrl" label="Адреса Local API" error={settingsErrors.apiUrl}
              hint="Змінюйте, лише якщо AdsPower працює на іншому порту. Підходить 127.0.0.1 або localhost.">
              <input id="set-apiUrl" type="url" value={apiUrl} aria-invalid={!!settingsErrors.apiUrl}
                onChange={(e) => setApiUrl(e.target.value)} />
            </Field>
          </details>
        </section>
        <section aria-labelledby="timing-title"><h2 id="timing-title">Час виконання</h2>
          <Field id="set-leadMin" label="Відкрити профіль за, хв" error={settingsErrors.leadMin}
            hint="За скільки хвилин до старту відкрити профіль і завантажити сторінку монети.">
            <input id="set-leadMin" inputMode="numeric" value={nums.leadMin} aria-invalid={!!settingsErrors.leadMin}
              onChange={(e) => setNums({ ...nums, leadMin: e.target.value })} />
          </Field>
          <Field id="set-retrySec" label="Повторне оновлення, с" error={settingsErrors.retrySec}
            hint="Якщо кнопки ще немає, повторне оновлення – через цей інтервал після завантаження сторінки. Мінімум і початкове значення – 1 с.">
            <input id="set-retrySec" inputMode="numeric" value={nums.retrySec} aria-invalid={!!settingsErrors.retrySec}
              onChange={(e) => setNums({ ...nums, retrySec: e.target.value })} />
          </Field>
          <Field id="set-windowMin" label="Чекати після старту, хв" error={settingsErrors.windowMin}
            hint="Скільки хвилин шукати кнопку після початку, перш ніж завершити завдання як «Час вичерпано».">
            <input id="set-windowMin" inputMode="numeric" value={nums.windowMin} aria-invalid={!!settingsErrors.windowMin}
              onChange={(e) => setNums({ ...nums, windowMin: e.target.value })} />
          </Field>
        </section>
        <div className="settings-footer"><button type="submit" disabled={busy || !state}>Зберегти налаштування</button></div>
      </form>
    </div>

    {notice && <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <p>{notice.text}</p>
      {notice.kind !== 'ok' && <button type="button" className="link" onClick={() => setNotice(undefined)}>Закрити</button>}
    </div>}
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
