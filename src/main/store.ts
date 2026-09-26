import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DEFAULT_SETTINGS, isFinal, settingsSchema, taskSchema, type Settings, type Task } from '../core/model';

const documentSchema = z.object({
  version: z.literal(1), settings: settingsSchema, tasks: z.array(taskSchema),
  retryIntervalVersion: z.literal(1).optional(),
});
type Document = z.infer<typeof documentSchema>;

// Finished tasks are kept for a month (sale summaries, clock history); active ones are never removed.
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const HISTORY_MAX_FINISHED = 500;
export function pruneHistory(tasks: Task[], now: number): Task[] {
  const finished = tasks.filter((task) => isFinal(task.status) && now - Math.max(task.updatedAt, task.saleAt) < HISTORY_MAX_AGE_MS)
    .sort((a, b) => Math.max(b.updatedAt, b.saleAt) - Math.max(a.updatedAt, a.saleAt)).slice(0, HISTORY_MAX_FINISHED);
  const kept = new Set(finished);
  return tasks.filter((task) => !isFinal(task.status) || kept.has(task));
}

export class Store {
  private document: Document = { version: 1, retryIntervalVersion: 1, settings: DEFAULT_SETTINGS, tasks: [] };
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      this.document = documentSchema.parse(raw);
      if (raw.settings.savedProfiles === undefined) {
        const { defaultProfileIds, defaultProfileId } = this.document.settings;
        const ids = defaultProfileIds.length ? defaultProfileIds : defaultProfileId ? [defaultProfileId] : [];
        this.document.settings.savedProfiles = [...new Set(ids)].map((id) => ({ id, name: '' }));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Не вдалося прочитати локальні завдання. Файл збережено без змін.');
    }
    if (!this.document.retryIntervalVersion) {
      // Apply the new one-second default once, preserving later choices and completed runs.
      if (this.document.settings.retrySec === 5) this.document.settings.retrySec = 1;
      for (const task of this.document.tasks) {
        if (task.status !== 'scheduled' || task.retrySec !== 5) continue;
        task.retrySec = 1;
        task.updatedAt = Date.now();
        task.events = [...task.events, { at: task.updatedAt,
          message: 'Інтервал повторного оновлення зменшено з 5 до 1 с.' }].slice(-200);
      }
      this.document.retryIntervalVersion = 1;
    }
    for (const task of this.document.tasks) {
      if (!isFinal(task.status) && task.status !== 'scheduled') {
        task.status = 'interrupted';
        task.updatedAt = Date.now();
        task.note = 'Попередній запуск перервано. Перевірте кошик; автоматичного повтору немає.';
        task.events = [...task.events, { at: task.updatedAt, message: task.note }].slice(-200);
      }
    }
    this.document.tasks = pruneHistory(this.document.tasks, Date.now());
    await this.flush();
  }

  tasks(): Task[] { return structuredClone(this.document.tasks); }
  settings(): Settings { return structuredClone(this.document.settings); }

  async saveTask(task: Task): Promise<void> {
    const parsed = taskSchema.parse(task);
    const index = this.document.tasks.findIndex((item) => item.id === task.id);
    if (index === -1) this.document.tasks.push(parsed);
    else this.document.tasks[index] = parsed;
    if (isFinal(parsed.status)) this.document.tasks = pruneHistory(this.document.tasks, Date.now());
    await this.flush();
  }

  // Replace several tasks with one disk write, so a batch is never left half-changed.
  async saveTasks(tasks: Task[]): Promise<void> {
    const parsed = tasks.map((task) => taskSchema.parse(task));
    for (const task of parsed) {
      const index = this.document.tasks.findIndex((item) => item.id === task.id);
      if (index !== -1) this.document.tasks[index] = task;
    }
    await this.flush();
  }

  async saveSettings(settings: Settings): Promise<void> {
    this.document.settings = settingsSchema.parse(settings);
    await this.flush();
  }

  async addTasks(tasks: Task[]): Promise<void> {
    const parsed = tasks.map((task) => taskSchema.parse(task));
    // Commit the entire batch to disk before making it visible to the scheduler.
    const write = async () => {
      const next = { ...this.document, tasks: [...this.document.tasks, ...parsed] };
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(`${this.path}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
      this.document.tasks.push(...parsed);
    };
    this.writes = this.writes.then(write, write);
    await this.writes;
  }

  private flush(): Promise<void> {
    const write = async () => {
      const contents = JSON.stringify(this.document, null, 2);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(`${this.path}.tmp`, contents, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
}
