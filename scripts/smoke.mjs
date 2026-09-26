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
  await page.getByLabel('Повторне оновлення, с').fill('7');
  await page.getByRole('button', { name: 'Зберегти налаштування', exact: true }).click();
  await page.getByText('Налаштування збережено.', { exact: true }).waitFor();
  let localState = await page.evaluate(() => window.desktop.state());
  assert.equal(localState.hasApiKey, false);
  assert.deepEqual(localState.settings.savedProfiles, [{ id: 'profile_a', name: 'Основний' }, { id: 'profile_b', name: 'Другий' }]);
  assert.equal(profileRequests, 0); // The local list works without any AdsPower request.
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
    assert.equal(task.status, 'cancelled'); assert.equal(task.clicks, 0); assert.equal(task.leadMin, 3); assert.equal(task.retrySec, 7);
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
  assert.equal(restored.settings.retrySec, 7);
  assert.deepEqual(restored.settings.savedProfiles, [{ id: 'profile_a', name: 'Основний' }, { id: 'profile_b', name: 'Другий' }]);
  assert.equal(await page.getByRole('checkbox', { name: /Основний/ }).isChecked(), true);
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
