import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_SETTINGS, isFinal, settingsSchema, taskSchema, type Settings, type Task } from '../core/model';

// Version 1 kept every task inside tasks.json; it is still read and migrated on load.
const legacySchema = z.object({
  version: z.literal(1), settings: settingsSchema, tasks: z.array(taskSchema),
  retryIntervalVersion: z.literal(1).optional(),
});
// Version 2: tasks.json holds settings and the ordered list of committed task IDs; each task lives in
// its own file. Saving a task during a sale rewrites only that small file, never the whole history,
// and tasks of different coins do not queue behind each other's writes.
const indexSchema = z.object({
  version: z.literal(2), settings: settingsSchema, taskIds: z.array(z.string().uuid()),
  retryIntervalVersion: z.literal(1).optional(),
});

// Finished tasks are kept for a month (sale summaries, clock history); active ones are never removed.
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const HISTORY_MAX_FINISHED = 500;
export function pruneHistory(tasks: Task[], now: number): Task[] {
  const finished = tasks.filter((task) => isFinal(task.status) && now - Math.max(task.updatedAt, task.saleAt) < HISTORY_MAX_AGE_MS)
    .sort((a, b) => Math.max(b.updatedAt, b.saleAt) - Math.max(a.updatedAt, a.saleAt)).slice(0, HISTORY_MAX_FINISHED);
  const kept = new Set(finished);
  return tasks.filter((task) => !isFinal(task.status) || kept.has(task));
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await writeFile(`${path}.tmp`, contents, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export class Store {
  private currentSettings: Settings = DEFAULT_SETTINGS;
  private list: Task[] = [];
  private indexWrites: Promise<void> = Promise.resolve();
  private taskWrites = new Map<string, Promise<void>>();
  private readonly dir: string;
  constructor(private readonly path: string) {
    this.dir = join(dirname(path), basename(path, '.json'));
  }

  async load(): Promise<void> {
    let raw: { settings?: { savedProfiles?: unknown }; version?: unknown };
    const rewrite = new Set<string>();
    let retryIntervalVersion: 1 | undefined;
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (raw.version === 1) {
        const document = legacySchema.parse(raw);
        this.currentSettings = document.settings;
        this.list = document.tasks;
        retryIntervalVersion = document.retryIntervalVersion;
        for (const task of this.list) rewrite.add(task.id);
      } else {
        const index = indexSchema.parse(raw);
        this.currentSettings = index.settings;
        retryIntervalVersion = index.retryIntervalVersion;
        this.list = await Promise.all(index.taskIds.map(async (id) =>
          taskSchema.parse(JSON.parse(await readFile(this.taskPath(id), 'utf8')))));
      }
      if (raw.settings?.savedProfiles === undefined) {
        const { defaultProfileIds, defaultProfileId } = this.currentSettings;
        const ids = defaultProfileIds.length ? defaultProfileIds : defaultProfileId ? [defaultProfileId] : [];
        this.currentSettings.savedProfiles = [...new Set(ids)].map((id) => ({ id, name: '' }));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (error as NodeJS.ErrnoException).path === this.path) return;
      throw new Error('Не вдалося прочитати локальні завдання. Файл збережено без змін.');
    }
    if (!retryIntervalVersion) {
      // Apply the new one-second default once, preserving later choices and completed runs.
      if (this.currentSettings.retrySec === 5) this.currentSettings.retrySec = 1;
      for (const task of this.list) {
        if (task.status !== 'scheduled' || task.retrySec !== 5) continue;
        task.retrySec = 1;
        task.updatedAt = Date.now();
        task.events = [...task.events, { at: task.updatedAt,
          message: 'Інтервал повторного оновлення зменшено з 5 до 1 с.' }].slice(-200);
        rewrite.add(task.id);
      }
    }
    for (const task of this.list) {
      if (!isFinal(task.status) && task.status !== 'scheduled') {
        task.status = 'interrupted';
        task.updatedAt = Date.now();
        task.note = 'Попередній запуск перервано. Перевірте кошик; автоматичного повтору немає.';
        task.events = [...task.events, { at: task.updatedAt, message: task.note }].slice(-200);
        rewrite.add(task.id);
      }
    }
    this.list = pruneHistory(this.list, Date.now());
    // Task files first, then the index that commits them. Interrupted in between, the old index
    // (or the legacy document) is still valid and the migration simply runs again.
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await Promise.all(this.list.filter((task) => rewrite.has(task.id)).map((task) => this.writeTask(task)));
    await this.writeIndex();
    // Files no longer listed: pruned history, or tasks whose batch was never committed.
    await this.removeUnlisted();
  }

  tasks(): Task[] { return structuredClone(this.list); }
  settings(): Settings { return structuredClone(this.currentSettings); }

  async saveTask(task: Task): Promise<void> {
    const parsed = taskSchema.parse(task);
    const index = this.list.findIndex((item) => item.id === task.id);
    if (index !== -1) {
      this.list[index] = parsed;
      const written = this.writeTask(parsed);
      if (!isFinal(parsed.status)) return written;
      await written;
      await this.prune();
      return;
    }
    await this.writeTask(parsed);
    await this.writeIndex([parsed]);
  }

  // Replace several tasks. Every new version is written to a temporary file before any of them
  // replaces its task: a failed write leaves the batch unchanged, and the renames that follow
  // take microseconds, so only a crash in that instant could leave the batch half-changed.
  async saveTasks(tasks: Task[]): Promise<void> {
    const parsed = tasks.map((task) => taskSchema.parse(task)).filter((task) => this.list.some((item) => item.id === task.id));
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await Promise.all(parsed.map((task) => this.queueTask(task.id, () => writeFile(`${this.taskPath(task.id)}.tmp`, JSON.stringify(task), { mode: 0o600 }))));
    await Promise.all(parsed.map((task) => this.queueTask(task.id, () => rename(`${this.taskPath(task.id)}.tmp`, this.taskPath(task.id)))));
    for (const task of parsed) this.list[this.list.findIndex((item) => item.id === task.id)] = task;
  }

  async saveSettings(settings: Settings): Promise<void> {
    this.currentSettings = settingsSchema.parse(settings);
    await this.writeIndex();
  }

  async addTasks(tasks: Task[]): Promise<void> {
    const parsed = tasks.map((task) => taskSchema.parse(task));
    // The batch becomes visible (on disk and to the scheduler) only when the index lists it.
    await Promise.all(parsed.map((task) => this.writeTask(task)));
    await this.writeIndex(parsed);
  }

  private taskPath(id: string): string { return join(this.dir, `${z.string().uuid().parse(id)}.json`); }

  private queueTask(id: string, action: () => Promise<void>): Promise<void> {
    const operation = (this.taskWrites.get(id) ?? Promise.resolve()).then(action, action);
    const tail = operation.catch(() => {});
    this.taskWrites.set(id, tail);
    void tail.then(() => { if (this.taskWrites.get(id) === tail) this.taskWrites.delete(id); });
    return operation;
  }

  private writeTask(task: Task): Promise<void> {
    const contents = JSON.stringify(task);
    return this.queueTask(task.id, async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeAtomic(this.taskPath(task.id), contents);
    });
  }

  // Contents are taken when the write runs, so concurrent adds and prunes never overwrite each other.
  // `added` tasks join the list only once the index that commits them is on disk.
  private writeIndex(added: Task[] = []): Promise<void> {
    const write = async () => {
      const taskIds = [...this.list, ...added].map((task) => task.id);
      const contents = JSON.stringify({ version: 2, retryIntervalVersion: 1, settings: this.currentSettings, taskIds });
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeAtomic(this.path, contents);
      this.list.push(...added);
    };
    this.indexWrites = this.indexWrites.then(write, write);
    return this.indexWrites;
  }

  private async prune(): Promise<void> {
    const kept = pruneHistory(this.list, Date.now());
    if (kept.length === this.list.length) return;
    const removed = this.list.filter((task) => !kept.includes(task));
    this.list = kept;
    await this.writeIndex();
    await Promise.all(removed.map((task) => this.queueTask(task.id, () => unlink(this.taskPath(task.id)).catch(() => {}))));
  }

  private async removeUnlisted(): Promise<void> {
    const listed = new Set(this.list.map((task) => `${task.id}.json`));
    const names = await readdir(this.dir).catch(() => [] as string[]);
    await Promise.all(names.filter((name) => !listed.has(name)).map((name) => unlink(join(this.dir, name)).catch(() => {})));
  }
}
