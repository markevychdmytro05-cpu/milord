import { useRef, useState } from 'react';
import type { SavedProfile } from '../core/model';

const loginLabels = { 'logged-in': 'так', 'logged-out': 'ні', unknown: '?' } as const;

export function BehaviorTest({ profiles, now, enabled = true }: { profiles: SavedProfile[]; now: number; enabled?: boolean }) {
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hasWarning, setHasWarning] = useState(false);
  const [navigate, setNavigate] = useState(true);
  const [showCursor, setShowCursor] = useState(false);
  const [minutes, setMinutes] = useState('1');
  const [running, setRunning] = useState(false);
  const [activeCount, setActiveCount] = useState(0);
  const [until, setUntil] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const activeProfiles = useRef(new Set<string>());
  const busy = useRef(false);
  const duration = Number(minutes);
  const validDuration = Number.isInteger(duration) && duration >= 1 && duration <= 60;
  const chosen = selectedIds === null ? profiles : profiles.filter(p => selectedIds.includes(p.id));
  const selectionLabel = !chosen.length ? 'Вибрати профілі' : chosen.length === profiles.length ? 'Усі профілі' : chosen.length === 1 ? chosen[0]!.name || chosen[0]!.id : `Обрано: ${chosen.length}`;
  const log = (text: string) => setEvents(current => [...current.slice(-199), text]);
  async function run() {
    if (busy.current || !validDuration) return;
    if (!chosen.length) return;
    setPickerOpen(false);
    busy.current = true; setRunning(true); setStopping(false); setEvents([]); setHasWarning(false);
    activeProfiles.current = new Set(chosen.map(p => p.id)); setActiveCount(chosen.length);
    setUntil(Date.now() + duration * 60_000);
    try {
      await Promise.all(chosen.map(async item => {
        const name = item.name || item.id;
        log(`${name}: прогрів на ${duration} хв розпочато.`);
        try {
          const result = await window.desktop.testBehavior({ profileId: item.id, navigate, showCursor, minutes: duration });
          log(`${name}: ${result.stopped ? 'зупинено' : 'готово'} · рухів: ${result.moves} · прокруток: ${result.scrolls} · переходів: ${result.navigations} · пауз: ${result.pauses} · вхід: ${loginLabels[result.login]} · ${Math.round(result.durationMs / 1000)} с.`);
          if (result.loginNote) { log(`${name}: ${result.loginNote}`); setDetailsOpen(true); setExpanded(true); setHasWarning(true); }
        } catch (error) {
          const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') : 'Не вдалося виконати прогрів.';
          log(`${name}: ${message}`); setDetailsOpen(true); setExpanded(true); setHasWarning(true);
        } finally { activeProfiles.current.delete(item.id); setActiveCount(activeProfiles.current.size); }
      }));
    } finally { busy.current = false; setRunning(false); setStopping(false); }
  }
  async function stop() {
    setStopping(true);
    try { await Promise.all([...activeProfiles.current].map(id => window.desktop.stopBehaviorTest(id))); }
    catch { log('Не вдалося надіслати зупинку. Повторіть натискання.'); setStopping(false); setExpanded(true); setDetailsOpen(true); setHasWarning(true); }
  }
  const remaining = Math.max(0, Math.ceil((until - now) / 1000));
  return <section className="behavior-test" aria-labelledby="behavior-test-title">
    <div className="behavior-test-header">
      <h2 id="behavior-test-title"><button type="button" className="behavior-expand" aria-expanded={expanded} aria-controls="behavior-test-body"
        onClick={() => setExpanded(value => !value)}>Прогрів профілів <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span></button></h2>
      {running ? <button type="button" className="ghost" disabled={stopping} onClick={() => void stop()}>{stopping ? 'Зупиняємо…' : 'Зупинити прогрів'}</button>
        : <button type="button" className="ghost" disabled={!enabled || !chosen.length || !validDuration} onClick={() => void run()}>Прогріти</button>}
    </div>
    <p className="hint behavior-status" role="status">{running ? (stopping ? 'Зупинка…' : `Активних профілів: ${activeCount} · ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`)
      : hasWarning ? 'Перевірте журнал прогріву' : events.length ? 'Прогрів завершено' : `${selectionLabel} · ${minutes} хв`}</p>
    <div id="behavior-test-body" hidden={!expanded}>
    <div className="behavior-test-fields">
      <div className="field behavior-profile-picker" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPickerOpen(false);
      }} onKeyDown={event => { if (event.key === 'Escape') { setPickerOpen(false); event.currentTarget.querySelector('button')?.focus(); } }}>
        <span id="behavior-profiles-label">Профілі</span>
        <button type="button" className="behavior-profile-toggle" aria-label={`Профілі для прогріву: ${selectionLabel}`}
          aria-expanded={pickerOpen} aria-controls="behavior-profile-options" disabled={running} onClick={() => setPickerOpen(open => !open)}>
          <span>{selectionLabel}</span><span aria-hidden="true">▾</span>
        </button>
        {pickerOpen && <div id="behavior-profile-options" className="behavior-profile-options" role="group" aria-labelledby="behavior-profiles-label">
          <div className="row-between"><button type="button" className="link" onClick={() => setSelectedIds(null)}>Усі</button>
            <button type="button" className="link" onClick={() => setSelectedIds([])}>Очистити</button></div>
          {profiles.map(item => <label key={item.id} className="check">
            <input type="checkbox" checked={chosen.some(p => p.id === item.id)} onChange={event => {
              setSelectedIds(current => {
                const ids = current ?? profiles.map(p => p.id);
                return event.target.checked ? [...ids.filter(id => id !== item.id), item.id] : ids.filter(id => id !== item.id);
              });
            }} /><span>{item.name || item.id}</span>
          </label>)}
          {!profiles.length && <p className="hint">Додайте профілі в налаштуваннях.</p>}
        </div>}
      </div>
      <label className="field"><span>Хв</span>
        <input type="number" aria-label="Тривалість прогріву, хв" min="1" max="60" step="1" value={minutes} disabled={running}
          aria-invalid={!validDuration} onChange={event => setMinutes(event.target.value)} />
        {!validDuration && <span className="field-error">Вкажіть ціле число від 1 до 60.</span>}
      </label>
    </div>
    <details className="behavior-test-details" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary>Опції та журнал{events.length ? ` (${events.length})` : ''}</summary>
      <label className="behavior-test-option"><input type="checkbox" checked={navigate} disabled={running} onChange={event => setNavigate(event.target.checked)} />
        Випадкові переходи сайтом
      </label>
      <label className="behavior-test-option"><input type="checkbox" checked={showCursor} disabled={running} onChange={event => setShowCursor(event.target.checked)} />
        Показувати курсор на сторінці (сайт може це помітити)
      </label>
      <p className="hint">Планування покупки зупинить прогрів. Прогрів не додає товари в кошик.</p>
      {!!events.length && <div className="behavior-test-log" role="log" aria-label="Журнал прогріву">{events.map((event, index) => <p key={index}>{event}</p>)}</div>}
    </details>
    </div>
  </section>;
}
