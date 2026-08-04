// ---------------------------------------------------------------------------
// replays/rounds/bombRace.js
// The race for the bomb, and who is standing where.
//
// The round model's first version knew the bomb timer but not the geometry
// around it, which left it unable to express the most clear-cut situation in
// the game: a bomb with nine seconds left, a CT side with no kit, and no
// possible way to defuse it whoever is alive. Time alone cannot say that. It
// needs to know how far the nearest CT is, how long a defuse takes, and whether
// those two numbers fit inside the clock.
//
// Everything here is geometry and arithmetic over the painted bombsites and key
// zones. Nothing is weighted; the model decides what any of it is worth.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { FLAG_ALIVE } from '../shared/tickFormat.js';
import { pointInPiece } from '../zones/zoneGeom.js';
import { bombSiteCenters, sanitizeBombSites } from '../zones/bombSites.js';
import { keyZonesFor } from '../zones/keyZones.js';
import { DEFUSE_KIT_DEADLINE, DEFUSE_NO_KIT_DEADLINE } from '../coach/winProbability.js';

/**
 * Ground speed used to turn a distance into a time, world units per second.
 *
 * Deliberately below the 250 a knife-out sprint reaches. A player crossing a
 * map to defuse is holding a rifle, taking corners, and probably checking
 * angles on the way; assuming a straight-line sprint would make the model think
 * defuses are reachable that in practice are not.
 */
export const APPROACH_SPEED = 200;

/** World units used to normalise bomb distances. */
const DIST_SCALE = 2000;

/** Alive players on a side, from the tick states. */
function alivePlayers(players, states, teamSides, deadIds, side) {
  const out = [];
  for (const p of players || []) {
    if (teamSides?.[p.team] !== side) continue;
    if (deadIds?.has(p.id)) continue;
    const s = states?.[p.slot];
    if (!s || (s.flags & FLAG_ALIVE) === 0 || s.health <= 0) continue;
    out.push({ player: p, state: s });
  }
  return out;
}

const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Where the bomb is, or where it is going.
 *
 * After a plant this is the bomb itself. Before one it is the site the T side
 * is closest to, which is the best available guess at where the round is about
 * to happen and is what makes the pre-plant distances mean anything.
 *
 * @returns {{ x: number, y: number, site: 'a'|'b'|null, planted: boolean } | null}
 */
export function bombTarget({ meta, tick, network, tAlive }) {
  const planted = (meta.events?.bomb || []).find(
    (b) => b?.type === 'planted' && (b.tick ?? 0) <= tick
  );
  if (planted && Number.isFinite(planted.x)) {
    return {
      x: planted.x,
      y: planted.y,
      site: planted.site ? String(planted.site).toLowerCase() : null,
      planted: true
    };
  }

  const centers = bombSiteCenters(network);
  const options = [
    centers.a ? { ...centers.a, site: 'a' } : null,
    centers.b ? { ...centers.b, site: 'b' } : null
  ].filter(Boolean);
  if (!options.length || !tAlive?.length) return null;

  // Whichever site the T side is collectively closest to.
  let best = null;
  let bestD = Infinity;
  for (const o of options) {
    let sum = 0;
    for (const t of tAlive) sum += dist2d(t.state, o);
    const mean = sum / tAlive.length;
    if (mean < bestD) {
      bestD = mean;
      best = o;
    }
  }
  return best ? { x: best.x, y: best.y, site: best.site, planted: false } : null;
}

/**
 * @typedef {object} BombRace
 * @property {boolean} known
 * @property {number} ctBombDist    nearest alive CT to the bomb, normalised
 * @property {number} tBombDist     nearest alive T to the bomb, normalised
 * @property {number} bombDistDiff  tBombDist minus ctBombDist, positive favours CT
 * @property {number} ctInSite      alive CTs standing in the bombsite
 * @property {number} tInSite
 * @property {number} keyZoneNet    key zones held by CT minus by T, per zone
 * @property {number} defuseSlack   spare seconds after reaching and defusing
 * @property {boolean} defuseImpossible
 * @property {number} closestCtSlot @property {number} closestTSlot
 */

/**
 * Bomb geometry, site occupancy, key zone possession, and whether a defuse can
 * physically happen at all.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {Array} args.states
 * @param {number} args.tick
 * @param {object|null} args.network
 * @param {Set<string>} args.deadIds
 * @param {{1:string,2:string}} args.teamSides
 * @param {number} args.bombSecondsLeft
 * @param {boolean} args.ctHasKit
 * @returns {BombRace}
 */
export function bombRaceAt({
  meta,
  states,
  tick,
  network,
  deadIds,
  teamSides,
  bombSecondsLeft,
  ctHasKit
}) {
  const empty = {
    known: false,
    ctBombDist: 0,
    tBombDist: 0,
    bombDistDiff: 0,
    ctInSite: 0,
    tInSite: 0,
    keyZoneNet: 0,
    defuseSlack: 0,
    defuseImpossible: false,
    closestCtSlot: -1,
    closestTSlot: -1
  };
  if (!network) return empty;

  const players = meta.players || [];
  const ct = alivePlayers(players, states, teamSides, deadIds, 'CT');
  const t = alivePlayers(players, states, teamSides, deadIds, 'T');
  const target = bombTarget({ meta, tick, network, tAlive: t });
  if (!target) return empty;

  const nearest = (list) => {
    let bestD = Infinity;
    let bestSlot = -1;
    for (const e of list) {
      const d = dist2d(e.state, target);
      if (d < bestD) {
        bestD = d;
        bestSlot = e.player.slot;
      }
    }
    return { d: bestD, slot: bestSlot };
  };
  const nearCt = nearest(ct);
  const nearT = nearest(t);

  // --- who is standing in the site --------------------------------------
  const sites = sanitizeBombSites(network.bombSites);
  const sitePiece = target.site ? sites[target.site] : null;
  let ctInSite = 0;
  let tInSite = 0;
  if (sitePiece) {
    for (const e of ct) if (pointInPiece(e.state.x, e.state.y, sitePiece)) ctInSite++;
    for (const e of t) if (pointInPiece(e.state.x, e.state.y, sitePiece)) tInSite++;
  }

  // --- key zone possession -----------------------------------------------
  // Each painted key zone around the live site is scored for whoever has more
  // bodies in it, and the balance is averaged over the zones. A side holding
  // three of four approach zones owns the fight before it starts.
  let keyZoneNet = 0;
  if (target.site) {
    const zones = keyZonesFor(network, target.site);
    if (zones.length) {
      let net = 0;
      for (const z of zones) {
        let c = 0;
        let tt = 0;
        for (const e of ct) if (pointInPiece(e.state.x, e.state.y, z)) c++;
        for (const e of t) if (pointInPiece(e.state.x, e.state.y, z)) tt++;
        if (c > tt) net += 1;
        else if (tt > c) net -= 1;
      }
      keyZoneNet = net / zones.length;
    }
  }

  // --- can a defuse physically happen ------------------------------------
  // Travel plus defuse against the clock. This is what makes "nine seconds, no
  // kit, and the nearest CT is across the map" a fact rather than a tendency,
  // and it holds however many CTs are alive: five players cannot defuse faster
  // than one.
  let defuseSlack = 0;
  let defuseImpossible = false;
  if (target.planted && bombSecondsLeft > 0) {
    const defuseTime = ctHasKit ? DEFUSE_KIT_DEADLINE : DEFUSE_NO_KIT_DEADLINE;
    if (!ct.length) {
      defuseImpossible = true;
      defuseSlack = -bombSecondsLeft;
    } else {
      const travel = nearCt.d / APPROACH_SPEED;
      defuseSlack = bombSecondsLeft - (travel + defuseTime);
      defuseImpossible = defuseSlack < 0;
    }
  }

  return {
    known: true,
    ctBombDist: Number.isFinite(nearCt.d) ? nearCt.d / DIST_SCALE : 0,
    tBombDist: Number.isFinite(nearT.d) ? nearT.d / DIST_SCALE : 0,
    bombDistDiff: Number.isFinite(nearT.d) && Number.isFinite(nearCt.d)
      ? (nearT.d - nearCt.d) / DIST_SCALE
      : 0,
    ctInSite,
    tInSite,
    keyZoneNet,
    // Clamped so one absurd value cannot dominate a linear term; the sign and
    // the first few seconds either way are the whole signal.
    defuseSlack: Math.max(-20, Math.min(20, defuseSlack)),
    defuseImpossible,
    closestCtSlot: nearCt.slot,
    closestTSlot: nearT.slot
  };
}
