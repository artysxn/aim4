// Run: node src/replays/similar/roundSimilarity.test.js
//
// Similar Rounds' scoring, on rounds built in the real tick format: what
// makes two rounds alike (positions, guns, utility, a drawing), what keeps a
// round out of the comparison altogether (economy, the clock, the team), and
// dominance, the fall in a side's win chance over the round.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADER_BYTES, PLAYER_SLOTS, TICK_BYTES, writeHeader, writeRecord } from '../shared/tickFormat.js';
import {
  SCAN_STRIDE,
  bestAssignment,
  buildQuery,
  buildRoundIndex,
  dominanceOf,
  econClass,
  gateReason,
  roundDominance,
  scoreRound,
  weaponClass
} from './roundSimilarity.js';

// ---- dominance ----------------------------------------------------------------
{
  // The examples it is defined by.
  assert.deepEqual(
    [dominanceOf([50, 40, 100]).dominance, dominanceOf([50, 40, 100]).drop],
    [90, 10],
    '50% at the start, down to 40%, then the win: ten points given up'
  );
  assert.equal(dominanceOf([5, 30, 60, 100]).dominance, 100, 'climbing from 5% to the win gives nothing up');
  assert.equal(dominanceOf([50, 0]).dominance, 50, 'a loss from an even start');
  assert.equal(dominanceOf([50, 10, 90, 20, 100]).dominance, 0, 'two collapses add up past a hundred');
  // A slow bleed is a real fall; wobble that comes straight back is not.
  assert.equal(dominanceOf([80, 78, 76, 74, 72, 70, 100]).drop, 10, 'a slow bleed adds up');
  assert.equal(dominanceOf([50, 49.5, 50.4, 49.8, 50.2, 100]).drop, 0, 'sub-point wobble is ignored');
  assert.equal(dominanceOf([]).dominance, 0, 'no series, no claim');
}

// ---- economy and guns -----------------------------------------------------------
{
  assert.equal(econClass(0), 'pistol');
  assert.equal(econClass(1), 'eco');
  assert.equal(econClass(2), 'half');
  assert.equal(econClass(3), 'force');
  assert.equal(econClass(4), 'full');
  assert.equal(econClass(5), 'full', 'a full buy with an AWP is still a full buy');

  assert.ok(weaponClass('awp') > weaponClass('ak47'), 'an AWP outranks a rifle');
  assert.ok(weaponClass('AK-47') === weaponClass('m4a1_silencer'), 'loadout and dictionary spellings agree');
  assert.ok(weaponClass('ak47') > weaponClass('mac10') && weaponClass('mac10') > weaponClass('glock'));
  assert.equal(weaponClass('smoke_grenade'), 0, 'a grenade is not a gun');
  assert.equal(weaponClass('Karambit'), 0, 'nor is a knife');
}

// ---- the pairing --------------------------------------------------------------------
{
  // Against brute force, on small random matrices with unequal sides.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const brute = (m, n, k) => {
    let best = 0;
    const walk = (i, used, sum) => {
      if (i === n) {
        best = Math.max(best, sum);
        return;
      }
      walk(i + 1, used, sum);
      for (let j = 0; j < k; j++) if (!(used & (1 << j))) walk(i + 1, used | (1 << j), sum + m[i * k + j]);
    };
    walk(0, 0, 0);
    return best;
  };
  for (let t = 0; t < 40; t++) {
    const n = 1 + Math.floor(rand() * 5);
    const k = 1 + Math.floor(rand() * 5);
    const m = Array.from({ length: n * k }, rand);
    assert.ok(Math.abs(bestAssignment(m, n, k) - brute(m, n, k)) < 1e-9, `assignment ${n}x${k}`);
  }
}

// ---- rounds -------------------------------------------------------------------------

const RATE = 64;
const START = 1000;
const FREEZE_END = START + 15 * RATE;
const T_IDS = ['ta', 'tb', 'tc', 'td', 'te'];
const CT_IDS = ['ca', 'cb', 'cc', 'cd', 'ce'];
const WEAPONS = ['none', 'ak47', 'm4a1_silencer', 'awp', 'glock', 'usp_silencer'];

/** Where slot `s` stands `sec` seconds after freeze end: T walk +x, CT hold. */
function basePos(s, sec) {
  if (s < 5) return { x: -2000 + s * 150 + sec * 20, y: 500 + s * 40 };
  return { x: 1500 + (s - 5) * 200, y: -600 };
}

/**
 * @param {object} o
 * @param {string} o.id
 * @param {(s: number, sec: number) => {x: number, y: number}} [o.pos]
 * @param {number} [o.econ1] team 1 (T) buy digit
 * @param {number} [o.econ2] team 2 (CT) buy digit
 * @param {number} [o.length] seconds the round runs after freeze end
 * @param {string} [o.tGun]  what the T side holds
 * @param {Array} [o.grenades]
 * @param {Array} [o.kills]
 * @param {string} [o.team1]
 * @param {1|2} [o.winner]
 */
function makeRound({
  id,
  pos = basePos,
  econ1 = 4,
  econ2 = 4,
  length = 100,
  tGun = 'ak47',
  grenades = [],
  kills = [],
  team1 = 'AAA',
  winner = 1
}) {
  const endTick = FREEZE_END + length * RATE;
  const rows = Math.ceil((endTick + 5 * RATE - START) / SCAN_STRIDE) + 1;
  const buf = new ArrayBuffer(HEADER_BYTES + rows * TICK_BYTES);
  const view = new DataView(buf);
  writeHeader(view, { tickCount: rows, firstTick: START, stride: SCAN_STRIDE, tickRate: RATE, playerCount: PLAYER_SLOTS });
  const deaths = new Map(kills.map((k) => [k.victim, k.tick]));
  for (let r = 0; r < rows; r++) {
    const tick = START + r * SCAN_STRIDE;
    const sec = Math.max(0, (tick - FREEZE_END) / RATE);
    for (let s = 0; s < PLAYER_SLOTS; s++) {
      const pid = s < 5 ? T_IDS[s] : CT_IDS[s - 5];
      const dead = deaths.has(pid) && deaths.get(pid) <= tick;
      const p = pos(s, sec);
      const gun = s < 5 ? tGun : 'm4a1_silencer';
      writeRecord(view, r, s, {
        x: p.x,
        y: p.y,
        z: p.z ?? 0,
        health: dead ? 0 : 100,
        armor: 100,
        weapon: WEAPONS.indexOf(gun),
        flags: dead ? 0 : 1,
        side: s < 5 ? 2 : 3
      });
    }
  }
  const players = [...T_IDS, ...CT_IDS].map((pid, slot) => ({ id: pid, name: pid, team: slot < 5 ? 1 : 2, slot }));
  const stats = Object.fromEntries(
    players.map((p) => [
      p.id,
      {
        money: 500,
        equipValue: 4500,
        loadout: ['Knife', p.team === 1 ? 'Glock-18' : 'USP-S', p.team === 1 ? (tGun === 'awp' ? 'AWP' : 'AK-47') : 'M4A1-S']
      }
    ])
  );
  const meta = {
    id,
    map: 'MIR',
    round: 7,
    tickRate: RATE,
    startTick: START,
    freezeEndTick: FREEZE_END,
    endTick,
    winner,
    winnerSide: winner === 1 ? 'T' : 'CT',
    team1Side: 'T',
    team2Side: 'CT',
    econ1,
    econ2,
    team1: { id: team1, name: 'Alpha' },
    team2: { id: 'BBB', name: 'Bravo' },
    players,
    stats,
    weapons: WEAPONS,
    events: { kills, grenades, bomb: [], items: [] }
  };
  return buildRoundIndex(meta, buf, id);
}

const smoke = (player, x, y, sec) => ({
  type: 'smokegrenade',
  player,
  throwTick: FREEZE_END + (sec - 2) * RATE,
  detonateTick: FREEZE_END + sec * RATE,
  at: { x, y, z: 0 }
});

const AT = FREEZE_END + 30 * RATE; // 1:25 on the clock
const SMOKES = [smoke('ta', -1200, 800, 20), smoke('tb', -1000, 900, 22)];

const source = makeRound({ id: 'src', grenades: SMOKES });
const same = makeRound({ id: 'same', grenades: SMOKES });
const near = makeRound({ id: 'near', grenades: SMOKES, pos: (s, sec) => {
  const p = basePos(s, sec);
  return s < 5 ? { x: p.x + 200, y: p.y } : p;
} });
const far = makeRound({ id: 'far', grenades: SMOKES, pos: (s, sec) => {
  const p = basePos(s, sec);
  return s < 5 ? { x: p.x + 1600, y: p.y - 1400 } : p;
} });
const awps = makeRound({ id: 'awps', grenades: SMOKES, tGun: 'awp' });
const otherSmokes = makeRound({ id: 'smokes', grenades: [smoke('ta', 900, -900, 5), smoke('tb', 1100, -800, 6)] });
const ctMoved = makeRound({ id: 'ctmoved', grenades: SMOKES, pos: (s, sec) => {
  const p = basePos(s, sec);
  return s >= 5 ? { x: p.x - 2500, y: p.y + 2000 } : p;
} });
const force = makeRound({ id: 'force', econ1: 3, grenades: SMOKES });
const short = makeRound({ id: 'short', length: 20, grenades: SMOKES });
const otherTeam = makeRound({ id: 'otherteam', team1: 'ZZZ', grenades: SMOKES });
const twoDead = makeRound({
  id: 'twodead',
  grenades: SMOKES,
  kills: [
    { tick: FREEZE_END + 10 * RATE, attacker: 'ca', victim: 'td' },
    { tick: FREEZE_END + 12 * RATE, attacker: 'ca', victim: 'te' }
  ]
});

const qT = buildQuery(source, { tick: AT, side: 'T' });
const sim = (q, idx) => scoreRound(q, idx)?.similarity ?? null;

{
  assert.equal(qT.elapsed, 30, 'the moment is read as seconds since freeze end');
  assert.equal(qT.players.T.length, 5);
  assert.equal(sim(qT, same), 100, 'the same round under another name is 100%');
  assert.ok(sim(qT, near) > 85, `two hundred units over is still close (${sim(qT, near)})`);
  assert.ok(sim(qT, near) > sim(qT, far), 'closer positions score higher');
  assert.ok(sim(qT, far) < 50, `across the map is not similar (${sim(qT, far)})`);
  assert.ok(sim(qT, awps) < sim(qT, same) && sim(qT, awps) > sim(qT, far), 'same spots with AWPs: close, not the same');
  const smokesScore = scoreRound(qT, otherSmokes);
  assert.equal(smokesScore.parts.positions, 100, 'positions match');
  assert.equal(smokesScore.parts.utility, 0, 'smokes on the other side of the map do not');
  assert.ok(sim(qT, twoDead) < sim(qT, near), 'a 3v5 is not the 5v5 on screen');
}

{
  // Gates: never "a bit like", simply not the same situation.
  assert.equal(gateReason(qT, source), 'self', 'the round on screen is not its own result');
  assert.equal(gateReason(qT, force), 'economy', 'a force buy is not compared with a full buy');
  assert.equal(scoreRound(qT, force), null);
  assert.equal(gateReason(qT, short), 'ended', 'a round over by the asked moment did not reach it');
  const qCt = buildQuery(source, { tick: AT, side: 'CT' });
  assert.equal(gateReason(qCt, force), '', "the other side's buy does not matter for a CT question");
  const qBoth = buildQuery(source, { tick: AT, side: 'CT', both: true });
  assert.equal(gateReason(qBoth, force), 'economy', 'but it does when both sides are compared');
  const qTeam = buildQuery(source, { tick: AT, side: 'T', team: 'AAA' });
  assert.equal(qTeam.teamSide, 'T');
  assert.equal(gateReason(qTeam, otherTeam), 'team', 'a team filter keeps that team in its seat');
  assert.equal(gateReason(qTeam, same), '');
}

{
  // One side, or both.
  const qBoth = buildQuery(source, { tick: AT, side: 'T', both: true });
  assert.deepEqual(qBoth.sides, ['T', 'CT']);
  assert.ok(sim(qT, ctMoved) > 95, 'a T question ignores where the CTs stood');
  assert.ok(sim(qBoth, ctMoved) < 70, `a both-sides question does not (${sim(qBoth, ctMoved)})`);
}

{
  // Drawing: a path a T walked, and one nobody did.
  const walked = { side: 'T', pts: Array.from({ length: 10 }, (_, i) => [-2000 + i * 120, 500]) };
  const nowhere = { side: 'T', pts: Array.from({ length: 10 }, (_, i) => [3000 + i * 120, 3000]) };
  const qWalked = buildQuery(source, { tick: AT, side: 'T', mode: 'drawing', strokes: [walked] });
  const qNowhere = buildQuery(source, { tick: AT, side: 'T', mode: 'drawing', strokes: [nowhere] });
  assert.equal(qWalked.mode, 'drawing');
  assert.ok(scoreRound(qWalked, same).parts.drawing > 90, 'a walked path is found');
  assert.ok(scoreRound(qNowhere, same).parts.drawing < 5, 'an empty corridor is not');
  assert.equal(scoreRound(qWalked, same).parts.positions, undefined, 'drawing only reads the drawing');
  const qBlend = buildQuery(source, { tick: AT, side: 'T', mode: 'both', strokes: [nowhere] });
  const blend = scoreRound(qBlend, same);
  assert.ok(blend.similarity > 45 && blend.similarity < 55, `both blends the two halves (${blend.similarity})`);
  // A dot is a spot to stand on at the moment.
  const tSpot = basePos(0, 30);
  const qSpot = buildQuery(source, { tick: AT, side: 'T', mode: 'drawing', strokes: [{ pts: [[tSpot.x, tSpot.y]] }] });
  assert.equal(qSpot.drawn[0].kind, 'spot');
  assert.ok(scoreRound(qSpot, same).parts.drawing > 95, 'someone stands on the spot');
  assert.equal(buildQuery(source, { tick: AT, mode: 'drawing' }).mode, 'round', 'nothing drawn reads the round');
}

{
  // Dominance rides with each result, for the side the question is about.
  const r = scoreRound(qT, same);
  assert.equal(r.dominance, same.dominance.T.dominance);
  assert.equal(r.won, true);
  assert.equal(r.tick, AT, 'the result opens at the same moment of its own round');
  const lostIdx = makeRound({ id: 'lost', winner: 2, grenades: SMOKES });
  assert.equal(scoreRound(qT, lostIdx).won, false);
  assert.equal(lostIdx.win[lostIdx.win.length - 1], 0, 'the T series ends at the result');
  for (const idx of [same, lostIdx]) {
    for (const side of ['T', 'CT']) {
      const d = idx.dominance[side].dominance;
      assert.ok(d >= 0 && d <= 100, 'dominance is a percentage');
    }
  }
}

// ---- a real round -------------------------------------------------------------------
{
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sampledemos');
  if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.aim4replay'))) {
    const { listSampleRoundNames, getSampleRoundMeta, getSampleRoundTicks } = await import(
      '../../../server/replays/sampleDemos.js'
    );
    const names = (await listSampleRoundNames()).slice(0, 12);
    for (const n of names) {
      const meta = await getSampleRoundMeta(n);
      const ticks = await getSampleRoundTicks(n, SCAN_STRIDE);
      const idx = buildRoundIndex(meta, ticks, n);
      // The Demo Manager's filter reads the same numbers Similar Rounds shows.
      const dom = roundDominance(meta, ticks);
      assert.deepEqual([dom.T, dom.CT, dom.winner], [idx.dominance.T.dominance, idx.dominance.CT.dominance, idx.winnerSide], `${n}: the filter and the scan agree`);
      const last = idx.win[idx.win.length - 1];
      assert.equal(last, idx.winnerSide === 'T' ? 100 : 0, `${n}: the series ends at the result`);
      assert.ok(idx.win.length > 10, 'a series point every row of the live round');
      const tick = idx.freezeEndTick + 20 * idx.tickRate;
      assert.equal(scoreRound(buildQuery(idx, { tick, side: 'T', both: true }), { ...idx, file: 'copy' }).similarity, 100);
    }
  } else {
    console.log('  sampledemos/ missing: real-round checks skipped');
  }
}

console.log('roundSimilarity.test.js ok');
