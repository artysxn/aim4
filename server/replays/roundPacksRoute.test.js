// Run: node server/replays/roundPacksRoute.test.js
//
// The batched surfaces the library pages lean on at scale, end to end through
// handleReplayRequest against a real temp library:
//
//   POST /api/replays/rounds/packs   meta + coarse ticks for many rounds
//   GET  /api/replays/demos?ids=     records for an explicit id list
//   GET  /api/replays/rounds         the collector, twice (round-name cache)

import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HEADER_BYTES,
  TICK_BYTES,
  PLAYER_SLOTS,
  writeHeader,
  writeRecord as writeTickRecord,
  sliceStride
} from '../../src/replays/shared/tickFormat.js';
import { buildRoundId } from '../../src/replays/shared/roundId.js';
import { decodeRoundPacks } from '../../src/replays/shared/roundPackWire.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'aim4-packs-'));
process.env.AIM4_REPLAY_DIR = ROOT;

// ROOT is read at module load, so the env has to be set before the imports.
const store = await import('./demoStore.js');
const { handleReplayRequest } = await import('./routes.js');

const USER = 'local';
const DEMO_ID = 'abc123def4567890';

function makeTicks(rows) {
  const buf = Buffer.alloc(HEADER_BYTES + rows * TICK_BYTES);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  writeHeader(view, {
    tickCount: rows,
    firstTick: 9001,
    stride: 1,
    tickRate: 64,
    playerCount: PLAYER_SLOTS
  });
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < PLAYER_SLOTS; s++) {
      writeTickRecord(view, r, s, {
        x: r + s,
        y: r - s,
        z: 64,
        yaw: 0,
        pitch: 0,
        health: 100,
        armor: 100,
        weapon: 4,
        flags: 1,
        flash: 0,
        side: s < 5 ? 2 : 3
      });
    }
  }
  return buf;
}

const players1 = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'];
const players2 = ['fff', 'ggg', 'hhh', 'iii', 'jjj'];
const roundIdFor = (round) =>
  buildRoundId({
    team1: 'FZE',
    team2: 'VPX',
    winner: 1,
    econ1: 4,
    econ2: 3,
    map: 'INF',
    round,
    players1,
    players2
  });

const ticksByStem = new Map();
const stems = [];
for (const round of [5, 6]) {
  const ticks = makeTicks(2500);
  const stem = await store.writeRound(
    USER,
    DEMO_ID,
    {
      id: roundIdFor(round),
      round,
      winner: 1,
      team1: { id: 'FZE', name: 'FaZe' },
      team2: { id: 'VPX', name: 'Virtus.pro' },
      startTick: 9001,
      freezeEndTick: 9200,
      endTick: 15800,
      players: [{ id: 'p1', name: 'One', team: 1 }, { id: 'p2', name: 'Two', team: 2 }],
      stats: { [`p${round}`]: { kills: 1 } },
      events: {
        kills: [{ tick: 9500, attacker: 'p1', victim: 'p2' }],
        shots: Array.from({ length: 40 }, (_, i) => ({ tick: 9300 + i, player: 'p1' })),
        damage: [{ tick: 9500, attacker: 'p1', victim: 'p2', hp: 27 }],
        items: [{ tick: 9200, player: 'p1', item: 'ak47' }],
        grenades: [{ tick: 9400, player: 'p1', type: 'smoke' }],
        bomb: []
      },
      ticks: ticks.buffer.slice(ticks.byteOffset, ticks.byteOffset + ticks.byteLength)
    },
    { map: 'INF' }
  );
  ticksByStem.set(stem, ticks);
  stems.push(stem);
}

// Old enough that the free-tier "first half of a recent demo" cutoff is moot.
await store.writeRecord(USER, {
  id: DEMO_ID,
  status: 'ready',
  filename: 'faze-vs-vp-inferno.dem',
  map: 'INF',
  uploadedAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
  team1: { id: 'FZE', name: 'FaZe' },
  team2: { id: 'VPX', name: 'Virtus.pro' },
  roundCount: 2,
  rounds: stems.map((file) => ({ file }))
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (await handleReplayRequest(req, res, url)) return;
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- POST /rounds/packs -----------------------------------------------------
{
  const res = await fetch(`${base}/api/replays/rounds/packs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [...stems, 'Missing~0000000000000000'], stride: 100 })
  });
  assert(res.ok, `packs responds 200 (${res.status})`);
  const packs = decodeRoundPacks(await res.arrayBuffer());
  assert(packs && packs.length === 3, 'one entry per requested file, in order');
  for (const [i, stem] of stems.entries()) {
    assert(packs[i].file === stem, 'entries keep request order');
    assert(packs[i].meta?.round === 5 + i, 'meta is the stored round meta');
    const want = Buffer.from(sliceStride(ticksByStem.get(stem), 100));
    assert(
      Buffer.compare(Buffer.from(packs[i].ticks), want) === 0,
      'ticks are the precomputed coarse pass, byte-identical'
    );
  }
  assert(packs[2].meta === null && packs[2].ticks === null, 'unknown round is explicit nulls');
}

// The matching projection: what the search predicates read, nothing else.
// `shots` is the field that made a 150-round batch megabytes; a client that
// asks for meta:'match' must not receive it, and must still receive every
// field the predicates do read — including the ticks, untouched.
{
  const res = await fetch(`${base}/api/replays/rounds/packs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: stems, stride: 100, meta: 'match' })
  });
  assert(res.ok, `match packs respond 200 (${res.status})`);
  const packs = decodeRoundPacks(await res.arrayBuffer());
  for (const [i, stem] of stems.entries()) {
    const m = packs[i].meta;
    assert(m, 'projected meta present');
    assert(m.events?.kills?.length === 1, 'kills survive the projection');
    assert(m.events?.grenades?.length === 1, 'grenades survive');
    assert(Array.isArray(m.events?.bomb), 'bomb survives');
    assert(m.events.shots === undefined, 'shots are dropped');
    assert(m.events.damage === undefined, 'damage is dropped');
    assert(m.events.items === undefined, 'items are dropped');
    assert(m.stats === undefined, 'per-round stats are dropped');
    assert(m.startTick === 9001 && m.freezeEndTick === 9200 && m.endTick === 15800,
      'phase-bound scalars pass through');
    assert(Array.isArray(m.players), 'players pass through');
    const want = Buffer.from(sliceStride(ticksByStem.get(stem), 100));
    assert(Buffer.compare(Buffer.from(packs[i].ticks), want) === 0,
      'ticks are untouched by the meta projection');
  }
}

// Meta-only batches skip the tick blobs entirely.
{
  const res = await fetch(`${base}/api/replays/rounds/packs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: stems, ticks: false })
  });
  const packs = decodeRoundPacks(await res.arrayBuffer());
  assert(packs.every((p) => p.meta && p.ticks === null), 'ticks:false means meta only');
}

// ---- GET /demos?ids= --------------------------------------------------------
{
  const res = await fetch(`${base}/api/replays/demos?ids=${DEMO_ID},nope123`);
  assert(res.ok, 'ids listing responds 200');
  const body = await res.json();
  assert(Array.isArray(body.demos) && body.demos.length === 1, 'only readable ids come back');
  assert(body.demos[0].id === DEMO_ID, 'and they are the records asked for');
  assert(body.teams === undefined, 'no team clusters on the ids path');
}

// ---- GET /rounds, twice (the round-name cache), then after a delete ---------
{
  const first = await (await fetch(`${base}/api/replays/rounds?maps=INF`)).json();
  assert(first.total === 2, `collector finds both rounds (got ${first.total})`);
  const again = await (await fetch(`${base}/api/replays/rounds?maps=INF`)).json();
  assert(again.total === 2, 'cached names give the same answer');

  await store.deleteDemo(USER, DEMO_ID);
  const gone = await (await fetch(`${base}/api/replays/rounds?maps=INF`)).json();
  assert(gone.total === 0, 'a delete invalidates the round-name cache');
}

server.close();
await fsp.rm(ROOT, { recursive: true, force: true });
console.log('roundPacksRoute.test.js: all assertions passed');
