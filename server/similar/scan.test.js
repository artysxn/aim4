// Run: node server/similar/scan.test.js
//
// The Similar Rounds scan in the desktop app's server, against a stand-in
// for /api/replays serving the sample demos' Cache rounds:
//
//   * the route exists only in the desktop app's server (AIM4_DESKTOP=1)
//   * a request is checked before anything runs
//   * the library is asked for the right economy and with the caller's
//     sign-in, and the rounds come in the Similar Rounds projection
//   * results are best first, never the round on screen, and stay inside
//     its economy
//   * a second scan reads what the first indexed instead of downloading it
//   * a stopped scan stops, and a refused sign-in says so
//   * the whole thing through HTTP, as the viewer reads it

import assert from 'node:assert/strict';
import http from 'node:http';
import { listSampleRoundNames, getSampleRoundMeta, getSampleRoundTicks } from '../replays/sampleDemos.js';
import { encodeRoundPacks } from '../../src/replays/shared/roundPackWire.js';
import { econClass } from '../../src/replays/similar/roundSimilarity.js';
import { clearScanCache, closeScanPool, runScan } from './scan.js';
import { handleSimilarRequest, parseAsk } from './routes.js';

const names = (await listSampleRoundNames()).filter((n) => n.includes('-CCH-'));
if (names.length < 10) {
  console.log('scan.test.js: sampledemos/ has no Cache rounds, skipped');
  process.exit(0);
}
const library = new Map();
for (const n of names) library.set(n, { meta: await getSampleRoundMeta(n), ticks: await getSampleRoundTicks(n, 100) });

// ---- a stand-in for /api/replays --------------------------------------------
const seen = { listQueries: [], packBodies: [], auth: new Set() };
let refuse = false;
async function handleReplays(req, res, url) {
  seen.auth.add(String(req.headers.authorization || ''));
  if (refuse) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":"Sign in."}');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/replays/rounds') {
    seen.listQueries.push(Object.fromEntries(url.searchParams));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rounds: names.map((file) => ({ file })) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/replays/rounds/packs') {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.packBodies.push(body);
    const entries = body.files.map((file) => {
      const r = library.get(file);
      return { file, meta: r?.meta || null, ticks: r?.ticks || null };
    });
    res.writeHead(200, { 'Content-Type': 'application/vnd.aim4.round-packs' });
    res.end(Buffer.from(encodeRoundPacks(entries)));
    return;
  }
  res.writeHead(404).end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handleSimilarRequest(req, res, url)) return;
  if (url.pathname.startsWith('/api/replays/')) return handleReplays(req, res, url);
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const api = { base, headers: { authorization: 'Bearer test-token' } };

// The round on screen: FaZe's T-side full buy, 40 s in.
const sourceFile = names.find((n) => n.startsWith('DNH-vzF-154-CCH-06'));
const sourceMeta = library.get(sourceFile).meta;
const ask = { file: sourceFile, tick: sourceMeta.freezeEndTick + 40 * 64, side: 'T', both: false, mode: 'round', strokes: [], team: '' };

// ---- desktop only -------------------------------------------------------------
{
  delete process.env.AIM4_DESKTOP;
  const off = await fetch(`${base}/api/similar/status`);
  assert.equal(off.status, 404, 'outside the desktop app the route is not there');
  assert.match((await off.json()).error, /desktop app/, 'and it says where it is');
  process.env.AIM4_DESKTOP = '1';
  const on = await (await fetch(`${base}/api/similar/status`)).json();
  assert.equal(on.available, true);
  assert.ok(on.threads >= 1, 'it reports the threads it scans with');
}

// ---- the request ----------------------------------------------------------------
{
  assert.throws(() => parseAsk({ file: '../etc/passwd', tick: 1 }), /round/, 'a round name is a round name');
  assert.throws(() => parseAsk({ file: 'abc', tick: 'soon' }), /tick/, 'the moment is a tick');
  const a = parseAsk({
    file: 'abc~1',
    tick: 5,
    side: 'sideways',
    mode: 'nonsense',
    team: 'not-a-team',
    strokes: [{ side: 'CT', pts: [[1, 2], ['x', 3], [4, 5]] }, { pts: [] }]
  });
  assert.equal(a.side, 'T', 'an unknown side reads as T');
  assert.equal(a.mode, 'round');
  assert.equal(a.team, '', 'a team id is three characters');
  assert.deepEqual(a.strokes, [{ side: 'CT', pts: [[1, 2], [4, 5]] }], 'bad points and empty strokes go');
}

// ---- a scan ---------------------------------------------------------------------
clearScanCache();
const events = [];
const first = await runScan({ api, ask, emit: (e) => events.push(e) });
{
  const types = events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ['phase', 'phase', 'start'], 'source, list, then start');
  assert.equal(types[types.length - 1], 'done');
  const start = events.find((e) => e.type === 'start');
  assert.equal(start.total, names.length - 1, 'every listed round but the one on screen');
  assert.equal(start.cached, 0);

  assert.equal(seen.listQueries[0].maps, 'CCH', 'the map is asked for');
  assert.equal(seen.listQueries[0].economies, '4', 'and the T side buy, by name');
  assert.ok(seen.auth.has('Bearer test-token'), "the caller's sign-in goes with it");
  assert.ok(seen.packBodies.every((b) => b.meta === 'similar' && b.stride === 100), 'rounds come in the scan projection');

  assert.ok(first.results.length > 10, 'results come back');
  assert.ok(!first.results.some((r) => r.file === sourceFile), 'never the round on screen');
  for (let i = 1; i < first.results.length; i++) {
    assert.ok(first.results[i - 1].similarity >= first.results[i].similarity, 'best first');
  }
  for (const r of first.results) {
    assert.equal(econClass(r.teams.T.econ), 'full', 'inside the T side economy');
    assert.ok(r.dominance >= 0 && r.dominance <= 100);
    assert.ok(Number.isFinite(r.tick));
  }
  assert.equal(first.econ.T, 'Full buy');
  assert.equal(first.failed, 0);
}

// ---- again: nothing downloaded twice ------------------------------------------
{
  const packsBefore = seen.packBodies.length;
  const again = [];
  const second = await runScan({ api, ask, emit: (e) => again.push(e) });
  const start = again.find((e) => e.type === 'start');
  assert.equal(start.cached, start.total, 'every round comes from the kept indexes');
  assert.equal(seen.packBodies.length, packsBefore + 1, 'only the round on screen is fetched');
  assert.deepEqual(
    second.results.map((r) => [r.file, r.similarity]),
    first.results.map((r) => [r.file, r.similarity]),
    'and the answer is the same'
  );
}

// ---- both sides ask for both buys ---------------------------------------------
{
  await runScan({ api, ask: { ...ask, both: true }, emit: () => {} });
  const q = seen.listQueries[seen.listQueries.length - 1];
  assert.equal(q.econA, '4');
  assert.equal(q.econB, '4');
  assert.equal(q.economies, undefined);
}

// ---- stop -------------------------------------------------------------------------
{
  clearScanCache();
  const controller = new AbortController();
  let done = false;
  const out = await runScan({
    api,
    ask,
    signal: controller.signal,
    emit: (e) => {
      if (e.type === 'start') controller.abort();
      if (e.type === 'done') done = true;
    }
  }).catch((err) => (err?.name === 'AbortError' ? null : Promise.reject(err)));
  assert.equal(out, null, 'a stopped scan returns nothing');
  assert.equal(done, false, 'and never reports done');
}

// ---- a refused sign-in ---------------------------------------------------------
{
  refuse = true;
  await assert.rejects(runScan({ api, ask, emit: () => {} }), /Sign in to scan rounds/);
  refuse = false;
}

// ---- through HTTP ---------------------------------------------------------------
{
  const res = await fetch(`${base}/api/similar/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ ...ask, both: true })
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /ndjson/);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  const done = lines.find((e) => e.type === 'done');
  assert.ok(done, 'a done event');
  assert.deepEqual(done.sides, ['T', 'CT']);
  assert.ok(lines.some((e) => e.type === 'progress'), 'with progress on the way');

  const bad = await fetch(`${base}/api/similar/scan`, { method: 'POST', body: '{"file":"x"}' });
  assert.equal(bad.status, 400, 'a malformed request is refused before anything runs');
}

await closeScanPool();
server.close();
console.log('scan.test.js: all assertions passed');
