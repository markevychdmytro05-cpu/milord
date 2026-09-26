import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { NbuCredentials } from '../browser/nbu-login';
import type { SecretCipher } from './key-store';

export const nbuCredentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
});
const fileSchema = z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), nbuCredentialsSchema);

// NBU logins, one per AdsPower profile. The whole map is one encrypted file; passwords never leave
// the main process — the UI only receives the e-mail of each saved account.
export class AccountStore {
  private accounts: Record<string, NbuCredentials> = {};
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly cipher: SecretCipher) {}

  async load(): Promise<string | undefined> {
    let encrypted: Buffer;
    try { encrypted = await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return 'Не вдалося прочитати збережені акаунти НБУ.';
    }
    try {
      if (!this.cipher.available()) throw new Error('Encryption unavailable');
      this.accounts = fileSchema.parse(JSON.parse(this.cipher.decrypt(encrypted)));
      return undefined;
    } catch {
      return 'Не вдалося відкрити збережені акаунти НБУ. Введіть їх повторно.';
    }
  }

  get(profileId: string): NbuCredentials | undefined { return this.accounts[profileId]; }
  emails(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.accounts).map(([id, account]) => [id, account.email]));
  }

  save(profileId: string, credentials: NbuCredentials): Promise<void> {
    return this.write({ ...this.accounts, [profileId]: nbuCredentialsSchema.parse(credentials) });
  }
  clear(profileId: string): Promise<void> {
    const { [profileId]: _removed, ...rest } = this.accounts;
    return this.write(rest);
  }

  private write(next: Record<string, NbuCredentials>): Promise<void> {
    const operation = this.writes.then(async () => {
      if (!Object.keys(next).length) {
        try { await unlink(this.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      } else {
        if (!this.cipher.available()) throw new Error('Системне сховище ключів недоступне. Акаунт не збережено.');
        // Encrypt before touching the existing file; never fall back to plaintext storage.
        const encrypted = this.cipher.encrypt(JSON.stringify(next));
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await writeFile(`${this.path}.tmp`, encrypted, { mode: 0o600 });
        await rename(`${this.path}.tmp`, this.path);
      }
      this.accounts = next;
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}
