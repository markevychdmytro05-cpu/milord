// Adapted from nbu-store-speed-buyer content.js (MIT).
// Copyright (c) 2026 Mykhailo Toporkov. See third-party/nbu-store-speed-buyer/LICENSE.
import { intersectBounds, offsetFromBounds, type OffsetBounds } from './clock-bounds';
import { isFinal, type Task, type TaskStatus } from './model';
import { ShopRateLimitError, UserFacingError } from './shop-errors';
import { describeFailure, describePage, type EventDetails } from './task-journal';
import type { BrowserProvider, Clock, PageState, ShopSession } from './ports';

export const CLICK_COOLDOWN_MS = 11_000;
export const MAX_CLICKS = 5;
export const WATCH_AFTER_CLICK_MS = 120_000;
// With the clock verified against atomic time, the sale refresh fires this long after the start.
// Measured: the shop's clock is within about ±60 ms of UTC and a request needs at least ~27 ms to
// reach it, so the shop never receives the first refresh before its own start. An early refresh
// costs far more (a page without the button, then a whole reload interval) than these 40 ms.
export const SALE_START_MARGIN_MS = 40;

type SaveTask = (task: Task) => Promise<void>;

// Refresh fast only while the sale is actually opening, then back off. A coin that has not
// appeared after a minute rarely appears on the next second, and every reload is a full
// document request to the shop — until now up to ~300 per tab over a 5-minute window.
// A slower interval chosen by the user is never shortened after the opening burst.
export function reloadIntervalMs(elapsedMs: number, retrySec: number): number {
  const base = Math.max(1, retrySec) * 1000;
  if (elapsedMs < 5_000) return retrySec <= 1 ? 200 : base;
  const tier = elapsedMs < 20_000 ? 1000 : elapsedMs < 60_000 ? 3000 : elapsedMs < 120_000 ? 5000 : 10_000;
  return Math.max(base, tier);
}

// A small spread so reloads do not tick at an exactly regular rhythm.
export const RELOAD_JITTER = 0.1;
export function jitterMs(ms: number, random = Math.random): number {
  return Math.round(ms * (1 + (random() * 2 - 1) * RELOAD_JITTER));
}

export async function runTask(
  task: Task, provider: BrowserProvider, clock: Clock, signal: AbortSignal, save: SaveTask,
  // Read at measurement time, so tasks prepared together already see each other's readings.
  priorBounds: () => OffsetBounds[] = () => [],
  // UTC minus the local clock from SNTP, when a fresh reading exists.
  atomicOffset: () => number | undefined = () => undefined,
): Promise<void> {
  let session: ShopSession | undefined;
  let lastClickAt = 0;
  let watchUntil = 0;
  let nextReloadAt = 0;
  let observedPurchase = false;
  let recoveredAfterPurchase = false;
  let readyToBuy = false;
  let phase = 'перевірка запуску';
  let lastState: PageState | undefined;
  let dirty = false;
  let lastDecision = '';
  let loginTried = false;
  let loginFailure = '';
  const record = (message: string, details: EventDetails = {}) => {
    task.events.push({ at: clock.now(), message, details: {
      phase, clicks: task.clicks, reloads: task.reloads, offsetMs: task.offsetMs,
      saleDeltaMs: serverNow() - task.saleAt, ...details,
    } });
    task.events = task.events.slice(-200);
    dirty = true;
  };
  const persist = async () => {
    if (!dirty) return;
    task.updatedAt = clock.now();
    await save(structuredClone(task));
    dirty = false;
  };
  // Page records never block the purchase path; a failed record is ignored.
  const capture = (label: string, force = false) => {
    void session?.capture?.({ label, saleDeltaMs: serverNow() - task.saleAt, force }).catch(() => {});
  };
  const observe = (state: PageState) => {
    if (JSON.stringify(state) !== JSON.stringify(lastState)) {
      // Only explicit page flags are logged; no HTML, account fields or response bodies.
      record(describePage(state), Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined)));
      lastState = { ...state };
      // After a click every recognized change is kept, even when the visible text stays the same.
      if (task.clicks) capture(`state-${state.queuePosition ? 'queue' : state.inCart ? 'cart' : state.turnstile || state.challenge
        ? 'check' : state.purchasePending ? 'pending' : state.buyAvailable ? 'button' : 'other'}`, true);
    }
    return state;
  };
  const decision = (message: string, details: EventDetails = {}) => {
    if (message !== lastDecision) record(message, details);
    lastDecision = message;
  };
  const read = async () => { phase = 'читання сторінки'; return observe(await session!.read()); };
  const check = () => signal.throwIfAborted();
  const serverNow = () => clock.now() + task.offsetMs;
  const saleDeadline = () => task.saleAt + task.windowMin * 60_000;
  // Neither a positive estimate nor a fast local clock may advance the sale refresh. Only a clock
  // verified against atomic time, and consistent with the shop's own responses, is used as is.
  let atomicStart = false;
  const startNow = () => atomicStart ? serverNow() : Math.min(clock.now(), serverNow());
  const startAt = () => task.saleAt + (atomicStart ? SALE_START_MARGIN_MS : 0);
  const reloadInterval = () => jitterMs(reloadIntervalMs(startNow() - task.saleAt, task.retrySec));

  const update = async (status: TaskStatus, note: string) => {
    check();
    if (task.status === status && task.note === note) { await persist(); return; }
    task.status = status;
    task.note = note;
    task.updatedAt = clock.now();
    record(note, { status, ...(isFinal(status) ? {
      lastPageState: lastState ? describePage(lastState) : 'Стан сторінки ще не отримано.',
      saleDeadline: saleDeadline(), watchUntil,
    } : {}) });
    await persist();
  };
  const wait = (ms = 1000) => clock.sleep(ms, signal);

  try {
    check();
    record('Запуск завдання.', { profileId: task.profileId, url: task.url, mode: task.mode,
      saleAt: task.saleAt, windowMin: task.windowMin, retrySec: task.retrySec, leadMin: task.leadMin });
    if (task.status !== 'scheduled' || task.clicks > 0) {
      throw new Error('Виконане або перерване завдання не можна запускати повторно.');
    }
    if (serverNow() >= saleDeadline()) {
      await update('expired', 'Час для запуску минув.');
      return;
    }
    phase = 'підключення та підготовка профілю';
    await update('preparing', 'Підключення до профілю AdsPower.');
    session = await provider.connect(task.profileId, task.url, signal, {
      deadline: saleDeadline() - task.offsetMs,
      onRateLimit: () => update('preparing', 'НБУ відповів 429. Пауза перед автоматичним повтором; інші монети також очікують.'),
      capture: { taskId: task.id, saleAt: task.saleAt },
    });
    check();

    record('Профіль підключено.', { prepared: !!session.prepared });

    const readWithRecovery = async (initial?: PageState): Promise<PageState> => {
      let state = initial ? observe(initial) : await read();
      while (state.rateLimited) {
        check();
        if (!session!.recoverRateLimit) throw new ShopRateLimitError();
        recoveredAfterPurchase ||= task.clicks > 0 || observedPurchase || state.purchasePending;
        await update('waiting', 'НБУ відповів 429. Очікуємо дозволений повтор і автоматично оновимо сторінку.');
        phase = 'відновлення після 429';
        const reloaded = await session!.recoverRateLimit(watchUntil || saleDeadline() - task.offsetMs);
        if (reloaded) task.reloads++;
        record('Завершено крок відновлення після 429.', { reloaded });
        state = await read();
      }
      if (recoveredAfterPurchase && !state.inCart && !state.purchasePending && !state.queuePosition &&
          !state.challenge && !state.turnstile && state.login === 'logged-in') {
        throw new Error('Purchase outcome is unknown after recovery; do not submit twice');
      }
      return state;
    };

    // One automatic sign-in per task, and only before any purchase attempt: after a click the tab
    // must stay exactly as the shop left it.
    const tryLogin = async (state: PageState): Promise<boolean> => {
      if (loginTried || !session!.login || state.login !== 'logged-out' || state.challenge || state.turnstile ||
          task.clicks || observedPurchase || state.purchasePending || state.queuePosition) return false;
      loginTried = true;
      phase = 'автоматичний вхід';
      try {
        if (!await session!.login()) return false;
        task.reloads++;
        record('Виконано автоматичний вхід в акаунт НБУ.');
        return true;
      } catch (error) {
        if (signal.aborted) throw error;
        loginFailure = error instanceof UserFacingError ? error.message : 'Автоматичний вхід в акаунт НБУ не вдався.';
        record(loginFailure);
        return false;
      }
    };
    const attentionNote = (state: PageState, fallback: string) =>
      state.login === 'logged-out' && loginFailure ? loginFailure : fallback;
    // Not a shop page at all: an overloaded server's error page (502/503/504) or a cut-off load. It asks
    // for no verification and no sign-in, so a person could do nothing either: the way forward is the
    // next scheduled reload, never a pause for attention.
    const notShopPage = (state: PageState) => state.login === 'unknown' && !state.buyAvailable && !state.challenge && !state.turnstile &&
      !state.inCart && !state.purchasePending && !state.queuePosition;
    const brokenNote = (state: PageState) => `НБУ віддав сторінку помилки${state.navigationHttpStatus && state.navigationHttpStatus >= 400
      ? ` (HTTP ${state.navigationHttpStatus})` : ''}. Оновлюємо за розкладом.`;

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
        if (await tryLogin(state)) continue;
        if (notShopPage(state) && !observedPurchase) { record(brokenNote(state)); readyToBuy = false; return true; }
        if (state.challenge || state.turnstile || state.login !== 'logged-in') {
          await update('needs_attention', attentionNote(state, 'Увійдіть в акаунт НБУ та завершіть перевірку браузера.'));
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
    if (serverNow() < task.saleAt - 2000) capture('before-sale', true);
    phase = 'визначення серверного часу';
    const bounds = await session.serverOffsetBounds?.();
    if (bounds) {
      // This session's own range first: an older reading that disagrees with it is dropped.
      const prior = priorBounds();
      const combined = intersectBounds([bounds, ...prior])!;
      const atomic = atomicOffset();
      atomicStart = atomic !== undefined && atomic >= combined.lowMs && atomic <= combined.highMs;
      task.offsetLowMs = bounds.lowMs;
      task.offsetHighMs = bounds.highMs;
      task.offsetMs = offsetFromBounds(combined, atomic ?? 0);
      task.offsetSampledAt = clock.now();
      record('Оцінено різницю часу сервера й комп’ютера.', { offsetLowMs: combined.lowMs, offsetHighMs: combined.highMs,
        priorSamples: prior.length, ...(atomic !== undefined ? { atomicOffsetMs: atomic, atomicStart } : {}) });
    } else {
      task.offsetMs = await session.serverOffset();
      task.offsetSampledAt = clock.now();
      record('Оцінено різницю часу сервера й комп’ютера.');
    }
    await persist();
    check();

    let pointerStarted = false, pointerParked = false;
    let brokenReloadAt = -Infinity;
    // Pointer activity is cosmetic: it must never fail or delay the purchase.
    const quietly = async (action: () => Promise<void>) => {
      try { await action(); } catch (error) { if (signal.aborted) throw error; }
    };
    while (startNow() < startAt()) {
      const remaining = startAt() - startNow();
      // Park on the button a few seconds early, so the click itself is a short, still press.
      if (remaining <= 3500 && remaining > 2000 && !pointerParked && session.approach) {
        pointerParked = true;
        await quietly(() => session!.approach!(remaining - 1200));
        continue;
      }
      if (remaining <= 1000) {
        // Reserve the last second for the deadline: no CDP reads or filesystem work.
        await wait(Math.min(50, remaining));
        continue;
      }
      const state = await readWithRecovery();
      check();
      if (state.rateLimited) throw new ShopRateLimitError();
      observedPurchase ||= state.purchasePending;
      if (await tryLogin(state)) continue;
      if (notShopPage(state)) {
        // Before the sale the shop is quiet: reload a failed page now, so sign-in and the clock are
        // checked in time. Never in the last 10 s and at most every 30 s.
        await update('waiting', brokenNote(state));
        if (remaining > 10_000 && clock.now() - brokenReloadAt >= 30_000) {
          brokenReloadAt = clock.now();
          await session.reload();
          continue;
        }
      } else if (state.challenge || state.turnstile || state.login !== 'logged-in') {
        await update('needs_attention', attentionNote(state, 'Увійдіть в акаунт НБУ та завершіть перевірку браузера.'));
      } else if (state.queuePosition) {
        await update('queued', `Черга: ${state.queuePosition}`);
      } else if (state.purchasePending) {
        await update('firing', 'Магазин уже обробляє додавання. Очікуємо результат без нових натискань.');
      } else {
        await update('waiting', 'Профіль готовий. Очікуємо початок продажу.');
      }
      const pause = Math.min(1000, Math.max(1, startAt() - startNow() - 1000));
      if (session.idle && !pointerParked && startAt() - startNow() > 4000) {
        if (!pointerStarted) { pointerStarted = true; record('Легкий рух миші під час очікування, без кліків і переходів.'); }
        const started = clock.now();
        await quietly(() => session!.idle!(pause));
        const left = pause - (clock.now() - started);
        if (left > 0) await wait(left);
      } else await wait(pause);
    }
    check();
    // A challenge may have appeared during the final countdown. Recheck once at the
    // deadline rather than destroying an in-progress verification with the sale refresh.
    if (!await waitUntilReady()) return;
    if (serverNow() >= saleDeadline()) {
      await update('expired', 'Вікно продажу завершилося під час очікування.');
      return;
    }
    record('Початок роботи у вікні продажу.');
    if (!session.prepared || !readyToBuy) {
      task.reloads++;
      check();
      phase = 'стартове оновлення сторінки';
      record(readyToBuy ? 'Оновлення: вкладка не була підготовлена.' : 'Оновлення: на старті кнопка недоступна.');
      await session.reload();
      task.startLoadedMs ??= serverNow() - task.saleAt;
      record('Стартове оновлення завершено.');
    } else record('Підготовлена кнопка доступна; стартове оновлення пропущено.');
    nextReloadAt = clock.now() + reloadInterval();
    let detectImmediately = true;
    let awaitingVerification = false;

    for (;;) {
      check();
      phase = 'очікування змін сторінки';
      const state = await readWithRecovery(detectImmediately || task.clicks
        ? await read()
        : await session.waitForActionable(Math.max(1, Math.min(1000,
          nextReloadAt - clock.now(), saleDeadline() - serverNow()))));
      detectImmediately = false;
      check();
      if (state.rateLimited) throw new ShopRateLimitError();
      observedPurchase ||= state.purchasePending;
      if (state.buyAvailable && task.buttonSeenMs === undefined) {
        task.buttonSeenMs = serverNow() - task.saleAt;
        task.buttonReloads = task.reloads;
      }
      if (state.inCart) {
        if (task.clicks) task.cartMs ??= serverNow() - task.saleAt;
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
      if (await tryLogin(state)) { detectImmediately = true; continue; }
      if (notShopPage(state) && !task.clicks) decision(brokenNote(state), state.navigationHttpStatus ? { httpStatus: state.navigationHttpStatus } : {});
      else if (state.challenge || state.turnstile || state.login !== 'logged-in') {
        awaitingVerification = true;
        await update('needs_attention', state.login === 'logged-out'
          ? attentionNote(state, 'Потрібен вхід в акаунт НБУ.')
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
        if (task.clicks >= MAX_CLICKS) {
          decision('Досягнуто ліміт натискань. Очікуємо підтвердження кошика.', { maxClicks: MAX_CLICKS, watchUntil });
        } else if (task.clicks && clock.now() - lastClickAt < CLICK_COOLDOWN_MS) {
          decision('Пауза між натисканнями.', { nextClickAt: lastClickAt + CLICK_COOLDOWN_MS });
        }
        if (task.clicks < MAX_CLICKS && (!task.clicks || clock.now() - lastClickAt >= CLICK_COOLDOWN_MS)) {
          check();
          // Persist intent before the side effect. After a crash, this task will never auto-replay.
          phase = 'натискання кнопки покупки';
          lastDecision = '';
          task.clicks++;
          task.firstClickMs ??= serverNow() - task.saleAt;
          lastClickAt = clock.now();
          watchUntil ||= lastClickAt + WATCH_AFTER_CLICK_MS;
          await update('firing', `Спроба додати в кошик: ${task.clicks}/${MAX_CLICKS}.`);
          check();
          try {
            const method = await session.clickBuy();
            record('Натискання виконано. Це ще не підтвердження кошика.', { watchUntil, ...(method ? { clickMethod: method } : {}) });
            capture(`click-${task.clicks}`, true);
          }
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
        phase = 'повторне оновлення сторінки';
        record('Повторне оновлення: кнопка недоступна, інтервал очікування минув.');
        await session.reload();
        record('Повторне оновлення завершено.');
        nextReloadAt = clock.now() + reloadInterval();
        detectImmediately = true;
      } else if (!task.clicks) {
        await update('firing', `Очікуємо кнопку. Оновлень: ${task.reloads}; локальне стеження без запитів.`);
      }
      if (task.clicks && !state.buyAvailable) {
        decision('Після натискання кнопка недоступна. Очікуємо підтвердження без оновлення сторінки.', { watchUntil });
      }
      await persist();
      if (task.clicks) capture('after-click');
      // Before the first click, the browser waiter drives the loop; never add a 1 s sleep after reload.
      if (task.clicks) await wait();
    }
  } catch (error) {
    task.status = signal.aborted ? 'cancelled' : task.clicks || observedPurchase ? 'interrupted'
      : error instanceof ShopRateLimitError ? 'expired' : 'failed';
    // Provider errors are deliberately not persisted: they can contain a CDP URL or a token.
    task.note = error instanceof ShopRateLimitError
      ? error.message + (task.clicks || observedPurchase ? ' Результат додавання невідомий – перевірте кошик.' : '')
      : signal.aborted
      ? 'Зупинено. Уже надіслану дію не скасовано; перевірте кошик, якщо було натискання.'
      : error instanceof UserFacingError
      ? error.message + (task.clicks || observedPurchase ? ' Перевірте кошик перед новою спробою.' : '')
      : task.clicks || observedPurchase
        ? 'Зв’язок або дія завершилися помилкою. Перевірте кошик перед новою спробою.'
        : 'Не вдалося виконати завдання. Перевірте AdsPower, профіль і сторінку магазину.';
    if (!signal.aborted && !(error instanceof UserFacingError) && !(error instanceof ShopRateLimitError)) record(describeFailure(error));
    record(task.note, { status: task.status,
      lastPageState: lastState ? describePage(lastState) : 'Стан сторінки ще не отримано.' });
    await persist();
  } finally {
    if (session?.capture) {
      const final = session.capture({ label: `final-${task.status}`, saleDeltaMs: serverNow() - task.saleAt, force: true });
      await Promise.race([final, new Promise((resolve) => setTimeout(resolve, 3000))]).catch(() => {});
    }
    // Disconnect automation only. Keep the browser open for captcha/checkout and manual inspection.
    await session?.disconnect().catch(() => {});
  }
  if (!isFinal(task.status)) throw new Error('Task did not reach a terminal state');
}
