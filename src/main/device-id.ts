import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
async function machineId(): Promise<string> {
  if (process.platform === 'darwin') {
    const { stdout } = await execute('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000 });
    return stdout.match(/"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]+)"/)?.[1] ?? '';
  }
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'], { timeout: 5000 });
    return stdout.trim();
  }
  return (await readFile('/etc/machine-id', 'utf8')).trim();
}

// Persist the identifier once; a later unavailable hardware service must not consume another device slot.
export async function deviceId(path: string, hardwareId = machineId): Promise<string> {
  try {
    const saved = (await readFile(path, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(saved)) throw new Error('Некоректний ідентифікатор пристрою.');
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const hardware = await hardwareId().catch(() => '');
  const id = createHash('sha256').update(`nbu-desktop-device-v1:${hardware || randomUUID()}`).digest('hex');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, id, { mode: 0o600, flag: 'wx' });
  return id;
}
