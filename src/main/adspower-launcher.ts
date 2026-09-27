import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const run = (file: string, args: string[]) => new Promise<void>((resolve, reject) => {
  execFile(file, args, { windowsHide: true }, (error) => error ? reject(error) : resolve());
});

async function launch(): Promise<void> {
  if (process.platform === 'darwin') {
    for (const name of ['AdsPower Global', 'AdsPower']) {
      try { await run('open', ['-g', '-a', name]); return; } catch { /* try the next name */ }
    }
    throw new Error('AdsPower is not installed');
  }
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
      process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((root): root is string => !!root);
    for (const root of roots) {
      for (const name of ['AdsPower Global', 'AdsPower']) {
        const exe = join(root, name, `${name}.exe`);
        try { await access(exe); } catch { continue; }
        // `start` detaches AdsPower, so it keeps running after NBU Desktop exits.
        await run('cmd.exe', ['/c', 'start', '""', exe]);
        return;
      }
    }
    throw new Error('AdsPower is not installed');
  }
  await run('sh', ['-c', 'command -v adspower_global >/dev/null && (adspower_global >/dev/null 2>&1 &)']);
}

// Concurrent profile starts share one launch.
let pending: Promise<void> | undefined;
export function launchAdsPower(): Promise<void> {
  pending ??= launch().finally(() => { setTimeout(() => { pending = undefined; }, 30_000); });
  return pending;
}
