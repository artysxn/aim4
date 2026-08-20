// ---------------------------------------------------------------------------
// replays/strategy/roundRoles.js
// Which of the five bodies on a side belongs in which stratbook column.
//
// The stratbook's role columns ARE the position vocabulary (teamPositions.js):
// Mirage T is Rotation / A Lurk / B / UG / AWPer / Mid, in that order, and
// `roleNotes[i]` is the note under column `i`. The Statistics database already
// answers "who plays which of those" with the painted-zone ruleset in
// computeRoles.js, so nothing here re-invents the assignment — it reads the
// same answer and seats it.
//
// Where the answer comes from, in order:
//
//   1. The demo's stored roles (`entry.roles`), computed by the stats index
//      over every round of that match. That is the twelve-round scan and more.
//   2. Other demos in the library with the SAME five players on the same map,
//      merged by majority vote. This is the "the round is the only round"
//      case: one demo cannot say much, several can.
//   3. A local walk over whatever rounds are in hand, through the identical
//      accumulate/finalize pair the backend uses.
//
// Two players landing on one label, or a map with no rule set for its columns
// (Overpass has stratbook columns but no painted-zone rules), fall through to
// the same place: the contested seat is decided by coin flip and whoever is
// left fills the empty columns. A strategy still gets created — the notes are
// what matter, and a coach can drag a column's text sideways.
// ---------------------------------------------------------------------------

import {
  accumulateRoundRoles,
  createRoleWork,
  finalizeRoles,
  roleForPlayer
} from '../roles/computeRoles.js';
import { positionsFor } from '../roles/teamPositions.js';
import { hasBombSites } from '../zones/bombSites.js';
import { hasKeyZones } from '../zones/keyZones.js';

/** Rounds the local walk looks at when it has to run. */
export const ROLE_SCAN_ROUNDS = 12;

/** Fisher-Yates on a copy. The spec asks for "at random" on every tie. */
function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Seat five players into a map's stratbook columns.
 *
 * @param {object} args
 * @param {string} args.mapCode
 * @param {'T'|'CT'} args.side
 * @param {string[]} args.playerIds   the five on that side, roster order
 * @param {object|null} args.roles    entry.roles shape ({ v, maps })
 * @returns {{ columns: string[], seats: string[], matched: number }}
 *   `seats[i]` is the player id for `columns[i]`, or '' when nobody is left.
 *   `matched` counts seats filled by the ruleset rather than by coin flip.
 */
export function seatPlayers({ mapCode, side, playerIds, roles }) {
  const columns = positionsFor(side, mapCode);
  const seats = columns.map(() => '');
  const ids = (playerIds || []).filter(Boolean);
  if (!columns.length) return { columns, seats, matched: 0 };

  /** label → every player the ruleset gave that label. */
  const byLabel = new Map();
  const unlabelled = [];
  for (const id of ids) {
    const label = roleForPlayer(roles, mapCode, side, id)?.label || '';
    if (!label) {
      unlabelled.push(id);
      continue;
    }
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(id);
  }

  const spare = [...unlabelled];
  let matched = 0;
  for (const [label, group] of byLabel) {
    const col = columns.indexOf(label);
    if (col < 0) {
      // A label the ruleset knows but this map's columns do not (generic
      // Pack/Lurk on a map without painted rules). Nobody owns a seat by it.
      spare.push(...group);
      continue;
    }
    // Two players with the same role: between them, pick at random.
    const order = group.length === 1 ? group : shuffled(group);
    seats[col] = order[0];
    matched += 1;
    spare.push(...order.slice(1));
  }

  const rest = shuffled(spare);
  for (let i = 0; i < seats.length && rest.length; i++) {
    if (!seats[i]) seats[i] = rest.shift();
  }
  return { columns, seats, matched };
}

/**
 * A stats-index round row good enough for `accumulateRoundRoles`, built from
 * the round meta alone.
 *
 * The real row carries per-player AWP shot counts; without the index those are
 * zero, which only means the AWPer is decided by held-weapon sampling and AWP
 * kills instead. Every other field the accumulator reads is in the meta.
 */
export function rowFromMeta(meta) {
  const kills = meta?.events?.kills || [];
  return {
    m: meta?.map || '',
    s1: meta?.team1Side || 'T',
    s2: meta?.team2Side || (meta?.team1Side === 'T' ? 'CT' : 'T'),
    e1: meta?.econ1 ?? 0,
    e2: meta?.econ2 ?? 0,
    p: {},
    kt: kills.map((k) => ({ a: k.attacker, w: k.weapon }))
  };
}

/** Geometry flags `finalizeRoles` needs to know an A/B split is possible. */
export function siteFlagsFor(mapCode, network) {
  const bomb = hasBombSites(network);
  return new Map([[mapCode, { bomb, ct: bomb || hasKeyZones(network) }]]);
}

/**
 * Run the backend ruleset locally over rounds already in hand.
 *
 * @param {Array<{ meta: object, track: object }>} loaded
 * @param {object|null} network
 * @param {string} mapCode
 * @returns {object} entry.roles shape
 */
export function rolesFromLoadedRounds(loaded, network, mapCode) {
  const work = createRoleWork();
  for (const { meta, track } of loaded || []) {
    if (!meta || !track) continue;
    accumulateRoundRoles(work, {
      meta,
      track,
      row: rowFromMeta(meta),
      network,
      roster: (meta.players || []).map((p) => ({ id: p.id, team: p.team, slot: p.slot }))
    });
  }
  return finalizeRoles(work, siteFlagsFor(mapCode, network));
}

/**
 * Majority vote across several demos' stored roles.
 *
 * Used when the demo on screen is thin — one bookmarked round out of a package
 * that has no others. Every library demo whose roster on this map/side is the
 * same five players gets one vote per player, and the label with the most
 * votes wins. Ties go to the first demo seen, which is the newest.
 *
 * @param {Array<object>} demos       stats index entries
 * @param {string} mapCode
 * @param {'T'|'CT'} side
 * @param {string[]} playerIds
 * @returns {object|null} entry.roles shape, or null when nothing matched
 */
export function mergeRolesAcrossDemos(demos, mapCode, side, playerIds) {
  const want = new Set(playerIds.filter(Boolean));
  if (want.size < 2) return null;

  /** playerId → label → votes */
  const votes = new Map();
  let sources = 0;
  for (const demo of demos || []) {
    const bag = demo?.roles?.maps?.[mapCode]?.[side];
    if (!bag) continue;
    const present = Object.keys(bag).filter((id) => want.has(id));
    // The same five, not merely an overlapping four: a different fifth player
    // shifts everyone else's role and would poison the vote.
    if (present.length !== want.size) continue;
    sources += 1;
    for (const id of present) {
      const label = bag[id]?.label || '';
      if (!label) continue;
      if (!votes.has(id)) votes.set(id, new Map());
      const tally = votes.get(id);
      tally.set(label, (tally.get(label) || 0) + 1);
    }
  }
  if (!sources) return null;

  const bag = {};
  for (const [id, tally] of votes) {
    let best = '';
    let bestN = 0;
    for (const [label, n] of tally) {
      if (n > bestN) {
        best = label;
        bestN = n;
      }
    }
    if (best) bag[id] = { position: '', label: best, tactical: '' };
  }
  return Object.keys(bag).length ? { v: 0, maps: { [mapCode]: { [side]: bag } } } : null;
}

/** True when every player on the side got a label out of `roles`. */
export function rolesCoverSide(roles, mapCode, side, playerIds) {
  return (playerIds || []).every((id) => Boolean(roleForPlayer(roles, mapCode, side, id)?.label));
}
