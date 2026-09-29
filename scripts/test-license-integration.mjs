// Real Electron + Laravel API, with a copied SQLite database and isolated desktop data.
// The user's licenses, activations, profiles, and purchase history are never mutated.
import { _electron as electron } from 'patchright-core';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
const serverRoot = resolve(process.argv[2] || '../license-server');
const root = await mkdtemp(join(tmpdir(), 'nbu-license-integration-'));
const database = join(root, 'license.sqlite');
const desktopData = join(root, 'desktop');
const fixture = JSON.parse((await execute('python3', ['-c',
  'import sqlite3,json,sys; source=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); dest=sqlite3.connect(sys.argv[2]); source.backup(dest); row=dest.execute("select id,key,max_accounts from licenses where status=\'active\' and expires_at is null order by id limit 1").fetchone(); assert row, "Need an active lifetime demo license for isolated integration"; dest.execute("delete from license_activations where license_id=?",(row[0],)); dest.commit(); print(json.dumps(dict(id=row[0],key=row[1],maxAccounts=row[2])))',
  join(serverRoot, 'database/database.sqlite'), database])).stdout);
const publicKey = (await execute('php', ['-r',
  'require "vendor/autoload.php"; $app = require "bootstrap/app.php"; $app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap(); echo base64_encode(sodium_crypto_sign_publickey_from_secretkey(base64_decode(config("license.signing_secret_key"), true)));'],
  { cwd: serverRoot })).stdout.trim();
const portServer = createServer();
await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const url = `http://127.0.0.1:${port}`;
// Run the PHP built-in server directly, so stopping it cannot leave an Artisan child behind.
const server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', '.', join(serverRoot, 'vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php')], {
  cwd: join(serverRoot, 'public'), env: { ...process.env, APP_ENV: 'local', DB_CONNECTION: 'sqlite', DB_DATABASE: database }, stdio: 'ignore',
});
let application;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const closed = new Promise(resolve => server.once('exit', resolve)); server.kill('SIGTERM'); await closed;
}
async function closeApp() {
  if (!application) return;
  const current = application; application = undefined;
  const process = current.process();
  const exited = process.exitCode !== null || process.signalCode !== null
    ? Promise.resolve() : new Promise(resolve => process.once('exit', resolve));
  await current.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await exited;
}
async function launch() {
  application = await electron.launch({ args: ['.'], env: { ...process.env, NBU_DESKTOP_TEST_DATA: desktopData,
    NBU_LICENSE_SERVER_URL: url, NBU_LICENSE_PUBLIC_KEY: publicKey, ADSPOWER_API_KEY: '' }, timeout: 30_000 });
  const page = await application.firstWindow();
  await page.getByRole('heading', { name: 'Нове завдання' }).waitFor();
  await page.getByRole('tab', { name: 'Налаштування', exact: true }).click();
  return page;
}
async function setRevoked(revoked) {
  await execute('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("update licenses set status=? where id=?",(sys.argv[2],int(sys.argv[3]))); c.commit()',
    database, revoked ? 'revoked' : 'active', String(fixture.id)]);
}
const state = page => page.evaluate(() => window.desktop.state(), undefined, undefined, false);
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error('Isolated Laravel server failed to start');
    try {
      const response = await fetch(`${url}/up`, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) throw new Error('Laravel health check failed');
      ready = true; break;
    } catch { await pause(100); }
  }
  assert.ok(ready);
  let page = await launch();
  assert.equal((await state(page)).license.allowed, false);
  assert.equal(await page.getByRole('button', { name: 'Запланувати', exact: true, includeHidden: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Прогріти', exact: true, includeHidden: true }).isDisabled(), true);
  await assert.rejects(() => page.evaluate(() => window.desktop.inspectProfile({ profileId: 'test', url: 'https://coins.bank.gov.ua/test.html' }), undefined, undefined, false), /Активуйте/);
  await page.getByLabel('Ключ ліцензії', { exact: true }).fill(fixture.key);
  await page.getByRole('button', { name: 'Активувати ліцензію', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#license-key').value === '');
  await page.waitForFunction(async () => (await window.desktop.state()).license.status === 'active');
  const activated = await state(page);
  assert.equal(activated.license.maxAccounts, fixture.maxAccounts);
  assert.ok(!(await readFile(join(desktopData, 'license.enc'))).includes(Buffer.from(fixture.key)));
  const original = activated.settings;
  await page.evaluate(settings => window.desktop.saveSettings(settings), { ...original,
    savedProfiles: Array.from({ length: fixture.maxAccounts + 1 }, (_, i) => ({ id: `license_test_${i}`, name: '' })) }, undefined, false);
  await page.waitForFunction(async () => !(await window.desktop.state()).license.allowed);
  await assert.rejects(() => page.evaluate(() => window.desktop.inspectProfile({ profileId: 'test', url: 'https://coins.bank.gov.ua/test.html' }), undefined, undefined, false), /ліміт/);
  await page.evaluate(settings => window.desktop.saveSettings(settings), original, undefined, false);
  await page.evaluate(() => window.desktop.checkLicense(), undefined, undefined, false);
  assert.equal((await state(page)).license.allowed, true);
  const device = (await state(page)).license.deviceId;
  await closeApp(); page = await launch();
  assert.equal((await state(page)).license.deviceId, device);
  await page.evaluate(() => window.desktop.checkLicense(), undefined, undefined, false);
  assert.equal((await state(page)).license.allowed, true);
  await setRevoked(true);
  await assert.rejects(() => page.evaluate(() => window.desktop.checkLicense(), undefined, undefined, false), /відкликано/);
  await closeApp(); page = await launch();
  assert.equal((await state(page)).license.allowed, false);
  await setRevoked(false);
  await page.evaluate(() => window.desktop.checkLicense(), undefined, undefined, false);
  await stopServer();
  await page.evaluate(() => window.desktop.checkLicense(), undefined, undefined, false);
  assert.equal((await state(page)).license.status, 'offline');
  await closeApp(); page = await launch();
  assert.equal((await state(page)).license.allowed, true);
  await page.getByLabel('Ключ ліцензії', { exact: true }).fill('NBU2-TEST-FRND-2626');
  await page.getByRole('button', { name: 'Активувати ліцензію', exact: true }).click();
  await page.waitForFunction(async () => (await window.desktop.state()).license.status === 'test');
  await closeApp(); page = await launch();
  assert.equal((await state(page)).license.status, 'test');
  await page.evaluate(() => window.desktop.addTasks(['test_a', 'test_b'].map(profileId => ({
    profileId, url: 'https://coins.bank.gov.ua/test-license.html', saleAt: Date.now() + 86_400_000,
    leadMin: 5, retrySec: 1, windowMin: 5, mode: 'cart',
  }))), undefined, undefined, false);
  assert.equal((await state(page)).tasks.filter(task => task.status === 'scheduled').length, 2);
  await page.getByRole('button', { name: 'Видалити ліцензію', exact: true }).click();
  await page.waitForFunction(async () => !(await window.desktop.state()).license.allowed);
  await page.waitForFunction(async () => (await window.desktop.state()).tasks.every(task => task.status === 'cancelled'));
  await closeApp(); page = await launch();
  assert.equal((await state(page)).license.allowed, false);
  assert.equal((await state(page)).tasks.every(task => task.status === 'cancelled'), true);
  assert.equal(await page.getByRole('button', { name: 'Запланувати', exact: true, includeHidden: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Прогріти', exact: true, includeHidden: true }).isDisabled(), true);
  await page.getByRole('tab', { name: 'Кабінет', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Оновити кабінет', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.desktop.activateLicense('NBU2-TEST-FRND-2626'), undefined, undefined, false);
  assert.equal((await state(page)).tasks.every(task => task.status === 'cancelled'), true);
  console.log('License integration passed: real signed Laravel API, Electron IPC/UI, encrypted persistence, stable device, limits, revocation/restart, offline grace/restart, embedded test key without server, cancellation on removal and no task replay after reactivation.');
} finally {
  await closeApp().catch(() => {}); await stopServer(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
