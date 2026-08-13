// Run: node tools/sim-lab.test.js
//
// The lab is loopback-only and must refuse a non-local socket even if someone
// later binds it wrong. The HTML file has to exist, because the launcher
// serves that file rather than a generated string.

import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-simlab-'));
process.env.AIM4_REPLAY_DIR = ROOT;
if (!process.env.AIM4_SIM_WORKERS) process.env.AIM4_SIM_WORKERS = '1';

const { handleLabRequest } = await import('./sim-lab.mjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

{
  await fsp.access(path.join(__dirname, 'sim-lab.html'));
}

function fakeReq(url, { method = 'GET', ip = '127.0.0.1', body = null } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    url,
    socket: { remoteAddress: ip },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    }
  };
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end(buf) {
      this.body = buf ? String(buf) : '';
    }
  };
}

{
  const res = fakeRes();
  await handleLabRequest(fakeReq('/api/status', { ip: '8.8.8.8' }), res);
  assert(res.status === 403, `non-loopback is refused (${res.status})`);
}

{
  const res = fakeRes();
  await handleLabRequest(fakeReq('/api/status'), res);
  assert(res.status === 200, 'loopback status answers');
  const body = JSON.parse(res.body);
  assert(body.host && typeof body.host.heavyJobs === 'boolean', 'with host');
  assert(Array.isArray(body.maps), 'and maps');
}

{
  const res = fakeRes();
  await handleLabRequest(fakeReq('/api/demos'), res);
  assert(res.status === 200, 'demos list answers');
  assert(Array.isArray(JSON.parse(res.body).demos), 'as an array');
}

{
  const res = fakeRes();
  await handleLabRequest(fakeReq('/'), res);
  assert(res.status === 200, 'the overview page is served');
  assert(/Sim lab/.test(res.body), 'and is the lab html');
}

{
  const res = fakeRes();
  await handleLabRequest(
    fakeReq('/api/jobs', { method: 'POST', body: JSON.stringify({ kind: 'extract', params: {} }) }),
    res
  );
  assert(res.status === 409, 'extract without demos is refused');
  assert(/demos/.test(JSON.parse(res.body).error), 'and says why');
}

{
  const res = fakeRes();
  await handleLabRequest(
    fakeReq('/api/jobs', { method: 'POST', body: JSON.stringify({ kind: 'not-a-kind' }) }),
    res
  );
  assert(res.status === 409, 'unknown job kinds are refused');
}

{
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert(addr.address === '127.0.0.1', 'listen example is loopback');
  server.close();
}

console.log('sim-lab: ok');
