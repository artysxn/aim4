// The download probe, end to end against a stub server. What matters here:
// every hop lands in the log, a challenge is a stop rather than a retry, the
// downloaded bytes are classified by magic rather than by name, and a finished
// run leaves .aim4replay packages and nothing else. Never touches the network
// beyond loopback; the parse child is stubbed out.

import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { cancelProbe, filenameFromResponse, probeState, sniffMagic, startProbe } from './probe.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-probe-'));
process.env.AIM4_INGEST_STATE_DIR = path.join(tmp, 'state');
process.env.AIM4_INGEST_WORK_DIR = path.join(tmp, 'work');

// ---------------------------------------------------------------------------
// Stub server.
// ---------------------------------------------------------------------------

const FAKE_DEM = Buffer.concat([Buffer.from('PBDEMS2\0'), Buffer.alloc(256, 7)]);
const GZ_BODY = zlib.gzipSync(FAKE_DEM);
const seen = { fileHeaders: null };

const server = http.createServer((req, res) => {
  if (req.url === '/download') {
    res.writeHead(302, { Location: '/files/dl', 'Set-Cookie': 'probe=yes; Path=/' });
    res.end();
    return;
  }
  if (req.url === '/files/dl') {
    seen.fileHeaders = req.headers;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': GZ_BODY.length,
      'Content-Disposition': 'attachment; filename="test-map.dem.gz"'
    });
    res.end(GZ_BODY);
    return;
  }
  if (req.url === '/blocked') {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<html><head><script src="/cdn-cgi/challenge-platform/x.js"></script></head></html>');
    return;
  }
  if (req.url === '/mitigated') {
    res.writeHead(200, { 'cf-mitigated': 'challenge', 'Content-Type': 'text/html' });
    res.end('<html>checking</html>');
    return;
  }
  if (req.url === '/html') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end('<!DOCTYPE html><html><head><title>Demo not found</title></head></html>');
    return;
  }
  res.writeHead(404);
  res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function waitDone(timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const st = await probeState();
    if (!st.running) return st;
    if (Date.now() - t0 > timeoutMs) {
      await cancelProbe();
      throw new Error('probe did not finish in time');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const logHas = (st, re) => st.log.some((l) => re.test(l.text));

// ---------------------------------------------------------------------------
// Unit: magic sniffing and filename extraction.
// ---------------------------------------------------------------------------

{
  assert(sniffMagic(Buffer.from('Rar!\x1a\x07\x01\x00')).kind === 'rar', 'rar magic');
  assert(sniffMagic(Buffer.from('PK\x03\x04....')).kind === 'zip', 'zip magic');
  assert(sniffMagic(GZ_BODY).kind === 'gz', 'gz magic');
  assert(sniffMagic(FAKE_DEM).kind === 'dem', 'cs2 dem magic');
  assert(sniffMagic(Buffer.from('HL2DEMO\0')).kind === 'dem', 'csgo dem magic');
  assert(sniffMagic(Buffer.from('  <!DOCTYPE html><html>')).kind === 'html', 'html sniff');
  assert(sniffMagic(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])).kind === 'unknown', 'unknown sniff');

  const res = new Response(null, {
    headers: { 'content-disposition': 'attachment; filename="a-vs-b.rar"' }
  });
  assert(filenameFromResponse(res, `${BASE}/x/y`) === 'a-vs-b.rar', 'disposition filename');
  const bare = new Response(null);
  assert(filenameFromResponse(bare, `${BASE}/files/demo.zip`) === 'demo.zip', 'url filename');
}

// ---------------------------------------------------------------------------
// Happy path: redirect, cookie carry, gz download, unpack, package, cleanup.
// The parse child is stubbed: this test is about the probe, not the parser.
// ---------------------------------------------------------------------------

{
  const packaged = [];
  const first = await startProbe(`${BASE}/download`, {
    allowPrivate: true,
    packageDemo: async (demoFile, outPath, meta) => {
      packaged.push({ demoFile, outPath, meta });
      await fsp.writeFile(outPath, Buffer.from('AIM4RPLY-fake'));
      return {
        map: 'de_test',
        mapName: 'Test',
        score: { team1: 13, team2: 7 },
        team1: 'Alpha',
        team2: 'Bravo',
        roundCount: 20,
        packageBytes: 13
      };
    }
  });
  assert(first.running === true, 'probe reports running');

  // A second start while one is live must refuse, not queue.
  const second = await startProbe(`${BASE}/download`, { allowPrivate: true });
  assert(second.busy === true, 'second probe is refused while one runs');

  const st = await waitDone();
  assert(st.verdict === 'ok', `verdict ok, got ${st.verdict}: ${st.summary}`);
  assert(logHas(st, /-> HTTP 302/), 'redirect hop logged');
  assert(logHas(st, /-> HTTP 200/), 'final hop logged');
  assert(logHas(st, /Downloaded .* (B|KB|MB|GB) in /), 'download size logged');
  assert(logHas(st, /Extracted test-map\.dem/), 'extraction logged');
  assert(/PASS/.test(st.summary), 'summary says PASS');
  assert(seen.fileHeaders.cookie === 'probe=yes', 'cookie from hop 1 carried to hop 2');

  assert(packaged.length === 1, 'one demo packaged');
  assert(packaged[0].meta.filename === 'test-map.dem', 'inner demo name reached the packager');
  assert(st.packages.length === 1 && st.packages[0].team1 === 'Alpha', 'package summary kept');
  const kept = await fsp.readFile(st.packages[0].path, 'utf8');
  assert(kept === 'AIM4RPLY-fake', '.aim4replay file exists after cleanup');
  await fsp.access(path.join(tmp, 'work', st.runId)).then(
    () => assert(false, 'work dir must be deleted'),
    () => {}
  );

  // The state file is the restart story: it must already say the same thing.
  const onDisk = JSON.parse(
    await fsp.readFile(path.join(tmp, 'state', 'probe.json'), 'utf8')
  );
  assert(onDisk.verdict === 'ok' && onDisk.running === false, 'probe.json persisted');
}

// ---------------------------------------------------------------------------
// A 403 challenge page is "blocked", named as such, and nothing is retried.
// ---------------------------------------------------------------------------

{
  await startProbe(`${BASE}/blocked`, { allowPrivate: true });
  const st = await waitDone();
  assert(st.verdict === 'blocked', `403 challenge -> blocked, got ${st.verdict}`);
  assert(/challenge/i.test(st.summary), 'summary names the challenge');
}

// A cf-mitigated header alone is enough; no body reading needed.
{
  await startProbe(`${BASE}/mitigated`, { allowPrivate: true });
  const st = await waitDone();
  assert(st.verdict === 'blocked', `cf-mitigated -> blocked, got ${st.verdict}`);
  assert(/cf-mitigated/.test(st.summary), 'summary names the header');
}

// An HTML page saved as a "download" is failed and named for what it is.
{
  await startProbe(`${BASE}/html`, { allowPrivate: true });
  const st = await waitDone();
  assert(st.verdict === 'failed', `html body -> failed, got ${st.verdict}`);
  assert(/HTML page/.test(st.summary) && /Demo not found/.test(st.summary), st.summary);
}

// ---------------------------------------------------------------------------
// The address guard: without the test hook, loopback and link-local refuse.
// ---------------------------------------------------------------------------

{
  await startProbe('http://169.254.169.254/latest/meta-data');
  const st = await waitDone();
  assert(st.verdict === 'failed', 'private target -> failed');
  assert(/private address/.test(st.summary), 'summary names the refusal');
}

server.close();
console.log('probe.test.js OK');
