import { useState } from 'react';
import type { LicenseState } from '../core/license';

export function UpdateBanner({ update }: { update: NonNullable<LicenseState['update']> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  async function download() {
    setBusy(true); setError('');
    try { setSaved(await window.desktop.downloadUpdate()); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') : 'Не вдалося завантажити оновлення.');
    } finally { setBusy(false); }
  }
  return <div className="banner" role="status">
    Доступна нова версія <strong>{update.version}</strong> ({(update.size / 1048576).toFixed(1)} МБ).
    {update.notes && <span className="hint"> {update.notes}</span>}
    {saved
      ? <> Файл збережено у «Завантаженнях». Дочекайтесь завершення завдань, закрийте програму й запустіть інсталятор.</>
      : <> <button type="button" className="link" disabled={busy} onClick={() => void download()}>{busy ? 'Завантаження…' : 'Завантажити оновлення'}</button></>}
    {error && <span className="field-error" role="alert"> {error}</span>}
  </div>;
}
