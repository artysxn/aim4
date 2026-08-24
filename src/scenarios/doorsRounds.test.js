// Run: node src/scenarios/doorsRounds.test.js
//
// The Doors gamemode's data layer, without a browser or a backend.
//
// Two halves. The role picker is checked twice: once against a synthetic
// round whose five CTs stand in textbook spots (so the expected answer is
// known exactly), and once against every round of the bundled Dust2 sample
// demo (so the reader survives real tick buffers, real loadouts and players
// who die mid-window). The playlist selector runs against a scripted API and
// is checked for the rules that matter: most recent game only, CT side only,
// three per top-10 team, thirty for a named team, AWP rounds first.

import assert from 'node:assert';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {
  writeHeader,
  HEADER_BYTES,
  RECORD_BYTES,
  TICK_BYTES,
  POS_SCALE,
  FLAG_ALIVE,
  SIDE_CT,
  SIDE_T
} from '../replays/shared/tickFormat.js';
import { unpackColumnarInto } from '../replays/shared/tickPacked.js';
import { readHeader } from '../replays/shared/tickFormat.js';
import { decodeReplayPackage } from '../replays/shared/replayPackage.js';
import { RoundTicks } from './doorsPlayback.js';
import {
  pickDoorsCts,
  selectDoorsRounds,
  resolveTeamQuery,
  awperOf,
  ctPlayersOf,
  TOP10_PER_TEAM,
  TEAM_MODE_ROUNDS
} from './doorsRounds.js';

let failures = 0;
function check(ok, msg) {
  if (ok) {
    console.log('  ok:', msg);
    return;
  }
  failures++;
  console.error('  FAIL:', msg);
}

// ---- a synthetic round ------------------------------------------------------
// Five CTs in the spots the roles are named after. The mode must draw the
// AWPer (mid), the B anchor (B site) and the B rotation (CT mid), and leave
// the long anchor and the short player undrawn.

const SPOTS = {
  aLong: { x: 1250, y: 900 },
  aShort: { x: 500, y: 2100 },
  awper: { x: -350, y: 1900 }, // holding mid from CT
  bMid: { x: -150, y: 2250 }, // CT spawn / doors side
  bAnchor: { x: -1550, y: 2480 } // B site
};

function syntheticRound() {
  const tickRate = 64;
  const tickCount = 40 * tickRate;
  const buf = new ArrayBuffer(HEADER_BYTES + tickCount * TICK_BYTES);
  const view = new DataView(buf);
  writeHeader(view, { tickCount, firstTick: 0, stride: 1, tickRate, playerCount: 10 });

  const roles = ['aLong', 'aShort', 'awper', 'bMid', 'bAnchor'];
  for (let row = 0; row < tickCount; row++) {
    for (let slot = 0; slot < 10; slot++) {
      const at = HEADER_BYTES + row * TICK_BYTES + slot * RECORD_BYTES;
      const ct = slot >= 5;
      const spot = ct ? SPOTS[roles[slot - 5]] : { x: -600, y: -1200 };
      view.setInt16(at, spot.x * POS_SCALE, true);
      view.setInt16(at + 2, spot.y * POS_SCALE, true);
      view.setInt16(at + 4, 0, true);
      view.setUint8(at + 10, 100);
      view.setUint8(at + 13, FLAG_ALIVE);
      view.setUint8(at + 15, ct ? SIDE_CT : SIDE_T);
    }
  }

  const players = [];
  for (let slot = 0; slot < 10; slot++) {
    players.push({
      id: `p${slot}`,
      name: slot >= 5 ? roles[slot - 5] : `t${slot}`,
      team: slot >= 5 ? 2 : 1,
      slot
    });
  }
  const stats = {};
  for (const p of players) {
    stats[p.id] = {
      loadout: p.name === 'awper' ? ['AWP', 'USP-S'] : ['M4A1-S', 'USP-S', 'Smoke Grenade']
    };
  }
  const meta = {
    round: 5,
    team1Side: 'T',
    team2Side: 'CT',
    team1: { id: 'TTT', name: 'Attack' },
    team2: { id: 'CCC', name: 'Defence' },
    freezeEndTick: 0,
    endTick: tickCount - 1,
    players,
    stats,
    events: {}
  };
  return { meta, ticks: new RoundTicks(buf) };
}

console.log('synthetic role picking');
{
  const { meta, ticks } = syntheticRound();
  const drawn = pickDoorsCts(meta, ticks);
  const names = drawn.map((d) => d.name).sort();
  check(drawn.length === 3, 'three CTs are drawn');
  check(
    names.join(',') === 'awper,bAnchor,bMid',
    `AWPer + B anchor + B rotation are the drawn three (got ${names.join(',')})`
  );
  const awper = drawn.find((d) => d.role === 'awper');
  check(awper?.weapon === 'awp', 'the AWPer bot holds the AWP');
  const anchor = drawn.find((d) => d.role === 'bAnchor');
  check(anchor?.name === 'bAnchor', 'the deeper B player is labeled the anchor');
  const rifles = drawn.filter((d) => d.role !== 'awper');
  check(rifles.every((d) => d.weapon === 'm4a1_silencer'), 'riflers hold their loadout primary');
}

console.log('synthetic role picking, no AWP in the round');
{
  const { meta, ticks } = syntheticRound();
  for (const s of Object.values(meta.stats)) s.loadout = ['M4A1-S', 'USP-S'];
  const drawn = pickDoorsCts(meta, ticks);
  const names = drawn.map((d) => d.name).sort();
  check(drawn.length === 3, 'still three CTs without an AWP');
  check(
    !names.includes('aLong') && !names.includes('aShort'),
    'the two A players stay undrawn without an AWP'
  );
}

// ---- the bundled sample demo ------------------------------------------------

const SAMPLE = 'sampledemos/fnatic-vs-brute-m1-dust2.aim4replay';

/** .tickz → tickFormat buffer; the node twin of demoData.js's browser walk. */
function decodeTickz(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codec = view.getUint8(6);
  const blockTicks = view.getUint16(8, true);
  const blockCount = view.getUint32(12, true);
  const srcHeader = bytes.subarray(16, 16 + HEADER_BYTES);
  const header = readHeader(new DataView(srcHeader.slice().buffer));
  const out = new Uint8Array(HEADER_BYTES + header.tickCount * TICK_BYTES);
  out.set(srcHeader, 0);
  let offset = 48 + blockCount * 4;
  for (let i = 0; i < blockCount; i++) {
    const length = view.getUint32(48 + i * 4, true);
    const rows = Math.min(blockTicks, header.tickCount - i * blockTicks);
    const plain = zlib.zstdDecompressSync(bytes.subarray(offset, offset + length));
    offset += length;
    const at = HEADER_BYTES + i * blockTicks * TICK_BYTES;
    if (codec === 2) unpackColumnarInto(plain, rows, out, at);
    else out.set(plain, at);
  }
  return out.buffer;
}

console.log('every round of the sample Dust2 demo');
if (!fs.existsSync(SAMPLE)) {
  check(false, `sample demo missing at ${SAMPLE}`);
} else {
  const { files } = decodeReplayPackage(new Uint8Array(fs.readFileSync(SAMPLE)));
  let rounds = 0;
  let awpRounds = 0;
  let ok = true;
  for (const [name, raw] of files) {
    const m = /^rounds\/(.+)\.json\.zst$/.exec(name);
    if (!m) continue;
    const meta = JSON.parse(zlib.zstdDecompressSync(Buffer.from(raw)).toString('utf8'));
    const tickz = files.get(`rounds/${m[1]}.tickz`);
    if (!tickz) continue;
    rounds++;
    const ticks = new RoundTicks(decodeTickz(tickz));
    const drawn = pickDoorsCts(meta, ticks);
    const ct = ctPlayersOf(meta);
    const ctIds = new Set(ct.map((p) => p.id));
    if (drawn.length !== 3 || !drawn.every((d) => ctIds.has(d.id))) ok = false;
    if (new Set(drawn.map((d) => d.id)).size !== 3) ok = false;
    const awper = awperOf(meta, ct);
    if (awper) {
      awpRounds++;
      if (!drawn.some((d) => d.id === awper.id && d.role === 'awper')) ok = false;
    }
  }
  check(rounds >= 15, `parsed a real match (${rounds} rounds)`);
  check(ok, 'every round yields three distinct CTs, AWP holder always drawn');
  check(awpRounds > 0, `some rounds actually had a CT AWP (${awpRounds})`);
}

// ---- playlist selection -----------------------------------------------------

function summary(file, demoId, t1, t2, e1, e2) {
  return { file: `${file}~${demoId}`, demoId, team1: t1, team2: t2, econ1: e1, econ2: e2 };
}

function fakeApi() {
  const demos = [
    { id: 'new1', map: 'DD2', uploadedAt: 300, team1: { id: 'AAA', name: 'Alpha' }, team2: { id: 'BBB', name: 'Bravo' } },
    { id: 'old1', map: 'DD2', uploadedAt: 100, team1: { id: 'AAA', name: 'Alpha' }, team2: { id: 'CCC', name: 'Charlie' } }
  ];
  // Every round: Alpha full+AWP against full+AWP. Alpha is CT in even rounds.
  const summaries = [];
  const metas = new Map();
  for (const demo of ['new1', 'old1']) {
    for (let r = 1; r <= 8; r++) {
      const opp = demo === 'new1' ? { id: 'BBB', name: 'Bravo' } : { id: 'CCC', name: 'Charlie' };
      const s = summary(`r${r}`, demo, 'AAA', opp.id, 5, 5);
      summaries.push(s);
      metas.set(s.file, {
        round: r,
        team1: { id: 'AAA', name: 'Alpha' },
        team2: opp,
        team1Side: r % 2 === 0 ? 'CT' : 'T',
        team2Side: r % 2 === 0 ? 'T' : 'CT',
        econ1: 5,
        econ2: 5
      });
    }
  }
  const calls = { findRounds: [] };
  return {
    calls,
    fetchVrsRanks: async () => ({
      list: [
        { name: 'Alpha', rank: 1 },
        { name: 'Bravo', rank: 2 },
        { name: 'NoGames', rank: 3 },
        { name: 'Offlist', rank: 11 }
      ]
    }),
    fetchDemos: async () => ({ demos }),
    findRounds: async (query) => {
      calls.findRounds.push(query);
      return { rounds: summaries };
    },
    fetchRoundMeta: async (file) => {
      const meta = metas.get(file);
      if (!meta) throw new Error('no meta');
      return meta;
    }
  };
}

console.log('top-10 selection');
await (async () => {
  const api = fakeApi();
  const out = await selectDoorsRounds({ team: '', api, rand: () => 0.42 });
  check(out.label === 'VRS top 10', 'labelled as the top-10 playlist');
  const alpha = out.rounds.filter((r) => r.teamName === 'Alpha');
  const bravo = out.rounds.filter((r) => r.teamName === 'Bravo');
  check(alpha.length === TOP10_PER_TEAM, `Alpha contributes ${TOP10_PER_TEAM} rounds`);
  check(bravo.length === TOP10_PER_TEAM, 'Bravo contributes from the shared game');
  check(out.rounds.length === alpha.length + bravo.length, 'unlisted and gameless teams contribute nothing');
  check(alpha.every((r) => r.file.includes('~new1')), 'only the most recent game is used');
  check(
    alpha.every((r) => r.meta.team1Side === 'CT'),
    'every pick has the team on the CT side'
  );
  check(
    bravo.every((r) => r.meta.team2Side === 'CT'),
    'the opponent contributes its own CT halves'
  );
  const q = api.calls.findRounds[0];
  check(
    q.econA === 4 && q.econB === 4 && q.hasAwpA && q.hasAwpB,
    'the index is asked for full buy + AWP against full buy + AWP'
  );
})();

console.log('named team selection');
await (async () => {
  const api = fakeApi();
  const out = await selectDoorsRounds({ team: 'alp', api, rand: () => 0.42 });
  check(out.label === 'Alpha', 'the typed prefix resolves to the library team');
  check(out.rounds.length === 8, 'all of their CT full-buy rounds load (fewer than the 30 cap)');
  check(out.rounds.every((r) => r.teamName === 'Alpha'), 'only the chosen team');
  check(
    out.rounds.some((r) => r.file.includes('~old1')),
    'a named team is scanned across all of its games'
  );
  const q = api.calls.findRounds[0];
  check(q.econA === 4 && q.econB === 4 && !q.hasAwpA && !q.hasAwpB, 'named team asks for full buy against full buy');
  check(TEAM_MODE_ROUNDS === 30, 'the team-mode cap is 30 rounds');
})();

console.log('team resolution');
{
  const demos = [
    { id: 'x', team1: { id: 'AAA', name: 'Alpha' }, team2: { id: 'BBB', name: 'Beta Squad' } }
  ];
  check(resolveTeamQuery('beta squad', demos)?.id === 'BBB', 'exact name wins');
  check(resolveTeamQuery('bet', demos)?.id === 'BBB', 'prefix matches');
  check(resolveTeamQuery('squad', demos)?.id === 'BBB', 'substring matches');
  check(resolveTeamQuery('vitality', demos) === null, 'an unknown team resolves to nothing');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall good');
