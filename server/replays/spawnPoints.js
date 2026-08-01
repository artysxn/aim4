// ---------------------------------------------------------------------------
// replays/spawnPoints.js
// Where players actually start a round on a map, read out of parsed demos.
//
// The Strategy Creator needs real spawn points rather than a hand-drawn list,
// so this samples player positions at freeze end across a handful of rounds and
// keeps the distinct ones. Two players standing 20 units apart are the same
// spawn as far as a strat is concerned; MIN_SEPARATION is what "distinct" means.
//
// Results are cached per map: the answer only changes when demos are added, and
// reading tick files is the expensive part.
// ---------------------------------------------------------------------------

import { TickTrack } from '../../src/replays/tickStore.js';
import { timingFor } from '../../src/replays/viewer/roundClock.js';

/** Spawns closer together than this are treated as one. */
export const MIN_SEPARATION = 30;

/** Rounds sampled per map. More rounds, more of the rarely used spawns. */
const ROUNDS_SAMPLED = 12;

const CACHE_MS = 10 * 60 * 1000;
/** mapCode -> { at, spawns } */
const cache = new Map();

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * @param {object} io  { readRoundMeta, readRoundTicks }
 * @param {string} user
 * @param {object[]} records  demo records the caller may see
 * @param {string} mapCode
 * @returns {Promise<Array<{id: string, side: 'T'|'CT', x: number, y: number, z: number, seen: number}>>}
 */
export async function spawnsForMap(io, user, records, mapCode) {
  const map = String(mapCode || '').toUpperCase();
  if (!map) return [];

  const hit = cache.get(map);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.spawns;

  const onMap = (records || []).filter(
    (r) => (r.status || 'ready') === 'ready' && (r.map || '') === map && (r.rounds || []).length
  );
  if (!onMap.length) return [];

  // Spread the sample across demos rather than taking one match's dozen rounds:
  // a single demo only ever shows the spawns those ten players used.
  const files = [];
  for (let i = 0; files.length < ROUNDS_SAMPLED && i < 40; i++) {
    for (const record of onMap) {
      const rounds = record.rounds || [];
      if (i >= rounds.length) continue;
      if (rounds[i]?.file) files.push(rounds[i].file);
      if (files.length >= ROUNDS_SAMPLED) break;
    }
    if (!onMap.some((r) => (r.rounds || []).length > i + 1)) break;
  }

  /** @type {Array<{id: string, side: string, x: number, y: number, z: number, seen: number}>} */
  const spawns = [];

  for (const file of files) {
    let meta = null;
    try {
      meta = await io.readRoundMeta(user, file);
    } catch {
      meta = null;
    }
    if (!meta?.players?.length) continue;

    let buffer = null;
    try {
      // The coarse pass is precomputed, and a spawn point does not need
      // full-rate ticks.
      buffer = await io.readRoundTicks(user, file, 100);
    } catch {
      buffer = null;
    }
    if (!buffer) continue;

    let track;
    try {
      track = new TickTrack(buffer);
    } catch {
      continue;
    }

    const timing = timingFor(meta);
    const sides = { 1: meta.team1Side || 'T', 2: meta.team2Side || 'CT' };
    // A shade before the gun goes: still standing on the spawn, and the tick is
    // guaranteed to exist in every recording.
    const at = Math.max(timing.startTick, timing.freezeEndTick - Math.round(timing.tickRate / 2));

    for (const p of meta.players) {
      if (!Number.isFinite(p.slot)) continue;
      const s = track.sample(p.slot, at, {});
      if (!s?.alive) continue;
      const point = { x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z) };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      // No origin guard: (0, 0) is inside the playable area on several maps,
      // and a zeroed record from a bad parse is already excluded by `alive`.
      const side = sides[p.team] === 'CT' ? 'CT' : 'T';

      const near = spawns.find((sp) => sp.side === side && dist2(sp, point) < MIN_SEPARATION ** 2);
      if (near) {
        near.seen++;
        continue;
      }
      spawns.push({
        id: `sp_${side}_${point.x}_${point.y}`,
        side,
        x: point.x,
        y: point.y,
        z: point.z,
        seen: 1
      });
    }
  }

  // Most-used first: the five a team actually spawns on lead the list.
  spawns.sort((a, b) => b.seen - a.seen || a.side.localeCompare(b.side));
  cache.set(map, { at: Date.now(), spawns });
  return spawns;
}

/** Called when the library changes so a new demo's spawns show up. */
export function forgetSpawnCache(mapCode = '') {
  if (mapCode) cache.delete(String(mapCode).toUpperCase());
  else cache.clear();
}
