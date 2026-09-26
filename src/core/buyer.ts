// Adapted from nbu-store-speed-buyer content.js (MIT).
// Copyright (c) 2026 Mykhailo Toporkov. See third-party/nbu-store-speed-buyer/LICENSE.
import { isFinal, type Task, type TaskStatus } from './model';
import { ShopRateLimitError } from './shop-errors';
import type { BrowserProvider, Clock, PageState, ShopSession } from './ports';

export const CLICK_COOLDOWN_MS = 11_000;
export const MAX_CLICKS = 5;
export const WATCH_AFTER_CLICK_MS = 120_000;

type SaveTask = (task: Task) => Promise<void>;

export async function runTask(
  task: Task, provider: BrowserProvider, clock: Clock, signal: AbortSignal, save: SaveTask,
): Promise<void> {
  let session: ShopSession | undefined;
  let lastClickAt = 0;
  let watchUntil = 0;
  let nextReloadAt = 0;
  let observedPurchase = false;
  let recoveredAfterPurchase = false;
  let readyToBuy = false;
  const check = () => signal.throwIfAborted();
  const serverNow = () => clock.now() + task.offsetMs;
  const saleDeadline = () => task.saleAt + task.windowMin * 60_000;
  // Neither a positive estimate nor a fast local clock may advance the sale refresh.
  const startNow = () => Math.min(clock.now(), serverNow());
  const reloadInterval = () => Math.max(5, task.retrySec) * 1000;

  const update = async (status: TaskStatus, note: string) => {
    check();
    if (task.status === status && task.note === note) return;
    task.status = status;
    task.note = note;
    task.updatedAt = clock.now();
    task.events.push({ at: task.updatedAt, message: note });
    task.events = task.events.slice(-200);
    await save(structuredClone(task));
  };
  const wait = (ms = 1000) => clock.sleep(ms, signal);

  try {
    check();
    if (task.status !== 'scheduled' || task.clicks > 0) {
      throw new Error('Виконане або перерване завдання не можна запускати повторно.');
    }
    if (serverNow() >= saleDeadline()) {
      await update('expired', 'Час для запуску минув.');
      return;
    }
    await update('preparing', 'Підключення до профілю AdsPower.');
    session = await provider.connect(task.profileId, task.url, signal, {
      deadline: saleDeadline() - task.offsetMs,
      onRateLimit: () => update('preparing', 'НБУ відповів 429. Пауза перед автоматичним повтором; інші монети також очікують.'),
    });
    check();

    const readWithRecovery = async (initial?: PageState): Promise<PageState> => {
      let state = initial ?? await session!.read();
      while (state.rateLimited) {
        check();
        if (!session!.recoverRateLimit) throw new ShopRateLimitError();
        recoveredAfterPurchase ||= task.clicks > 0 || observedPurchase || state.purchasePending;
        await update('waiting', 'НБУ відповів 429. Очікуємо дозволений повтор і автоматично оновимо сторінку.');
        if (await session!.recoverRateLimit(watchUntil || saleDeadline() - task.offsetMs)) task.reloads++;
        state = await session!.read();
      }
      if (recoveredAfterPurchase && !state.inCart && !state.purchasePending && !state.queuePosition &&
          !state.challenge && !state.turnstile && state.login === 'logged-in') {
        throw new Error('Purchase outcome is unknown after recovery; do not submit twice');
      }
      return state;
    };

    // Observe only while a verification/login/queue is active. No time probes or reloads.
    const waitUntilReady = async (): Promise<boolean> => {
      for (;;) {
        check();
        const state = await readWithRecovery();
        check();
        if (state.rateLimited) throw new ShopRateLimitError();
        observedPurchase ||= state.purchasePending;
        if (state.inCart && state.login === 'logged-in') {
          await update('in_cart', 'Монета вже в кошику. Завершіть оформлення у браузері.');
          return false;
        }
        if (serverNow() >= saleDeadline()) {
          await update(observedPurchase ? 'interrupted' : 'expired', observedPurchase
            ? 'Попереднє додавання не підтверджене. Перевірте кошик вручну; нову спробу не надіслано.'
            : 'Сторінка не готова до завершення вікна продажу.');
          return false;
        }
        if (state.challenge || state.turnstile || state.login !== 'logged-in') {
          await update('needs_attention', 'Увійдіть в акаунт НБУ та завершіть перевірку браузера.');
        } else if (state.queuePosition) {
          await update('queued', `Черга: ${state.queuePosition}`);
        } else if (state.purchasePending) {
          await update('firing', 'Магазин уже обробляє додавання. Очікуємо результат без нових натискань.');
        } else if (observedPurchase) {
          await update('interrupted', 'Попереднє додавання завершило очікування без підтвердження. Перевірте кошик вручну.');
          return false;
        } else { readyToBuy = state.buyAvailable; return true; }
        await wait();
      }
    };
    if (!await waitUntilReady()) return;
    task.offsetMs = await session.serverOffset();
    check();

    while (startNow() < task.saleAt) {
      const remaining = task.saleAt - startNow();
      if (remaining <= 1000) {
        // Reserve the last second for the deadline: no CDP reads or filesystem work.
        await wait(Math.min(50, remaining));
        continue;
      }
      const state = await readWithRecovery();
      check();
      if (state.rateLimited) throw new ShopRateLimitError();
      observedPurchase ||= state.purchasePending;
      if (state.challenge || state.turnstile || state.login !== 'logged-in') {
        await update('needs_attention', 'Увійдіть в акаунт НБУ та завершіть перевірку браузера.');
      } else if (state.queuePosition) {
        await update('queued', `Черга: ${state.queuePosition}`);
      } else if (state.purchasePending) {
        await update('firing', 'Магазин уже обробляє додавання. Очікуємо результат без нових натискань.');
      } else {
        await update('waiting', 'Профіль готовий. Очікуємо початок продажу.');
      }
      await wait(Math.min(1000, Math.max(1, task.saleAt - startNow() - 1000)));
    }
    check();
    // A challenge may have appeared during the final countdown. Recheck once at the
    // deadline rather than destroying an in-progress verification with the sale refresh.
    if (!await waitUntilReady()) return;
    if (serverNow() >= saleDeadline()) {
      await update('expired', 'Вікно продажу завершилося під час очікування.');
      return;
    }
    if (!session.prepared || !readyToBuy) {
      task.reloads++;
      check();
      await session.reload();
    }
    nextReloadAt = clock.now() + reloadInterval();
    let detectImmediately = true;
    let awaitingVerification = false;

    for (;;) {
      check();
      const state = await readWithRecovery(detectImmediately || task.clicks
        ? await session.read()
        : await session.waitForActionable(Math.max(1, Math.min(1000,
          nextReloadAt - clock.now(), saleDeadline() - serverNow()))));
      detectImmediately = false;
      check();
      if (state.rateLimited) throw new ShopRateLimitError();
      observedPurchase ||= state.purchasePending;
      if (state.inCart) {
        await update('in_cart', 'Монета в кошику. Завершіть оформлення у браузері.');
        return;
      }
      const deadline = watchUntil || saleDeadline() - task.offsetMs;
      if (clock.now() >= deadline) {
        await update(task.clicks || observedPurchase ? 'interrupted' : 'expired', task.clicks || observedPurchase
          ? 'Час перевірки вичерпано. Результат невідомий – перевірте кошик вручну.'
          : 'Час очікування кнопки покупки вичерпано.');
        return;
      }
      if (state.challenge || state.turnstile || state.login !== 'logged-in') {
        awaitingVerification = true;
        await update('needs_attention', state.login === 'logged-out'
          ? 'Потрібен вхід в акаунт НБУ.'
          : 'Потрібна перевірка сторінки у браузері. Автоматичні дії призупинені.');
        await wait();
        continue;
      }
      if (state.queuePosition) {
        awaitingVerification = false;
        await update('queued', `Черга: ${state.queuePosition}`);
        await wait();
        continue;
      }
      if (state.purchasePending) {
        awaitingVerification = false;
        await update('firing', 'Магазин обробляє додавання в кошик. Очікуємо підтвердження.');
        await wait();
        continue;
      }
      if (!task.clicks && observedPurchase) {
        await update('interrupted', 'Попереднє додавання завершило очікування без підтвердження. Перевірте кошик вручну.');
        return;
      }
      if (task.clicks && awaitingVerification) {
        await update('firing', 'Перевірка сторінки завершена. Очікуємо результат додавання.');
        awaitingVerification = false;
      }
      if (state.buyAvailable) {
        if (task.mode === 'observe') {
          await update('observed', 'Кнопку покупки знайдено. Режим спостереження: без натискання.');
          return;
        }
        if (task.clicks < MAX_CLICKS && (!task.clicks || clock.now() - lastClickAt >= CLICK_COOLDOWN_MS)) {
          check();
          // Persist intent before the side effect. After a crash, this task will never auto-replay.
          task.clicks++;
          lastClickAt = clock.now();
          watchUntil ||= lastClickAt + WATCH_AFTER_CLICK_MS;
          await update('firing', `Спроба додати в кошик: ${task.clicks}/${MAX_CLICKS}.`);
          check();
          try { await session.clickBuy(); }
          catch (error) {
            if (!(error instanceof ShopRateLimitError)) throw error;
            // The provider checks the shared guard before dispatching the click.
            task.clicks--;
            if (!task.clicks) watchUntil = 0;
            await update('waiting', 'НБУ відповів 429 перед натисканням. Очікуємо автоматичну повторну спробу.');
          }
        }
      } else if (!task.clicks && clock.now() >= nextReloadAt) {
        task.reloads++;
        check();
        await session.reload();
        nextReloadAt = clock.now() + reloadInterval();
        detectImmediately = true;
      } else if (!task.clicks) {
        await update('firing', `Очікуємо кнопку. Оновлень: ${task.reloads}; локальне стеження без запитів.`);
      }
      // Before the first click, the browser waiter drives the loop; never add a 1 s sleep after reload.
      if (task.clicks) await wait();
    }
  } catch (error) {
    task.status = signal.aborted ? 'cancelled' : task.clicks || observedPurchase ? 'interrupted'
      : error instanceof ShopRateLimitError ? 'expired' : 'failed';
    // Provider errors are deliberately not persisted: they can contain a CDP URL or a token.
    task.note = error instanceof ShopRateLimitError
      ? error.message + (task.clicks || observedPurchase ? ' Результат додавання невідомий — перевірте кошик.' : '')
      : signal.aborted
      ? 'Зупинено. Уже надіслану дію не скасовано; перевірте кошик, якщо було натискання.'
      : task.clicks || observedPurchase
        ? 'Зв’язок або дія завершилися помилкою. Перевірте кошик перед новою спробою.'
        : 'Не вдалося виконати завдання. Перевірте AdsPower, профіль і сторінку магазину.';
    task.updatedAt = clock.now();
    task.events = [...task.events, { at: task.updatedAt, message: task.note }].slice(-200);
    await save(structuredClone(task));
  } finally {
    // Disconnect automation only. Keep the browser open for captcha/checkout and manual inspection.
    await session?.disconnect().catch(() => {});
  }
  if (!isFinal(task.status)) throw new Error('Task did not reach a terminal state');
}
