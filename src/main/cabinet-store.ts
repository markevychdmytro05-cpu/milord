import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cabinetDocumentSchema, emptyCabinetState, filterCabinetProfiles, restoreCabinet, type CabinetSavedState } from '../core/cabinet-state';

export class CabinetStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  async load(connection: string, ids: string[], legacy?: string): Promise<CabinetSavedState> {
    await this.flush();
    try {
      const document = cabinetDocumentSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
      if (document.connection !== connection) return emptyCabinetState();
      return filterCabinetProfiles(document, ids);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Не вдалося прочитати збережений кабінет. Файл залишено без змін.');
    }
    const restored = restoreCabinet({ getItem: () => legacy ?? null }, connection, ids);
    await this.save(connection, ids, restored);
    return restored;
  }
  save(connection: string, ids: string[], state: CabinetSavedState): Promise<void> {
    const document = cabinetDocumentSchema.parse({ ...state, connection, version: 1 });
    const contents = JSON.stringify({ version: 1, connection, ...filterCabinetProfiles(document, ids) });
    const write = async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(`${this.path}.tmp`, contents, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    };
    const operation = this.writes.then(write);
    this.writes = operation.catch(() => {});
    return operation;
  }
  flush(): Promise<void> { return this.writes; }
}
