import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { deviceId } from '../src/main/device-id';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function path() { const dir = await mkdtemp(join(tmpdir(), 'nbu-device-')); directories.push(dir); return join(dir, 'device'); }
it('hashes hardware identity and retains it when the hardware service later fails', async () => {
  const file = await path(); const id = await deviceId(file, async () => 'hardware-123');
  expect(id).toMatch(/^[a-f0-9]{64}$/); expect(await readFile(file, 'utf8')).not.toContain('hardware');
  const hardware = vi.fn(async () => { throw new Error('offline'); });
  expect(await deviceId(file, hardware)).toBe(id); expect(hardware).not.toHaveBeenCalled();
});
it('falls back to a persisted installation identity when hardware lookup is unavailable', async () => {
  const file = await path(); const id = await deviceId(file, async () => { throw new Error('not available'); });
  expect(await deviceId(file)).toBe(id);
});
it('does not silently generate another device slot for a corrupted saved identity', async () => {
  const file = await path(); await writeFile(file, 'corrupted');
  await expect(deviceId(file)).rejects.toThrow('ідентифікатор');
});
