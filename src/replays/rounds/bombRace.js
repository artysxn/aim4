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

import { pointInPiece } from '../zones/zoneGeom.js';
import { livingSide } from './stateReading.js';
import { bombSiteCenters, sanitizeBombSites } from '../zones/bombSites.js';
import { keyZonesFor } from '../zones/keyZones.js';
import { pathDistanceField } from '../zones/pathDistance.js';
import { DEFUSE_KIT_DEADLINE, DEFUSE_NO_KIT_DEADLINE } from '../coach/winProbability.js';

/**
 * Ground speed used to turn a distance into a time, world units per second.
 *
 * Deliberately below the 250 a knife-out sprint reaches: a player crossing a
 * map to defuse is holding a rifle and probably checking angles on the way.
 *
 * This used to be carrying a second job. When distance was a straight line
 * through walls, the low speed was also standing in for the detour the line
 * ignored. Distance is now measured on the walkable raster, so the geometry
 * pays for itself and this is only the behavioural discount it claims to be.
 */
export const APPROACH_SPEED = 200;

/** World units used to normalise bomb distances. */
const DIST_SCALE = 2000;

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
  mapCode = '',
  deadIds,
  teamSides,
  bombSecondsLeft,
  ctHasKit
}) {
  const empty = {
    known: false,
    geometryKnown: false,
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
  const ctSide = livingSide(players, states, teamSides, deadIds, 'CT');
  const tSide = livingSide(players, states, teamSides, deadIds, 'T');

  // Without positions there is no race to describe. Returning the neutral bag
  // is the whole point: a kill-log stub knows who is alive but not where they
  // are, and guessing would mean declaring defuses impossible on every
  // post-plant sample.
  if (!ctSide.geometryKnown && !tSide.geometryKnown) return empty;

  const ct = ctSide.positioned;
  const t = tSide.positioned;
  const target = bombTarget({ meta, tick, network, tAlive: t });
  if (!target) return empty;

  // Distance on foot where the walkable raster is available, straight line
  // where it is not. The difference is not cosmetic: a straight line through a
  // wall makes a defuse look reachable that in practice cannot be started, and
  // that is exactly the situation the defuse slack term exists to catch.
  const field = mapCode ? pathDistanceField(mapCode, target.x, target.y) : null;
  const distTo = (state) => {
    const walked = field?.distanceTo(state.x, state.y);
    return Number.isFinite(walked) ? walked : dist2d(state, target);
  };

  const nearest = (list) => {
    let bestD = Infinity;
    let bestSlot = -1;
    for (const e of list) {
      const d = distTo(e.state);
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
  const sitePieces = target.site ? sites[target.site] || [] : [];
  let ctInSite = 0;
  let tInSite = 0;
  if (sitePieces.length) {
    const inSite = (state) => sitePieces.some((p) => pointInPiece(state.x, state.y, p));
    for (const e of ct) if (inSite(e.state)) ctInSite++;
    for (const e of t) if (inSite(e.state)) tInSite++;
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
  if (target.planted && bombSecondsLeft > 0 && ctSide.geometryKnown) {
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
    geometryKnown: ctSide.geometryKnown && tSide.geometryKnown,
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
