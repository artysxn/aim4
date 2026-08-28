// Run: node server/replays/pistolFix.test.js
//
// The two pistol-round repairs, against synthetic rounds built with the real
// tick writer. The knife case is the exact shape from the bug report: nine
// knife deaths, one survivor, then everyone alive again and a pistol round
// beginning inside the same stored round. The missing-pistol case is a
// "round 1" where players hold rifles at freeze end.

import {
  HEADER_BYTES,
  PLAYER_SLOTS,
  readHeader,
  totalBytes,
  writeHeader,
  writeRecord
} from '../../src/replays/shared/tickFormat.js';
import {
  detectMissingPistol,
  findFreezeEnd,
  findKnifeCut,
  fixNormalizedDemo,
  reclassifyEcon,
  trimMeta,
  trimTicks
} from './pistolFix.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const RATE = 64;

/**
 * Build a tick buffer from a script: for each row, a function saying which
 * slots are alive, what everyone holds, and where they stand.
 */
function buildTicks({ firstTick, rows, at }) {
  const buf = new ArrayBuffer(totalBytes(rows));
  const view = new DataView(buf);
  writeHeader(view, {
    tickCount: rows,
    firstTick,
    stride: 1,
    tickRate: RATE,
    playerCount: PLAYER_SLOTS
  });
  for (let row = 0; row < rows; row++) {
    const s = at(row);
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      writeRecord(view, row, slot, {
        x: s.x?.(slot) ?? 100 + slot * 50,
        y: s.y?.(slot) ?? -200,
        z: 0,
        yaw: 0,
        pitch: 0,
        health: s.alive(slot) ? 100 : 0,
        armor: 0,
        weapon: s.weapon(slot),
        flags: s.alive(slot) ? 1 : 0,
        flash: 0,
        side: slot < 5 ? 2 : 3
      });
    }
  }
  return buf;
}

const WEAPONS = ['knife', 'glock', 'usp_silencer', 'ak47', 'm4a1'];
const KNIFE = 0;
const GLOCK = 1;
const AK = 3;

const PLAYERS = Array.from({ length: 10 }, (_, slot) => ({
  id: `p${slot}`,
  name: `player${slot}`,
  steamId: '',
  team: slot < 5 ? 1 : 2,
  slot
}));

/**
 * The glued round: 20s of knife round in which slots 1..9 die one by one,
 * a 4s limbo with one survivor, then at KNIFE_END everyone respawns frozen
 * with pistols for 15s, then moves out.
 */
const KNIFE_END = 24 * RATE; // rows are ticks here (firstTick 0)
const PISTOL_LIVE = KNIFE_END + 15 * RATE;

function gluedScript(row) {
  if (row < KNIFE_END) {
    // One death every 2 seconds from row 2s: alive drops 10 -> 1.
    const deaths = Math.min(9, Math.max(0, Math.floor((row - 2 * RATE) / (2 * RATE)) + 1));
    return {
      alive: (slot) => slot >= deaths || slot === 9 ? slot >= deaths : false,
      weapon: () => KNIFE
    };
  }
  const frozen = row < PISTOL_LIVE;
  return {
    alive: () => true,
    weapon: () => GLOCK,
    // Frozen in spawn through the pistol freeze, then everyone runs.
    x: (slot) => (frozen ? 100 + slot * 50 : 100 + slot * 50 + (row - PISTOL_LIVE) * 2)
  };
}

function gluedMeta() {
  const kills = [];
  for (let d = 0; d < 9; d++) {
    kills.push({
      tick: (2 + d * 2) * RATE,
      attacker: 'p9',
      victim: `p${d}`,
      assister: '',
      weapon: 'knife',
      headshot: false
    });
  }
  const stats = {};
  for (const p of PLAYERS) {
    stats[p.id] = {
      kills: p.id === 'p9' ? 9 : 0,
      deaths: p.id === 'p9' ? 0 : 1,
      assists: 0,
      damage: p.id === 'p9' ? 900 : 0,
      shots: 5,
      money: 800,
      equipValue: 200
    };
  }
  return {
    round: 1,
    tickRate: RATE,
    startTick: 0,
    freezeEndTick: 2 * RATE,
    endTick: PISTOL_LIVE + 40 * RATE,
    players: PLAYERS,
    weapons: WEAPONS,
    events: {
      kills,
      shots: kills.map((k) => ({ tick: k.tick, player: k.attacker, weapon: 'knife' })),
      damage: kills.map((k) => ({ tick: k.tick, attacker: k.attacker, victim: k.victim, hp: 100 })),
      grenades: [],
      bomb: []
    },
    stats
  };
}

// ---- the glued knife round is found and cut exactly at the respawn -----------
{
  const rows = PISTOL_LIVE + 20 * RATE;
  const ticks = buildTicks({ firstTick: 0, rows, at: gluedScript });
  const meta = gluedMeta();

  const cut = findKnifeCut(meta, ticks);
  assert(cut === KNIFE_END, `cut at the respawn tick (got ${cut}, want ${KNIFE_END})`);

  const trimmed = trimTicks(ticks, cut);
  const header = readHeader(trimmed);
  assert(header.firstTick === KNIFE_END, 'the buffer now starts at the pistol freeze');
  assert(header.tickCount === rows - KNIFE_END, 'and holds exactly the remaining rows');

  const freezeEnd = findFreezeEnd(meta, trimmed, cut);
  assert(
    Math.abs(freezeEnd - PISTOL_LIVE) <= RATE,
    `freeze end found from movement (got ${freezeEnd}, want ~${PISTOL_LIVE})`
  );

  trimMeta(meta, cut, freezeEnd);
  assert(meta.events.kills.length === 0, 'the knife kills are gone');
  assert(meta.stats.p9.kills === 0, 'and the killer gives back all nine');
  assert(meta.stats.p0.deaths === 0, 'and the victims their deaths');
  assert(meta.stats.p9.damage === 0, 'and the damage');
  assert(meta.startTick === cut && meta.freezeEndTick === freezeEnd, 'timing follows');
  assert(meta.pistolFix.knifeTrimmed === true, 'and the round says it was repaired');
}

// ---- an honest round 1 is left completely alone ------------------------------
{
  const rows = 60 * RATE;
  const ticks = buildTicks({
    firstTick: 0,
    rows,
    at: (row) => ({
      // Normal pistol round: two deaths, nobody comes back.
      alive: (slot) => !(slot === 0 && row > 30 * RATE) && !(slot === 7 && row > 40 * RATE),
      weapon: () => GLOCK
    })
  });
  const meta = gluedMeta();
  assert(findKnifeCut(meta, ticks) === 0, 'no refill, no cut');
  assert(detectMissingPistol(meta, ticks) === false, 'pistols in hand, nothing to flag');
}

// ---- the missing pistol round is flagged and reclassified --------------------
{
  const rows = 40 * RATE;
  const live = 15 * RATE;
  const ticks = buildTicks({
    firstTick: 0,
    rows,
    at: (row) => ({
      alive: () => true,
      weapon: () => (row < live ? KNIFE : AK),
      x: (slot) => (row < live ? 100 + slot * 50 : 100 + slot * 50 + (row - live) * 2)
    })
  });
  const meta = gluedMeta();
  meta.freezeEndTick = live;
  // A second round's wallet: rifles bought, some cash left.
  for (const p of PLAYERS) {
    meta.stats[p.id].equipValue = 4200;
    meta.stats[p.id].money = 300;
  }

  assert(detectMissingPistol(meta, ticks) === true, 'rifles at freeze end cannot be round 1');
  const { econ1, econ2 } = reclassifyEcon(meta);
  assert(econ1 === 4 && econ2 === 4, `5x4200 equip is a full buy, not a pistol (got ${econ1}/${econ2})`);
}

// ---- fixNormalizedDemo does the whole dance ----------------------------------
{
  const rows = 40 * RATE;
  const live = 15 * RATE;
  const first = {
    ...gluedMeta(),
    winner: 1,
    econ1: 0,
    econ2: 0,
    freezeEndTick: live,
    ticks: buildTicks({
      firstTick: 0,
      rows,
      at: (row) => ({
        alive: () => true,
        weapon: () => (row < live ? KNIFE : AK),
        x: (slot) => (row < live ? 100 + slot * 50 : 100 + slot * 50 + (row - live) * 2)
      })
    })
  };
  for (const p of PLAYERS) {
    first.stats[p.id].equipValue = 4200;
    first.stats[p.id].money = 300;
  }
  const demo = {
    rounds: [first, { ...gluedMeta(), round: 2, ticks: null }],
    tickRate: RATE
  };
  const out = fixNormalizedDemo(demo);
  assert(out.missingPistol === true, 'flagged');
  assert(demo.rounds[0].round === 2 && demo.rounds[1].round === 3, 'every round moved up one');
  assert(demo.rounds[0].econ1 === 4, 'economy digit corrected before ids are built');
  assert(demo.pistolFix.missingPistol === true, 'and the demo carries the mark');
}

console.log('pistolFix: all assertions passed');
