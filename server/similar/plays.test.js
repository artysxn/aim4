// Run: node server/similar/plays.test.js
//
// The eye's play tools in the desktop app's server, against a stand-in for
// /api/replays serving the sample demos' Cache rounds:
//
//   * outside the desktop app the routes are not there
//   * requests are checked: a round name, a guess of known kinds, a verdict
//   * the first ask on a map learns its baseline from the library (and says
//     so); the next one reads it straight away
//   * plays come back with a summary, and a guess comes back checked
//   * round_moves' unlabelled round rides along when asked for
//   * a review names the play by id, clock or words, and a wrong name lists the plays

import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.AIM4_PLAYS_DIR = path.join(os.tmpdir(), `aim4-plays-test-${process.pid}`);

const { listSampleRoundNames, getSampleRoundMeta, getSampleRoundTicks } = await import('../replays/sampleDemos.js');
const { encodeRoundPacks } = await import('../../src/replays/shared/roundPackWire.js');
const { clearScanCache, closeScanPool } = await import('./scan.js');
const { clearBaselines, pickPlay } = await import('./plays.js');
const { handleSimilarRequest, parsePlaysAsk, parseReviewAsk } = await import('./routes.js');

const names = (await listSampleRoundNames()).filter((n) => n.includes('-CCH-'));
if (names.length < 10) {
  console.log('plays.test.js: sampledemos/ has no Cache rounds, skipped');
  process.exit(0);
}
const library = new Map();
for (const n of names) library.set(n, { meta: await getSampleRoundMeta(n), ticks: await getSampleRoundTicks(n, 100) });

let lists = 0;
async function handleReplays(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/replays/rounds') {
    lists++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rounds: names.map((file) => ({ file })) }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/replays/rounds/packs') {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const entries = body.files.map((file) => ({ file, meta: library.get(file)?.meta || null, ticks: library.get(file)?.ticks || null }));
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

async function events(route, body) {
  const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.headers.get('content-type')?.includes('ndjson')) return { status: res.status, body: await res.json() };
  const text = await res.text();
  return { status: res.status, list: text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const file = names.find((n) => n.startsWith('DNH-vzF-154-CCH-06'));

// ---- desktop only, and checked --------------------------------------------------
{
  delete process.env.AIM4_DESKTOP;
  const off = await events('/api/similar/plays', { file });
  assert.equal(off.status, 404, 'outside the desktop app the plays route is not there');
  assert.match(off.body.error, /desktop app/);
  process.env.AIM4_DESKTOP = '1';

  assert.throws(() => parsePlaysAsk({ file: '../x' }), /round/);
  const a = parsePlaysAsk({ file: 'abc~1', guess: [{ side: 'T', kind: 'Execute', site: 'A', clock: '1:05' }, { side: 'X', kind: 'execute' }, { side: 'CT', kind: 'teleport' }], moves: true });
  assert.deepEqual(a.guess, [{ side: 'T', kind: 'execute', site: 'A', clock: '1:05' }], 'only known sides and kinds');
  assert.equal(a.moves, true);
  assert.throws(() => parseReviewAsk({ file: 'abc' }), /play/, 'a review names a play');
  assert.equal(parseReviewAsk({ file: 'abc', play: 'T2', guess: { verdict: 'great' } }).guess, null, 'an unknown verdict is no guess');
  assert.deepEqual(parseReviewAsk({ file: 'abc', play: 'T2', guess: { verdict: 'BAD', why: 'no flash' } }).guess, { verdict: 'bad', why: 'no flash' });
}

// ---- plays --------------------------------------------------------------------------
clearScanCache();
clearBaselines();
let plays;
{
  const r = await events('/api/similar/plays', { file, moves: true, guess: [{ side: 'T', kind: 'execute', site: 'B', clock: '1:11' }] });
  const types = r.list.map((e) => e.type);
  assert.ok(r.list.some((e) => e.type === 'phase' && e.phase === 'baseline'), 'the first ask on a map learns its baseline');
  assert.ok(r.list.some((e) => e.type === 'start' && /usual/.test(e.purpose)), 'and says what it is doing');
  assert.equal(types.at(-1), 'done');
  const done = r.list.at(-1);
  plays = done.plays;
  assert.match(done.usual_from, /rounds in your library/);
  assert.match(done.summary, /^T \(FaZe\)/);
  assert.ok(plays.some((p) => p.kind === 'execute' && p.site === 'B'), 'the B execute is read');
  assert.ok(done.check.score > 0 && done.check.right.length === 1, 'the guess comes back checked');
  assert.ok(Array.isArray(done.check.definitions), 'with the definitions of what it missed');
  assert.equal(done.moves.paths.length, 10, 'the unlabelled round rides along');

  const listsBefore = lists;
  const again = await events('/api/similar/plays', { file });
  assert.ok(!again.list.some((e) => e.phase === 'baseline'), 'the second ask reads the kept baseline');
  assert.equal(lists, listsBefore, 'and lists nothing');
  assert.equal(again.list.at(-1).check, undefined, 'no guess, no check');
}

// ---- review ------------------------------------------------------------------------------
{
  const hit = plays.find((p) => p.kind === 'execute');
  const r = await events('/api/similar/review', { file, play: hit.id, guess: { verdict: 'good' } });
  const done = r.list.at(-1);
  assert.equal(done.type, 'done', JSON.stringify(r.list.at(-1)));
  assert.equal(done.play.id, hit.id);
  assert.ok(['good', 'bad', 'mixed'].includes(done.verdict));
  assert.ok(done.similar.rounds > 0, 'similar rounds were read');
  assert.ok(!done.similar.examples.some((x) => x.round === file), 'never the round itself');
  assert.equal(done.your_guess.said, 'good');
  assert.equal(done.map, 'CCH');

  const bad = await events('/api/similar/review', { file, play: 'T99' });
  assert.equal(bad.list.at(-1).type, 'error');
  assert.match(bad.list.at(-1).error, /Its plays: .*\bT1 /, 'a wrong name lists the plays');

  assert.equal(pickPlay(plays, hit.id.toLowerCase())?.id, hit.id, 'by id, any case');
  assert.equal(pickPlay(plays, hit.clock)?.id, hit.id, 'by the clock it started at');
  assert.equal(pickPlay(plays, 'B execute')?.id, hit.id, 'by words of its label');
  assert.equal(pickPlay(plays, ''), null);
}

await closeScanPool();
server.close();
console.log('plays.test.js (server): all assertions passed');
