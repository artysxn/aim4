// Run: node server/replays/ingest.test.js
//
// Drives the real HTTP route the browser uses: upload a .zip over the wire,
// then poll the batch the way the progress bar does. The parser is not
// installed on every dev box and these fixtures are not real CS2 demos, so the
// parse itself is expected to fail. That is the point of the assertions here:
// the pipeline has to unpack correctly, report honestly, and clean up after
// itself even when parsing does not work.

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-ingest-'));
process.env.AIM4_REPLAY_DIR = ROOT;
process.env.AIM4_PARSE_ATTEMPTS = '1'; // no point retrying a fixture

// Uploads are account-gated, so this drives the real verification path against
// a stub that speaks Supabase's /auth/v1/user.
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

/** Every call the browser makes carries the session token; so does this one. */
const authed = (url, init = {}) =>
  fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${TOKEN}` }
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handleReplayRequest(req, res, url)) return;
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- build a zip with two demos and three pieces of junk --------------------

const TMP = path.join(ROOT, 'fixtures');
await fsp.mkdir(TMP, { recursive: true });
const demoBytes = (seed) => {
  const b = Buffer.alloc(128 * 1024);
  for (let i = 0; i < b.length; i++) b[i] = (i * seed) % 251;
  return Buffer.concat([Buffer.from('PBDEMS2\0'), b]);
};
await fsp.writeFile(path.join(TMP, 'match1.dem'), demoBytes(7));
await fsp.writeFile(path.join(TMP, 'match2.dem'), demoBytes(13));
await fsp.writeFile(path.join(TMP, 'readme.txt'), 'junk');
await fsp.writeFile(path.join(TMP, 'screenshot.jpg'), Buffer.alloc(2048, 3));
await fsp.writeFile(path.join(TMP, 'autoexec.cfg'), 'cl_crosshairsize 2');

const zipPath = path.join(ROOT, 'bundle.zip');
try {
  execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: TMP });
} catch {
  console.log('ingest: skipped (no zip binary)');
  server.close();
  await fsp.rm(ROOT, { recursive: true, force: true });
  process.exit(0);
}

// ---- upload it exactly the way the client does ------------------------------

const zip = await fsp.readFile(zipPath);
const upload = await fetch(`${base}/api/replays/demos`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/octet-stream',
    'X-Aim4-Filename': 'bundle.zip',
    Authorization: `Bearer ${TOKEN}`,
    'X-Aim4-Visibility': 'unlisted'
  },
  body: zip
});
assert(upload.status === 202, `upload should be accepted immediately, got ${upload.status}`);
const { batch } = await upload.json();
assert(batch?.id, 'a batch id comes back');
assert(batch.stage === 'unpacking', `first stage is unpacking, got ${batch.stage}`);
console.log('  upload accepted (202) before unpacking started');

// ---- poll the batch the way the progress bar does ---------------------------

let last = null;
for (let i = 0; i < 200; i++) {
  const res = await fetch(`${base}/api/replays/uploads/${batch.id}`);
  assert(res.status === 200, `batch poll returned ${res.status}`);
  last = (await res.json()).batch;
  if (last.stage === 'done' || last.stage === 'error') break;
  await new Promise((r) => setTimeout(r, 50));
}
assert(last, 'batch was polled');
assert(last.totals.files === 2, `expected 2 demos in the batch, got ${last.totals.files}`);
assert(last.totals.unpacked === 2, `both demos should unpack, got ${last.totals.unpacked}`);
const names = last.files.map((f) => f.name).sort();
assert(names.join(',') === 'match1.dem,match2.dem', `batch files: ${names.join(', ')}`);
console.log(`  batch reported ${last.totals.files} demos unpacked, junk ignored`);

// ---- the junk was never stored ---------------------------------------------

{
  const demosDir = path.join(ROOT, 'local', 'demos');
  const stored = await fsp.readdir(demosDir).catch(() => []);
  const junk = stored.filter((f) => /\.(txt|jpg|cfg|zip)$/i.test(f));
  assert(junk.length === 0, `junk reached storage: ${junk.join(', ')}`);
  console.log('  no junk in the demo directory');
}

// ---- the archive and the extracted .dem files are gone ----------------------

{
  const left = await fsp.readdir(ROOT);
  const tmpLeft = left.filter((f) => f.startsWith('.upload-'));
  assert(tmpLeft.length === 0, `temp upload left behind: ${tmpLeft.join(', ')}`);

  const demosDir = path.join(ROOT, 'local', 'demos');
  const dems = (await fsp.readdir(demosDir).catch(() => [])).filter((f) => f.endsWith('.dem'));
  assert(dems.length === 0, `source .dem files were not deleted: ${dems.join(', ')}`);
  console.log('  archive and extracted .dem files deleted');
}

// ---- a failed parse is reported, not swallowed ------------------------------

{
  assert(last.stage === 'error' || last.stage === 'done', `batch settled, got ${last.stage}`);
  const listed = await (await authed(`${base}/api/replays/demos`)).json();
  assert(listed.demos.length === 2, `library lists both demos, got ${listed.demos.length}`);
  for (const d of listed.demos) {
    assert(d.status === 'error', `fixture demo should fail to parse, got ${d.status}`);
    assert(d.error, 'a failed demo carries an error message');
  }
  for (const d of listed.demos) {
    assert(d.owner?.username === 'tester', `upload is credited to its uploader: ${d.owner?.username}`);
    assert(d.owner?.visibility === 'unlisted', `visibility is stored: ${d.owner?.visibility}`);
  }
  const anonView = await (await fetch(`${base}/api/replays/demos`)).json();
  assert(anonView.demos.length === 0, 'an unlisted upload is not browsable signed out');
  console.log('  both fixtures reported as failed parses with a reason');
  console.log('  uploads carry their uploader and stay out of the signed-out library');
}

// ---- an upload that unpacks to nothing must say so --------------------------

{
  // The regression this guards: a batch that fails before identifying any file
  // has no per-file outcomes, so counting only files reported "nothing
  // succeeded and nothing failed" and the UI printed "Upload complete." over
  // the top of the real error. The reason has to survive on the batch.
  const res = await authed(`${base}/api/replays/demos`, {
    method: 'POST',
    headers: { 'X-Aim4-Filename': 'cs2-demos.rar' },
    body: Buffer.alloc(4096, 7)
  });
  assert(res.status === 202, `upload accepted before unpacking, got ${res.status}`);
  const { batch } = await res.json();

  let settled = null;
  for (let i = 0; i < 100; i++) {
    settled = (await (await fetch(`${base}/api/replays/uploads/${batch.id}`)).json()).batch;
    if (settled.stage === 'done' || settled.stage === 'error') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(settled.stage === 'error', `unreadable archive settles as error, got ${settled.stage}`);
  assert(settled.totals.files === 0, 'no files were identified');
  assert(settled.totals.parsed === 0 && settled.totals.failed === 0, 'no per-file outcomes exist');
  // With no per-file outcomes, this is the ONLY thing the client can report.
  assert(settled.error && settled.error.length > 10, `batch carries a reason: ${settled.error}`);
  console.log(`  failed unpack carries its reason on the batch: "${settled.error.slice(0, 60)}…"`);
}

// ---- refusals ---------------------------------------------------------------

{
  const res = await authed(`${base}/api/replays/demos`, {
    method: 'POST',
    headers: { 'X-Aim4-Filename': 'notes.txt' },
    body: Buffer.from('nope')
  });
  assert(res.status === 400, `a .txt upload should be refused, got ${res.status}`);
  const missing = await fetch(`${base}/api/replays/uploads/deadbeef`);
  assert(missing.status === 404, 'unknown batch is a 404');
  console.log('  unsupported extension and unknown batch refused');
}

server.close();
authStub.close();
await fsp.rm(ROOT, { recursive: true, force: true });
console.log('ingest: all assertions passed');
