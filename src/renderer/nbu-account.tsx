import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

const errorText = (error: unknown) => error instanceof Error
  ? error.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') : 'Не вдалося зберегти акаунт.';

// Compact status next to a saved profile; the editor opens only on demand.
export function NbuAccountToggle({ email, saved, open, onToggle }: { email?: string; saved: boolean; open: boolean; onToggle: () => void }) {
  if (!saved) return <span className="nbu-account-toggle hint" title="Спочатку збережіть налаштування з цим профілем">Вхід НБУ можна додати після збереження профілю</span>;
  return <button type="button" className={`nbu-account-toggle${email ? ' set' : ''}`} aria-expanded={open} onClick={onToggle}
    title={email ? `Автовхід НБУ: ${email}` : 'Додати пошту й пароль НБУ для автовходу'}>
    {email ? <><span className="nbu-account-dot" aria-hidden="true" />{email}</> : '+ Вхід НБУ'}
  </button>;
}

// Nested inside the settings form: Enter saves the account instead of submitting the settings.
export function NbuAccountEditor({ profileId, email, onClose }: { profileId: string; email?: string; onClose: () => void }) {
  const [draft, setDraft] = useState({ email: email ?? '', password: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  useEffect(() => { (email ? passwordInput : emailInput).current?.focus(); }, []);
  async function save() {
    if (!/^\S+@\S+\.\S+$/.test(draft.email.trim())) { setError('Вкажіть пошту акаунта НБУ.'); return; }
    if (!draft.password) { setError(email ? 'Вкажіть пароль ще раз, щоб зберегти зміни.' : 'Вкажіть пароль.'); return; }
    setSaving(true); setError('');
    try { await window.desktop.saveNbuAccount({ profileId, email: draft.email.trim(), password: draft.password }); onClose(); }
    catch (failure) { setError(errorText(failure)); setSaving(false); }
  }
  async function remove() {
    setSaving(true); setError('');
    try { await window.desktop.clearNbuAccount(profileId); onClose(); }
    catch (failure) { setError(errorText(failure)); setSaving(false); }
  }
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); void save(); }
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
  };
  return <div className="nbu-account-editor" role="group" aria-label="Акаунт НБУ для автовходу" onKeyDown={keys}>
    <div className="nbu-account-fields">
      <input ref={emailInput} type="email" autoComplete="off" placeholder="Пошта НБУ" aria-label="Пошта акаунта НБУ" value={draft.email}
        onChange={event => setDraft(current => ({ ...current, email: event.target.value }))} />
      <input ref={passwordInput} type="password" autoComplete="new-password" placeholder={email ? 'Пароль (введіть знову)' : 'Пароль'} aria-label="Пароль акаунта НБУ"
        value={draft.password} onChange={event => setDraft(current => ({ ...current, password: event.target.value }))} />
    </div>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="nbu-account-actions">
      <button type="button" disabled={saving} onClick={() => void save()}>{saving ? 'Збереження…' : 'Зберегти'}</button>
      <button type="button" className="ghost" disabled={saving} onClick={onClose}>Скасувати</button>
      {email && (confirmRemove
        ? <button type="button" className="link danger-text" disabled={saving} onClick={() => void remove()}>Точно видалити вхід</button>
        : <button type="button" className="link danger-text" disabled={saving} onClick={() => setConfirmRemove(true)}>Видалити вхід</button>)}
    </div>
    <p className="hint">Програма входить сама, лише якщо сесія НБУ в цьому профілі злетіла. Пароль зашифрований на цьому комп’ютері.</p>
  </div>;
}
