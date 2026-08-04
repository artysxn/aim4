// ---------------------------------------------------------------------------
// scripts/lib/duelCorpus.mjs
// On-disk format for extracted duels, plus the map setup extraction needs.
//
// Extraction takes about twenty seconds over the whole corpus, which is nothing
// once, and far too much to repeat inside a training loop that evaluates
// hundreds of generations. So it happens once and the result is cached here.
//
// Only the fields the model actually reads are written. A full snapshot carries
// plenty that is useful for debugging and useless for fitting, and at forty
// thousand snapshots the difference between keeping it and dropping it is the
// difference between a cache you can load in one gulp and one you cannot.
//
// Node-only.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getZones } from '../../server/zonesStore.js';
import { hasVisionLayers } from '../../src/replays/zones/visionLayers.js';
import {
  hasControlField,
  prepareControlField,
  registerRadarMask
} from '../../src/replays/zones/zoneOverlay.js';
import { getBlockedMask } from '../../src/replays/duels/sightRay.js';
import { loadRadarMask } from './radarMask.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Cache location and format version. Bump the version to force a re-extract. */
export const CACHE_DIR = path.join(__dirname, '../duel-cache');
export const FEATURE_VERSION = 2;

/**
 * Nuke is excluded everywhere.
 *
 * It is the one supported map with no painted vision geometry, and it is the
 * one map whose two floors a flat sight test cannot tell apart. Training on it
 * would mean fitting to a map the vision model cannot represent.
 */
export const SKIP_MAPS = ['NUK'];

const r2 = (v) => Math.round(v * 100) / 100;
/** sinceShot is Infinity when a gun has not been fired; JSON has no Infinity. */
const NEVER_FIRED = 999;

function encodePlayer(p) {
  return {
    s: p.slot,
    w: p.weapon,
    c: p.category,
    pr: p.price,
    ot: p.oneTap ? 1 : 0,
    cy: r2(p.cycleSeconds),
    sp: r2(p.speed),
    hp: p.hp,
    ar: p.armor,
    hm: p.helmet ? 1 : 0,
    fl: r2(p.flash),
    sc: p.scoped ? 1 : 0,
    dk: p.ducking ? 1 : 0,
    ai: p.airborne ? 1 : 0,
    rl: p.reloading ? 1 : 0,
    mg: r2(p.magFraction),
    ss: Number.isFinite(p.sinceShot) ? r2(Math.min(NEVER_FIRED, p.sinceShot)) : NEVER_FIRED
  };
}

function decodePlayer(e) {
  return {
    slot: e.s,
    weapon: e.w,
    category: e.c,
    price: e.pr,
    oneTap: e.ot === 1,
    cycleSeconds: e.cy,
    speed: e.sp,
    hp: e.hp,
    armor: e.ar,
    helmet: e.hm === 1,
    flash: e.fl,
    scoped: e.sc === 1,
    ducking: e.dk === 1,
    airborne: e.ai === 1,
    reloading: e.rl === 1,
    magFraction: e.mg,
    sinceShot: e.ss >= NEVER_FIRED ? Infinity : e.ss
  };
}

const encodeThreat = (t) => ({
  p: encodePlayer(t.p),
  d: r2(t.dist),
  o: r2(t.off),
  // The watched player's own crosshair error toward this extra enemy. Without
  // it the model cannot tell an ambush from a fight the player was ready for.
  so: r2(t.selfOff)
});
const decodeThreat = (t) => ({ p: decodePlayer(t.p), dist: t.d, off: t.o, selfOff: t.so });

export function encodeSample(ctx) {
  const { pair } = ctx;
  return {
    a: encodePlayer(pair.a),
    b: encodePlayer(pair.b),
    d: r2(pair.dist),
    oa: r2(pair.offA),
    ob: r2(pair.offB),
    ia: r2(pair.infoAdvSecs),
    lc: pair.losClear ? 1 : 0,
    ta: ctx.threatsOnA.map(encodeThreat),
    tb: ctx.threatsOnB.map(encodeThreat),
    sa: r2(ctx.spreadA),
    sb: r2(ctx.spreadB)
  };
}

export function decodeSample(e) {
  const a = decodePlayer(e.a);
  const b = decodePlayer(e.b);
  return {
    pair: {
      aSlot: a.slot,
      bSlot: b.slot,
      a,
      b,
      dist: e.d,
      offA: e.oa,
      offB: e.ob,
      infoAdvSecs: e.ia,
      losClear: e.lc === 1
    },
    threatsOnA: e.ta.map(decodeThreat),
    threatsOnB: e.tb.map(decodeThreat),
    spreadA: e.sa,
    spreadB: e.sb
  };
}

/**
 * One labelled duel as a cache line.
 * `y` is 1 when the player listed as A won, which is the target the model's
 * antisymmetric output predicts directly.
 */
export function encodeEpisode(ep) {
  return {
    r: ep.round,
    m: ep.map,
    a: ep.aSlot,
    b: ep.bSlot,
    t0: ep.startTick,
    t1: ep.endTick,
    y: ep.winnerSlot === ep.aSlot ? 1 : 0,
    sg: ep.sighted === false ? 0 : 1,
    s: ep.samples.map(encodeSample)
  };
}

export function decodeEpisode(e) {
  return {
    round: e.r,
    map: e.m,
    aSlot: e.a,
    bSlot: e.b,
    startTick: e.t0,
    endTick: e.t1,
    y: e.y,
    sighted: e.sg === 1,
    // One fight is one vote no matter how long it lasted, so a thirty second
    // standoff cannot outweigh a hundred short duels.
    weight: e.s.length ? 1 / e.s.length : 0,
    samples: e.s.map(decodeSample)
  };
}

/** Cache file for one demo package. */
export function cacheFileFor(demoName) {
  return path.join(CACHE_DIR, `v${FEATURE_VERSION}`, `${demoName}.jsonl`);
}

/**
 * Radar mask, painted zones and wall segments for a map, prepared once.
 *
 * Refuses a map with no painted vision layers rather than quietly falling back
 * to the radar outline. The painted geometry is most of what makes the sight
 * test resemble the game, and a corpus half fitted with it and half without
 * would be worse than either.
 */
export async function prepareMap(mapCode, cache = new Map()) {
  if (cache.has(mapCode)) return cache.get(mapCode);
  const network = await getZones(mapCode);
  if (!network) throw new Error(`${mapCode}: no zone network on this machine`);
  if (!hasVisionLayers(network)) {
    throw new Error(
      `${mapCode}: no painted vision blocks. Run scripts/fetch-zone-networks.mjs first.`
    );
  }
  const mask = await loadRadarMask(mapCode);
  if (!mask) throw new Error(`${mapCode}: no radar PNG`);
  registerRadarMask(mapCode, mask);
  prepareControlField(network, mapCode, null);
  if (!hasControlField(network)) throw new Error(`${mapCode}: could not build the control field`);
  getBlockedMask(network, mapCode);
  cache.set(mapCode, network);
  return network;
}

/** Every cached episode, decoded. */
export async function loadCorpus({ limit = 0, maps = null } = {}) {
  const dir = path.join(CACHE_DIR, `v${FEATURE_VERSION}`);
  let names;
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    throw new Error(`No cache at ${dir}. Run: node scripts/extract-duel-episodes.mjs`);
  }
  if (limit) names = names.slice(0, limit);

  const episodes = [];
  const demos = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(dir, name), 'utf8');
    let header = null;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line);
      if (row.header) {
        header = row;
        continue;
      }
      if (maps?.length && !maps.includes(row.m)) continue;
      episodes.push(decodeEpisode(row));
    }
    demos.push({ name: name.replace(/\.jsonl$/, ''), header });
  }
  return { episodes, demos };
}
