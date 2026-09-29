import { useState } from 'react';
import type { LicenseState } from '../core/license';

export function LicensePanel({ license, refresh }: { license?: LicenseState; refresh: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); await refresh(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') : 'Не вдалося перевірити ліцензію.');
      await refresh().catch(() => {});
    } finally { setBusy(false); }
  }
  return <section aria-labelledby="license-title">
    <h2 id="license-title">Ліцензія</h2>
    <p className="hint lead" role="status">{license?.message ?? 'Завантаження…'}</p>
    {license?.maxAccounts !== undefined && <p className="hint">Профілів: {license.accountsUsed} / {license.maxAccounts}
      {license.maxDevices !== undefined ? ` · пристроїв у тарифі: ${license.maxDevices}` : ''}</p>}
    {license?.expiresAt && <p className="hint">Діє до: {new Date(license.expiresAt).toLocaleString('uk-UA')}</p>}
    {license?.status === 'offline' && license.validUntil && <p className="hint">Офлайн-доступ до: {new Date(license.validUntil).toLocaleString('uk-UA')}</p>}
    <div className="field">
      <label htmlFor="license-key">Ключ ліцензії</label>
      <input id="license-key" type="password" autoComplete="off" maxLength={64} value={key}
        placeholder={license?.keySuffix ? `Збережений ключ закінчується на ${license.keySuffix}` : 'XXXX-XXXX-XXXX-XXXX'}
        onChange={event => setKey(event.target.value)} />
    </div>
    <div className="actions">
      <button type="button" disabled={busy || !key.trim()} onClick={() => void run(async () => {
        await window.desktop.activateLicense(key); setKey('');
      })}>{busy ? 'Перевірка…' : 'Активувати ліцензію'}</button>
      {license?.keySuffix && <button type="button" className="ghost" disabled={busy}
        onClick={() => void run(() => window.desktop.checkLicense())}>Перевірити ліцензію</button>}
      {license?.keySuffix && <button type="button" className="link danger-text" disabled={busy}
        onClick={() => void run(() => window.desktop.clearLicense())}>Видалити ліцензію</button>}
    </div>
    {error && <p className="field-error" role="alert">{error}</p>}
    <details className="advanced"><summary>Дані підключення</summary>
      <p className="hint">Сервер: {license?.serverUrl ?? '…'}</p>
      <p className="hint">Пристрій: <code>{license?.deviceId ?? '…'}</code></p>
      <p className="hint">Ключ зберігається зашифрованим на цьому комп’ютері. Профіль AdsPower рахується як один акаунт.</p>
    </details>
  </section>;
}
