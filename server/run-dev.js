// Dev LAN mode: Vite client + multiplayer backend together.
// Friends open http://<your-lan-ip>:5173 — /ws and /api proxy to port 3784.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(label, cmd, args) {
  const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    if (code) console.error(`[${label}] exited with code ${code}`);
  });
  return child;
}

console.log('');
console.log('AIM4 dev + multiplayer');
console.log('  Client:  http://localhost:5173  (share your LAN IP:5173 with friends)');
console.log('  Backend: http://127.0.0.1:3784  (proxied as /api and /ws)');
console.log('  For production hosting use npm run host instead.');
console.log('');

const server = run('server', 'node', ['server/index.js']);
const vite = run('vite', npmCmd, ['run', 'dev']);

function shutdown() {
  server.kill();
  vite.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
