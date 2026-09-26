import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SecretCipher {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class KeyStore {
  constructor(private readonly path: string, private readonly cipher: SecretCipher) {}

  available(): boolean { return this.cipher.available(); }

  async load(): Promise<{ value: string; saved: boolean; error?: string }> {
    let encrypted: Buffer;
    try { encrypted = await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: '', saved: false };
      return { value: '', saved: true, error: 'Не вдалося прочитати збережений ключ. Перевірте налаштування.' };
    }
    try {
      if (!this.available()) throw new Error('Encryption unavailable');
      return { value: this.cipher.decrypt(encrypted), saved: true };
    } catch {
      return { value: '', saved: true, error: 'Не вдалося відкрити збережений ключ. Введіть його повторно або видаліть у налаштуваннях.' };
    }
  }

  async save(value: string): Promise<void> {
    if (!value.trim()) throw new Error('Вкажіть непорожній API-ключ.');
    if (!this.available()) throw new Error('Системне сховище ключів недоступне. Ключ не збережено.');
    // Encrypt before touching the existing file; never fall back to plaintext storage.
    const encrypted = this.cipher.encrypt(value.trim());
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(`${this.path}.tmp`, encrypted, { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }

  async clear(): Promise<void> {
    try { await unlink(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
