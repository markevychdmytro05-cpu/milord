import { _electron as electron } from 'playwright-core';
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
  let localState = await page.evaluate(() => window.desktop.state());
  assert.equal(localState.hasApiKey, false);
  assert.deepEqual(localState.settings.savedProfiles, [{ id: 'profile_a', name: 'Основний' }, { id: 'profile_b', name: 'Другий' }]);
  assert.equal(profileRequests, 0); // The local list works without any AdsPower request.
  // Exercise the actual cabinet UI through isolated IPC fixtures; never open a real profile.
  await application.evaluate(({ ipcMain, app }) => {
    app.cabinetReads = { snapshots: 0, details: 0 };
    ipcMain.removeHandler('load-cabinet');
    ipcMain.handle('load-cabinet', (_event, input) => {
      const profileId = typeof input === 'string' ? input : input.profileId;
      app.cabinetReads.snapshots++;
      return { profileId, fetchedAt: Date.now(), errors: {}, wishlist: [],
        orders: [{ id: '100', detailId: profileId === 'profile_a' ? '777' : undefined, date: '27.08.2026', status: 'Оплачено', quantity: 2, total: profileId === 'profile_a' ? 100 : 200, tracking: '123456' },
          ...(profileId === 'profile_a' ? [{ id: '101', mergedInto: '100', date: '27.08.2026', status: 'Об’єднано в №100', quantity: 1, total: 50, tracking: '' },
            ...Array.from({ length: 11 }, (_, i) => ({ id: String(200 + i), date: '26.08.2026', status: 'Отримано', quantity: 1, total: 50, tracking: '' }))] : [])],
        nextOrdersPage: profileId === 'profile_a' ? 2 : undefined,
        cart: [{ id: '42', name: 'Тестова монета', quantity: 2, price: 50, total: 100 }] };
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
      app.finishBehaviorTests.get(profileId)({ moves: 1, scrolls: 0, navigations: 0, stopped: true, durationMs: 1000 });
    });
  });
  await page.getByRole('tab', { name: 'Завдання', exact: true }).click();
  const behavior = page.getByRole('region', { name: 'Тест поведінки', exact: true });
  const compact = await behavior.boundingBox();
  assert.ok(compact.width <= 420 && compact.height < 240);
  await behavior.screenshot({ path: join(dataDirectory, 'behavior-compact.png') });
  await behavior.locator('summary').click();
  await behavior.getByRole('spinbutton', { name: 'Тривалість тесту, хв' }).fill('3');
  await behavior.getByRole('button', { name: /^Профілі для тесту:/ }).click();
  await behavior.getByRole('button', { name: 'Очистити', exact: true }).click();
  assert.equal(await behavior.getByRole('button', { name: 'Тест', exact: true }).isDisabled(), true);
  await behavior.getByRole('checkbox', { name: 'Основний', exact: true }).check();
  await behavior.getByRole('checkbox', { name: 'Основний', exact: true }).press('Escape');
  await behavior.getByRole('button', { name: 'Тест', exact: true }).click();
  await behavior.getByRole('button', { name: 'Зупинити тест', exact: true }).click();
  await behavior.getByRole('log').getByText(/Основний: зупинено/).waitFor();
  assert.deepEqual(await application.evaluate(({ app }) => app.behaviorCalls.map(call => call.profileId)), ['profile_a']);
  await application.evaluate(({ app }) => { app.behaviorCalls = []; app.stoppedBehaviorProfiles = []; });
  await behavior.getByRole('button', { name: /^Профілі для тесту:/ }).click();
  await behavior.getByRole('checkbox', { name: 'Другий', exact: true }).check();
  assert.equal(await behavior.getByRole('checkbox', { name: 'Основний', exact: true }).isChecked(), true);
  await behavior.screenshot({ path: join(dataDirectory, 'behavior-profiles.png') });
  await behavior.getByRole('checkbox', { name: 'Другий', exact: true }).press('Escape');
  await behavior.getByRole('button', { name: 'Тест', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.behavior-test [role="status"]').textContent.includes('Активних профілів: 2'));
  assert.deepEqual(await application.evaluate(({ app }) => app.behaviorCalls.map(call => [call.profileId, call.minutes])), [['profile_a', 3], ['profile_b', 3]]);
  await behavior.getByRole('button', { name: 'Зупинити тест', exact: true }).click();
  await behavior.getByRole('log').getByText(/Основний: зупинено/).waitFor();
  await behavior.getByRole('log').getByText(/Другий: зупинено/).waitFor();
  assert.deepEqual(await application.evaluate(({ app }) => app.stoppedBehaviorProfiles.sort()), ['profile_a', 'profile_b']);
  await behavior.screenshot({ path: join(dataDirectory, 'behavior-test.png') });
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
  await page.getByRole('button', { name: 'Додати монету', exact: true }).click();
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
  await page.getByText('Скасовано', { exact: true }).waitFor();
  assert.equal(await page.getByText('Заплановано', { exact: true }).count(), 3);
  for (let remaining = 3; remaining > 0; remaining--) {
    await page.getByRole('button', { name: 'Зупинити', exact: true }).first().click();
    await page.waitForFunction(async (count) => (await window.desktop.state()).tasks.filter((task) => task.status === 'scheduled').length === count, remaining - 1);
  }
  await page.waitForFunction(async () => (await window.desktop.state()).tasks.every((task) => task.status === 'cancelled'));
  const persisted = await readFile(join(dataDirectory, 'tasks.json'), 'utf8');
  assert.equal(persisted.includes(secret), false);
  const saved = JSON.parse(persisted).tasks;
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
  const restored = await page.evaluate(() => window.desktop.state());
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
  // Saving a blank key keeps the existing encrypted key.
  await page.getByRole('button', { name: 'Зберегти налаштування', exact: true }).click();
  await page.getByText('Налаштування збережено.', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.desktop.state())).savedApiKey, true);
  await page.getByRole('button', { name: 'Видалити профіль Другий', exact: true }).click();
  await page.getByRole('button', { name: 'Зберегти налаштування', exact: true }).click();
  await page.waitForFunction(async () => (await window.desktop.state()).settings.savedProfiles.length === 1);
  await page.getByRole('button', { name: 'Видалити збережений ключ', exact: true }).click();
  await page.getByText('Збережений ключ видалено.', { exact: true }).waitFor();
  await application.close();
  page = await launch();
  assert.equal((await page.evaluate(() => window.desktop.state())).hasApiKey, false);
  assert.equal(await page.getByRole('checkbox', { name: /Другий/ }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: /Основний/ }).count(), 1);
  console.log(`UI smoke passed: local profiles without API, duplicates, deletion and restart, inline validation, multi-profile scheduling, independent cancellation, encrypted key restart/clear, Inter, Kyiv time. Screenshots: ${dataDirectory}`);
} finally {
  if (application) await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  server.close();
}
