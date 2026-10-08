import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadUpdate } from '../src/main/updater';

const BODY = Buffer.from('installer-bytes');
const offer = (changes = {}) => ({ version: '0.2.0', notes: null, size: BODY.length, sha256: createHash('sha256').update(BODY).digest('hex'),
  url: 'https://numis.example/zavantazhyty/1/file?signature=x', ...changes });
const reply = (body: Buffer = BODY, headers: Record<string, string> = { 'content-disposition': 'attachment; filename=nbu-desktop-0.2.0-win-x64.exe' }) =>
  (async () => new Response(new Uint8Array(body), { headers })) as unknown as typeof fetch;

describe('downloadUpdate', () => {
  it('saves a verified installer under the server-provided safe name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'upd-'));
    const path = await downloadUpdate(offer(), 'https://numis.example/', dir, reply());
    expect(path).toBe(join(dir, 'nbu-desktop-0.2.0-win-x64.exe'));
    expect(await readFile(path)).toEqual(BODY);
  });
  it('refuses a different origin, a bad checksum and a wrong size, leaving no partial file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'upd-'));
    await expect(downloadUpdate(offer({ url: 'https://evil.example/f' }), 'https://numis.example/', dir, reply())).rejects.toThrow('не на сервер');
    await expect(downloadUpdate(offer({ sha256: 'b'.repeat(64) }), 'https://numis.example/', dir, reply())).rejects.toThrow('Контрольна сума');
    await expect(downloadUpdate(offer({ size: 3 }), 'https://numis.example/', dir, reply())).rejects.toThrow('більший');
    await expect(downloadUpdate(offer({ size: 99 }), 'https://numis.example/', dir, reply())).rejects.toThrow('Контрольна сума');
    expect(await readdir(dir)).toEqual([]);
  });
  it('ignores path tricks in the file name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'upd-'));
    const path = await downloadUpdate(offer(), 'https://numis.example/', dir, reply(BODY, { 'content-disposition': 'attachment; filename="../../evil.sh"' }));
    expect(path).toBe(join(dir, 'evil.sh'));
  });
});
