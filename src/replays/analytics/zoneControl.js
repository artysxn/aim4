// ---------------------------------------------------------------------------
// replays/analytics/zoneControl.js
// "Who held this ground, and did holding it win the round?"
//
// A `map_control` selection is unlike every other feature in the Pattern
// Finder: it filters nothing. Every round that reaches it is kept. What it
// produces instead is a SPLIT — the rounds where the Ts held the drawn ground
// during the window, the rounds where the CTs did — and the win rate of each,
// which is the actual question ("if I own banana at 1:20, do I win?").
//
// Control is the possession model the rest of the app already uses
// (`buildZonePresence` / `softOwnersAt`): a cell belongs to the last side that
// stood near it, sampled once a second. Reusing it rather than inventing a
// second definition is the point — a number here and a number in the viewer
// have to mean the same thing.
//
// The window is capped at MAP_CONTROL_MAX_SECONDS. "Who controls banana" is a
// question about a moment; asked of a whole round it averages into mush, and
// the answer stops being actionable.
// ---------------------------------------------------------------------------

import { pointInPiece } from '../zones/zoneGeom.js';
import { SIDE_CT, SIDE_T } from '../zones/controlField.js';
import { buildZonePresence, softOwnersAt } from '../zones/zoneOverlay.js';

/** Longest stretch of the round clock a control question may span, seconds. */
export const MAP_CONTROL_MAX_SECONDS = 20;

/**
 * The window a control selection asks about, or null when it has none / one
 * that is too long. Elapsed seconds since the round went live.
 *
 * The selection's own clock (the 🕒 on its row) is the one that counts: the
 * feature is per-selection, so two boxes can ask about two different moments
 * in the same search.
 */
export function controlWindow(shape) {
  const w = shape?.window;
  if (!w) return null;
  const from = Number(w.from);
  const to = Number(w.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  if (to - from > MAP_CONTROL_MAX_SECONDS) return null;
  return { from, to };
}

/** True for a control selection that is missing a usable window. */
export function needsControlWindow(shape) {
  return (shape?.feature === 'map_control') && !controlWindow(shape);
}

/** The enabled control selections in a set of shapes. */
export function controlShapes(shapes) {
  return (shapes || []).filter(
    (s) => s && s.enabled !== false && s.geometry && s.feature === 'map_control'
  );
}

/**
 * Walkable cells whose centre falls inside a drawn selection.
 *
 * Computed once per selection per map, not per round: the lattice is fixed and
 * the geometry only moves when someone drags a corner.
 *
 * @param {object} geom  FieldGeometry
 * @param {object} geometry  the drawn rect / poly
 * @returns {Int32Array}
 */
export function cellsInShape(geom, geometry) {
  if (!geom || !geometry) return new Int32Array(0);
  const { cell, originX, originY, cols, rows, walkable } = geom;
  /** @type {number[]} */
  const out = [];
  for (let iy = 0; iy < rows; iy++) {
    const cy = originY + (iy + 0.5) * cell;
    const row = iy * cols;
    for (let ix = 0; ix < cols; ix++) {
      const i = row + ix;
      if (!walkable[i]) continue;
      const cx = originX + (ix + 0.5) * cell;
      if (pointInPiece(cx, cy, geometry)) out.push(i);
    }
  }
  return Int32Array.from(out);
}

/**
 * Which side held the selection during the window.
 *
 * Cell-seconds, not a snapshot: every one-second frame in the window counts
 * the cells each side owns, and the side with the larger total holds it. Both
 * sides usually own some of it — a box across banana has Ts up one end and CTs
 * down the other for most of a round — which is exactly the case the user
 * asked to resolve by "whichever has more".
 *
 * @returns {{ side: 'T'|'CT'|'', t: number, ct: number }}
 */
export function controlOfCells({ meta, track, network, cells, window: win }) {
  const empty = { side: '', t: 0, ct: 0 };
  if (!meta || !track || !network?._fieldGeom || !cells?.length || !win) return empty;
  // `mapCode: ''` because the field is prepared once per map by the caller;
  // re-preparing it per round would rebuild the lattice thousands of times.
  const presence = buildZonePresence({ meta, track, network, mapCode: '' });
  if (!presence) return empty;

  const tickRate = meta.tickRate || 64;
  const live = meta.freezeEndTick ?? meta.startTick ?? 0;
  const endTick = Math.max(live, meta.endTick ?? live);
  const fromTick = live + Math.round(win.from * tickRate);
  const toTick = Math.min(endTick, live + Math.round(win.to * tickRate));
  if (toTick < fromTick) return empty;

  let t = 0;
  let ct = 0;
  // Forward only, so `softOwnersAt` never rewinds and refills its buffer.
  for (let tick = fromTick; tick <= toTick; tick += tickRate) {
    const owners = softOwnersAt(presence, tick);
    if (!owners) continue;
    for (let k = 0; k < cells.length; k++) {
      const o = owners[cells[k]];
      if (o === SIDE_T) t++;
      else if (o === SIDE_CT) ct++;
    }
  }
  return { side: t > ct ? 'T' : ct > t ? 'CT' : '', t, ct };
}

/** The side that won a round, from the row's winner and seating. */
export function winningSide(row) {
  if (!row) return '';
  if (row.w === 1) return row.s1 || '';
  if (row.w === 2) return row.s2 || '';
  return '';
}

/** The side a team (1|2) played on in a round. */
export function sideOfTeam(row, team) {
  return team === 1 ? row?.s1 || '' : team === 2 ? row?.s2 || '' : '';
}

/**
 * Win rate per controlling side, over a set of rounds.
 *
 * `control` maps a round file to the side that held the ground. Rounds where
 * neither side did (nobody went near it, or it split evenly) are counted, and
 * reported, rather than quietly dropped — "nobody took it" is an answer.
 *
 * @param {Map<string, string>} control  file → 'T' | 'CT' | ''
 * @param {Map<string, object>} rows     file → round row
 * @returns {{
 *   T: { rounds: number, wins: number, winrate: number },
 *   CT: { rounds: number, wins: number, winrate: number },
 *   neither: number, total: number
 * }}
 */
export function controlWinrates(control, rows) {
  const bucket = () => ({ rounds: 0, wins: 0, winrate: 0 });
  const out = { T: bucket(), CT: bucket(), neither: 0, total: 0 };
  for (const [file, side] of control || []) {
    const row = rows?.get(file);
    if (!row) continue;
    out.total += 1;
    if (side !== 'T' && side !== 'CT') {
      out.neither += 1;
      continue;
    }
    const b = out[side];
    b.rounds += 1;
    if (winningSide(row) === side) b.wins += 1;
  }
  for (const side of ['T', 'CT']) {
    const b = out[side];
    b.winrate = b.rounds ? (b.wins / b.rounds) * 100 : 0;
  }
  return out;
}

/**
 * Per-team win rate while holding the ground on one side.
 *
 * A team qualifies for a round when it was seated on `side` AND `side` held
 * the selection. Sorted by win rate, then by rounds, so a 100% from two rounds
 * does not outrank a 71% from forty — but it is still shown, with its count,
 * because hiding it would be the tool deciding what is interesting.
 *
 * @returns {Array<{ key: string, name: string, rounds: number, wins: number, winrate: number, files: string[] }>}
 */
export function controlTeamRows(control, rows, demosByFile, side) {
  /** @type {Map<string, { key: string, name: string, rounds: number, wins: number, files: string[] }>} */
  const byTeam = new Map();
  if (side !== 'T' && side !== 'CT') return [];

  for (const [file, held] of control || []) {
    if (held !== side) continue;
    const row = rows?.get(file);
    const demo = demosByFile?.get(file);
    if (!row || !demo) continue;
    for (const team of [1, 2]) {
      if (sideOfTeam(row, team) !== side) continue;
      const name =
        (team === 1 ? demo.name1 || demo.t1 : demo.name2 || demo.t2) || `Team ${team}`;
      const key = String(name).trim().toLowerCase() || `team${team}`;
      let g = byTeam.get(key);
      if (!g) {
        g = { key, name: String(name).trim() || `Team ${team}`, rounds: 0, wins: 0, files: [] };
        byTeam.set(key, g);
      }
      g.rounds += 1;
      g.files.push(file);
      if (row.w === team) g.wins += 1;
    }
  }

  return [...byTeam.values()]
    .map((g) => ({ ...g, winrate: g.rounds ? (g.wins / g.rounds) * 100 : 0 }))
    .sort((a, b) => b.winrate - a.winrate || b.rounds - a.rounds);
}
