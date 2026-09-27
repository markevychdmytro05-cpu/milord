import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Response } from 'patchright-core';
import type { CaptureRequest } from '../core/ports';

// Development aid: keeps what the shop showed around a purchase, so unseen markup (a moving queue,
// stock left, new errors) can be studied after the sale instead of waiting for the next one.
// Files stay on this computer; they contain the account's pages, so they are private (0600).
export const CAPTURE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_SNAPSHOTS = 300;
const MAX_BYTES = 150 * 1024 * 1024;
const MAX_NETWORK = 3000;
const BODY_LIMIT = 64 * 1024;

const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);

export class PageRecorder {
  constructor(private readonly root: string, private readonly now: () => number = Date.now) {}

  forTask(taskId: string, saleAt: number): TaskRecorder {
    const day = new Date(saleAt).toLocaleString('sv-SE', { timeZone: 'Europe/Kyiv' }).replace(/[: ]/g, '-').slice(0, 16);
    return new TaskRecorder(join(this.root, `${day}_${safe(taskId).slice(0, 8)}`), saleAt, this.now);
  }

  // Remove capture folders older than a month.
  async prune(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.root); } catch { return; }
    for (const name of names) {
      const path = join(this.root, name);
      try { if (this.now() - (await stat(path)).mtimeMs > CAPTURE_MAX_AGE_MS) await rm(path, { recursive: true, force: true }); }
      catch { /* A folder in use or already removed is skipped. */ }
    }
  }
}

export class TaskRecorder {
  private sequence = 0;
  private bytes = 0;
  private network = 0;
  private lastText = '';
  private lastAt = 0;
  private recordingNetwork = false;
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly dir: string, private readonly saleAt: number, private readonly now: () => number) {}

  private prepare(): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => {});
    return this.ready;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  // Saves the page when its visible text changed. Throttled: at most once a second in the first
  // minute after the start, then every five seconds; forced captures always save.
  snapshot(page: Page, request: CaptureRequest): Promise<void> {
    this.recordingNetwork = true;
    return this.serial(async () => {
      if (this.sequence >= MAX_SNAPSHOTS || this.bytes >= MAX_BYTES || page.isClosed()) return;
      const minGap = request.saleDeltaMs < 60_000 ? 1000 : 5000;
      if (!request.force && this.now() - this.lastAt < minGap) return;
      const { html, text, url } = await page.evaluate(() => ({
        html: document.documentElement.outerHTML, text: document.body?.innerText ?? '', url: location.href,
      }));
      const hash = createHash('sha1').update(text).digest('hex');
      if (!request.force && hash === this.lastText) return;
      this.lastText = hash;
      this.lastAt = this.now();
      await this.prepare();
      const delta = `${request.saleDeltaMs < 0 ? 'm' : 'p'}${String(Math.abs(Math.round(request.saleDeltaMs))).padStart(7, '0')}ms`;
      const name = `${String(++this.sequence).padStart(3, '0')}_${delta}_${safe(request.label)}`;
      const header = `<!-- NBU Desktop capture · ${new Date(this.now()).toISOString()} · від старту ${request.saleDeltaMs} мс · ${request.label} · ${url} -->\n`;
      await writeFile(join(this.dir, `${name}.html`), header + html, { mode: 0o600 });
      await writeFile(join(this.dir, `${name}.txt`), text, { mode: 0o600 });
      this.bytes += html.length + text.length;
    });
  }

  // Same-origin XHR/fetch traffic of the page itself (queue polling and similar), read-only.
  response(response: Response): void {
    if (!this.recordingNetwork || this.network >= MAX_NETWORK || this.bytes >= MAX_BYTES) return;
    const request = response.request();
    if (!['xhr', 'fetch'].includes(request.resourceType())) return;
    try { if (new URL(response.url()).origin !== 'https://coins.bank.gov.ua') return; } catch { return; }
    this.network++;
    void this.serial(async () => {
      let body = '';
      try { body = (await response.text()).slice(0, BODY_LIMIT); } catch { body = '[тіло недоступне]'; }
      const line = JSON.stringify({
        at: new Date(this.now()).toISOString(), saleDeltaMs: this.now() - this.saleAt,
        method: request.method(), url: response.url(), status: response.status(),
        contentType: response.headers()['content-type'] ?? '', requestBody: (request.postData() ?? '').slice(0, 4096), body,
      });
      await this.prepare();
      await appendFile(join(this.dir, 'network.jsonl'), `${line}\n`, { mode: 0o600 });
      this.bytes += line.length;
    }).catch(() => {});
  }
}
