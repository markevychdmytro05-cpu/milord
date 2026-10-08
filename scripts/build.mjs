import { build } from 'esbuild';
import { mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const release = process.env.NBU_RELEASE === '1';
// Release builds are minified without comments; the main process is additionally compiled to V8 bytecode below.
const minify = release ? { minify: true, legalComments: 'none' } : {};
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
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', bundle: true, ...minify,
    platform: 'node', target: 'node20', format: 'cjs', external: ['electron', 'patchright-core'], define: licenseConfig }),
  build({ entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, ...minify,
    platform: 'node', target: 'node20', format: 'cjs', external: ['electron'] }),
  build({ entryPoints: ['src/renderer/app.tsx'], outfile: 'dist/app.js', bundle: true, ...minify,
    platform: 'browser', target: 'chrome120', format: 'iife',
    loader: { '.woff2': 'file', '.woff': 'file' }, assetNames: 'fonts/[name]-[hash]' }),
  copyFile('src/renderer/index.html', 'dist/index.html'),
]);

// NBU_BYTECODE=0 skips bytecode when the target platform differs from the build machine and cannot be test-launched.
if (release && process.env.NBU_BYTECODE !== '0') {
  // Bytecode is tied to the exact Electron/V8 build, so it must be compiled by the same Electron binary that ships.
  // NBU_ELECTRON_BIN points at the target-architecture Electron binary (run through `arch -x86_64` etc. via NBU_ELECTRON_PREFIX).
  const electron = process.env.NBU_ELECTRON_BIN || createRequire(import.meta.url)('electron');
  const prefix = (process.env.NBU_ELECTRON_PREFIX || '').split(' ').filter(Boolean);
  const compiled = spawnSync(prefix[0] ?? electron, [...prefix.slice(1), ...(prefix.length ? [electron] : []), 'scripts/compile-bytecode.cjs', 'dist/main.cjs', 'dist/main.jsc'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
  if (compiled.status !== 0) throw new Error('Bytecode compilation failed.');
  await rm('dist/main.cjs');
  await build({ stdin: { contents: "require('bytenode');\nrequire(require('node:path').join(__dirname, 'main.jsc'));", resolveDir: process.cwd() }, outfile: 'dist/main.cjs',
    bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['electron'], minify: true });
}
