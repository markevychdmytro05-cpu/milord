import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateOffer } from './license-client';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SIZE = 1024 ** 3;

function fileName(response: Response, offer: UpdateOffer): string {
  const header = response.headers.get('content-disposition') ?? '';
  const raw = /filename="?([^";]+)"?/i.exec(header)?.[1];
  const name = raw ? basename(raw) : '';
  return SAFE_NAME.test(name) ? name : `nbu-desktop-${offer.version}.installer`;
}

/** Downloads the installer offered by the license server, verifies size and SHA-256, returns the saved path. */
export async function downloadUpdate(offer: UpdateOffer, serverUrl: string, directory: string,
  request: typeof fetch = fetch): Promise<string> {
  const url = new URL(offer.url);
  if (url.origin !== new URL(serverUrl).origin) throw new Error('Посилання на оновлення веде не на сервер ліцензій.');
  if (offer.size > MAX_SIZE) throw new Error('Файл оновлення завеликий.');
  let response: Response;
  try { response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(30 * 60_000) }); }
  catch { throw new Error('Не вдалося завантажити оновлення. Перевірте з’єднання й спробуйте ще раз.'); }
  if (!response.ok || !response.body) throw new Error('Сервер не віддав файл оновлення. Спробуйте пізніше.');

  await mkdir(directory, { recursive: true });
  const target = join(directory, fileName(response, offer));
  const partial = `${target}.part`;
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    received += chunk.length;
    if (received > offer.size) return done(new Error('Файл оновлення більший, ніж очікувалось.'));
    hash.update(chunk); done(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(partial, { flags: 'w', mode: 0o600 }));
    if (received !== offer.size || hash.digest('hex') !== offer.sha256) throw new Error('Контрольна сума оновлення не збігається. Файл не збережено.');
    await rename(partial, target);
    return target;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
