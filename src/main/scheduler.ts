import { randomUUID } from 'node:crypto';
import { runTask } from '../core/buyer';
import { isFinal, taskInputSchema, type Task, type TaskInput } from '../core/model';
import { realClock, type BrowserProvider, type PreparedProfile } from '../core/ports';
import { Store } from './store';

export function tasksOverlap(a: TaskInput, b: TaskInput): boolean {
  const start = (task: TaskInput) => task.saleAt - task.leadMin * 60_000;
  const end = (task: TaskInput) => task.saleAt + task.windowMin * 60_000 + 120_000;
  return a.profileId === b.profileId && start(a) < end(b) && start(b) < end(a);
}

export class Scheduler {
  private running = new Map<string, { controller: AbortController; done: Promise<void>; profileId: string }>();
  private prepared = new Map<string, PreparedProfile>();
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
          clicks: 0, reloads: 0, offsetMs: 0, note: batchIndex > 0
            ? 'Очікує попередню монету цього профілю.' : 'Завдання заплановано.', events: [],
        };
      });
      await this.store.addTasks(tasks);
      for (const task of tasks) this.onTask(task);
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
    } catch {
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
    for (const active of this.running.values()) active.controller.abort();
    await Promise.all([...this.running.values()].map((active) => active.done));
    await Promise.all([...this.prepared.values()].map((pool) => pool.disconnect().catch(() => {})));
    this.prepared.clear();
  }

  private tick(): void {
    if (this.stopped) return;
    for (const task of this.store.tasks()) {
      if (task.status !== 'scheduled' || this.running.has(task.id) || this.inspecting.has(task.profileId) ||
          Date.now() < task.saleAt - task.leadMin * 60_000 ||
          [...this.running.values()].some((active) => active.profileId === task.profileId)) continue;
      const previous = task.batchId ? this.store.tasks().filter((item) => item.batchId === task.batchId &&
        item.profileId === task.profileId && (item.batchIndex ?? 0) < (task.batchIndex ?? 0)) : [];
      if (previous.some((item) => !isFinal(item.status))) continue;
      const controller = new AbortController();
      const done = Promise.resolve().then(async () => {
        if (previous.some((item) => ['interrupted', 'failed', 'cancelled'].includes(item.status))) {
          task.status = 'cancelled';
          task.note = 'Послідовність зупинено після збою або скасування попередньої монети. Перевірте профіль і кошик.';
          task.updatedAt = Date.now();
          task.events.push({ at: task.updatedAt, message: task.note });
          await this.store.saveTask(task);
          this.onTask(task);
          return;
        }
        const provider = this.provider();
        const pooled: BrowserProvider = {
          connect: async (profileId, url, signal, options) => {
            if (!task.batchId || !provider.prepare) return provider.connect(profileId, url, signal, options);
            const key = JSON.stringify([task.batchId, profileId]);
            let pool = this.prepared.get(key);
            if (!pool) {
              const remaining = this.store.tasks().filter((item) => item.batchId === task.batchId &&
                item.profileId === profileId && !isFinal(item.status))
                .sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
              pool = await provider.prepare(profileId, remaining.map((item) => item.url), signal, options);
              this.prepared.set(key, pool);
              for (const item of remaining) {
                const current = this.store.tasks().find((saved) => saved.id === item.id);
                if (!current || current.id === task.id || current.status !== 'scheduled') continue;
                current.note = 'Сторінку відкрито заздалегідь. Очікує попередню монету цього профілю.';
                current.updatedAt = Date.now();
                await this.store.saveTask(current);
                this.onTask(current);
              }
            }
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
        if (task.batchId && this.store.tasks().filter((item) => item.batchId === task.batchId &&
            item.profileId === task.profileId).every((item) => isFinal(item.status))) {
          const key = JSON.stringify([task.batchId, task.profileId]);
          const pool = this.prepared.get(key);
          this.prepared.delete(key);
          await pool?.disconnect().catch(() => {});
        }
        this.running.delete(task.id);
        this.onBusy(this.hasActiveWork());
        if (!this.stopped) this.tick();
      });
      this.running.set(task.id, { controller, done, profileId: task.profileId });
    }
    this.onBusy(this.hasActiveWork());
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.mutations.then(action, action);
    this.mutations = operation.catch(() => {});
    return operation;
  }
}
