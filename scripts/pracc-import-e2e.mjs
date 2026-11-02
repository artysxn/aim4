// Run: node scripts/pracc-import-e2e.mjs <path to a real .dem.bz2>
//
// The successful half of server/replays/praccImport.test.js, which needs a real
// demo and so stays out of `npm test`: route, download, unpack, the real parse
// worker, the record, and the temp files gone. Runs in a temp library on no fixed
// port, so it cannot touch server/data or the API a desktop app is proxying.
//
// PRACC's storage host is still played locally: a signed link is the one thing
// this has no way to make. Everything from the socket up is the code that runs in
// production. Needs a bz2 tool on PATH (bsdcat, bzip2 or unar).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error('Usage: node scripts/pracc-import-e2e.mjs <path to a real .dem.bz2>');
  process.exit(2);
}

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-pracc-e2e-'));
process.env.AIM4_REPLAY_DIR = ROOT;
// Local mode resolves every request to the one owner, so no auth stub is needed.
process.env.AIM4_LOCAL = '1';

const { handleReplayRequest } = await import('../server/replays/routes.js');
const { _setPraccDeps } = await import('../server/replays/praccImport.js');
const store = await import('../server/replays/demoStore.js');

const { size } = await fsp.stat(source);
const id = path.basename(source).replace(/\.dem\.bz2$/i, '');
let fetches = 0;

/** deps.request: the response a storage host would give, off the local file. */
function localStorageHost(url) {
  fetches++;
  const res = Readable.from(fs.createReadStream(source));
  res.statusCode = 200;
  res.headers = { 'content-length': String(size) };
  console.log(`  storage host asked for ${url.hostname}${url.pathname}`);
  return Promise.resolve(res);
}
_setPraccDeps({ request: localStorageHost, pollMs: 250 });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handleReplayRequest(req, res, url)) return;
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const link = `https://fsn1.your-objectstorage.com/pracc-demos/scrims/teams/1/${id}/${id}.dem.bz2?X-Amz-Expires=3600&X-Amz-Signature=test`;
const post = async () => {
  const res = await fetch(`${base}/api/replays/pracc/imports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ demos: [{ uid: 'e2e', url: link, label: 'E2E vs Test' }] })
  });
  return { status: res.status, body: await res.json() };
};

function check(cond, label) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) process.exitCode = 1;
}

const started = Date.now();
const first = await post();
check(first.status === 202, `POST answers 202 (${first.status})`);

let last = '';
let finished = null;
while (!finished) {
  const poll = await (await fetch(`${base}/api/replays/pracc/imports/${first.body.request.id}`)).json();
  const demo = poll.request.demos[0];
  const line = `${demo.state}${demo.rounds ? ` round ${demo.round}/${demo.rounds}` : ''}`;
  if (line !== last) console.log(`  ${((Date.now() - started) / 1000).toFixed(0)}s ${line}`);
  last = line;
  if (poll.request.done) finished = demo;
  else await new Promise((r) => setTimeout(r, 500));
}
console.log(`  finished in ${((Date.now() - started) / 1000).toFixed(0)}s: ${JSON.stringify(finished)}`);
check(finished.state === 'done', 'the demo went all the way through');

const user = store.userKey('local');
const record = finished.demoIds?.[0] ? await store.readRecord(user, finished.demoIds[0]) : null;
check(record?.status === 'ready' || record?.rounds?.length > 0, `record is ready: ${record?.map} ${record?.team1?.name} vs ${record?.team2?.name}`);
check(record?.rounds?.length > 0, `rounds kept: ${record?.rounds?.length}`);
check(record?.filename === `${id}.dem`, `filename: ${record?.filename}`);
check(record?.visibility === 'private', `private by default: ${record?.visibility}`);

const leftovers = (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.pracc-') && f.endsWith('.tmp'));
check(!leftovers.length, `no temp archive left (${leftovers.length})`);
const demosDir = path.join(store.userDir(user), 'demos');
const raw = (await fsp.readdir(demosDir).catch(() => [])).filter((f) => f.endsWith('.dem'));
check(!raw.length, `no raw .dem left (${raw.length})`);

const before = fetches;
const second = await post();
check(second.status === 200 && second.body.request.demos[0].state === 'duplicate', 'a second click says it is already there');
check(fetches === before, 'without fetching the file again');

await new Promise((r) => server.close(r));
await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});
console.log(process.exitCode ? 'pracc e2e: FAILED' : 'pracc e2e: passed');
process.exit(process.exitCode || 0);
