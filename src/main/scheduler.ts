import { randomUUID } from 'node:crypto';
import { runTask } from '../core/buyer';
import { isFinal, productUrl, taskInputSchema, type Task, type TaskInput } from '../core/model';
import { realClock, type BrowserProvider, type PreparedProfile } from '../core/ports';
import { UserFacingError } from '../core/shop-errors';
import { Store } from './store';

export function tasksOverlap(a: TaskInput, b: TaskInput): boolean {
  const start = (task: TaskInput) => task.saleAt - task.leadMin * 60_000;
  const end = (task: TaskInput) => task.saleAt + task.windowMin * 60_000 + 120_000;
  return a.profileId === b.profileId && start(a) < end(b) && start(b) < end(a);
}

export class Scheduler {
  private running = new Map<string, { controller: AbortController; done: Promise<void>; profileId: string; batchId?: string }>();
  private prepared = new Map<string, { controller: AbortController; promise: Promise<PreparedProfile> }>();
  private inspecting = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private mutations: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly provider: () => BrowserProvider,
    private readonly onTask: (task: Task) => void,
    private readonly onBusy: (busy: boolean) => void,
    private readonly onError: (message: string) => void,
  ) {}

  start(): void {
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
          clicks: 0, reloads: 0, offsetMs: 0, note: 'Завдання заплановано. Монети запускаються незалежно.', events: [],
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
        await this.store.saveTask(task);
        this.onTask(task);
      }
      this.onBusy(this.hasActiveWork());
    });
  }

  async inspect(profileId: string, url: string): Promise<string> {
    if (this.inspecting.has(profileId) || this.store.tasks().some((task) =>
      task.profileId === profileId && !isFinal(task.status))) {
      throw new Error('Спочатку завершіть або скасуйте активні завдання цього профілю.');
    }
    this.inspecting.add(profileId);
    this.onBusy(true);
    let session;
    try {
      session = await this.provider().connect(profileId, url, new AbortController().signal);
      const state = await session.read();
      if (state.challenge || state.turnstile) return 'Профіль відкрито. Завершіть перевірку сайту у браузері.';
      if (state.login !== 'logged-in') return 'Профіль відкрито. Увійдіть в акаунт НБУ у браузері.';
      return state.inCart ? 'Підключення працює. Товар уже в кошику.' : 'Підключення працює. Вхід в акаунт підтверджено.';
    } catch (error) {
      // Rethrown as a plain Error so the IPC layer does not prefix the class name.
      if (error instanceof UserFacingError) throw new Error(error.message);
      throw new Error('Не вдалося перевірити профіль. Перевірте API, ключ, ID профілю та закрийте зайві вкладки НБУ.');
    } finally {
      await session?.disconnect().catch(() => {});
      this.inspecting.delete(profileId);
      this.onBusy(this.hasActiveWork());
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    for (const entry of this.prepared.values()) entry.controller.abort();
    for (const active of this.running.values()) active.controller.abort();
    await Promise.all([...this.running.values()].map((active) => active.done));
    await Promise.all([...this.prepared.values()].map((entry) => entry.promise.then((pool) => pool.disconnect()).catch(() => {})));
    this.prepared.clear();
  }

  private tick(): void {
    if (this.stopped) return;
    for (const task of this.store.tasks()) {
      if (task.status !== 'scheduled' || this.running.has(task.id) || this.inspecting.has(task.profileId) ||
          Date.now() < task.saleAt - task.leadMin * 60_000 ||
          [...this.running.values()].some((active) => active.profileId === task.profileId &&
            (!task.batchId || active.batchId !== task.batchId))) continue;
      const controller = new AbortController();
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
              const promise = Promise.resolve().then(() => provider.prepare!(profileId,
                remaining.map((item) => item.url), preparationController.signal, {
                  deadline: Math.max(...remaining.map((item) => item.saleAt + item.windowMin * 60_000)),
                }));
              entry = { controller: preparationController, promise };
              this.prepared.set(key, entry);
            }
            const pool = await this.waitForPool(entry.promise, signal);
            signal.throwIfAborted();
            return pool.connect(profileId, url, signal, options);
          },
        };
        await runTask(task, pooled, realClock, controller.signal, async (next) => {
          await this.store.saveTask(next);
          this.onTask(next);
        });
      }).catch(() => {
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
