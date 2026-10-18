// ---------------------------------------------------------------------------
// replays/eye/eyeRound.js
// One round's record and its movement, fetched once and kept for a few turns
// of conversation, so the screenshot and value tools can look at the same
// round without downloading it twice.
// ---------------------------------------------------------------------------

import { fetchRoundPacks } from '../api.js';
import { TickTrack } from '../tickStore.js';

/** One sample per this many demo ticks (an eighth of a second at 64 tick). */
const PACK_STRIDE = 8;
const CACHE_SIZE = 4;

/** @type {Map<string, { meta: object, track: TickTrack }>} */
const cache = new Map();

export async function loadRound(file) {
  if (cache.has(file)) {
    const hit = cache.get(file);
    cache.delete(file);
    cache.set(file, hit);
    return hit;
  }
  const packs = await fetchRoundPacks([file], { stride: PACK_STRIDE, ticks: true });
  const pack = packs.get(file);
  if (!pack?.meta || !pack.ticks) throw new Error(`Round "${file}" could not be loaded. Use a file from find_rounds.`);
  const loaded = { meta: pack.meta, track: new TickTrack(pack.ticks) };
  cache.set(file, loaded);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return loaded;
}
