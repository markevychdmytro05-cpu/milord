import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await mkdir('dist/licenses', { recursive: true });
await copyFile('third-party/Inter-OFL.txt', 'dist/licenses/Inter-OFL.txt');
await Promise.all([
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', bundle: true,
    platform: 'node', target: 'node20', format: 'cjs', external: ['electron', 'patchright-core'] }),
  build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', bundle: true,
    platform: 'node', target: 'node20', format: 'cjs', external: ['electron'] }),
  build({ entryPoints: ['src/renderer/app.tsx'], outfile: 'dist/app.js', bundle: true,
    platform: 'browser', target: 'chrome120', format: 'iife',
    loader: { '.woff2': 'file', '.woff': 'file' }, assetNames: 'fonts/[name]-[hash]' }),
  copyFile('src/renderer/index.html', 'dist/index.html'),
]);
