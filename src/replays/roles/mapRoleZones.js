// ---------------------------------------------------------------------------
// Painted-zone aliases for map-specific role assignment
// (INF / DD2 / ANU / CCH / ANC / MIR / NUK).
// Names match the Sites editor zone groups; matching is via normName/nameMatches.
// ---------------------------------------------------------------------------

import { nameMatches, normName } from './regionKeys.js';
import { positionsAtPoint } from '../zones/pointInZone.js';

/** Maps that use zone-presence role rules instead of Pack/Lurk + PSDT. */
export const MAP_ROLE_CODES = new Set(['INF', 'DD2', 'ANU', 'CCH', 'ANC', 'MIR', 'NUK']);

/**
 * Logical zone keys → aliases (already normalized where possible).
 * @type {Record<string, Record<string, string[]>>}
 */
export const MAP_ZONE_ALIASES = {
  INF: {
    pitA: ['pit a'],
    midA: ['mid a'],
    ctLong: ['ct long'],
    bBanana: ['b banana'],
    banana: ['b banana', 'banana'],
    bSite: ['b site'],
    tAps: ['t aps'],
    secondMid: ['2nd mid', 'second mid'],
    ramp: ['ramp t spawn', 'ramp']
  },
  DD2: {
    aLong: ['a long'],
    aCt: ['a ct'],
    aShort: ['a short'],
    aSite: ['a site'],
    bSite: ['b site'],
    bTunnels: ['b tunnels'],
    ctMid: ['ct mid'],
    tLong: ['t long'],
    tMid: ['t mid'],
    tSpawn: ['t spawn'],
    tB: ['t b']
  },
  ANU: {
    aSite: ['a site'],
    aMid: ['a mid'],
    aWater: ['a water'],
    bSite: ['b site'],
    ctCon: ['ct con'],
    ctSpawn: ['ct spawn'],
    tCon: ['t con'],
    tMid: ['t mid'],
    tSpawnBMain: ['t spawn b main', 't spawn + b main']
  },
  CCH: {
    aSite: ['a site'],
    bCheckers: ['b checkers', 'checkers'],
    bSite: ['b site'],
    ctMid: ['ct mid'],
    ctSpawn: ['ct spawn'],
    tA: ['t a'],
    tB: ['t b'],
    tMid: ['t mid']
  },
  ANC: {
    aMain: ['a main'],
    aSite: ['a site'],
    bCave: ['b cave'],
    bRamp: ['b ramp'],
    bSite: ['b site'],
    bStreet: ['b street'],
    ctDonut: ['ct donut', 'donut'],
    ctMid: ['ct mid'],
    ctSpawn: ['ct spawn'],
    tMid: ['t mid'],
    tSpawn: ['t spawn']
  },
  MIR: {
    aJungle: ['a jungle', 'jungle'],
    aSite: ['a site'],
    bAps: ['b aps', 'b apps', 'apartments'],
    bKitchen: ['b kitchen', 'kitchen'],
    bShort: ['b short'],
    bSite: ['b site'],
    ctSpawn: ['ct spawn'],
    mid: ['mid'],
    tA: ['t a'],
    tMid: ['t mid'],
    tSpawn: ['t spawn'],
    underground: ['underground', 'underpass', 'ug']
  },
  NUK: {
    aAnchor: ['a anchor'],
    aDoor: ['a door'],
    ctHeaven: ['ct heaven', 'heaven'],
    ctHell: ['ct hell', 'hell'],
    ctYard: ['ct yard'],
    lobby: ['lobby'],
    ramp: ['ramp', 'lower ramp', 'upper ramp'],
    secret: ['secret'],
    silo: ['silo'],
    tYard: ['t yard'],
    yard: ['yard']
  }
};

/** Painted zones + position names covering a world point. */
export function paintedZonesAt(x, y, network) {
  const posHits = positionsAtPoint(x, y, network);
  if (!posHits.length) return [];
  const ids = new Set(posHits.map((p) => p.id));
  const out = [];
  const seen = new Set();
  for (const z of network?.zones || []) {
    const name = z?.name;
    if (!name || seen.has(name)) continue;
    if ((z.positionIds || []).some((id) => ids.has(id))) {
      out.push(z);
      seen.add(name);
    }
  }
  // Also score bare position names (covers ungrouped paint).
  for (const p of posHits) {
    const name = p?.name;
    if (!name || seen.has(name)) continue;
    out.push({ name, positionIds: [p.id] });
    seen.add(name);
  }
  return out;
}

/**
 * Increment logical zone counters for one sample.
 * @param {Record<string, number>} bag
 * @param {string} mapCode
 * @param {Array<{ name?: string }>} zones
 */
export function bumpZoneHits(bag, mapCode, zones) {
  const aliases = MAP_ZONE_ALIASES[String(mapCode || '').toUpperCase()];
  if (!aliases || !zones?.length) return;
  const hitKeys = new Set();
  for (const z of zones) {
    const raw = z?.name || '';
    if (!raw) continue;
    for (const [key, list] of Object.entries(aliases)) {
      if (hitKeys.has(key)) continue;
      if (nameMatches(raw, list.map(normName))) {
        bag[key] = (bag[key] || 0) + 1;
        hitKeys.add(key);
      }
    }
  }
}

/** Sum of hits for one or more logical zone keys. */
export function zoneScore(bag, ...keys) {
  let s = 0;
  for (const k of keys) s += bag?.[k] || 0;
  return s;
}
