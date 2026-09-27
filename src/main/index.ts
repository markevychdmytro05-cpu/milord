import { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, safeStorage, shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AdsPowerClient, AdsPowerProvider, PreparationGate, ProfileStartGate } from '../browser/adspower';
import { isFinal, productUrl, settingsSchema, taskInputSchema, type Task } from '../core/model';
import { summarizeOffsetHistoryByProfile } from '../core/offset-history';
import { ShopRequestGuard } from '../core/shop-errors';
import { Store } from './store';
import { Scheduler } from './scheduler';
import { KeyStore } from './key-store';
import { CabinetReader, cabinetError } from '../browser/cabinet';
import { CabinetCache } from './cabinet-cache';
import { BehaviorTester } from '../browser/behavior-test';
import { BehaviorTests } from './behavior-tests';
import { CabinetStore } from './cabinet-store';
import { cabinetDocumentSchema } from '../core/cabinet-state';
import { AccountStore, nbuCredentialsSchema } from './account-store';
import { NbuLogin } from '../browser/nbu-login';
import { PageRecorder } from '../browser/page-recorder';
import { launchAdsPower } from './adspower-launcher';

app.setName('NBU Desktop');
// UI smoke tests use an isolated temporary directory, never the user's task history.
if (process.env.NBU_DESKTOP_TEST_DATA) app.setPath('userData', process.env.NBU_DESKTOP_TEST_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else void boot();

async function boot(): Promise<void> {
  await app.whenReady();
  const store = new Store(join(app.getPath('userData'), 'tasks.json'));
  try { await store.load(); }
  catch {
    dialog.showErrorBox('Не вдалося відкрити завдання', 'Файл tasks.json пошкоджений або недоступний. Оригінал не змінено.');
    app.quit();
    return;
  }

  const cipher = {
    available: () => safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value: string) => safeStorage.encryptString(value),
    decrypt: (value: Buffer) => safeStorage.decryptString(value),
  };
  const keyStore = new KeyStore(join(app.getPath('userData'), 'adspower-key.enc'), cipher);
  const accountStore = new AccountStore(join(app.getPath('userData'), 'nbu-accounts.enc'), cipher);
  let accountsError = await accountStore.load();
  const restoredKey = await keyStore.load();
  let apiKey = restoredKey.value || process.env.ADSPOWER_API_KEY || '';
  let savedApiKey = restoredKey.saved;
  let secretError = restoredKey.error;
  let blocker: number | undefined;
  let scheduler: Scheduler;
  const window = new BrowserWindow({
    width: 1160, height: 850, minWidth: 850, minHeight: 650,
    title: 'NBU Desktop', backgroundColor: '#f1f0ec',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);
  const uiUrl = pathToFileURL(join(__dirname, 'index.html')).href;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  app.on('second-instance', () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  const busy = (active: boolean) => {
    if (active && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (!active && blocker !== undefined) {
      powerSaveBlocker.stop(blocker);
      blocker = undefined;
    }
  };
  const notify = (task: Task) => {
    if ((isFinal(task.status) || task.status === 'needs_attention') && Notification.isSupported()) {
      new Notification({ title: 'NBU Desktop', body: task.note }).show();
    }
  };
  const profileStartGate = new ProfileStartGate();
  const shopGuard = new ShopRequestGuard();
  const preparationGate = new PreparationGate();
  const nbuLogin = new NbuLogin(profileId => accountStore.get(profileId), shopGuard, preparationGate);
  const capturesPath = join(app.getPath('userData'), 'captures');
  const recorder = new PageRecorder(capturesPath);
  void recorder.prune();
  scheduler = new Scheduler(store,
    () => new AdsPowerProvider(new AdsPowerClient(store.settings().apiUrl, apiKey, fetch, profileStartGate, launchAdsPower), shopGuard, preparationGate, nbuLogin, recorder),
    notify, busy,
    (message) => dialog.showErrorBox('Планувальник зупинено', message),
  );

  function handle(channel: string, handler: (input: unknown) => unknown) {
    ipcMain.handle(channel, (event, input: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame?.url !== uiUrl) throw new Error('Untrusted IPC caller');
      return handler(input);
    });
  }

  handle('state', () => ({ tasks: store.tasks(), settings: store.settings(), hasApiKey: !!apiKey,
    savedApiKey, secretStorageAvailable: keyStore.available(), secretError,
    nbuAccounts: accountStore.emails(), accountsError,
    offsetHistoryByProfile: summarizeOffsetHistoryByProfile(store.tasks()) }));
  const cabinetCache = new CabinetCache();
  const cabinetStore = new CabinetStore(join(app.getPath('userData'), 'cabinet-cache.json'));
  handle('restore-cabinet', input => {
    const { connection, legacy } = z.object({ connection: z.string(), legacy: z.string().max(10_000_000).optional() }).parse(input);
    if (connection !== store.settings().apiUrl) throw new Error('Підключення змінилося. Відкрийте кабінет повторно.');
    return cabinetStore.load(connection, store.settings().savedProfiles.map(p => p.id), legacy);
  });
  handle('save-cabinet', input => {
    const { connection, state } = z.object({ connection: z.string(), state: z.unknown() }).parse(input);
    if (connection !== store.settings().apiUrl) throw new Error('Підключення змінилося. Відкрийте кабінет повторно.');
    const parsed = cabinetDocumentSchema.parse({ ...z.record(z.string(), z.unknown()).parse(state), connection, version: 1 });
    return cabinetStore.save(connection, store.settings().savedProfiles.map(p => p.id), parsed);
  });
  let settingsWrites: Promise<unknown> = Promise.resolve();
  function changeSettings(action: () => Promise<void>): Promise<void> {
    const operation = settingsWrites.then(async () => {
      if (scheduler.hasRunningWork()) throw new Error('Зупиніть активне виконання перед зміною підключення.');
      const previousConnection = JSON.stringify([store.settings().apiUrl, apiKey]);
      await action();
      if (JSON.stringify([store.settings().apiUrl, apiKey]) !== previousConnection) cabinetCache.clear();
    });
    settingsWrites = operation.catch(() => {});
    return operation;
  }
  handle('save-settings', (input) => changeSettings(async () => {
    const parsed = settingsSchema.extend({ apiKey: z.string().trim().min(1).max(4096).optional() }).parse(input);
    if (parsed.apiKey !== undefined) {
      await keyStore.save(parsed.apiKey);
      apiKey = parsed.apiKey;
      savedApiKey = true;
      secretError = undefined;
    }
    await store.saveSettings(settingsSchema.parse(parsed));
  }));
  handle('clear-api-key', () => changeSettings(async () => {
    await keyStore.clear();
    apiKey = process.env.ADSPOWER_API_KEY || '';
    savedApiKey = false;
    secretError = undefined;
  }));
  let profilesRequest: Promise<unknown> | undefined;
  let profilesConnection = '';
  handle('list-profiles', () => {
    if (scheduler.hasRunningWork()) throw new Error('Оновіть список після завершення активного виконання.');
    const connection = JSON.stringify([store.settings().apiUrl, apiKey]);
    if (profilesRequest && profilesConnection === connection) return profilesRequest;
    profilesConnection = connection;
    const request = new AdsPowerClient(store.settings().apiUrl, apiKey, fetch, profileStartGate)
      .listProfiles(AbortSignal.timeout(180_000))
      .catch((error) => { throw new Error(error instanceof Error && error.message.startsWith('AdsPower')
        ? error.message : 'Не вдалося завантажити профілі. Перевірте AdsPower, Local API та ключ.'); })
      .finally(() => { if (profilesRequest === request) profilesRequest = undefined; });
    profilesRequest = request;
    return request;
  });
  const cabinetProfile = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
  const behaviorTests = new BehaviorTests();
  handle('test-behavior', input => {
    const { profileId, navigate, showCursor, minutes } = z.object({ profileId: cabinetProfile, navigate: z.boolean(),
      showCursor: z.boolean().default(false), minutes: z.number().int().min(1).max(60) }).parse(input);
    if (!store.settings().savedProfiles.some(profile => profile.id === profileId)) throw new Error('Збережіть профіль у налаштуваннях.');
    return behaviorTests.run(profileId, cancel => scheduler.readProfile(profileId, signal => new BehaviorTester(
      new AdsPowerClient(store.settings().apiUrl, apiKey, fetch, profileStartGate, launchAdsPower), shopGuard, preparationGate, undefined, undefined, nbuLogin,
    ).run(profileId, { navigate, showCursor, durationMs: minutes * 60_000 }, AbortSignal.any([signal, cancel])), minutes * 60_000 + 240_000));
  });
  handle('stop-behavior-test', input => { behaviorTests.stop(cabinetProfile.parse(input)); });
  function cabinetRequest<T>(profileId: string, key: string, read: (reader: CabinetReader, signal: AbortSignal) => Promise<T>, openProfile = true): Promise<T> {
    if (!store.settings().savedProfiles.some(profile => profile.id === profileId)) throw new Error('Збережіть профіль у налаштуваннях.');
    return cabinetCache.get(JSON.stringify([profileId, key, openProfile]), () => scheduler.readProfile(profileId, signal => {
      const reader = new CabinetReader(new AdsPowerClient(store.settings().apiUrl, apiKey, fetch, profileStartGate, launchAdsPower), shopGuard, preparationGate, nbuLogin, openProfile);
      return read(reader, signal);
    }, openProfile ? 240_000 : 90_000)).catch(error => { throw new Error(cabinetError(error)); });
  }
  handle('open-captures', async () => {
    await mkdir(capturesPath, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(capturesPath);
    if (error) throw new Error('Не вдалося відкрити папку записів.');
  });
  handle('save-nbu-account', async input => {
    const { profileId, ...credentials } = nbuCredentialsSchema.extend({ profileId: cabinetProfile }).parse(input);
    if (!store.settings().savedProfiles.some(profile => profile.id === profileId)) throw new Error('Збережіть профіль у налаштуваннях.');
    // NBU keeps one session per account: two profiles with the same login would sign each other out.
    const taken = Object.entries(accountStore.emails()).find(([id, email]) => id !== profileId &&
      email.toLowerCase() === credentials.email.toLowerCase());
    if (taken) {
      const name = store.settings().savedProfiles.find(profile => profile.id === taken[0])?.name || taken[0];
      throw new Error(`Ця пошта вже прив’язана до профілю «${name}». НБУ тримає одну сесію на акаунт, тож два профілі вибивали б один одного.`);
    }
    await accountStore.save(profileId, credentials);
    accountsError = undefined;
  });
  handle('clear-nbu-account', async input => { await accountStore.clear(cabinetProfile.parse(input)); });
  handle('load-cabinet', input => {
    const { profileId, sections, openProfile } = z.object({ profileId: cabinetProfile, openProfile: z.boolean().default(false),
      sections: z.array(z.enum(['orders', 'wishlist', 'cart'])).min(1).max(3).optional() }).parse(input);
    return cabinetRequest(profileId, `snapshot:${(sections ?? ['all']).join(',')}`, (reader, signal) => reader.load(profileId, signal, sections), openProfile);
  });
  handle('load-cabinet-order', input => {
    const { profileId, orderId, detailId } = z.object({ profileId: cabinetProfile, orderId: z.string().regex(/^\d{1,20}$/),
      detailId: z.string().regex(/^\d{1,20}$/).optional() }).parse(input);
    return cabinetRequest(profileId, `order:${orderId}:${detailId ?? orderId}`, (reader, signal) => reader.order(profileId, orderId, signal, detailId));
  });
  handle('load-cabinet-orders', input => {
    const { profileId, page } = z.object({ profileId: cabinetProfile, page: z.number().int().min(2).max(1000) }).parse(input);
    return cabinetRequest(profileId, `orders:${page}`, (reader, signal) => reader.ordersPage(profileId, page, signal));
  });
  handle('add-task', input => {
    const parsed = taskInputSchema.parse(input);
    return behaviorTests.beforePurchase(() => scheduler.add(parsed));
  });
  handle('add-tasks', input => {
    const parsed = z.array(taskInputSchema).min(1).max(200).parse(input);
    return behaviorTests.beforePurchase(() => scheduler.addMany(parsed));
  });
  handle('cancel-task', (input) => scheduler.cancel(z.string().uuid().parse(input)));
  handle('update-task', (input) => {
    const parsed = z.object({ id: z.string().uuid(), url: z.string().max(2048),
      saleAt: z.number().int().positive().max(8_640_000_000_000_000) }).parse(input);
    return behaviorTests.beforePurchase(() => scheduler.update(parsed.id, parsed));
  });
  handle('inspect-profile', (input) => {
    const parsed = z.object({
      profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
      url: z.string().max(2048).transform(productUrl),
    }).parse(input);
    return scheduler.inspect(parsed.profileId, parsed.url);
  });

  let quitting = false;
  let closingDialog = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (closingDialog) return;
    closingDialog = true;
    void (async () => {
      if (scheduler.hasActiveWork()) {
        const result = await dialog.showMessageBox(window, {
          type: 'question', title: 'Закрити NBU Desktop?',
          message: 'Виконання активних завдань зупиниться.',
          detail: 'Заплановані завдання збережено. Уже надіслане додавання в кошик не скасовується.',
          buttons: ['Залишити відкритою', 'Закрити'], defaultId: 0, cancelId: 0,
        });
        if (result.response === 0) { closingDialog = false; return; }
      }
      await scheduler.stop();
      await cabinetStore.flush();
      busy(false);
      quitting = true;
      app.quit();
    })();
  });
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); app.quit(); }
  });
  await window.loadFile(join(__dirname, 'index.html'));
  scheduler.start();
}
