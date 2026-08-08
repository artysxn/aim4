// ---------------------------------------------------------------------------
// Round library tags on a stats row.
//
// Classification is expensive (it walks the tick buffer) and never changes for
// a given round file, so it happens once while the stats index is built and
// rides along on the row as `row.rl`. Everything downstream — the antistrat
// document, the team overview panel — reads tags instead of reopening rounds.
//
// Both sides of every round are tagged, not just the side one team played:
// measuring a call means measuring it from both ends, "how often did our A Fake
// work" and "how often did we hold theirs".
// ---------------------------------------------------------------------------

import { buildRoundFacts } from './roundFacts.js';
import { classifyRoundTypes, hasRoundLibrary } from './roundLibrary.js';

/**
 * Bumped when a definition changes, so stored tags are rebuilt.
 *   1  Nuke
 *   2  Inferno; utility match radius 100 -> 250 units
 *   3  Dust2; the three Nuke smoke walls made mutually exclusive; setup rules
 *      that spawn made true in every round now need a 5s hold
 *   4  Anubis; Dust2 T Short folded into A Short; Mid fight default held 20s
 *      from 1:39
 */
export const ROUND_LIBRARY_VERSION = 4;

/**
 * @typedef {{ k: string, m: Record<string, number> }} RoundTag
 * @typedef {{ v: number, t: RoundTag[], ct: RoundTag[] }} RoundTagBag
 */

const pack = (list) => list.map((x) => ({ k: x.key, m: x.marks }));

/**
 * Tag one round for both sides. Returns an empty bag (not null) on maps with
 * no library, so the "have we done this round yet" test stays a simple
 * presence check rather than a per-map special case.
 *
 * @param {object} args
 * @param {object} args.meta
 * @param {import('../tickStore.js').TickTrack|null} args.track
 * @param {object|null} args.network
 * @param {Array} [args.utilities]
 * @param {string} args.mapCode
 * @returns {RoundTagBag}
 */
export function roundTagsFor({ meta, track, network, utilities = [], mapCode }) {
  const empty = { v: ROUND_LIBRARY_VERSION, t: [], ct: [] };
  if (!hasRoundLibrary(mapCode) || !meta || !track) return empty;
  let facts = null;
  try {
    facts = buildRoundFacts({ meta, track, network, utilities, mapCode });
  } catch {
    return empty;
  }
  if (!facts) return empty;
  return {
    v: ROUND_LIBRARY_VERSION,
    t: pack(classifyRoundTypes(facts.T, mapCode, 'T')),
    ct: pack(classifyRoundTypes(facts.CT, mapCode, 'CT'))
  };
}

/** Tags carried by one side of a stored row. */
export function rowTags(row, side) {
  const bag = row?.rl;
  if (!bag) return [];
  const list = side === 'CT' ? bag.ct : bag.t;
  return Array.isArray(list) ? list : [];
}

/** True when a row already carries current-version tags. */
export function rowTagged(row) {
  return Boolean(row?.rl) && Number(row.rl.v) === ROUND_LIBRARY_VERSION;
}
