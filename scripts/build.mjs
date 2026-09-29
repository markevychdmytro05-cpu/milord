import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await mkdir('dist/licenses', { recursive: true });
await copyFile('third-party/Inter-OFL.txt', 'dist/licenses/Inter-OFL.txt');
const licenseConfig = {
  __LICENSE_SERVER_URL__: JSON.stringify(process.env.NBU_LICENSE_SERVER_URL || 'http://127.0.0.1:8000'),
  // Public verification key of the local license-server. The signing secret stays on the server.
  __LICENSE_PUBLIC_KEY__: JSON.stringify(process.env.NBU_LICENSE_PUBLIC_KEY || 'qKP9QqxYMdxx1M9Ogrvb5wYi/cAmnhT4g8AQAXJITpY='),
  __ALLOW_TEST_LICENSE__: process.env.NBU_DESKTOP_ALLOW_TEST_LICENSE === 'false' ? 'false' : 'true',
};
await Promise.all([
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', bundle: true,
    platform: 'node', target: 'node20', format: 'cjs', external: ['electron', 'patchright-core'], define: licenseConfig }),
  build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', bundle: true,
    platform: 'node', target: 'node20', format: 'cjs', external: ['electron'] }),
  build({ entryPoints: ['src/renderer/app.tsx'], outfile: 'dist/app.js', bundle: true,
    platform: 'browser', target: 'chrome120', format: 'iife',
    loader: { '.woff2': 'file', '.woff': 'file' }, assetNames: 'fonts/[name]-[hash]' }),
  copyFile('src/renderer/index.html', 'dist/index.html'),
]);
