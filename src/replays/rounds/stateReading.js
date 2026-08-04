// ---------------------------------------------------------------------------
// replays/rounds/stateReading.js
// Reading player state defensively, because not every caller has real ticks.
//
// The round model is fed from two very different places. The viewer hands it
// decoded tick records with flags, positions and weapons. The stats index and
// the round-decided detector hand it synthetic stubs built from the kill log:
// `{ alive, health }` and nothing else, because those paths deliberately avoid
// loading tick buffers at all.
//
// Left unguarded that difference is silent and severe rather than loud. A stub
// has no `flags`, and `undefined & FLAG_ALIVE` is 0, so every player reads as
// dead; the bomb race then finds no living CTs and concludes the defuse is
// impossible, which scores every post-plant moment as a certain T win. A model
// that is confidently wrong on the situations it was built for is worse than
// one that admits it cannot see.
//
// So: aliveness accepts either representation, and anything derived from a
// position is gated on the position actually existing. When geometry is
// missing the features go to neutral zero, which contributes nothing through
// the model's weights, and the prediction falls back to bodies, economy, the
// clock and the plant. That is exactly the information the old hand-tuned model
// had, so the degraded reading is no worse than what it replaces.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { FLAG_ALIVE } from '../shared/tickFormat.js';

/**
 * Is this player alive, from either a tick record or a kill-log stub?
 *
 * Tick records carry `flags`; stubs carry a plain `alive` boolean. Health is
 * checked in both cases because a record can be flagged alive at 0 hp on the
 * tick of a death.
 *
 * @param {object|null|undefined} s
 */
export function isAlive(s) {
  if (!s) return false;
  if (typeof s.flags === 'number') {
    if ((s.flags & FLAG_ALIVE) === 0) return false;
  } else if (s.alive !== true) {
    return false;
  }
  return !(s.health <= 0);
}

/** Does this state carry a usable world position? */
export function hasPosition(s) {
  return Boolean(s) && Number.isFinite(s.x) && Number.isFinite(s.y);
}

/**
 * Living players on one side, and whether their positions can be trusted.
 *
 * `positioned` is the subset with real coordinates. Callers that need geometry
 * must use that list and must treat an empty one as "unknown", never as "none
 * of them are there".
 *
 * @returns {{ all: Array, positioned: Array, geometryKnown: boolean }}
 */
export function livingSide(players, states, teamSides, deadIds, side) {
  const all = [];
  const positioned = [];
  for (const p of players || []) {
    if (teamSides?.[p.team] !== side) continue;
    if (deadIds?.has(p.id)) continue;
    const s = states?.[p.slot];
    if (!isAlive(s)) continue;
    const entry = { player: p, state: s };
    all.push(entry);
    if (hasPosition(s)) positioned.push(entry);
  }
  return {
    all,
    positioned,
    // Geometry is only trustworthy when every living player has a position.
    // A partial set would silently answer "nearest enemy" with the nearest of
    // whoever happened to be decoded, which is a different question.
    geometryKnown: all.length > 0 && positioned.length === all.length
  };
}
