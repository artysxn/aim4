// Builds the server pack the aim4 desktop app carries (recorder/app/pack/aim4-pack.zip):
// this Node, the server, its modules and the client build, so the app runs its own
// server on any PC and keeps working offline (server/run-pack.js, server/offline.js).
//
//   npm run build:account && node scripts/build-pack.mjs && (cd recorder && cargo build --release)
//
// Trainer maps and the 3D sky are left out: online they come from aim4.io.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'build', '.pack');
const OUT = path.join(ROOT, 'recorder', 'app', 'pack', 'aim4-pack.zip');
const SKIP_MODULES = new Set(['@esbuild', 'esbuild', '.cache']);

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
const copy = (rel, filter = () => true) => fs.cpSync(path.join(ROOT, rel), path.join(STAGE, rel), { recursive: true, filter: (src) => filter(path.relative(ROOT, src).replace(/\\/g, '/')) });

copy('package.json');
copy('server', (p) => !/^server\/data(\/|$)/.test(p) && !/\.test\.js$/.test(p));
copy('server/data/replays/zones');
copy('shared', (p) => !/\.test\.js$/.test(p));
copy('src', (p) => !/\.test\.js$/.test(p));
copy('scripts', (p) => !/\.test\.m?js$/.test(p));
copy('dist-account', (p) => !/^dist-account\/(maps|assets\/sky)(\/|$)/.test(p));
copy('node_modules', (p) => !SKIP_MODULES.has(p.split('/')[1]) && !/^node_modules\/\.bin(\/|$)/.test(p));
fs.copyFileSync(process.execPath, path.join(STAGE, 'node.exe'));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });
// Windows' own tar (bsdtar) writes zip with -a; run from the stage so no drive letter reaches it.
execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-cf', OUT, '*'], { cwd: STAGE, stdio: 'inherit', shell: false, windowsVerbatimArguments: false });
console.log(`pack: ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(0)} MB)`);
