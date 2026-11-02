// Run: node server/replays/praccImport.test.js
//
// The route that makes this server fetch an address a client chose. Most of the
// suite is refusals: which links it will not touch, which redirects it will not
// follow, what it does with an answer that is not a demo, and that none of those
// leave anything behind on the volume. The rest is the queue: a demo goes through
// once, a second click costs nothing, and a signed link never comes back out.
//
// PRACC itself is not in the room. Its storage host is played by a local server,
// reached through the one seam deps has for it, so everything above the socket
// (URL checks, redirects, caps, magic bytes, cleanup) is the real code.

import { gzipSync } from 'node:zlib';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-pracc-'));
process.env.AIM4_REPLAY_DIR = ROOT;

// Same stub as uploadLimit.test.js: the real verification path, a fake Supabase.
const TOKEN = 'test-token';
const TOKEN_UNLINKED = 'test-token-unlinked';
const authStub = http.createServer((req, res) => {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const users = {
    [TOKEN]: {
      id: 'user-1',
      email: 'tester@aim4.io',
      user_metadata: { username: 'tester' },
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
process.env.AIM4_LOCAL = '0';

const { handleReplayRequest } = await import('./routes.js');
const {
  PraccImportError,
  _setPraccDeps,
  checkSourceUrl,
  demoSources,
  downloadSource,
  guardedLookup,
  importFilename,
  isPublicAddress,
  queuePraccImports,
  praccRequestStatus,
  sourceKey
} = await import('./praccImport.js');
const { bz2Support, classifyUpload, isAcceptedUpload, unpackUpload } = await import('./archive.js');
const { sniffMagic } = await import('../ingest/hltv/classify.js');
const store = await import('./demoStore.js');

const HOST = 'https://fsn1.your-objectstorage.com';
const DEMO_BYTES = Buffer.concat([Buffer.from('PBDEMS2\0'), Buffer.alloc(4096, 7)]);
const GZ_BYTES = gzipSync(DEMO_BYTES);
const signed = (p) => `${HOST}/pracc-demos/${p}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=deadbeef`;

// ---- the storage host, played locally ---------------------------------------

/** Every path the "host" was asked for, which is how "never contacted" is proved. */
let contacted = [];

const storage = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  contacted.push(p);
  const send = (status, body, headers = {}) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  if (p.endsWith('/redirect-ok')) return send(302, '', { Location: '/pracc-demos/teams/1/RedirectedDemoFileId/RedirectedDemoFileId.dem.gz' });
  if (p.endsWith('/redirect-metadata')) return send(302, '', { Location: 'http://169.254.169.254/latest/meta-data/' });
  if (p.endsWith('/redirect-bucket')) return send(302, '', { Location: `${HOST}/somebody-else/secret.dem` });
  if (p.endsWith('/redirect-host')) return send(302, '', { Location: 'https://evil.example/x.dem' });
  if (p.endsWith('/redirect-http')) return send(302, '', { Location: `http://fsn1.your-objectstorage.com/pracc-demos/x.dem` });
  if (p.endsWith('/redirect-loop')) return send(302, '', { Location: '/pracc-demos/redirect-loop' });
  if (p.endsWith('/expired')) return send(403, '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>');
  if (p.endsWith('/gone')) return send(404, '<Error><Code>NoSuchKey</Code></Error>');
  if (p.endsWith('/down')) return send(503, 'busy');
  if (p.endsWith('/page')) return send(200, '<!doctype html><html><title>Sign in</title></html>', { 'Content-Type': 'text/html' });
  if (p.endsWith('/challenge')) return send(200, '<html><title>Just a moment...</title></html>', { 'Content-Type': 'text/html' });
  if (p.endsWith('/challenge403')) return send(403, '<html><title>Just a moment...</title></html>');
  if (p.endsWith('/junk')) return send(200, Buffer.alloc(2048, 0x41));
  if (p.endsWith('/empty')) return send(200, '');
  if (p.endsWith('/declared-huge')) {
    res.writeHead(200, { 'Content-Length': String(50 * 1024 ** 3) });
    res.flushHeaders();
    setTimeout(() => res.socket?.destroy(), 200);
    return undefined;
  }
  if (p.endsWith('/endless')) {
    // No Content-Length, so only the running count can stop this one.
    res.writeHead(200);
    res.write(GZ_BYTES);
    const filler = Buffer.alloc(64 * 1024, 1);
    const more = () => {
      while (!res.destroyed && res.write(filler));
      if (!res.destroyed) res.once('drain', more);
    };
    more();
    return undefined;
  }
  if (p.endsWith('/truncated')) {
    res.writeHead(200, { 'Content-Length': String(GZ_BYTES.length + 500) });
    res.write(GZ_BYTES);
    setTimeout(() => res.socket.destroy(), 20);
    return undefined;
  }
  return send(200, GZ_BYTES, { 'Content-Length': String(GZ_BYTES.length) });
});
await new Promise((r) => storage.listen(0, '127.0.0.1', r));

/** deps.request with the socket pointed here. Only the address changes. */
function fakeRequest(url) {
  assert(url.protocol === 'https:', `only https may reach the socket, got ${url.href}`);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: storage.address().port, path: url.pathname + url.search },
      resolve
    );
    req.on('error', reject);
  });
}

const tmpFiles = async () => (await fsp.readdir(ROOT)).filter((f) => f.startsWith('.pracc-') && f.endsWith('.tmp'));

async function refusedWith(reason, fn, label) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof PraccImportError, `${label}: threw something else: ${err}`);
    assert(err.reason === reason, `${label}: expected ${reason}, got ${err.reason} (${err.message})`);
    return err;
  }
  throw new Error(`${label}: should have been refused`);
}

// ---- which links it will touch ----------------------------------------------

assert(demoSources().some((s) => s.host === 'fsn1.your-objectstorage.com'), 'the current host is known');

checkSourceUrl(signed('scrims/teams/208805/AbC/AbC.dem.bz2'));
checkSourceUrl('https://23919397ed7c4cdd2bf49a1aacd4db9a.r2.cloudflarestorage.com/scrim-demos/teams/1/a/a.dem.bz2?X-Amz-Signature=x');

const badLinks = [
  ['not a url', 'bad_url'],
  ['', 'bad_url'],
  ['http://fsn1.your-objectstorage.com/pracc-demos/a.dem.bz2', 'bad_url'],
  ['ftp://fsn1.your-objectstorage.com/pracc-demos/a.dem.bz2', 'bad_url'],
  ['file:///etc/passwd', 'bad_url'],
  ['https://user:pw@fsn1.your-objectstorage.com/pracc-demos/a.dem', 'bad_url'],
  ['https://fsn1.your-objectstorage.com:8443/pracc-demos/a.dem', 'bad_url'],
  ['https://127.0.0.1/pracc-demos/a.dem', 'bad_url'],
  ['https://[::1]/pracc-demos/a.dem', 'bad_url'],
  ['https://2130706433/pracc-demos/a.dem', 'bad_url'],
  ['https://169.254.169.254/latest/meta-data/', 'bad_url'],
  ['https://localhost/pracc-demos/a.dem', 'host_not_allowed'],
  ['https://evil.example/pracc-demos/a.dem', 'host_not_allowed'],
  ['https://pracc.com/api/team/server/demos', 'host_not_allowed'],
  // A shared endpoint: the host alone proves nothing.
  ['https://fsn1.your-objectstorage.com/somebody-else/a.dem', 'host_not_allowed'],
  ['https://fsn1.your-objectstorage.com/pracc-demos-not/a.dem', 'host_not_allowed'],
  ['https://fsn1.your-objectstorage.com/pracc-demos/../somebody-else/a.dem', 'host_not_allowed'],
  ['https://fsn1.your-objectstorage.com/pracc-demos/%2e%2e/somebody-else/a.dem', 'host_not_allowed'],
  ['https://fsn1.your-objectstorage.com/pracc-demos/..%2Fsomebody-else/a.dem', 'bad_url'],
  // Lookalikes of a real host.
  ['https://fsn1.your-objectstorage.com.evil.example/pracc-demos/a.dem', 'host_not_allowed'],
  ['https://evil-fsn1.your-objectstorage.com/pracc-demos/a.dem', 'host_not_allowed'],
  ['https://fsn1.your-objectstorage.com./pracc-demos/a.dem', 'host_not_allowed'],
  ['https://fsn1.your-objectstorage.com@evil.example/pracc-demos/a.dem', 'bad_url']
];
for (const [link, reason] of badLinks) {
  await refusedWith(reason, () => checkSourceUrl(link), `"${link}"`);
}

process.env.AIM4_PRACC_DEMO_SOURCES = 'nbg1.your-objectstorage.com/pracc-demos/';
checkSourceUrl('https://nbg1.your-objectstorage.com/pracc-demos/a.dem.bz2');
await refusedWith('host_not_allowed', () => checkSourceUrl('https://nbg1.your-objectstorage.com/other/a.dem'), 'env entry keeps its prefix');
delete process.env.AIM4_PRACC_DEMO_SOURCES;

// ---- which addresses it will connect to -------------------------------------

for (const ip of [
  '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
  '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1',
  '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', 'not an ip', ''
]) {
  assert(!isPublicAddress(ip), `${ip} must not count as public`);
}
for (const ip of ['88.198.0.1', '49.13.197.107', '172.32.0.1', '2a01:4f8:c17:1::1']) {
  assert(isPublicAddress(ip), `${ip} is public`);
}

function lookupThrough(addresses, options = {}) {
  return new Promise((resolve) => {
    guardedLookup(
      'storage.example',
      options,
      (err, address, family) => resolve({ err, address, family }),
      (_host, _opts, cb) => cb(null, addresses)
    );
  });
}
{
  const ok = await lookupThrough([{ address: '88.198.0.1', family: 4 }]);
  assert(!ok.err && ok.address === '88.198.0.1' && ok.family === 4, 'a public name resolves');
  const all = await lookupThrough([{ address: '88.198.0.1', family: 4 }], { all: true });
  assert(Array.isArray(all.address) && all.address.length === 1, 'the all:true form is answered in kind');
  const privateName = await lookupThrough([{ address: '10.0.0.5', family: 4 }]);
  assert(privateName.err?.code === 'EPRACCADDRESS', 'a name pointing inside is refused');
  const mixed = await lookupThrough([{ address: '88.198.0.1', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  assert(mixed.err?.code === 'EPRACCADDRESS', 'one bad answer among good ones is enough');
}

// ---- naming -----------------------------------------------------------------

{
  const url = new URL(signed('scrims/teams/1/BafiXsktRnsUiPXVhxdBLviVJm/BafiXsktRnsUiPXVhxdBLviVJm.dem.bz2'));
  assert(sourceKey(url) === 'BafiXsktRnsUiPXVhxdBLviVJm', 'the key is the storage id');
  assert(importFilename(url, { kind: 'bz2', ext: '.bz2' }) === 'BafiXsktRnsUiPXVhxdBLviVJm.dem.bz2', 'a truthful name stands');
  assert(importFilename(url, { kind: 'gz', ext: '.gz' }).endsWith('.bz2.gz'), 'the bytes outrank the name');
  assert(classifyUpload(importFilename(url, { kind: 'gz', ext: '.gz' })) === 'gz', 'and it classifies by the bytes');
  const opaque = new URL(signed('blob'));
  assert(sourceKey(opaque).length === 32, 'a name with no id in it falls back to a hash of the path');
  assert(importFilename(opaque, { kind: 'bz2', ext: '.bz2' }) === 'blob.bz2', 'an extensionless key gets one');
  const nasty = new URL(signed('a%20b%zz..%5Cc.dem.gz').replace('%5C', '_'));
  assert(!/[\\/ ]/.test(importFilename(nasty, { kind: 'gz', ext: '.gz' })), 'a name cannot carry a path');
}

// ---- bz2 --------------------------------------------------------------------

assert(classifyUpload('a.dem.bz2') === 'bz2', 'bz2 classifies');
assert(isAcceptedUpload('BafiX.dem.bz2'), 'bz2 is accepted');
assert(sniffMagic(Buffer.from('BZh91AY&SY')).kind === 'bz2', 'bz2 is known by its bytes');

// printf 'PBDEMS2\0fake demo body fake demo body fake demo body' | bzip2 -9 | base64
const BZ2_FIXTURE = Buffer.from(
  'QlpoOTFBWSZTWZBSMlMAAAdfgEAAQAAQABYCSAA3CoAgIAAiPVADIMhTTIxMTEm5whGbOls3jaCjjnap46QQXPi7kinChISCkZKY',
  'base64'
);
const BZ2_PLAIN = Buffer.from('PBDEMS2\0fake demo body fake demo body fake demo body');

if (bz2Support().available) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-bz2-'));
  const source = path.join(dir, 'upload.tmp');
  await fsp.writeFile(source, BZ2_FIXTURE);
  const [file] = await unpackUpload({
    source,
    filename: 'BafiXsktRnsUiPXVhxdBLviVJm.dem.bz2',
    allowedBytes: 1024 * 1024,
    targetFor: (name) => path.join(dir, name)
  });
  assert(file.name === 'BafiXsktRnsUiPXVhxdBLviVJm.dem', `one suffix comes off, got ${file.name}`);
  assert((await fsp.readFile(file.path)).equals(BZ2_PLAIN), 'the bytes come back intact');

  // The cap holds while the tool is writing, and takes the half-written file with it.
  await fsp.writeFile(source, BZ2_FIXTURE);
  let capped = null;
  await unpackUpload({
    source,
    filename: 'bomb.dem.bz2',
    allowedBytes: 8,
    targetFor: (name) => path.join(dir, name)
  }).catch((err) => {
    capped = err;
  });
  assert(/available space/.test(capped?.message || ''), `a bz2 past its budget is stopped, got ${capped?.message}`);
  assert(!(await fsp.readdir(dir)).includes('bomb.dem'), 'and leaves nothing behind');

  // Corrupt input is an error, not an empty demo.
  await fsp.writeFile(source, Buffer.from('BZh91AY&SY this is not really bzip2 at all'));
  let corrupt = null;
  await unpackUpload({
    source,
    filename: 'bad.dem.bz2',
    allowedBytes: 1024,
    targetFor: (name) => path.join(dir, name)
  }).catch((err) => {
    corrupt = err;
  });
  assert(/Could not read that \.bz2/.test(corrupt?.message || ''), `corrupt bz2 is named, got ${corrupt?.message}`);
  assert(!(await fsp.readdir(dir)).includes('bad.dem'), 'and leaves nothing behind');
  await fsp.rm(dir, { recursive: true, force: true });
} else {
  console.log('praccImport: no bz2 tool on this host, skipping the bz2 unpack checks');
}

// ---- the download -----------------------------------------------------------

_setPraccDeps({ request: fakeRequest, pollMs: 5 });
const dest = path.join(ROOT, '.pracc-0000000000000000.tmp');
const LIMIT = 1024 * 1024;
const fetchIt = (name, opts = {}) => downloadSource(signed(name), dest, { limit: LIMIT, ...opts });
async function goneAfter(label) {
  assert(!(await tmpFiles()).length, `${label}: left a temp file behind`);
}

{
  let progress = 0;
  const got = await fetchIt('scrims/teams/1/a/a.dem.gz', {
    onProgress: ({ received, total }) => {
      progress = received;
      assert(total === GZ_BYTES.length, 'progress carries the declared size');
    }
  });
  assert(got.bytes === GZ_BYTES.length && got.magic.kind === 'gz', 'an ordinary download lands');
  assert(progress === GZ_BYTES.length, 'progress reaches the end');
  assert((await fsp.readFile(dest)).equals(GZ_BYTES), 'byte for byte');
  await fsp.rm(dest);
}
{
  const got = await fetchIt('redirect-ok');
  assert(got.magic.kind === 'gz', 'a redirect inside the bucket is followed');
  assert(got.url.pathname.endsWith('RedirectedDemoFileId.dem.gz'), 'the name comes from where the file really was');
  await fsp.rm(dest);
}

for (const [name, reason, label] of [
  ['redirect-metadata', 'bad_url', 'redirect to cloud metadata'],
  ['redirect-http', 'bad_url', 'redirect down to http'],
  ['redirect-bucket', 'host_not_allowed', 'redirect to another bucket on the same host'],
  ['redirect-host', 'host_not_allowed', 'redirect to another host'],
  ['redirect-loop', 'bad_url', 'redirect loop'],
  ['expired', 'link_expired', 'expired signature'],
  ['gone', 'missing', '404'],
  ['down', 'source_unavailable', '503'],
  ['page', 'not_a_demo', 'HTML with a 200'],
  ['challenge', 'blocked', 'a bot check with a 200'],
  ['challenge403', 'blocked', 'a bot check with a 403'],
  ['junk', 'not_a_demo', 'bytes that are nothing'],
  ['empty', 'not_a_demo', 'an empty body'],
  ['declared-huge', 'too_large', 'over the cap by its own admission'],
  ['endless', 'too_large', 'over the cap with no length declared'],
  ['truncated', 'source_unavailable', 'a body cut short']
]) {
  contacted = [];
  await refusedWith(reason, () => fetchIt(name), label);
  await goneAfter(label);
  if (name.startsWith('redirect-') && name !== 'redirect-loop') {
    assert(contacted.length === 1, `${label}: the target must never be contacted, saw ${contacted}`);
  }
}

// A name resolving inside the network, as the real socket would report it.
_setPraccDeps({
  request: async () => {
    const err = new Error('storage.example does not resolve to a public address.');
    err.code = 'EPRACCADDRESS';
    throw err;
  }
});
await refusedWith('bad_url', () => fetchIt('a.dem.bz2'), 'a rebinding answer');
await goneAfter('rebinding');

// ---- the routes -------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handleReplayRequest(req, res, url)) return;
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function postImports(body, token = TOKEN) {
  const res = await fetch(`${base}/api/replays/pracc/imports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const until = async (fn, label, ms = 8000) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const pollDone = (id) =>
  until(async () => {
    const res = await fetch(`${base}/api/replays/pracc/imports/${id}`);
    const body = await res.json();
    return body.request?.done ? body.request : null;
  }, `request ${id}`);

/**
 * startIngest with the parser stubbed out: the batch settles the way a real one
 * does, and the record gets written. Whether the real thing parses is the other
 * half of this file, below.
 */
function stubbedIngest(outcome) {
  let n = 0;
  const calls = [];
  return {
    calls,
    startIngest(opts) {
      calls.push(opts);
      const demoId = `demo${String(++n).padStart(12, '0')}`;
      const batch = { id: `batch${n}`, stage: 'unpacking', files: [], finishedAt: null, error: null };
      (async () => {
        await fsp.rm(opts.source, { force: true });
        const result = outcome(opts, demoId);
        batch.files = [{ name: opts.filename, demoId, ...result }];
        batch.stage = 'parsing';
        await store.writeRecord(store.userKey('local'), { id: demoId, status: 'ready', filename: opts.filename.replace(/\.bz2$/, ''), rounds: [] });
        opts.releaseQuota?.();
        batch.finishedAt = Date.now();
      })();
      return batch;
    },
    batchStatus: (batch) => ({ error: batch.error, files: batch.files })
  };
}

{
  const stub = stubbedIngest(() => ({ phase: 'analyzed', failed: false }));
  _setPraccDeps({ request: fakeRequest, startIngest: stub.startIngest, batchStatus: stub.batchStatus, pollMs: 5 });
  const one = { uid: 'u1', url: signed('scrims/teams/1/FirstDemoFileIdentifier/FirstDemoFileIdentifier.dem.gz'), label: 'Fraternity' };

  // Who may ask.
  const anon = await postImports({ demos: [one] }, null);
  assert(anon.status === 401, `signed out is refused, got ${anon.status}`);
  const unlinked = await postImports({ demos: [one] }, TOKEN_UNLINKED);
  assert(unlinked.status === 403 && unlinked.body.reason === 'link_required', 'an unanchored account is sent to Connections');
  contacted = [];

  // What they may ask for.
  assert((await postImports({})).status === 400, 'no demos');
  assert((await postImports({ demos: [] })).status === 400, 'empty list');
  assert((await postImports('{not json')).status === 400, 'not json');
  const tooMany = await postImports({ demos: Array.from({ length: 101 }, () => one) });
  assert(tooMany.status === 400 && /100/.test(tooMany.body.error), 'a request has a size limit');

  const evil = await postImports({ demos: [{ uid: 'e', url: 'https://evil.example/pracc-demos/a.dem' }] });
  assert(evil.status === 400, `every demo refused is a 400, got ${evil.status}`);
  assert(evil.body.request.demos[0].state === 'refused', 'the demo says so');
  assert(evil.body.request.demos[0].reason === 'host_not_allowed', 'and why');
  assert(/evil\.example/.test(evil.body.request.demos[0].error), 'naming the host, so the fix is obvious');
  const metadata = await postImports({ demos: [{ url: 'http://169.254.169.254/latest/meta-data/' }] });
  assert(metadata.status === 400, 'cloud metadata is just another refused link');
  assert(contacted.length === 0, `refused links must not be fetched, saw ${contacted}`);

  // One good demo among bad ones goes through.
  const mixed = await postImports({ demos: [one, { uid: 'bad', url: 'https://evil.example/a.dem' }] });
  assert(mixed.status === 202, `some taken is a 202, got ${mixed.status}`);
  const id = mixed.body.request.id;
  assert(/^[a-f0-9]{32}$/.test(id), 'the request id cannot be guessed');
  const finished = await pollDone(id);
  const [first, bad] = finished.demos;
  assert(first.uid === 'u1' && first.label === 'Fraternity', 'the client can match its row');
  assert(first.state === 'done' && first.demoIds.length === 1, `the good one landed: ${JSON.stringify(first)}`);
  assert(bad.state === 'refused', 'the bad one did not');
  await goneAfter('a finished import');

  // The ingest was handed what a normal upload hands it.
  const call = stub.calls[0];
  assert(call.filename === 'FirstDemoFileIdentifier.dem.gz', `classified by real bytes, got ${call.filename}`);
  assert(call.sizeBytes === GZ_BYTES.length, 'with the real size');
  assert(call.owner.uploaderId === 'user-1' && call.owner.uploaderName === 'tester', 'owned by the caller');
  assert(call.owner.visibility === 'private', 'and private by default');
  assert(call.reserved === 1, 'holding the place in the cap the gate took');

  // Nothing readable gives a signed link back.
  const statusText = await (await fetch(`${base}/api/replays/pracc/imports/${id}`)).text();
  assert(!/X-Amz|deadbeef|objectstorage/.test(statusText), `the link must not come back out: ${statusText}`);
  assert(!/X-Amz|deadbeef/.test(JSON.stringify(mixed.body)), 'not from the POST either');
  const ledgerText = await fsp.readFile(path.join(ROOT, '.pracc-imports.json'), 'utf8');
  assert(!/X-Amz|deadbeef|objectstorage/.test(ledgerText), 'and it is not written down');

  // A second click: no download, no ingest.
  contacted = [];
  const again = await postImports({ demos: [one] });
  assert(again.status === 200 && again.body.request.done, `all known answers at once, got ${again.status}`);
  assert(again.body.request.demos[0].state === 'duplicate', 'and says so');
  assert(contacted.length === 0, 'without touching the host');
  assert(stub.calls.length === 1, 'or the parser');

  // A fresh signature on the same file is still the same demo.
  const resigned = await postImports({ demos: [{ ...one, url: one.url.replace('deadbeef', 'cafef00d') }] });
  assert(resigned.body.request.demos[0].state === 'duplicate', 'links change every hour, demos do not');

  // Delete the demo and it may come back.
  await store.deleteDemo(store.userKey('local'), first.demoIds[0]);
  const back = await postImports({ demos: [one] });
  assert(back.status === 202, `a deleted demo can be imported again, got ${back.status}`);
  const returned = await pollDone(back.body.request.id);
  assert(returned.demos[0].state === 'done', 'and is');

  // Uploaded by hand before this route existed: same file name.
  await store.writeRecord(store.userKey('local'), { id: 'handupload000001', status: 'ready', filename: 'HandUploadedDemoFileId.dem', rounds: [] });
  const byHand = await postImports({ demos: [{ url: signed('t/HandUploadedDemoFileId/HandUploadedDemoFileId.dem.bz2') }] });
  assert(byHand.body.request.demos[0].state === 'duplicate', 'a copy under the same name counts');
  assert(byHand.body.request.demos[0].demoIds[0] === 'handupload000001', 'and is named');

  // A bad id, and an unknown one.
  assert((await fetch(`${base}/api/replays/pracc/imports/nope`)).status === 404, 'unknown request');
}

// ---- failures on the way through --------------------------------------------

{
  const stub = stubbedIngest(() => ({ phase: 'analyzed', failed: false }));
  let released = 0;
  let quotaReleased = 0;
  _setPraccDeps({
    request: fakeRequest,
    startIngest: stub.startIngest,
    batchStatus: stub.batchStatus,
    releaseUploads: (_id, n) => {
      released += n;
    },
    pollMs: 5
  });
  const owner = { uploaderId: 'user-1', uploaderName: 'tester', visibility: 'private' };
  const gate = async () => ({
    refusal: null,
    reserved: 1,
    gate: {
      allowed: 1024 * 1024,
      usage: { bytesLeft: 10 * 1024 * 1024 },
      release: () => {
        quotaReleased++;
      }
    }
  });

  const expired = await queuePraccImports({ user: 'local', owner, gate, demos: [{ uid: 'x', url: signed('LongEnoughFileIdentifier/expired') }] });
  const failed = await until(() => {
    const view = praccRequestStatus(expired.body.request.id);
    return view.done ? view : null;
  }, 'expired link');
  assert(failed.demos[0].state === 'failed' && failed.demos[0].reason === 'link_expired', `the button can act on this: ${JSON.stringify(failed.demos[0])}`);
  assert(released === 1 && quotaReleased === 1, 'a failed download gives back what the gate reserved');
  await goneAfter('an expired link');

  // The plan refusal, in the plan's own words.
  const refused = await queuePraccImports({
    user: 'local',
    owner,
    gate: async () => ({
      refusal: { status: 402, body: { error: 'upgrade_required', message: 'You have reached your limit of 3 demos.' } },
      reserved: 0,
      gate: null
    }),
    demos: [{ uid: 'cap', url: signed('t/OverTheLimitDemoFileId/OverTheLimitDemoFileId.dem.gz') }]
  });
  const capped = await until(() => {
    const view = praccRequestStatus(refused.body.request.id);
    return view.done ? view : null;
  }, 'plan refusal');
  assert(capped.demos[0].state === 'failed' && /limit of 3/.test(capped.demos[0].error), `says why: ${JSON.stringify(capped.demos[0])}`);

  // The same game under another name: parsed, found out, remembered.
  const dupStub = stubbedIngest(() => ({
    phase: 'unpacked',
    failed: true,
    duplicate: true,
    duplicateOf: 'handupload000001',
    error: 'already exists'
  }));
  contacted = [];
  _setPraccDeps({ request: fakeRequest, startIngest: dupStub.startIngest, batchStatus: dupStub.batchStatus, pollMs: 5 });
  const dupKey = signed('t/SameGameOtherFileName01/SameGameOtherFileName01.dem.gz');
  const dup = await queuePraccImports({ user: 'local', owner, gate, demos: [{ url: dupKey }] });
  const dupDone = await until(() => {
    const view = praccRequestStatus(dup.body.request.id);
    return view.done ? view : null;
  }, 'post-parse duplicate');
  assert(dupDone.demos[0].state === 'duplicate', `a parse-time duplicate is a duplicate: ${JSON.stringify(dupDone.demos[0])}`);
  assert(dupDone.demos[0].demoIds[0] === 'handupload000001', 'pointing at the copy that won');
  contacted = [];
  const dupAgain = await queuePraccImports({ user: 'local', owner, gate, demos: [{ url: dupKey }] });
  assert(dupAgain.body.request.demos[0].state === 'duplicate' && contacted.length === 0, 'and is not fetched and parsed again next click');

  // Parse failure.
  const parseStub = stubbedIngest(() => ({ phase: 'unpacked', failed: true, error: 'Not a CS2 demo.' }));
  _setPraccDeps({ request: fakeRequest, startIngest: parseStub.startIngest, batchStatus: parseStub.batchStatus, pollMs: 5 });
  const broken = await queuePraccImports({ user: 'local', owner, gate, demos: [{ url: signed('t/BrokenDemoFileIdentifier/BrokenDemoFileIdentifier.dem.gz') }] });
  const brokenDone = await until(() => {
    const view = praccRequestStatus(broken.body.request.id);
    return view.done ? view : null;
  }, 'parse failure');
  assert(brokenDone.demos[0].reason === 'parse_failed' && /Not a CS2/.test(brokenDone.demos[0].error), 'a failed parse says so');
  const brokenAgain = await queuePraccImports({ user: 'local', owner, gate, demos: [{ url: signed('t/BrokenDemoFileIdentifier/BrokenDemoFileIdentifier.dem.gz') }] });
  assert(brokenAgain.status === 202, 'and is free to be tried again');
  await until(() => praccRequestStatus(brokenAgain.body.request.id).done, 'retry');

  // A map the viewer does not cover fails the same way next click too, so that one
  // is remembered. Saying "unknown" means the parser could not read one, which is
  // not the same thing and stays free to retry.
  const OVERPASS = 'Unsupported map "de_overpass". Replays cover Ancient, Dust2, Inferno, Cache, Mirage, Nuke and Anubis.';
  const mapStub = stubbedIngest(() => ({ phase: 'unpacked', failed: true, error: OVERPASS }));
  _setPraccDeps({ request: fakeRequest, startIngest: mapStub.startIngest, batchStatus: mapStub.batchStatus, pollMs: 5 });
  const overpass = signed('t/OverpassScrimFileIdent/OverpassScrimFileIdent.dem.gz');
  const firstMap = await queuePraccImports({ user: 'local', owner, gate, demos: [{ url: overpass }] });
  const firstMapDone = await until(() => {
    const view = praccRequestStatus(firstMap.body.request.id);
    return view.done ? view : null;
  }, 'unsupported map');
  assert(firstMapDone.demos[0].reason === 'unsupported_map', `named for what it is: ${firstMapDone.demos[0].reason}`);
  contacted = [];
  const secondMap = await queuePraccImports({ user: 'local', owner, gate, demos: [{ url: overpass }] });
  assert(secondMap.status === 200 && secondMap.body.request.done, 'known at once');
  assert(secondMap.body.request.demos[0].reason === 'unsupported_map', 'with the same answer');
  assert(/de_overpass/.test(secondMap.body.request.demos[0].error), 'and the same words');
  assert(contacted.length === 0 && mapStub.calls.length === 1, 'without fetching or parsing it again');

  const unreadStub = stubbedIngest(() => ({ phase: 'unpacked', failed: true, error: 'Unsupported map "unknown". Replays cover Ancient.' }));
  _setPraccDeps({ request: fakeRequest, startIngest: unreadStub.startIngest, batchStatus: unreadStub.batchStatus, pollMs: 5 });
  const unread = signed('t/UnreadableMapFileIdent/UnreadableMapFileIdent.dem.gz');
  const firstUnread = await queuePraccImports({ user: 'local', owner, gate, demos: [{ url: unread }] });
  await until(() => praccRequestStatus(firstUnread.body.request.id).done, 'unreadable map');
  assert(praccRequestStatus(firstUnread.body.request.id).demos[0].reason === 'parse_failed', 'a map it could not read is an ordinary failure');
  const secondUnread = await queuePraccImports({ user: 'local', owner, gate, demos: [{ url: unread }] });
  assert(secondUnread.status === 202, 'and may be tried again');
  await until(() => praccRequestStatus(secondUnread.body.request.id).done, 'unreadable map retry');
}

// ---- the queue --------------------------------------------------------------

{
  // Downloads run ahead of the parser; ingest waits for it. This is what gets a
  // month of demos off one-hour links.
  let depth = 1;
  const stub = stubbedIngest(() => ({ phase: 'analyzed', failed: false }));
  const owner = { uploaderId: 'user-1', uploaderName: 'tester', visibility: 'private' };
  const gate = async () => ({
    refusal: null,
    reserved: 0,
    gate: { allowed: 1024 * 1024, usage: { bytesLeft: 10 * 1024 * 1024 }, release: null }
  });
  _setPraccDeps({
    request: fakeRequest,
    startIngest: stub.startIngest,
    batchStatus: stub.batchStatus,
    parseQueueDepth: () => depth,
    pollMs: 5
  });
  const names = ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCCCCCCCC'];
  const queued = await queuePraccImports({
    user: 'local',
    owner,
    gate,
    demos: names.map((n) => ({ uid: n, url: signed(`t/${n}/${n}.dem.gz`) }))
  });
  assert(queued.status === 202, 'queued');
  const id = queued.body.request.id;
  await until(() => praccRequestStatus(id).demos.every((d) => d.state === 'waiting'), 'all three on disk');
  assert(stub.calls.length === 0, 'and none handed to the parser while it is busy');
  assert((await tmpFiles()).length === 3, 'the compressed files are what is being held');

  depth = 0;
  await until(() => praccRequestStatus(id).done, 'the parse queue freeing up');
  assert(stub.calls.length === 3, 'then they all go through');
  assert(stub.calls.map((c) => c.filename.slice(0, 1)).join('') === 'ABC', 'in the order they were sent');
  await goneAfter('the queue draining');

  // A teammate clicking while it runs joins the work rather than repeating it.
  depth = 1;
  const shared = signed('t/SharedScrimFileIdentifier/SharedScrimFileIdentifier.dem.gz');
  const firstClick = await queuePraccImports({ user: 'local', owner, gate, demos: [{ uid: 'mine', url: shared }] });
  const secondClick = await queuePraccImports({
    user: 'local',
    owner: { uploaderId: 'user-9', uploaderName: 'mate', visibility: 'private' },
    gate,
    demos: [{ uid: 'theirs', url: shared.replace('deadbeef', 'cafef00d') }]
  });
  assert(secondClick.status === 202, 'still in progress');
  depth = 0;
  await until(() => praccRequestStatus(firstClick.body.request.id).done, 'shared demo');
  assert(praccRequestStatus(secondClick.body.request.id).demos[0].uid === 'theirs', 'each click keeps its own row');
  assert(praccRequestStatus(secondClick.body.request.id).demos[0].state === 'done', 'and sees the same result');
  assert(stub.calls.filter((c) => c.filename.startsWith('Shared')).length === 1, 'from one fetch');
}

// ---- through the real ingest ------------------------------------------------

{
  // Real startIngest, real unpack, real parse worker. These bytes are no demo, so
  // the parse fails, and that is the point: the failed path is the one that could
  // strand a file. The successful path needs a 500 MB demo and lives in
  // scripts/pracc-import-e2e.mjs.
  _setPraccDeps({ request: fakeRequest, pollMs: 20 });
  const res = await postImports({ demos: [{ uid: 'real', url: signed('t/RealPipelineFileId0001/RealPipelineFileId0001.dem.gz') }] });
  assert(res.status === 202, `taken, got ${res.status}: ${JSON.stringify(res.body)}`);
  const finished = await until(async () => {
    const body = await (await fetch(`${base}/api/replays/pracc/imports/${res.body.request.id}`)).json();
    return body.request.done ? body.request : null;
  }, 'the real pipeline', 60000);
  assert(finished.demos[0].state === 'failed', `junk does not parse: ${JSON.stringify(finished.demos[0])}`);
  assert(finished.demos[0].reason === 'parse_failed', `and is reported as that: ${finished.demos[0].reason}`);
  await goneAfter('the real pipeline');
  const demosDir = path.join(store.userDir(store.userKey('local')), 'demos');
  const raw = (await fsp.readdir(demosDir).catch(() => [])).filter((f) => f.endsWith('.dem'));
  assert(!raw.length, `the raw demo goes too, found ${raw}`);
}

await new Promise((r) => server.close(r));
await new Promise((r) => storage.close(r));
await new Promise((r) => authStub.close(r));
await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});

console.log('praccImport: all assertions passed');
process.exit(0);
