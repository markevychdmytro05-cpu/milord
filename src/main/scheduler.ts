import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runTask } from '../core/buyer';
import { priorOffsetBounds } from '../core/clock-bounds';
import type { ClockSync } from '../core/clock-sync';
import { isFinal, productUrl, taskInputSchema, type Task, type TaskInput } from '../core/model';
import { realClock, type BrowserProvider, type PreparedProfile } from '../core/ports';
import { UserFacingError } from '../core/shop-errors';
import { CONNECTION_LOST_NOTE } from '../core/task-journal';

const RECONNECT_NOTE = 'Зв’язок із браузером втрачено до кліку. Перепідключення до профілю.';
import { Store } from './store';

export function tasksOverlap(a: TaskInput, b: TaskInput): boolean {
  const start = (task: TaskInput) => task.saleAt - task.leadMin * 60_000;
  const end = (task: TaskInput) => task.saleAt + task.windowMin * 60_000 + 120_000;
  return a.profileId === b.profileId && start(a) < end(b) && start(b) < end(a);
}

const INSPECT_TIMEOUT_MS = 120_000;
export const UNEXPECTED_TASK_NOTE = 'Внутрішня помилка завдання. Перевірте кошик вручну; автоматичного повтору немає.';

export class Scheduler {
  private running = new Map<string, { controller: AbortController; done: Promise<void>; profileId: string; batchId?: string }>();
  private prepared = new Map<string, { controller: AbortController; promise: Promise<PreparedProfile>;
    rateLimitListeners: Set<() => Promise<void>> }>();
  private inspecting = new Set<string>();
  private profileReads = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
  private timer?: ReturnType<typeof setInterval>;
  private mutations: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly provider: () => BrowserProvider,
    private readonly onTask: (task: Task) => void,
    private readonly onBusy: (busy: boolean) => void,
    private readonly onError: (message: string) => void,
    // Latest SNTP reading, including its age and uncertainty.
    private readonly atomicSync: () => ClockSync | undefined = () => undefined,
    // A cached local decision; license HTTP requests never enter the purchase countdown.
    private readonly canStart: () => boolean = () => true,
  ) {}

  start(): void {
    clearInterval(this.timer);
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), 500);
    this.tick();
  }

  hasActiveWork(): boolean {
    return this.inspecting.size > 0 || this.running.size > 0 || this.store.tasks().some((task) => !isFinal(task.status));
  }

  hasRunningWork(): boolean { return this.inspecting.size > 0 || this.running.size > 0; }

  add(input: TaskInput): Promise<void> {
    return this.addMany([input]);
  }

  addMany(inputs: TaskInput[]): Promise<void> {
    return this.serialize(async () => {
      if (!inputs.length || inputs.length > 200) throw new Error('Можна створити від 1 до 200 завдань за раз.');
      const parsed = inputs.map((input) => taskInputSchema.parse(input));
      if (new Set(parsed.map((input) => JSON.stringify([input.profileId, input.url]))).size !== parsed.length) {
        throw new Error('Одна монета не має повторюватися для одного профілю.');
      }
      for (const input of parsed) {
        if (input.saleAt <= Date.now()) throw new Error('Оберіть час у майбутньому.');
        if (this.inspecting.has(input.profileId) || this.store.tasks().some((task) =>
          !isFinal(task.status) && tasksOverlap(task, input))) {
          throw new Error(`Профіль ${input.profileId} уже зайнятий у цей проміжок часу. Жодного нового завдання не додано.`);
        }
      }
      const batchId = randomUUID();
      const positions = new Map<string, number>();
      const tasks: Task[] = parsed.map((input) => {
        const batchIndex = positions.get(input.profileId) ?? 0;
        positions.set(input.profileId, batchIndex + 1);
        return {
          ...input, id: randomUUID(), batchId, batchIndex, status: 'scheduled', createdAt: Date.now(), updatedAt: Date.now(),
          clicks: 0, reloads: 0, offsetMs: 0, note: 'Завдання заплановано. Монети запускаються незалежно.',
          events: [{ at: Date.now(), message: 'Завдання заплановано. Монети запускаються незалежно.' }],
        };
      });
      await this.store.addTasks(tasks);
      for (const task of tasks) this.onTask(task);
      this.tick();
    });
  }

  // Change the coin link of one waiting task, or the start time of the whole batch it was created with.
  // A batch shares one preparation and one start time, so its members move together.
  update(id: string, patch: { url: string; saleAt: number }): Promise<void> {
    return this.serialize(async () => {
      const all = this.store.tasks();
      const task = all.find((item) => item.id === id);
      if (!task) throw new Error('Завдання не знайдено.');
      const group = task.batchId ? all.filter((item) => item.batchId === task.batchId) : [task];
      const started = task.status !== 'scheduled' || this.running.has(id) ||
        group.some((item) => !isFinal(item.status) && item.status !== 'scheduled') ||
        (!!task.batchId && [...this.prepared.keys()].some((key) => key.startsWith(JSON.stringify([task.batchId]).slice(0, -1))));
      if (started) throw new Error('Завдання вже виконується. Зупиніть його й створіть нове.');
      const url = productUrl(patch.url.trim());
      const timeChanged = patch.saleAt !== task.saleAt;
      if (url === task.url && !timeChanged) return;
      if (!Number.isSafeInteger(patch.saleAt) || patch.saleAt <= Date.now()) throw new Error('Оберіть час у майбутньому.');
      if (url !== task.url && group.some((item) => item.id !== id && !isFinal(item.status) &&
        item.profileId === task.profileId && item.url === url)) {
        throw new Error('Ця монета вже є для цього профілю в тій самій партії.');
      }
      const targets = timeChanged ? group.filter((item) => item.status === 'scheduled') : [task];
      const others = all.filter((item) => !isFinal(item.status) && !group.some((member) => member.id === item.id));
      for (const target of targets) {
        if (this.inspecting.has(target.profileId) || others.some((item) => tasksOverlap(item, { ...target, saleAt: patch.saleAt }))) {
          throw new Error(`Профіль ${target.profileId} уже зайнятий у цей проміжок часу. Нічого не змінено.`);
        }
      }
      const now = Date.now();
      const changed = targets.map((item): Task => ({
        ...item, updatedAt: now,
        url: item.id === id ? url : item.url,
        saleAt: timeChanged ? patch.saleAt : item.saleAt,
        events: [...item.events, { at: now, message: item.id === id && url !== item.url
          ? (timeChanged ? 'Змінено монету й час старту.' : 'Змінено монету.') : 'Змінено час старту.' }].slice(-200),
      }));
      await this.store.saveTasks(changed);
      for (const item of changed) this.onTask(item);
      this.tick();
    });
  }

  cancel(id: string): Promise<void> {
    return this.serialize(async () => {
      const task = this.store.tasks().find((item) => item.id === id);
      if (!task || isFinal(task.status)) return;
      const active = this.running.get(id);
      if (active) {
        active.controller.abort();
        await active.done;
      } else {
        task.status = 'cancelled';
        task.note = 'Завдання скасовано до запуску.';
        task.updatedAt = Date.now();
        task.events = [...task.events, { at: task.updatedAt, message: task.note }].slice(-200);
        await this.store.saveTask(task);
        this.onTask(task);
      }
      this.onBusy(this.hasActiveWork());
    });
  }

  cancelAll(reason: string): Promise<void> {
    const pending = new Set(this.store.tasks().filter(task => !isFinal(task.status)).map(task => task.id));
    const stopped = this.stop();
    return this.serialize(async () => {
      await stopped;
      // Include tasks from IPC mutations that were already queued when access was removed.
      for (const task of this.store.tasks()) if (!isFinal(task.status)) pending.add(task.id);
      for (const id of pending) {
        const task = this.store.tasks().find(item => item.id === id);
        if (!task || (isFinal(task.status) && task.status !== 'cancelled')) continue;
        task.status = 'cancelled'; task.note = reason; task.updatedAt = Date.now();
        task.events = [...task.events, { at: task.updatedAt, message: reason }].slice(-200);
        await this.store.saveTask(task); this.onTask(task);
      }
      this.onBusy(false);
    });
  }

  // Bounded like readProfile: a hung AdsPower start or a long 429 wait must not hold the profile
  // (and block new tasks for it) indefinitely, and quitting the app aborts it.
  inspect(profileId: string, url: string, timeoutMs = INSPECT_TIMEOUT_MS): Promise<string> {
    if (this.stopped || this.inspecting.has(profileId) || this.store.tasks().some((task) =>
      task.profileId === profileId && !isFinal(task.status))) {
      return Promise.reject(new Error('Спочатку завершіть або скасуйте активні завдання цього профілю.'));
    }
    this.inspecting.add(profileId);
    this.onBusy(true);
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([controller.signal, timeout]);
    const done = (async () => {
      let session;
      try {
        session = await this.provider().connect(profileId, url, signal);
        signal.throwIfAborted();
        const state = await session.read();
        if (state.challenge || state.turnstile) return 'Профіль відкрито. Завершіть перевірку сайту у браузері.';
        if (state.login !== 'logged-in') return 'Профіль відкрито. Увійдіть в акаунт НБУ у браузері.';
        return state.inCart ? 'Підключення працює. Товар уже в кошику.' : 'Підключення працює. Вхід в акаунт підтверджено.';
      } catch (error) {
        if (timeout.aborted) throw new Error(`Перевірка профілю не завершилася за ${Math.round(timeoutMs / 60_000)} хв. Перевірте AdsPower і спробуйте ще раз.`);
        if (signal.aborted) throw new Error('Перевірку профілю зупинено.');
        // Rethrown as a plain Error so the IPC layer does not prefix the class name.
        if (error instanceof UserFacingError) throw new Error(error.message);
        throw new Error('Не вдалося перевірити профіль. Перевірте API, ключ, ID профілю та закрийте зайві вкладки НБУ.');
      } finally {
        await session?.disconnect().catch(() => {});
        this.profileReads.delete(profileId);
        this.inspecting.delete(profileId);
        this.onBusy(this.hasActiveWork());
      }
    })();
    this.profileReads.set(profileId, { controller, done });
    return done;
  }

  readProfile<T>(profileId: string, action: (signal: AbortSignal) => Promise<T>, timeoutMs = 90_000): Promise<T> {
    if (this.stopped || this.inspecting.has(profileId) || this.store.tasks().some(task => task.profileId === profileId &&
      !isFinal(task.status) && (task.status !== 'scheduled' || task.saleAt - task.leadMin * 60_000 <= Date.now() + 120_000))) {
      return Promise.reject(new UserFacingError('Профіль зайнятий або скоро почне підготовку до покупки. Повторіть після завершення.'));
    }
    this.inspecting.add(profileId);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    this.onBusy(true);
    const done = Promise.resolve().then(() => action(signal)).finally(() => {
      this.profileReads.delete(profileId);
      this.inspecting.delete(profileId);
      this.onBusy(this.hasActiveWork());
    });
    this.profileReads.set(profileId, { controller, done });
    return done;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const read of this.profileReads.values()) read.controller.abort();
    for (const entry of this.prepared.values()) entry.controller.abort();
    for (const active of this.running.values()) active.controller.abort();
    await Promise.all([...this.running.values()].map((active) => active.done));
    await Promise.allSettled([...this.profileReads.values()].map(read => read.done));
    await Promise.all([...this.prepared.values()].map((entry) => entry.promise.then((pool) => pool.disconnect()).catch(() => {})));
    this.prepared.clear();
  }

  private tick(): void {
    if (this.stopped || !this.canStart()) return;
    for (const task of this.store.tasks()) {
      if (task.status === 'scheduled' && task.saleAt - task.leadMin * 60_000 <= Date.now()) {
        this.profileReads.get(task.profileId)?.controller.abort();
      }
    }
    for (const task of this.store.tasks()) {
      if (task.status !== 'scheduled' || this.running.has(task.id) || this.inspecting.has(task.profileId) ||
          Date.now() < task.saleAt - task.leadMin * 60_000 ||
          [...this.running.values()].some((active) => active.profileId === task.profileId &&
            (!task.batchId || active.batchId !== task.batchId))) continue;
      const controller = new AbortController();
      const startedAt = Date.now();
      let diskFailed = false;
      const done = Promise.resolve().then(async () => {
        const provider = this.provider();
        const pooled: BrowserProvider = {
          connect: async (profileId, url, signal, options) => {
            if (!task.batchId || !provider.prepare) return provider.connect(profileId, url, signal, options);
            const key = JSON.stringify([task.batchId, profileId]);
            let entry = this.prepared.get(key);
            if (!entry) {
              const remaining = this.store.tasks().filter((item) => item.batchId === task.batchId &&
                item.profileId === profileId && !isFinal(item.status))
                .sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
              // Preparation belongs to the group, not its first task. Cancelling one coin must
              // not cancel another coin's navigation or disconnect its browser session.
              const preparationController = new AbortController();
              const rateLimitListeners = new Set<() => Promise<void>>();
              const promise = Promise.resolve().then(() => provider.prepare!(profileId,
                remaining.map((item) => item.url), preparationController.signal, {
                  deadline: Math.max(...remaining.map((item) => item.saleAt + item.windowMin * 60_000)),
                  onRateLimit: async () => { await Promise.all([...rateLimitListeners].map((listener) => listener())); },
                }));
              entry = { controller: preparationController, promise, rateLimitListeners };
              this.prepared.set(key, entry);
            }
            const listener = async () => { if (!signal.aborted) await options?.onRateLimit?.(); };
            entry.rateLimitListeners.add(listener);
            try {
              const pool = await this.waitForPool(entry.promise, signal);
              signal.throwIfAborted();
              return await pool.connect(profileId, url, signal, options);
            } finally { entry.rateLimitListeners.delete(listener); }
          },
        };
        await runTask(task, pooled, realClock, controller.signal, async (next) => {
          try { await this.store.saveTask(next); }
          catch (error) {
            // Invalid task data concerns this task only; a failed disk write concerns every task.
            if (!(error instanceof z.ZodError)) diskFailed = true;
            throw error;
          }
          this.onTask(next);
        }, () => priorOffsetBounds(this.store.tasks(), task.profileId, Date.now(), task.id), this.atomicSync);
        await this.reconnectIfLost(task.id, startedAt);
      }).catch(async () => {
        if (!diskFailed && await this.finishUnexpected(task.id)) return;
        // Stop all scheduling on a persistence failure: a click must not happen without its journal entry.
        clearInterval(this.timer);
        this.stopped = true;
        for (const active of this.running.values()) active.controller.abort();
        this.onError('Помилка збереження завдань. Планувальник зупинено; перезапустіть програму після перевірки диска.');
      }).finally(async () => {
        this.running.delete(task.id);
        if (task.batchId &&
            ![...this.running.values()].some((active) => active.batchId === task.batchId && active.profileId === task.profileId) &&
            this.store.tasks().filter((item) => item.batchId === task.batchId &&
              item.profileId === task.profileId).every((item) => isFinal(item.status))) {
          const key = JSON.stringify([task.batchId, task.profileId]);
          const entry = this.prepared.get(key);
          this.prepared.delete(key);
          entry?.controller.abort();
          await entry?.promise.then((pool) => pool.disconnect()).catch(() => {});
        }
        this.onBusy(this.hasActiveWork());
        if (!this.stopped) this.tick();
      });
      this.running.set(task.id, { controller, done, profileId: task.profileId, batchId: task.batchId });
    }
    this.onBusy(this.hasActiveWork());
  }

  // The connection to the profile's browser dropped before any click (a crashed tab, AdsPower hiccup):
  // the task goes back to the queue and the next tick prepares the profile afresh. Never after a click
  // or an observed purchase (those end as 'interrupted', not 'failed'), at most three times, and only
  // while the sale window is still open.
  private async reconnectIfLost(id: string, startedAt: number): Promise<void> {
    const saved = this.store.tasks().find((item) => item.id === id);
    if (!saved || saved.status !== 'failed' || saved.clicks > 0 || this.stopped) return;
    if (!saved.events.some((event) => event.at >= startedAt && event.message === CONNECTION_LOST_NOTE)) return;
    const attempts = saved.events.filter((event) => event.message.startsWith(RECONNECT_NOTE)).length;
    if (attempts >= 3 || Date.now() + saved.offsetMs >= saved.saleAt + saved.windowMin * 60_000 - 10_000) return;
    if (saved.batchId) {
      const key = JSON.stringify([saved.batchId, saved.profileId]);
      const entry = this.prepared.get(key);
      // A dead browser connection is dropped; a live one reopens a closed tab by itself.
      if (entry && await entry.promise.then((pool) => pool.alive?.() === false, () => true)) {
        this.prepared.delete(key);
        entry.controller.abort();
        await entry.promise.then((pool) => pool.disconnect()).catch(() => {});
      }
    }
    const note = `${RECONNECT_NOTE} Спроба ${attempts + 1}/3.`;
    const next: Task = { ...saved, status: 'scheduled', note, updatedAt: Date.now(),
      events: [...saved.events, { at: Date.now(), message: note, details: { status: 'scheduled' } }].slice(-200) };
    await this.store.saveTask(next);
    this.onTask(next);
  }

  // A task that escaped runTask without a disk failure ends on its own; other tasks keep running.
  // Its last saved copy is used: a click is always saved before it is sent, so `clicks` is reliable.
  private async finishUnexpected(id: string): Promise<boolean> {
    const saved = this.store.tasks().find((item) => item.id === id);
    if (!saved) return true;
    if (isFinal(saved.status)) { this.onTask(saved); return true; }
    const now = Date.now();
    const finished: Task = { ...saved, status: saved.clicks ? 'interrupted' : 'failed', note: UNEXPECTED_TASK_NOTE, updatedAt: now,
      events: [...saved.events, { at: now, message: UNEXPECTED_TASK_NOTE }].slice(-200) };
    try { await this.store.saveTask(finished); }
    catch { return false; }
    this.onTask(finished);
    return true;
  }

  private async waitForPool(promise: Promise<PreparedProfile>, signal: AbortSignal): Promise<PreparedProfile> {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Task cancelled during preparation'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([promise, cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.mutations.then(action, action);
    this.mutations = operation.catch(() => {});
    return operation;
  }
}
