import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { KeyStore, type SecretCipher } from '../src/main/key-store';

const key = randomBytes(32);
const cipher: SecretCipher = {
  available: () => true,
  encrypt: (value) => {
    const iv = randomBytes(12);
    const aes = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([aes.update(value, 'utf8'), aes.final()]);
    return Buffer.concat([iv, aes.getAuthTag(), encrypted]);
  },
  decrypt: (value) => {
    const aes = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    aes.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([aes.update(value.subarray(28)), aes.final()]).toString('utf8');
  },
};
const pathForTest = async () => join(await mkdtemp(join(tmpdir(), 'nbu-key-')), 'key.enc');
it('restores, replaces and removes an encrypted key across instances', async () => {
  const path = await pathForTest();
  const store = new KeyStore(path, cipher);
  await store.save('test-private-api-key');
  expect((await readFile(path)).includes(Buffer.from('test-private-api-key'))).toBe(false);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await new KeyStore(path, cipher).load()).toEqual({ value: 'test-private-api-key', saved: true });
  await store.save('replacement');
  expect((await new KeyStore(path, cipher).load()).value).toBe('replacement');
  await store.clear();
  expect(await new KeyStore(path, cipher).load()).toEqual({ value: '', saved: false });
});
it('preserves the existing key when encryption is unavailable or fails', async () => {
  const path = await pathForTest();
  await new KeyStore(path, cipher).save('original');
  for (const broken of [{ ...cipher, available: () => false }, { ...cipher, encrypt: () => { throw Error('failed'); } }]) {
    await expect(new KeyStore(path, broken).save('replacement')).rejects.toThrow();
    expect((await new KeyStore(path, cipher).load()).value).toBe('original');
  }
});
it('reports an unreadable key without deleting the encrypted file', async () => {
  const path = await pathForTest();
  await writeFile(path, 'broken');
  expect(await new KeyStore(path, cipher).load()).toMatchObject({ value: '', saved: true, error: expect.any(String) });
  expect(await readFile(path, 'utf8')).toBe('broken');
});
