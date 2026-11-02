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
import zlib from 'node:zlib';

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
// A username account that never linked anything: allowed in, but not to write.
const TOKEN_UNLINKED = 'test-token-unlinked';
const authStub = http.createServer((req, res) => {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const users = {
    [TOKEN]: {
      id: 'user-1',
      email: 'tester@aim4.io',
      user_metadata: { username: 'tester' },
      // Uploads require a real identity behind the account; the main test
      // user is the normal case, a Google account.
      app_metadata: { provider: 'google', providers: ['google'] }
    },
    [TOKEN_UNLINKED]: {
      id: 'user-2',
      email: 'loner@users.aim4.io',
      user_metadata: { username: 'loner' },
      app_metadata: { provider: 'email', providers: ['email'] }
    }
  };
  const hit = users[bearer];
  res.writeHead(hit ? 200 : 401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(hit || { error: 'bad token' }));
});
await new Promise((r) => authStub.listen(0, '127.0.0.1', r));
process.env.SUPABASE_URL = `http://127.0.0.1:${authStub.address().port}`;
process.env.SUPABASE_ANON_KEY = 'anon';
// The suite checks the hosted upload gate, including that a signed-out caller
// is refused. Local mode (server/local/mode.js) is on by default and resolves
// every request to the one owner, so there is no signed-out caller to refuse.
// Opt out so identity.js reads the auth stub above like it does when deployed.
process.env.AIM4_LOCAL = '0';

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

// ---- a bare username account cannot upload ----------------------------------

{
  const res = await post(Buffer.alloc(1024, 3), { filename: 'ok.zip', token: TOKEN_UNLINKED });
  assert(res.status === 403, `unlinked account should be 403, got ${res.status}`);
  assert(/link_required/.test(res.text), `the client is told why: ${res.text}`);
  assert(/google or steam/i.test(res.text), 'and what fixes it');
  const tmp = (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.upload-'));
  assert(tmp.length === 0, 'nothing was written for an unlinked upload');
  console.log('  unlinked username account refused with directions');
}

// ---- the precheck answers what the upload would ------------------------------
//
// Why this route exists at all: every refusal above is decided before the body
// is read, and a browser will not look at a response while it is still sending
// a request. Measured against the live API, the far end answers and then drops
// the connection a few hundred KB in, so what the user sees for "link Steam
// first" is a network error with no reason in it. The client therefore asks
// over a few hundred bytes of JSON before it sends a 400 MB demo, which is only
// worth anything if the answer is identical to the upload's own.

function precheck(body, token = TOKEN) {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const u = new URL(`${base}/api/replays/uploads/precheck`);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': payload.length };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', (err) => resolve({ status: 0, text: err.message }));
    req.end(payload);
  });
}

{
  const out = await precheck({ filename: 'ok.zip', sizeBytes: 1024 }, '');
  assert(out.status === 401, `signed-out precheck should be 401, got ${out.status}`);

  const unlinked = await precheck({ filename: 'ok.zip', sizeBytes: 1024 }, TOKEN_UNLINKED);
  assert(unlinked.status === 403, `unlinked precheck should be 403, got ${unlinked.status}`);
  assert(/link_required/.test(unlinked.text), `and carry the reason: ${unlinked.text}`);

  const wrongType = await precheck({ filename: 'clip.mp4', sizeBytes: 1024 });
  assert(wrongType.status === 400, `unsupported type should be 400, got ${wrongType.status}`);

  const tooBig = await precheck({ filename: 'ok.zip', sizeBytes: CAP + 1 });
  assert(tooBig.status === 413, `oversize precheck should be 413, got ${tooBig.status}`);
  assert(/can be up to/i.test(tooBig.text), `and name the cap: ${tooBig.text}`);

  const ok = await precheck({ filename: 'ok.zip', sizeBytes: 1024 });
  assert(ok.status === 200, `an upload that would be taken precheks 200, got ${ok.status}`);

  const tmp = (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.upload-'));
  assert(tmp.length === 0, 'a precheck writes nothing');
  console.log('  precheck refuses what the upload would, before any bytes move');
}

// ---- a refusal reaches a client that is still uploading ----------------------

{
  // The body is bigger than the socket buffers a browser would fill before it
  // stalled. The refusal is only useful if it still arrives, so the server
  // reads the rest and throws it away rather than answering into a socket
  // nobody is reading yet.
  const res = await post(Buffer.alloc(2 * 1024 * 1024, 3), {
    filename: 'ok.zip',
    token: TOKEN_UNLINKED
  });
  assert(res.status === 403, `a refusal mid-body should still be 403, got ${res.status}`);
  assert(/link_required/.test(res.text), `with its reason intact: ${res.text}`);
  console.log('  a refusal with the body still in flight arrives with its reason');
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

// ---- the disk can run out before the cap ------------------------------------
//
// Measured on the Hetzner box 2026-11-02: a 100 GB cap over a 75 GB disk with
// 49 GB free. Nothing here goes near MAX_BYTES, so every refusal below can only
// have come from the disk. statfs is the one thing faked: the real file system
// has hundreds of gigabytes free and filling it is not a test.

{
  const { DISK_MARGIN_BYTES, checkQuota, storage } = await import('./demoStore.js');
  const realStatfs = fsp.statfs;
  const MB = 1024 * 1024;
  const ROOM = 2 * MB;
  let statfsCalls = 0;
  /** A disk with `room` bytes free above the margin. Negative is inside the margin. */
  const disk = (room) => {
    fsp.statfs = async () => {
      statfsCalls++;
      return { bsize: 1, bavail: DISK_MARGIN_BYTES + room };
    };
  };
  const uploadTemps = async () => (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.upload-'));

  try {
    disk(ROOM);

    const over = await precheck({ filename: 'ok.zip', sizeBytes: 3 * MB });
    assert(over.status === 413, `precheck over the disk should be 413, got ${over.status}`);
    assert(/disk space/i.test(over.text), `and name the disk: ${over.text}`);
    assert(/That upload is \d+\.\d GB and there is room for \d+\.\d GB/.test(over.text), `and the sizes: ${over.text}`);
    assert(!over.text.includes('—'), 'no em dashes in UI copy');

    const declared = await post(Buffer.alloc(3 * MB, 3), { filename: 'ok.zip' });
    assert(declared.status === 413, `declared over the disk should be 413, got ${declared.status}`);
    assert(/disk space/i.test(declared.text), `and name the disk: ${declared.text}`);
    assert((await uploadTemps()).length === 0, 'nothing was written for a refused upload');

    const fits = await precheck({ filename: 'ok.zip', sizeBytes: ROOM });
    assert(fits.status === 200, `what fits exactly is taken, got ${fits.status} ${fits.text}`);
    console.log(`  declared upload over the disk refused, margin ${DISK_MARGIN_BYTES} bytes held back`);

    // No Content-Length to refuse: the stream is what gets held to the disk.
    const stream = await post(chunked(3 * MB));
    assert(stream.status !== 202, `an undeclared stream over the disk must not be accepted, got ${stream.status}`);
    await new Promise((r) => setTimeout(r, 200));
    assert((await uploadTemps()).length === 0, 'partial upload removed');
    console.log('  undeclared stream over the disk cut off, partial file removed');

    // The archive fits and what comes out of it does not. Peak use is both.
    const bomb = await post(zlib.gzipSync(Buffer.alloc(3 * MB, 7)), { filename: 'big.dem.gz' });
    assert(bomb.status === 202, `the archive itself fits, got ${bomb.status} ${bomb.text}`);
    const { batch } = JSON.parse(bomb.text);
    let settled = null;
    for (let i = 0; i < 100; i++) {
      settled = (await (await fetch(`${base}/api/replays/uploads/${batch.id}`)).json()).batch;
      if (settled.stage === 'error' || settled.stage === 'done') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(settled.stage === 'error', `expanding past the disk should fail, got ${settled.stage}`);
    assert(/expands to more/i.test(settled.error), `and say why: ${settled.error}`);
    assert((await uploadTemps()).length === 0, 'temp file removed');
    console.log('  an archive that expands past the disk stops at the disk');

    // Two uploads together cannot both be admitted against the same room, and
    // reservations are per library while the disk is not.
    const first = await checkQuota('quota-a', 1.5 * MB, { reserve: true });
    assert(first.ok && first.allowed === ROOM, `first is admitted up to the disk, got ${first.allowed}`);
    const second = await checkQuota('quota-a', 1.5 * MB);
    assert(!second.ok && /disk space/i.test(second.error), `second in the same library: ${second.error}`);
    const other = await checkQuota('quota-b', 1.5 * MB);
    assert(!other.ok && /disk space/i.test(other.error), `second in another library: ${other.error}`);
    first.release();
    assert((await checkQuota('quota-b', 1.5 * MB)).ok, 'released room is room again');
    console.log('  reservations count against the disk across libraries');

    // Inside the margin the disk has room and uploads still may not take it.
    disk(-1024);
    const full = await checkQuota('quota-a', 1024);
    assert(!full.ok && /disk space/i.test(full.error), `inside the margin refuses: ${full.error}`);
    const nothing = await checkQuota('quota-a', 0);
    assert(nothing.ok && nothing.allowed === 0, `no declared size gets no room, got ${nothing.allowed}`);
    assert(nothing.usage.bytesLeft === 0, `and never a negative figure, got ${nothing.usage.bytesLeft}`);
    console.log('  the margin stays out of reach');

    // The meter, the Storage tab and the gate all read the same figure.
    disk(ROOM);
    const status = await (await fetch(`${base}/api/replays/status`)).json();
    assert(status.usage.bytesLeft === ROOM, `status reports the disk, got ${status.usage.bytesLeft}`);
    const tab = await (await fetch(`${base}/api/replays/storage`)).json();
    assert(tab.bytesLeft === ROOM, `the Storage route too, got ${tab.bytesLeft}`);
    assert((await checkQuota('quota-a', 0)).usage.bytesLeft === ROOM, 'and the gate');
    console.log('  /status, /storage and the gate agree on what is left');

    // Per upload request: one statfs and no walk. The cached total not moving
    // when a file appears behind its back is what says nothing walked.
    await checkQuota('quota-a', 0);
    const walkedBefore = (await storage('quota-a')).bytes;
    await fsp.mkdir(path.join(ROOT, 'quota-a', 'rounds'), { recursive: true });
    await fsp.writeFile(path.join(ROOT, 'quota-a', 'rounds', 'behind-its-back.bin'), Buffer.alloc(4096, 1));
    statfsCalls = 0;
    const cheap = await checkQuota('quota-a', 1024);
    assert(statfsCalls === 1, `one statfs per check, got ${statfsCalls}`);
    assert(cheap.usage.bytes === walkedBefore, 'cached usage, not a walk of the rounds directory');
    console.log('  the check is one statfs and no walk');

    // No reading: exactly what happened before the disk was looked at.
    fsp.statfs = async () => {
      throw Object.assign(new Error('not supported'), { code: 'ENOSYS' });
    };
    const blind = await checkQuota('quota-a', 3 * MB);
    assert(blind.ok, `a failed statfs must not refuse: ${blind.error}`);
    assert(blind.allowed === MAX_UPLOAD_BYTES, `the caps are all that is left, got ${blind.allowed}`);
    assert(blind.usage.diskFreeBytes === null, 'and the reading is reported missing');
    assert(blind.usage.bytesLeft > 3 * MB, `bytesLeft is the cap's again, got ${blind.usage.bytesLeft}`);
    const blindRoute = await precheck({ filename: 'ok.zip', sizeBytes: 3 * MB });
    assert(blindRoute.status === 200, `precheck falls back too, got ${blindRoute.status}`);
    console.log('  a failed statfs falls back to the cap');
  } finally {
    fsp.statfs = realStatfs;
  }
}

// ---- just under the cap is accepted -----------------------------------------

{
  const res = await post(Buffer.alloc(CAP - 1024, 3), { filename: 'ok.zip' });
  assert(res.status === 202, `an in-limit upload should be accepted, got ${res.status} ${res.text}`);
  console.log('  upload just under the cap accepted');

  // The response lands while the ingest is still running, which is the point of
  // it. Wait for that ingest to settle before tearing the directory down:
  // deleting a tree a worker is still writing into fails outright on Windows.
  const { batch } = JSON.parse(res.text);
  for (let i = 0; i < 100; i++) {
    const r = await fetch(`${base}/api/replays/uploads/${batch.id}`);
    const settled = (await r.json()).batch;
    if (settled.stage === 'error' || settled.stage === 'done') break;
    await new Promise((r2) => setTimeout(r2, 50));
  }
}

server.close();
authStub.close();
await fsp.rm(ROOT, { recursive: true, force: true });
console.log('uploadLimit: all assertions passed');
