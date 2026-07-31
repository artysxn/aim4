// ---------------------------------------------------------------------------
// Assign T/CT roles from tick samples + bombsite centers (backend index).
//
// T (after AWPer): 2 Pack (highest spatial diversity) + 2 Lurk (lowest),
//   then A/B lurk by closer to bombsite A vs B.
// CT (after AWPer): 2 Anchor (lowest PSDT on full buys) + 2 Rotation,
//   then A/B by rounds closer to each site.
// ---------------------------------------------------------------------------

import { P } from '../shared/statsMath.js';
import { buyBucket } from '../shared/roundId.js';
import { timingFor } from '../viewer/roundClock.js';
import { bombSiteCenters, hasBombSites } from '../zones/bombSites.js';
import {
  avgSiteDistances,
  pulledStringDistance,
  siteAffinity,
  spatialDiversity,
  tSampleTicks
} from './roleMetrics.js';
import { CT_POSITIONS, T_POSITIONS } from './regionKeys.js';

export const ROLES_VERSION = 1;

const SCRATCH = {};

function bareWeapon(weapon) {
  return String(weapon || '')
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, '');
}

function emptyPlayer(id) {
  return {
    id,
    tPoints: [],
    tCloserA: 0,
    tCloserB: 0,
    tDistA: 0,
    tDistB: 0,
    tSiteN: 0,
    ctPsdtSum: 0,
    ctPsdtN: 0,
    ctCloserA: 0,
    ctCloserB: 0,
    tAwpRounds: 0,
    tAwpKills: 0,
    tAwpShots: 0,
    ctAwpRounds: 0,
    ctAwpKills: 0,
    ctAwpShots: 0
  };
}

/** @returns {{ maps: Map<string, Map<number, Map<string, object>>> }} */
export function createRoleWork() {
  return { maps: new Map() };
}

function seat(work, map, team, id) {
  if (!map || !team || !id) return null;
  let byTeam = work.maps.get(map);
  if (!byTeam) {
    byTeam = new Map();
    work.maps.set(map, byTeam);
  }
  let byPlayer = byTeam.get(team);
  if (!byPlayer) {
    byPlayer = new Map();
    byTeam.set(team, byPlayer);
  }
  let p = byPlayer.get(id);
  if (!p) {
    p = emptyPlayer(id);
    byPlayer.set(id, p);
  }
  return p;
}

function samplePath(track, slot, timing, strideTicks) {
  const out = [];
  const start = timing.freezeEndTick;
  const end =
    Number.isFinite(timing.plantTick) && timing.plantTick
      ? Math.min(timing.endTick, timing.plantTick)
      : timing.endTick;
  const step = Math.max(1, strideTicks | 0);
  for (let tick = start; tick <= end; tick += step) {
    const s = track.sample(slot, tick, SCRATCH);
    out.push({ x: s.x, y: s.y, alive: Boolean(s.alive) });
  }
  return out;
}

function heldAwp(track, slot, weapons, timing) {
  const dict = weapons || [];
  const rate = timing.tickRate || 64;
  const start = timing.freezeEndTick;
  const end = timing.endTick;
  const step = Math.max(1, Math.round(rate * 1.5));
  for (let tick = start; tick <= end; tick += step) {
    const s = track.sample(slot, tick, SCRATCH);
    if (!s.alive) continue;
    if (bareWeapon(dict[s.weapon]) === 'awp') return true;
  }
  return false;
}

function roundAwpKills(row, playerId) {
  let n = 0;
  for (const k of row.kt || []) {
    if (k.a === playerId && bareWeapon(k.w) === 'awp') n++;
  }
  return n;
}

/**
 * Accumulate one round into the role work buffer.
 *
 * @param {object} work
 * @param {{ meta: object, track: object, row: object, network: object|null, roster: {id,team,slot}[] }} ctx
 */
export function accumulateRoundRoles(work, ctx) {
  const { meta, track, row, network, roster } = ctx;
  if (!meta || !track || !row || !roster?.length) return;

  const map = meta.map || row.m || '';
  if (!map) return;

  const timing = timingFor(meta);
  const rate = timing.tickRate || 64;
  const centers = bombSiteCenters(network);
  const sitesOk = hasBombSites(network);
  const tTicks = tSampleTicks(timing);
  // ~2 samples/sec is enough for PSDT; denser walks starve the event loop.
  const psdtStride = Math.max(1, Math.round(rate / 2));
  const siteStride = Math.max(1, Math.round(rate * 2));

  for (const who of roster) {
    const team = who.team;
    if (team !== 1 && team !== 2) continue;
    const side = team === 1 ? row.s1 : row.s2;
    if (side !== 'T' && side !== 'CT') continue;
    const slot = who.slot;
    if (slot == null || slot < 0) continue;

    const p = seat(work, map, team, who.id);
    if (!p) continue;

    const line = row.p?.[who.id];
    const awpShots = Array.isArray(line) ? line[P.AWP_SHOTS] || 0 : 0;
    const awpKills = roundAwpKills(row, who.id);
    const awpOut =
      awpShots > 0 || awpKills > 0 || heldAwp(track, slot, meta.weapons, timing);

    if (side === 'T') {
      if (awpOut) p.tAwpRounds++;
      p.tAwpKills += awpKills;
      p.tAwpShots += awpShots;

      for (const tick of tTicks) {
        const s = track.sample(slot, tick, SCRATCH);
        if (!s.alive) continue;
        const pt = { x: s.x, y: s.y };
        p.tPoints.push(pt);
        if (sitesOk) {
          const aff = siteAffinity([pt], centers);
          p.tCloserA += aff.closerA;
          p.tCloserB += aff.closerB;
          p.tDistA += aff.distA;
          p.tDistB += aff.distB;
          p.tSiteN += aff.n;
        }
      }
    } else {
      if (awpOut) p.ctAwpRounds++;
      p.ctAwpKills += awpKills;
      p.ctAwpShots += awpShots;

      const econ = buyBucket(team === 1 ? row.e1 : row.e2);
      if (econ === 4) {
        const path = samplePath(track, slot, timing, psdtStride);
        p.ctPsdtSum += pulledStringDistance(path);
        p.ctPsdtN++;

        if (sitesOk) {
          const sitePts = [];
          for (let tick = timing.freezeEndTick; tick <= timing.endTick; tick += siteStride) {
            const s = track.sample(slot, tick, SCRATCH);
            if (!s.alive) continue;
            sitePts.push({ x: s.x, y: s.y });
          }
          if (sitePts.length) {
            const aff = siteAffinity(sitePts, centers);
            // One vote per full-buy round: majority of samples closer to A or B.
            if (aff.closerA > aff.closerB) p.ctCloserA++;
            else if (aff.closerB > aff.closerA) p.ctCloserB++;
          }
        }
      }
    }
  }
}

function awpScore(p, side) {
  if (side === 'T') {
    return p.tAwpRounds * 1e6 + p.tAwpKills * 1e3 + p.tAwpShots;
  }
  return p.ctAwpRounds * 1e6 + p.ctAwpKills * 1e3 + p.ctAwpShots;
}

function pickMax(list, scoreFn, exclude = new Set()) {
  let best = null;
  let bestScore = -Infinity;
  for (const p of list) {
    if (exclude.has(p.id)) continue;
    const sc = scoreFn(p);
    if (sc > bestScore || (sc === bestScore && best && p.id < best.id)) {
      best = p;
      bestScore = sc;
    }
  }
  return best;
}

function setRole(out, id, key, side) {
  const def = side === 'T' ? T_POSITIONS[key] : CT_POSITIONS[key];
  if (!def || !id) return;
  out[id] = { position: key, label: def.label, tactical: def.tactical };
}

function aLeanT(p) {
  // Prefer more samples closer to A; break ties with lower avg dist to A.
  const closer = (p.tCloserA || 0) - (p.tCloserB || 0);
  const { avgA, avgB } = avgSiteDistances({
    distA: p.tDistA,
    distB: p.tDistB,
    n: p.tSiteN
  });
  const distLean = (Number.isFinite(avgB) ? avgB : 0) - (Number.isFinite(avgA) ? avgA : 0);
  return closer * 1e9 + distLean;
}

function aLeanCT(p) {
  return (p.ctCloserA || 0) - (p.ctCloserB || 0);
}

function assignT(list, sitesOk) {
  /** @type {Record<string, object>} */
  const out = {};
  const taken = new Set();
  const awper = pickMax(list, (p) => awpScore(p, 'T'));
  if (awper && awpScore(awper, 'T') > 0) {
    setRole(out, awper.id, 'awper', 'T');
    taken.add(awper.id);
  }

  const rest = list.filter((p) => !taken.has(p.id));
  // Highest diversity → Pack; lowest → Lurk. Exactly 2 of each among 4 riflers.
  const ranked = [...rest].sort(
    (a, b) =>
      spatialDiversity(b.tPoints) - spatialDiversity(a.tPoints) || a.id.localeCompare(b.id)
  );

  let packIds = [];
  let lurkIds = [];
  if (ranked.length >= 4) {
    packIds = [ranked[0].id, ranked[1].id];
    lurkIds = [ranked[ranked.length - 1].id, ranked[ranked.length - 2].id];
  } else if (ranked.length === 3) {
    packIds = [ranked[0].id, ranked[1].id];
    lurkIds = [ranked[2].id];
  } else if (ranked.length === 2) {
    packIds = [ranked[0].id];
    lurkIds = [ranked[1].id];
  } else if (ranked.length === 1) {
    lurkIds = [ranked[0].id];
  }

  for (const id of packIds) setRole(out, id, 'pack', 'T');

  const lurkers = lurkIds.map((id) => list.find((p) => p.id === id)).filter(Boolean);
  if (lurkers.length === 2 && sitesOk) {
    const [x, y] = lurkers;
    if (aLeanT(x) >= aLeanT(y)) {
      setRole(out, x.id, 'aLurk', 'T');
      setRole(out, y.id, 'bLurk', 'T');
    } else {
      setRole(out, y.id, 'aLurk', 'T');
      setRole(out, x.id, 'bLurk', 'T');
    }
  } else {
    for (const p of lurkers) setRole(out, p.id, 'lurk', 'T');
  }

  // Leftovers (short roster) → Pack.
  for (const p of list) {
    if (!out[p.id]) setRole(out, p.id, 'pack', 'T');
  }
  return out;
}

function assignCT(list, sitesOk) {
  /** @type {Record<string, object>} */
  const out = {};
  const taken = new Set();
  const awper = pickMax(list, (p) => awpScore(p, 'CT'));
  if (awper && awpScore(awper, 'CT') > 0) {
    setRole(out, awper.id, 'awper', 'CT');
    taken.add(awper.id);
  }

  const rest = list.filter((p) => !taken.has(p.id));
  const avgPsdt = (p) => (p.ctPsdtN > 0 ? p.ctPsdtSum / p.ctPsdtN : Infinity);
  const ranked = [...rest].sort(
    (a, b) => avgPsdt(a) - avgPsdt(b) || a.id.localeCompare(b.id)
  );

  let anchors = [];
  let rotations = [];
  if (ranked.length >= 4) {
    anchors = ranked.slice(0, 2);
    rotations = ranked.slice(2, 4);
  } else if (ranked.length === 3) {
    anchors = ranked.slice(0, 2);
    rotations = ranked.slice(2);
  } else if (ranked.length === 2) {
    anchors = [ranked[0]];
    rotations = [ranked[1]];
  } else if (ranked.length === 1) {
    anchors = [ranked[0]];
  }

  const splitAB = (pair, leanFn, aKey, bKey, genericKey) => {
    if (pair.length === 2 && sitesOk) {
      const [x, y] = pair;
      if (leanFn(x) >= leanFn(y)) {
        setRole(out, x.id, aKey, 'CT');
        setRole(out, y.id, bKey, 'CT');
      } else {
        setRole(out, y.id, aKey, 'CT');
        setRole(out, x.id, bKey, 'CT');
      }
    } else {
      for (const p of pair) setRole(out, p.id, genericKey, 'CT');
    }
  };

  splitAB(anchors, aLeanCT, 'aAnchor', 'bAnchor', 'anchor');
  splitAB(rotations, aLeanCT, 'aRotation', 'bRotation', 'rotation');

  for (const p of list) {
    if (!out[p.id]) setRole(out, p.id, 'rotation', 'CT');
  }
  return out;
}

/**
 * Finalize accumulated samples into `entry.roles`.
 * @param {ReturnType<typeof createRoleWork>} work
 * @param {Map<string, boolean>} [sitesByMap] map → has bombsites
 */
export function finalizeRoles(work, sitesByMap = new Map()) {
  /** @type {{ v: number, maps: Record<string, { T: object, CT: object }> }} */
  const roles = { v: ROLES_VERSION, maps: {} };

  for (const [map, byTeam] of work.maps) {
    const sitesOk = sitesByMap.get(map) === true;
    const T = {};
    const CT = {};
    for (const [, byPlayer] of byTeam) {
      const list = [...byPlayer.values()];
      if (!list.length) continue;
      Object.assign(T, assignT(list, sitesOk));
      Object.assign(CT, assignCT(list, sitesOk));
    }
    roles.maps[map] = { T, CT };
  }
  return roles;
}

/**
 * Lookup stored role for a player on a side/map.
 * @param {object|null|undefined} roles  entry.roles
 */
export function roleForPlayer(roles, map, side, playerId) {
  if (!roles?.maps || !map || !side || !playerId) return null;
  return roles.maps[map]?.[side]?.[playerId] || null;
}
