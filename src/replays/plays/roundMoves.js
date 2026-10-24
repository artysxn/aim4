// ---------------------------------------------------------------------------
// replays/plays/roundMoves.js
// A round as it happened, with no labels: what the eye reads before it
// guesses the plays.
//
// Each player's path as the places he held (three seconds or more), both
// sides' shape every ten seconds, every grenade with where it landed, every
// kill with where it happened, and the plant. Nothing here says "execute",
// "default" or "stack": that is the eye's guess to make, and the round_plays
// tool's to check (plays/findPlays.js).
//
// DOM-free.
// ---------------------------------------------------------------------------

import { clockOf } from './findPlays.js';
import { ECON_WORD, econGroup, firstLiveRow, lastLiveRow, livePos, placeOf, rowAt, rowElapsed, sideAt } from './playMap.js';

/** A place held fewer rows than this (about 3 s) is a place passed through. */
const HOLD_ROWS = 2;
const SHAPE_EVERY = 10;
const NADE_NAME = { 1: 'smoke', 2: 'molotov', 3: 'flash', 4: 'HE' };

/**
 * @param {object} index     Similar Rounds index
 * @param {object} baseline  the map's baseline (places and sites)
 */
export function roundMoves(index, baseline) {
  const r0 = firstLiveRow(index);
  const rEnd = lastLiveRow(index);
  const place = (p) => placeOf(baseline, p.x, p.y, p.z);
  const name = (slot) => index.names?.[slot] || index.ids?.[slot] || `player ${slot}`;
  const sideOf = (slot) => (index.slotSide[slot] === 1 ? 'T' : 'CT');

  // Paths: each player's places in order, a place counted once he held it HOLD_ROWS rows.
  const paths = [];
  for (let s = 0; s < index.slots; s++) {
    if (!index.slotSide[s]) continue;
    const steps = [];
    let run = null;
    let deadAt = null;
    for (let r = r0; r <= rEnd; r++) {
      const p = livePos(index, r, s);
      if (!p) {
        if (r > r0) deadAt = rowElapsed(index, r);
        break;
      }
      const here = place(p).name;
      if (run && run.name === here) run.rows += 1;
      else run = { name: here, e: rowElapsed(index, r), rows: 1 };
      if (run.rows === HOLD_ROWS || (r === r0 && run.rows === 1)) {
        if (steps[steps.length - 1]?.name !== run.name) steps.push({ name: run.name, e: run.e });
      }
    }
    const kill = (index.kills || []).find((k) => k.v === s);
    if (kill) deadAt = kill.t;
    paths.push({
      player: name(s),
      side: sideOf(s),
      path: `${steps.map((st) => `${clockOf(Math.max(0, st.e))} ${st.name}`).join(', ')}${deadAt != null ? `, died ${clockOf(deadAt)}` : ''}`
    });
  }

  // Shapes every ten seconds until the round's end.
  const shapes = [];
  const endE = rowElapsed(index, rEnd);
  for (let e = 5; e <= endE; e += SHAPE_EVERY) {
    const r = rowAt(index, e);
    const line = ['T', 'CT']
      .map((side) => {
        const c = new Map();
        for (const p of sideAt(index, r, side)) {
          const where = place(p);
          const key = where.site ? `${where.site} site` : where.ground === 'mid' ? 'mid' : `${where.ground} area`;
          c.set(key, (c.get(key) || 0) + 1);
        }
        return `${side} ${[...c.entries()].map(([k, n]) => `${k} ${n}`).join(', ') || 'none alive'}`;
      })
      .join(' | ');
    shapes.push(`${clockOf(e)} ${line}`);
  }

  const utility = (index.nades || [])
    .filter((n) => n.t >= -5)
    .sort((a, b) => a.t - b.t)
    .map((n) => `${clockOf(Math.max(0, n.t))} ${n.side === 1 ? 'T' : 'CT'} ${NADE_NAME[n.kind] || 'grenade'}${n.slot >= 0 ? ` by ${name(n.slot)}` : ''} landed ${place(n).name}`);

  const kills = (index.kills || []).map((k) => {
    const r = rowAt(index, k.t);
    const pos = livePos(index, Math.max(0, r - 1), k.v) || livePos(index, r, k.v);
    const where = pos ? ` at ${place(pos).name}` : '';
    const killer = k.a >= 0 ? `${name(k.a)} (${sideOf(k.a)})` : 'the world';
    return `${clockOf(k.t)} ${killer} killed ${name(k.v)} (${sideOf(k.v)})${where}`;
  });

  const out = {
    map: index.map,
    round: index.round,
    teams: `${index.teams.T?.name || 'T'} (T, ${ECON_WORD[econGroup(index.teams.T?.econ)]?.replace(/s$/, '')}) vs ${index.teams.CT?.name || 'CT'} (CT, ${ECON_WORD[econGroup(index.teams.CT?.econ)]?.replace(/s$/, '')})`,
    winner: index.winnerSide || null,
    sites: baseline.anchors.sitesFrom === 'zones' ? 'named by the map\'s zones' : 'placed from where the bomb is planted on this map',
    paths,
    shape_every_10s: shapes,
    utility,
    kills
  };
  if (index.plant) {
    const site = placeOf(baseline, index.plant.x, index.plant.y).site;
    out.plant = `${clockOf(index.plant.t)}${index.plant.slot >= 0 ? ` by ${name(index.plant.slot)}` : ''}${site ? ` on ${site}` : ''}`;
  }
  if (index.defuse != null) out.defuse = clockOf(index.defuse);
  return out;
}

