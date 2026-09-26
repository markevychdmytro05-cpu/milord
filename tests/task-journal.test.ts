import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runTask, MAX_CLICKS } from '../src/core/buyer';
import { Store } from '../src/main/store';
import { fakeBrowser, FakeClock, ready, task } from './helpers';

it('explains an unavailable button at expiry without repeating identical page snapshots', async () => {
  const clock = new FakeClock();
  const browser = fakeBrowser(clock, () => ({ ...ready, buyAvailable: false, buyUnavailableReason: 'limited' }));
  const input = task();
  await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
  expect(input.status).toBe('expired');
  expect(browser.clicks).toEqual([]);
  expect(input.events.filter(e => e.message === 'Запуск завдання.')).toHaveLength(1);
  expect(input.events.filter(e => e.details?.buyUnavailableReason === 'limited')).toHaveLength(1);
  expect(input.events.at(-1)?.details?.lastPageState).toContain('limited');
  expect(input.events.length).toBeLessThan(60);
});

it('distinguishes persisted intent, dispatched clicks, retry pauses and exhaustion', async () => {
  const clock = new FakeClock();
  const browser = fakeBrowser(clock);
  const input = task();
  await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
  expect(input.events.filter(e => e.message.startsWith('Натискання виконано'))).toHaveLength(MAX_CLICKS);
  expect(input.events.filter(e => e.message === 'Пауза між натисканнями.')).toHaveLength(MAX_CLICKS - 1);
  expect(input.events.filter(e => e.message.startsWith('Досягнуто ліміт'))).toHaveLength(1);
  expect(input.events.at(-1)?.details).toMatchObject({ status: 'interrupted', clicks: MAX_CLICKS });
});

it('records the failing operation without leaking a provider endpoint or secret', async () => {
  const clock = new FakeClock();
  const browser = fakeBrowser(clock);
  browser.session.clickBuy = async () => { throw new Error('net::ERR_CONNECTION_RESET ws://localhost/devtools/secret-token'); };
  const input = task();
  await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
  expect(input.events.at(-1)?.details?.phase).toBe('натискання кнопки покупки');
  expect(input.events.some(e => e.message === 'Помилка мережевого з’єднання.')).toBe(true);
  expect(input.events.some(e => e.message.startsWith('Натискання виконано'))).toBe(false);
  expect(JSON.stringify(input)).not.toContain('secret-token');
});

it('persists confirmation evidence and diagnostics across restart alongside legacy events', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'nbu-journal-')), 'tasks.json');
  const store = new Store(path);
  const clock = new FakeClock();
  clock.time = Date.now(); // A finished task from the fixture epoch would be removed as month-old history.
  const browser = fakeBrowser(clock, () => ({ ...ready, inCart: true, cartConfirmation: 'visible-cart', navigationHttpStatus: 200 }));
  const input = task({ saleAt: clock.time, events: [{ at: clock.time - 100_000, message: 'Старий запис' }] });
  await runTask(input, browser.provider, clock, new AbortController().signal, next => store.saveTask(next));
  const reopened = new Store(path); await reopened.load();
  expect(reopened.tasks()[0]?.events).toEqual(input.events);
  expect(input.events.some(e => e.details?.cartConfirmation === 'visible-cart' && e.details.navigationHttpStatus === 200)).toBe(true);
  expect(browser.clicks).toHaveLength(0);
});

it('logs a page-state race as a rejected click, without claiming successful dispatch', async () => {
  const clock = new FakeClock();
  const browser = fakeBrowser(clock);
  browser.session.clickBuy = async () => { throw new Error('page.evaluate: Page state changed before purchase click'); };
  const input = task();
  await runTask(input, browser.provider, clock, new AbortController().signal, async () => {});
  expect(input.events.some(e => e.message.includes('кнопку не натиснуто'))).toBe(true);
  expect(input.events.some(e => e.message.startsWith('Натискання виконано'))).toBe(false);
});
