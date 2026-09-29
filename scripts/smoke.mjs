import { _electron as electron } from 'patchright-core';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const dataDirectory = await mkdtemp(join(tmpdir(), 'nbu-desktop-ui-'));
const secret = 'test-key-not-a-real-secret';
let profileRequests = 0;
const server = createServer((request, response) => {
  profileRequests++;
  response.setHeader('Content-Type', 'application/json');
  if (!request.url.startsWith('/api/v1/user/list')) { response.writeHead(404); response.end('{}'); return; }
  response.end(JSON.stringify(request.headers.authorization === `Bearer ${secret}` ? {
    code: 0, data: { list: [
      { user_id: 'profile_a', serial_number: '7', name: 'Основний' },
      { user_id: 'profile_b', serial_number: '8', name: 'Другий' },
    ] },
  } : { code: -1 }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await writeFile(join(dataDirectory, 'tasks.json'), JSON.stringify({ version: 1, tasks: [],
  settings: { apiUrl: `http://127.0.0.1:${server.address().port}` } }));
let application;
const launch = async () => {
  application = await electron.launch({ args: ['.'],
    env: { ...process.env, TZ: 'America/Los_Angeles', NBU_DESKTOP_TEST_DATA: dataDirectory, ADSPOWER_API_KEY: '' }, timeout: 30_000 });
  const page = await application.firstWindow();
  await page.evaluate(() => window.desktop.activateLicense('NBU2-TEST-FRND-2626'), undefined, undefined, false);
  await page.route('https://cdn-nbu.solomono.net/bank/images/ui-test-*.svg', route => route.request().url().includes('missing') ? route.abort()
    : route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="34" fill="#ddd6bc" stroke="#9e9577" stroke-width="3"/><text x="40" y="50" text-anchor="middle" font-size="28" fill="#605638">N</text></svg>' }));
  await page.getByRole('heading', { name: 'Нове завдання' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('button[type="submit"]')?.disabled);
  return page;
};
try {
  let page = await launch();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  assert.match(await page.locator('[name="saleAt"]').inputValue(), /T10:00/);
  await page.getByRole('tab', { name: 'Кабінет', exact: true }).click();
  const cabinet = page.getByRole('region', { name: 'Кабінет НБУ', exact: true });
  await cabinet.getByRole('heading', { name: 'Замовлення ще не завантажені' }).waitFor();
  assert.equal(await cabinet.getByRole('button', { name: 'Показати приклад' }).count(), 0);
  assert.equal(await cabinet.locator('.order-card').count(), 0);
  await cabinet.getByRole('tab', { name: /Бажане/ }).click();
  await cabinet.getByRole('heading', { name: 'Бажане ще не завантажене' }).waitFor();
  await cabinet.getByRole('tab', { name: /Бажане/ }).press('ArrowRight');
  await cabinet.getByRole('heading', { name: 'Кошик ще не завантажений' }).waitFor();
  await cabinet.getByRole('tab', { name: /Замовлення/ }).click();
  await page.screenshot({ path: join(dataDirectory, 'cabinet.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Кабінет', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('heading', { name: 'Нове завдання' }).waitFor();

  // Inline validation appears in Ukrainian, next to the field, without native browser bubbles.
  const submit = page.getByRole('button', { name: 'Запланувати', exact: true });
  await submit.click();
  await page.getByText('Вставте посилання на монету.', { exact: true }).waitFor();
  await page.getByLabel('Посилання на монету').fill('https://example.com/x');
  await submit.click();
  await page.getByText(/coins\.bank\.gov\.ua/).first().waitFor();
  assert.equal(await page.getByText(/Error invoking remote method/).count(), 0);
  await page.getByRole('tab', { name: 'Налаштування', exact: true }).click();
  assert.equal(await page.getByLabel('API-ключ').isVisible(), true);
  await page.getByRole('button', { name: 'Додати профіль', exact: true }).click();
  await page.locator('#profile-name-0').fill('Основний');
  await page.locator('#profile-id-0').fill('profile_a');
  await page.getByRole('button', { name: 'Додати профіль', exact: true }).click();
  await page.locator('#profile-name-1').fill('Другий');
  await page.locator('#profile-id-1').fill('profile_a');
  await page.getByRole('button', { name: 'Зберегти налаштування', exact: true }).click();
  await page.getByText('Цей ID уже є у списку. Приберіть повтор.', { exact: true }).waitFor();
  await page.locator('#profile-id-1').fill('profile_b');
  await page.getByLabel('Відкрити профіль за, хв', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Зберегти налаштування', exact: true }).click();
  await page.getByText('Ціле число від 1 до 60.', { exact: true }).waitFor();
  await page.getByLabel('Відкрити профіль за, хв', { exact: true }).fill('3');
  await page.getByLabel('Повторне оновлення, с').fill('1');
  await page.getByRole('button', { name: 'Зберегти налаштування', exact: true }).click();
  await page.getByText('Налаштування збережено.', { exact: true }).waitFor();
  let localState = await page.evaluate(() => window.desktop.state(), undefined, undefined, false);
  assert.equal(localState.hasApiKey, false);
  assert.deepEqual(localState.settings.savedProfiles, [{ id: 'profile_a', name: 'Основний' }, { id: 'profile_b', name: 'Другий' }]);
  assert.equal(profileRequests, 0); // The local list works without any AdsPower request.
  // Exercise the actual cabinet UI through isolated IPC fixtures; never open a real profile.
  await application.evaluate(({ ipcMain, app }) => {
    app.cabinetReads = { snapshots: 0, details: 0 };
    app.cabinetOpenProfiles = [];
    ipcMain.removeHandler('load-cabinet');
    ipcMain.handle('load-cabinet', (_event, input) => {
      const profileId = typeof input === 'string' ? input : input.profileId;
      app.cabinetReads.snapshots++;
      app.cabinetOpenProfiles.push(input.openProfile);
      return { profileId, fetchedAt: Date.now(), errors: {}, wishlist: [],
        orders: [{ id: '100', detailId: profileId === 'profile_a' ? '777' : undefined, date: '27.08.2026', status: 'Оплачено', quantity: 2, total: profileId === 'profile_a' ? 100 : 200, tracking: '123456' },
          ...(profileId === 'profile_a' ? [{ id: '101', mergedInto: '100', date: '27.08.2026', status: 'Об’єднано в №100', quantity: 1, total: 50, tracking: '' },
            ...Array.from({ length: 11 }, (_, i) => ({ id: String(200 + i), date: '26.08.2026', status: 'Отримано', quantity: 1, total: 50, tracking: '' }))] : [])],
        nextOrdersPage: profileId === 'profile_a' ? 2 : undefined,
        cart: [{ id: '42', name: 'Тестова монета', quantity: 2, price: 50, total: 100, imageUrl: `https://cdn-nbu.solomono.net/bank/images/ui-test-${profileId === 'profile_a' ? 'coin' : 'missing'}.svg` }] };
    });
    app.cabinetPageReads = 0;
    ipcMain.removeHandler('load-cabinet-orders');
    ipcMain.handle('load-cabinet-orders', (_event, { profileId, page }) => {
      app.cabinetPageReads++;
      return { profileId, page, fetchedAt: Date.now(), orders: [300, 301].map(id => ({ id: String(id), date: '25.08.2026', status: 'Отримано', quantity: 1, total: 50, tracking: '' })) };
    });
    ipcMain.removeHandler('load-cabinet-order');
    ipcMain.handle('load-cabinet-order', (_event, { orderId, profileId, detailId }) => {
      app.cabinetReads.details++;
      app.lastDetailId = detailId ?? orderId;
      return { id: orderId, delivery: 'Укрпошта', deliveryCost: 'За тарифами перевізника', address: 'Тестова адреса',
        payment: 'LiqPay', total: profileId === 'profile_a' ? 100 : 200,
        products: [{ id: '42', name: 'Тестова монета', quantity: 2, price: 50, total: 100 }],
        history: [{ at: '27.08.2026 10:00', status: 'Оплачено' }] };
    });
  });
  assert.deepEqual(await application.evaluate(({ app }) => app.cabinetReads), { snapshots: 0, details: 0 });
  await page.getByRole('tab', { name: 'Кабінет', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.order-card').length === 10);
  assert.deepEqual(await application.evaluate(({ app }) => app.cabinetOpenProfiles), [false, false]);
  assert.equal(await cabinet.getByRole('button', { name: /Оновити через/ }).isDisabled(), true);
  await cabinet.getByRole('button', { name: 'Дивитись замовлення 100 · Основний', exact: true }).click();
  await cabinet.getByText('Тестова адреса', { exact: true }).waitFor();
  assert.equal(await application.evaluate(({ app }) => app.lastDetailId), '777');
  assert.equal(await cabinet.getByRole('button', { name: /Дивитись замовлення 101/ }).count(), 0);
  await cabinet.getByRole('button', { name: 'Закрити деталі замовлення' }).press('Escape');
  await cabinet.getByRole('button', { name: 'Сторінка 2', exact: true }).click();
  assert.equal(await cabinet.locator('.order-card').count(), 4);
  assert.deepEqual(await application.evaluate(({ app }) => app.cabinetReads), { snapshots: 2, details: 1 });
  await cabinet.getByRole('button', { name: 'Дивитись замовлення 100 · Другий', exact: true }).click();
  await cabinet.locator('.order-sum').getByText('200 грн', { exact: true }).waitFor();
  await page.screenshot({ path: join(dataDirectory, 'cabinet-loaded.png'), fullPage: true });
  await cabinet.getByRole('button', { name: 'Закрити деталі замовлення' }).click();
  await cabinet.getByRole('checkbox', { name: /Автооновлення/ }).uncheck();
  assert.equal(await page.evaluate(() => localStorage.getItem('cabinet-auto-refresh')), 'off');
  await cabinet.getByRole('combobox', { name: 'Профіль кабінету' }).selectOption('profile_a');
  assert.equal(await cabinet.locator('.order-card').count(), 10);
  await cabinet.getByRole('tab', { name: /Кошик/ }).click();
  await cabinet.getByRole('heading', { name: 'Тестова монета' }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.product-image img')].some(image => image.complete && image.naturalWidth > 0));
  assert.equal(await cabinet.getByRole('img', { name: 'Тестова монета', exact: true }).isVisible(), true);
  await page.screenshot({ path: join(dataDirectory, 'cart-photo.png'), fullPage: true });
  await cabinet.getByRole('combobox', { name: 'Профіль кабінету' }).selectOption('profile_b');
  await cabinet.getByRole('img', { name: 'Фото відсутнє', exact: true }).waitFor();
  assert.equal(await cabinet.getByRole('heading', { name: 'Тестова монета' }).isVisible(), true);
  await cabinet.getByRole('combobox', { name: 'Профіль кабінету' }).selectOption('profile_a');
  await cabinet.getByRole('tab', { name: /Бажане/ }).click();
  await cabinet.getByRole('heading', { name: 'Бажане порожнє' }).waitFor();
  assert.deepEqual(await application.evaluate(({ app }) => app.cabinetReads), { snapshots: 2, details: 2 });
  await cabinet.getByRole('tab', { name: /Замовлення/ }).click();
  await cabinet.getByRole('button', { name: 'Сторінка 2', exact: true }).click();
  await cabinet.getByRole('button', { name: 'Ще замовлення · Основний', exact: true }).click();
  await cabinet.getByRole('heading', { name: '301', exact: true }).waitFor();
  assert.equal(await cabinet.locator('.order-card').count(), 5);
  assert.equal(await application.evaluate(({ app }) => app.cabinetPageReads), 1);
  await cabinet.getByRole('button', { name: 'Сторінка 1', exact: true }).click();
  await cabinet.getByRole('button', { name: 'Сторінка 2', exact: true }).click();
  assert.equal(await application.evaluate(({ app }) => app.cabinetPageReads), 1);
  await page.getByRole('tab', { name: 'Налаштування', exact: true }).click();

  // Behavior controls live with tasks and launch selected profiles together.
  await application.evaluate(({ ipcMain, app }) => {
    app.behaviorCalls = []; app.finishBehaviorTests = new Map(); app.stoppedBehaviorProfiles = [];
    ipcMain.removeHandler('test-behavior');
    ipcMain.handle('test-behavior', (_event, input) => {
      app.behaviorCalls.push(input);
      return new Promise(resolve => app.finishBehaviorTests.set(input.profileId, resolve));
    });
    ipcMain.removeHandler('stop-behavior-test');
    ipcMain.handle('stop-behavior-test', (_event, profileId) => {
      app.stoppedBehaviorProfiles.push(profileId);
      app.finishBehaviorTests.get(profileId)({ moves: 1, scrolls: 0, navigations: 0, pauses: 0, stopped: true, durationMs: 1000, login: 'logged-in' });
    });
  });
  await page.getByRole('tab', { name: 'Завдання', exact: true }).click();
  const behavior = page.getByRole('region', { name: 'Прогрів профілів', exact: true });
  const compact = await behavior.boundingBox();
  assert.ok(compact.width <= 420 && compact.height < 100);
  await behavior.screenshot({ path: join(dataDirectory, 'behavior-compact.png') });
  assert.equal(await behavior.getByRole('spinbutton').isVisible(), false);
  await behavior.getByRole('button', { name: 'Прогрів профілів', exact: true }).click();
  await behavior.locator('summary').click();
  await behavior.getByRole('spinbutton', { name: 'Тривалість прогріву, хв' }).fill('3');
  await behavior.getByRole('button', { name: /^Профілі для прогріву:/ }).click();
  await behavior.getByRole('button', { name: 'Очистити', exact: true }).click();
  assert.equal(await behavior.getByRole('button', { name: 'Прогріти', exact: true }).isDisabled(), true);
  await behavior.getByRole('checkbox', { name: 'Основний', exact: true }).check();
  await behavior.getByRole('checkbox', { name: 'Основний', exact: true }).press('Escape');
  await behavior.getByRole('button', { name: 'Прогріти', exact: true }).click();
  await behavior.getByRole('button', { name: 'Зупинити прогрів', exact: true }).click();
  await behavior.getByRole('log').getByText(/Основний: зупинено/).waitFor();
  assert.deepEqual(await application.evaluate(({ app }) => app.behaviorCalls.map(call => call.profileId)), ['profile_a']);
  await application.evaluate(({ app }) => { app.behaviorCalls = []; app.stoppedBehaviorProfiles = []; });
  await behavior.getByRole('button', { name: /^Профілі для прогріву:/ }).click();
  await behavior.getByRole('checkbox', { name: 'Другий', exact: true }).check();
  assert.equal(await behavior.getByRole('checkbox', { name: 'Основний', exact: true }).isChecked(), true);
  await behavior.screenshot({ path: join(dataDirectory, 'behavior-profiles.png') });
  await behavior.getByRole('checkbox', { name: 'Другий', exact: true }).press('Escape');
  await behavior.getByRole('button', { name: 'Прогрів профілів', exact: true }).click();
  await behavior.getByRole('button', { name: 'Прогріти', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.behavior-test [role="status"]').textContent.includes('Активних профілів: 2'));
  assert.deepEqual(await application.evaluate(({ app }) => app.behaviorCalls.map(call => [call.profileId, call.minutes])), [['profile_a', 3], ['profile_b', 3]]);
  await behavior.getByRole('button', { name: 'Зупинити прогрів', exact: true }).click();
  await behavior.getByRole('button', { name: 'Прогрів профілів', exact: true }).click();
  await behavior.getByRole('log').getByText(/Основний: зупинено/).waitFor();
  await behavior.getByRole('log').getByText(/Другий: зупинено/).waitFor();
  assert.deepEqual(await application.evaluate(({ app }) => app.stoppedBehaviorProfiles.sort()), ['profile_a', 'profile_b']);
  await behavior.screenshot({ path: join(dataDirectory, 'behavior-test.png') });
  await behavior.getByRole('button', { name: 'Прогрів профілів', exact: true }).click();
  await page.getByRole('tab', { name: 'Налаштування', exact: true }).click();

  await page.locator('.profile-import > summary').click();
  await page.getByRole('button', { name: 'Завантажити профілі', exact: true }).click();
  await page.getByText(/Можна додати профілі вручну вище/).waitFor();
  await page.getByLabel('API-ключ').fill(secret);
  await page.getByRole('button', { name: 'Зберегти налаштування', exact: true }).click();
  await page.waitForFunction(async () => (await window.desktop.state()).savedApiKey);
  await page.waitForFunction(() => document.getElementById('set-apiKey').value === '');
  assert.equal(await page.getByLabel('API-ключ').inputValue(), '');
  await page.screenshot({ path: join(dataDirectory, 'settings.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Завдання', exact: true }).click();
  assert.equal(await page.getByLabel('ID профілів вручну').count(), 0);
  assert.equal(await page.locator('#panel-tasks').getByText(/AdsPower не надав/).count(), 0);
  await page.getByRole('checkbox', { name: /Основний/ }).check();
  await page.getByRole('checkbox', { name: /Другий/ }).check();
  await page.getByLabel('Посилання на монету').fill('https://coins.bank.gov.ua/test-coin.html');
  await page.getByRole('button', { name: '+ Ще монета', exact: true }).click();
  await page.getByLabel('Монета 2', { exact: true }).fill('https://coins.bank.gov.ua/second-coin.html');
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await page.locator('[name="saleAt"]').fill(`${tomorrow}T10:00`);
  await page.screenshot({ path: join(dataDirectory, 'multiple-coins.png'), fullPage: true });
  await submit.click();
  await page.getByText('Заплановано', { exact: true }).first().waitFor();
  assert.equal(await page.getByText('Заплановано', { exact: true }).count(), 4);
  await page.getByText(/до старту/).first().waitFor();
  // Journal export is local and preserves task identity and event timestamps.
  const journal = page.locator('.task .journal').first();
  await journal.getByRole('log').waitFor();
  const card = page.locator('.task').first();
  const expandedHeight = (await card.boundingBox()).height;
  await card.getByRole('button', { name: 'Згорнути', exact: true }).click();
  assert.equal(await journal.isVisible(), false);
  assert.equal(await card.getByRole('heading', { name: 'test coin', exact: true }).isVisible(), true);
  assert.ok((await card.boundingBox()).height < expandedHeight);
  await card.getByRole('button', { name: 'Розгорнути', exact: true }).click();
  await journal.getByRole('log').waitFor();
  assert.ok((await journal.getByRole('log').boundingBox()).y <
    (await journal.getByRole('button', { name: 'Завантажити журнал' }).boundingBox()).y);
  await card.screenshot({ path: join(dataDirectory, 'task-console.png') });
  await journal.getByText('Завдання заплановано. Монети запускаються незалежно.', { exact: false }).waitFor();
  const exportPath = join(dataDirectory, 'journal-export.json');
  await application.evaluate(({ session }, path) => {
    session.defaultSession.journalDownload = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 10_000);
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(path);
        item.once('done', (_event, state) => { clearTimeout(timer); resolve(state); });
      });
    });
  }, exportPath);
  await journal.getByRole('button', { name: 'Завантажити журнал' }).click();
  assert.equal(await application.evaluate(({ session }) => session.defaultSession.journalDownload), 'completed');
  const report = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(report.profileId, 'profile_a');
  assert.equal(report.events[0].message, 'Завдання заплановано. Монети запускаються незалежно.');
  assert.equal(report.timeZone, 'Europe/Kyiv');
  assert.ok(report.id);

  // A task that has not started is cancelled at once; no confirmation is needed.
  await page.getByRole('button', { name: 'Зупинити', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('#task-panel-active .task').length === 3);
  assert.equal(await page.getByText('Заплановано', { exact: true }).count(), 3);
  for (let remaining = 3; remaining > 0; remaining--) {
    await page.getByRole('button', { name: 'Зупинити', exact: true }).first().click();
    await page.waitForFunction(async (count) => (await window.desktop.state()).tasks.filter((task) => task.status === 'scheduled').length === count, remaining - 1);
  }
  await page.waitForFunction(async () => (await window.desktop.state()).tasks.every((task) => task.status === 'cancelled'));
  await page.getByText('Активних завдань немає', { exact: true }).waitFor();
  await page.getByRole('tab', { name: /^Історія/ }).click();
  assert.equal(await page.locator('.sale').count(), 1);
  assert.equal(await page.locator('.hist').count(), 4);
  assert.equal(await page.locator('.hist').first().isVisible(), false);
  await page.locator('.sale > summary').click();
  assert.equal(await page.getByText('Скасовано', { exact: true }).first().isVisible(), true);
  await page.locator('.hist > summary').first().click();
  await page.locator('.hist').first().getByRole('log').waitFor();
  await page.getByRole('tab', { name: /^Історія/ }).press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: /^Активні/ }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: /^Активні/ }).press('ArrowRight');
  const index = JSON.parse(await readFile(join(dataDirectory, 'tasks.json'), 'utf8'));
  const files = await Promise.all(index.taskIds.map((id) => readFile(join(dataDirectory, 'tasks', `${id}.json`), 'utf8')));
  for (const persisted of [JSON.stringify(index), ...files]) assert.equal(persisted.includes(secret), false);
  const saved = files.map((file) => JSON.parse(file));
  assert.equal(saved.length, 4);
  assert.equal(new Set(saved.map((task) => task.batchId)).size, 1);
  assert.equal(saved.filter((task) => task.profileId === 'profile_a').length, 2);
  for (const task of saved) {
    assert.equal(task.status, 'cancelled'); assert.equal(task.clicks, 0); assert.equal(task.leadMin, 3); assert.equal(task.retrySec, 1);
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(task.saleAt);
    assert.equal(hour, '10:00');
  }
  assert.equal((await readFile(join(dataDirectory, 'adspower-key.enc'))).includes(Buffer.from(secret)), false);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => [...document.fonts].some((font) => font.family.includes('Inter') && font.status === 'loaded')), true);
  await page.screenshot({ path: join(dataDirectory, 'tasks.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await application.close();
  page = await launch();
  const restored = await page.evaluate(() => window.desktop.state(), undefined, undefined, false);
  assert.equal(restored.hasApiKey, true); assert.equal(restored.savedApiKey, true);
  assert.equal(JSON.stringify(restored).includes(secret), false);
  assert.equal(restored.settings.retrySec, 1);
  assert.deepEqual(restored.settings.savedProfiles, [{ id: 'profile_a', name: 'Основний' }, { id: 'profile_b', name: 'Другий' }]);
  assert.equal(await page.getByRole('checkbox', { name: /Основний/ }).isChecked(), true);
  // Disk cache restores immediately, even with auto refresh enabled, with no IPC shop reads.
  await application.evaluate(({ ipcMain, app }) => {
    app.cabinetRestartReads = 0;
    ipcMain.removeHandler('load-cabinet');
    ipcMain.handle('load-cabinet', () => { app.cabinetRestartReads++; throw Error('Unexpected shop read after restart'); });
    ipcMain.removeHandler('load-cabinet-order');
    ipcMain.handle('load-cabinet-order', () => { app.cabinetRestartReads++; throw Error('Unexpected detail read after restart'); });
  });
  await page.getByRole('tab', { name: 'Кабінет', exact: true }).click();
  const restoredCabinet = page.getByRole('region', { name: 'Кабінет НБУ', exact: true });
  await restoredCabinet.getByRole('heading', { name: '301', exact: true }).waitFor();
  assert.equal(await restoredCabinet.getByRole('button', { name: 'Сторінка 2', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await restoredCabinet.locator('.order-card').count(), 5);
  await restoredCabinet.getByRole('button', { name: 'Сторінка 1', exact: true }).click();
  await restoredCabinet.getByRole('button', { name: 'Дивитись замовлення 100 · Основний', exact: true }).click();
  await restoredCabinet.getByText('Тестова адреса', { exact: true }).waitFor();
  await restoredCabinet.getByRole('button', { name: 'Закрити деталі замовлення' }).click();
  assert.equal(await restoredCabinet.getByRole('checkbox', { name: /Автооновлення/ }).isChecked(), false);
  await restoredCabinet.getByRole('checkbox', { name: /Автооновлення/ }).check();
  await page.waitForTimeout(1200); // Allow the normal one-second auto-refresh check to run.
  assert.equal(await application.evaluate(({ app }) => app.cabinetRestartReads), 0);
  await restoredCabinet.getByRole('checkbox', { name: /Автооновлення/ }).uncheck();
  await page.getByRole('tab', { name: 'Налаштування', exact: true }).click();
  assert.equal(await page.getByRole('heading', { name: 'Діагностика' }).isVisible(), true);
  assert.equal(await page.locator('.side .sys-row').count(), 5); // API, profiles, Kyiv, PC clock vs atomic time, server offset
  // Saving a blank key keeps the existing encrypted key.
  await page.getByRole('button', { name: 'Зберегти налаштування', exact: true }).click();
  await page.getByText('Налаштування збережено.', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.desktop.state(), undefined, undefined, false)).savedApiKey, true);
  await page.getByRole('button', { name: 'Видалити профіль Другий', exact: true }).click();
  await page.getByRole('button', { name: 'Зберегти налаштування', exact: true }).click();
  await page.waitForFunction(async () => (await window.desktop.state()).settings.savedProfiles.length === 1);
  await page.getByRole('button', { name: 'Видалити збережений ключ', exact: true }).click();
  await page.getByText('Збережений ключ видалено.', { exact: true }).waitFor();
  await application.close();
  page = await launch();
  assert.equal((await page.evaluate(() => window.desktop.state(), undefined, undefined, false)).hasApiKey, false);
  assert.equal(await page.getByRole('checkbox', { name: /Другий/ }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: /Основний/ }).count(), 1);
  // Exercise grouped history with mixed outcomes, old sales and future cancellations.
  const fixtureState = await page.evaluate(() => window.desktop.state(), undefined, undefined, false);
  const baseTask = fixtureState.tasks[0];
  const now = Date.now();
  fixtureState.tasks = Array.from({ length: 7 }, (_, index) => ({ ...baseTask, id: `history-${index}`,
    saleAt: now - index * 86400000, updatedAt: now, url: 'https://coins.bank.gov.ua/pamiatna-moneta/p-42.html',
    status: index === 0 ? 'in_cart' : index === 1 ? 'failed' : 'cancelled',
    note: index === 0 ? 'Монета у кошику. Завершіть оформлення у браузері.' : 'Тестовий результат',
    buttonSeenMs: index === 0 ? 6130 : undefined, cartMs: index === 0 ? 12190 : undefined }));
  fixtureState.tasks.push({ ...fixtureState.tasks[0], id: 'same-sale-failure', status: 'failed', note: 'Тестова помилка', cartMs: undefined });
  await application.evaluate(({ ipcMain }, fixture) => {
    ipcMain.removeHandler('state'); ipcMain.handle('state', () => fixture);
  }, fixtureState);
  await page.getByRole('tab', { name: /^Історія/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sale').length === 5);
  const firstSale = page.locator('.sale').first();
  assert.equal(await firstSale.locator(':scope > summary').getByText('1/2 у кошику', { exact: true }).isVisible(), true);
  assert.equal(await firstSale.locator('.sale-stats').isVisible(), false);
  await page.screenshot({ path: join(dataDirectory, 'simplified-history.png'), fullPage: true });
  await firstSale.locator(':scope > summary').click();
  assert.equal(await firstSale.locator('.hist').count(), 2);
  assert.equal(await firstSale.getByText('Монета у кошику. Завершіть оформлення у браузері.', { exact: true }).isVisible(), false);
  await firstSale.locator('.hist > summary').first().click();
  await firstSale.getByRole('log').first().waitFor();
  await page.getByRole('button', { name: 'Усі продажі · 7', exact: true }).click();
  assert.equal(await page.locator('.sale').count(), 7);
  await page.getByRole('button', { name: 'Показати менше', exact: true }).click();
  assert.equal(await page.locator('.sale').count(), 5);
  await page.setViewportSize({ width: 980, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: join(dataDirectory, 'simplified-narrow.png'), fullPage: true });
  await application.evaluate(({ ipcMain, app }) => {
    app.manualCabinetRequests = [];
    ipcMain.removeHandler('load-cabinet');
    ipcMain.handle('load-cabinet', (_event, input) => {
      app.manualCabinetRequests.push(input);
      return { profileId: input.profileId, fetchedAt: Date.now(), orders: [], wishlist: [], cart: [], errors: {} };
    });
  });
  await page.clock.install({ time: new Date(Date.now() + 120_000) });
  await page.clock.runFor(1100);
  await page.getByRole('tab', { name: 'Кабінет', exact: true }).click();
  await page.getByRole('button', { name: 'Оновити кабінет', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.cabinet').getAttribute('aria-busy') || document.querySelector('.cabinet').getAttribute('aria-busy') === 'false');
  const manualRequests = await application.evaluate(({ app }) => app.manualCabinetRequests);
  assert.equal(manualRequests.length, 1);
  assert.equal(manualRequests[0].profileId, 'profile_a');
  assert.equal(manualRequests[0].openProfile, true);
  // A retry replaces old connection/section errors with progress until its own result arrives.
  for (const sectionError of [false, true]) {
    await application.evaluate(({ ipcMain }, partial) => {
      ipcMain.removeHandler('load-cabinet');
      ipcMain.handle('load-cabinet', (_event, input) => {
        if (!partial) throw Error('Попередня помилка підключення');
        return { profileId: input.profileId, fetchedAt: Date.now(), orders: [], wishlist: [], errors: { cart: 'Попередня помилка кошика' } };
      });
    }, sectionError);
    await page.clock.fastForward(61_000);
    await page.getByRole('button', { name: 'Оновити кабінет', exact: true }).click();
    await page.locator('.cabinet').getByRole('tab', { name: /^Кошик/ }).click();
    await page.locator('.cabinet-profile-state [role="alert"]').waitFor();
    await application.evaluate(({ ipcMain, app }) => {
      ipcMain.removeHandler('load-cabinet');
      ipcMain.handle('load-cabinet', (_event, input) => new Promise(resolve => {
        app.finishCabinetRetry = () => resolve({ profileId: input.profileId, fetchedAt: Date.now(), orders: [], wishlist: [], cart: [], errors: {} });
      }));
    });
    await page.clock.fastForward(61_000);
    await page.getByRole('button', { name: 'Оновити кабінет', exact: true }).click();
    await page.getByText('Підключення й оновлення: Основний…', { exact: true }).waitFor();
    assert.equal(await page.locator('.cabinet-profile-state [role="alert"]').count(), 0);
    await application.evaluate(({ app }) => app.finishCabinetRetry());
    await page.waitForFunction(() => document.querySelector('.cabinet').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('.cabinet-profile-state [role="alert"]').count(), 0);
  }
  console.log(`UI smoke passed: local profiles without API, duplicates, deletion and restart, inline validation, multi-profile scheduling, independent cancellation, encrypted key restart/clear, Inter, Kyiv time. Screenshots: ${dataDirectory}`);
} finally {
  if (application) await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  server.close();
}
