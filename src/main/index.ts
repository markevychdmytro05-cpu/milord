import { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, safeStorage } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AdsPowerClient, AdsPowerProvider, PreparationGate, ProfileStartGate } from '../browser/adspower';
import { isFinal, productUrl, settingsSchema, taskInputSchema, type Task } from '../core/model';
import { ShopRequestGuard } from '../core/shop-errors';
import { Store } from './store';
import { Scheduler } from './scheduler';
import { KeyStore } from './key-store';

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

  const keyStore = new KeyStore(join(app.getPath('userData'), 'adspower-key.enc'), {
    available: () => safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  });
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
  scheduler = new Scheduler(store,
    () => new AdsPowerProvider(new AdsPowerClient(store.settings().apiUrl, apiKey, fetch, profileStartGate), shopGuard, preparationGate),
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
    savedApiKey, secretStorageAvailable: keyStore.available(), secretError }));
  let settingsWrites: Promise<unknown> = Promise.resolve();
  function changeSettings(action: () => Promise<void>): Promise<void> {
    const operation = settingsWrites.then(async () => {
      if (scheduler.hasRunningWork()) throw new Error('Зупиніть активне виконання перед зміною підключення.');
      await action();
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
  handle('add-task', (input) => scheduler.add(taskInputSchema.parse(input)));
  handle('add-tasks', (input) => scheduler.addMany(z.array(taskInputSchema).min(1).max(200).parse(input)));
  handle('cancel-task', (input) => scheduler.cancel(z.string().uuid().parse(input)));
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
