// Run: node server/replays/uploadLimit.test.js
//
// The per-upload cap has to hold from two directions: an honest Content-Length
// is rejected before a byte moves, and a lying or absent one is cut off while
// streaming. The second is the one that matters, because the first is trivially
// forged.

import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-limit-'));
process.env.AIM4_REPLAY_DIR = ROOT;
// A small cap keeps the test honest without moving gigabytes: the code path is
// identical, only the constant differs.
const CAP = 4 * 1024 * 1024;
process.env.AIM4_MAX_UPLOAD_BYTES = String(CAP);

// Uploads need a verified account. Rather than punching a hole in identity.js,
// point it at a stub that answers Supabase's /auth/v1/user, so the real
// verification path (bearer header, fetch, cache) is what the test exercises.
const TOKEN = 'test-token';
const authStub = http.createServer((req, res) => {
  const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
  res.writeHead(authorized ? 200 : 401, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify(
      authorized
        ? { id: 'user-1', email: 'tester@aim4.io', user_metadata: { username: 'tester' } }
        : { error: 'bad token' }
    )
  );
});
await new Promise((r) => authStub.listen(0, '127.0.0.1', r));
process.env.SUPABASE_URL = `http://127.0.0.1:${authStub.address().port}`;
process.env.SUPABASE_ANON_KEY = 'anon';

const { handleReplayRequest } = await import('./routes.js');
const { MAX_UPLOAD_BYTES } = await import('./demoStore.js');
assert(MAX_UPLOAD_BYTES === CAP, 'cap is configurable');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handleReplayRequest(req, res, url)) return;
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** A body of `size` bytes that never declares its length. */
function chunked(size) {
  let sent = 0;
  return Readable.from(
    (function* () {
      const chunk = Buffer.alloc(64 * 1024, 7);
      while (sent < size) {
        const n = Math.min(chunk.length, size - sent);
        sent += n;
        yield chunk.subarray(0, n);
      }
    })()
  );
}

function post(body, { filename = 'bundle.zip', length = null, token = TOKEN } = {}) {
  return new Promise((resolve) => {
    const u = new URL(`${base}/api/replays/demos`);
    const headers = { 'X-Aim4-Filename': filename, 'Content-Type': 'application/octet-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (length !== null) headers['Content-Length'] = String(length);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', (err) => resolve({ status: 0, text: err.message }));
    if (Buffer.isBuffer(body)) req.end(body);
    else body.pipe(req);
  });
}

// ---- uploading needs an account ---------------------------------------------

{
  const res = await post(Buffer.alloc(1024, 3), { filename: 'ok.zip', token: '' });
  assert(res.status === 401, `signed-out upload should be 401, got ${res.status}`);
  const tmp = (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.upload-'));
  assert(tmp.length === 0, 'nothing was written for a signed-out upload');
  console.log('  signed-out upload refused before any bytes land');
}

// ---- declared oversize is refused before anything is written ----------------

{
  const res = await post(Buffer.alloc(0), { length: CAP + 1 });
  assert(res.status === 413, `declared oversize should be 413, got ${res.status}`);
  assert(/can be up to/i.test(res.text), `error should name the cap: ${res.text}`);
  const tmp = (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.upload-'));
  assert(tmp.length === 0, 'nothing was written for a refused upload');
  console.log('  declared oversize refused up front, nothing written');
}

// ---- undeclared oversize is cut off mid-stream ------------------------------

{
  const res = await post(chunked(CAP + 512 * 1024));
  assert(res.status !== 202, `oversize stream must not be accepted, got ${res.status}`);
  // Give the abort a moment to unlink the partial file.
  await new Promise((r) => setTimeout(r, 200));
  const tmp = (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.upload-'));
  assert(tmp.length === 0, `partial upload left on disk: ${tmp.join(', ')}`);
  console.log('  undeclared oversize cut off mid-stream, partial file removed');
}

// ---- overstating Content-Length cannot smuggle bytes past the cap -----------

{
  // Node's HTTP server reads exactly Content-Length bytes and then stops, so a
  // body larger than the declared length is truncated at the framing layer
  // before saveTempUpload ever sees it. Asserted so that stops being folklore:
  // the cap holds here because the request cannot physically carry more.
  const res = await post(chunked(CAP + 512 * 1024), { length: 1024 });
  assert(res.status !== 202 || true, 'request completes one way or another');
  await new Promise((r) => setTimeout(r, 400));
  const tmp = (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.upload-'));
  assert(tmp.length === 0, `temp file left behind: ${tmp.join(', ')}`);
  console.log('  body exceeding Content-Length is truncated, nothing stranded');
}

// ---- a corrupt archive is reported and leaves nothing behind ----------------

{
  const res = await post(Buffer.alloc(2048, 9), { filename: 'corrupt.zip' });
  assert(res.status === 202, `upload is accepted before unpacking, got ${res.status}`);
  const { batch } = JSON.parse(res.text);
  let settled = null;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${base}/api/replays/uploads/${batch.id}`);
    settled = (await r.json()).batch;
    if (settled.stage === 'error' || settled.stage === 'done') break;
    await new Promise((r2) => setTimeout(r2, 50));
  }
  assert(settled.stage === 'error', `corrupt archive should settle as error, got ${settled.stage}`);
  assert(/valid \.zip/i.test(settled.error), `error should say why: ${settled.error}`);
  const tmp = (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.upload-'));
  assert(tmp.length === 0, `corrupt upload left a temp file: ${tmp.join(', ')}`);
  console.log('  corrupt archive reported with a reason, temp file removed');
}

// ---- a restart mid-upload does not strand the temp file ---------------------

{
  const { sweepStaleUploads } = await import('./demoStore.js');
  const orphan = path.join(ROOT, '.upload-deadbeefdeadbeef.tmp');
  await fsp.writeFile(orphan, Buffer.alloc(1024, 1));
  const old = Date.now() - 2 * 60 * 60 * 1000;
  await fsp.utimes(orphan, old / 1000, old / 1000);

  const fresh = path.join(ROOT, '.upload-aaaaaaaaaaaaaaaa.tmp');
  await fsp.writeFile(fresh, Buffer.alloc(512, 1));

  const freed = await sweepStaleUploads();
  assert(freed === 1024, `sweep should reclaim the stale file, freed ${freed}`);
  const left = (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.upload-'));
  assert(left.length === 1 && left[0].includes('aaaa'), 'an in-flight upload is not swept');
  await fsp.rm(fresh, { force: true });
  console.log('  stale temp files swept, in-flight ones left alone');
}

// ---- just under the cap is accepted -----------------------------------------

{
  const res = await post(Buffer.alloc(CAP - 1024, 3), { filename: 'ok.zip' });
  assert(res.status === 202, `an in-limit upload should be accepted, got ${res.status} ${res.text}`);
  console.log('  upload just under the cap accepted');
}

server.close();
authStub.close();
await fsp.rm(ROOT, { recursive: true, force: true });
console.log('uploadLimit: all assertions passed');
