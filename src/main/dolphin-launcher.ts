import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const run = (file: string, args: string[]) => new Promise<void>((resolve, reject) => {
  execFile(file, args, { windowsHide: true }, (error) => error ? reject(error) : resolve());
});

const NAMES = ['Dolphin Anty', 'Dolphin{anty}', 'DolphinAnty'];

async function launch(): Promise<void> {
  if (process.platform === 'darwin') {
    for (const name of NAMES) {
      try { await run('open', ['-g', '-a', name]); return; } catch { /* try the next name */ }
    }
    throw new Error('Dolphin Anty is not installed');
  }
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((root): root is string => !!root);
    for (const root of roots) {
      for (const name of NAMES) {
        const exe = join(root, name, `${name}.exe`);
        try { await access(exe); } catch { continue; }
        await run('cmd.exe', ['/c', 'start', '""', exe]);
        return;
      }
    }
  }
  throw new Error('Dolphin Anty is not installed');
}

// Concurrent profile starts share one launch.
let pending: Promise<void> | undefined;
export function launchDolphin(): Promise<void> {
  pending ??= launch().finally(() => { setTimeout(() => { pending = undefined; }, 30_000); });
  return pending;
}
