// ---------------------------------------------------------------------------
// shared/sim/knowledgeBake.js
// Reading a map's mined knowledge tables at runtime.
//
// The miner (scripts/sim-mine-knowledge.mjs) writes what a POSITION is: where
// winners stand, which way they face, what they throw and when, how far they
// sit from the other contracts. This file is the query surface the caller and
// the arbiter use, so a bot can hold the angles pros hold and throw what they
// throw at the clock they throw it, without either of those modules knowing
// how the JSON is laid out.
//
// Lookup falls through lookupChain (exact call+contract, then wider) and
// refuses a row with fewer than MIN_ROWS samples: one round is an anecdote.
// A miss is ordinary and returns empty, which is the same contract playbook.js
// uses — the arbiter is a better improviser than a badly matched table.
// ---------------------------------------------------------------------------

import { KNOWLEDGE_VERSION, lookupChain, MIN_ROWS } from './demoContracts.js';

/**
 * Whether `seconds` after live sits inside a Dist's usual window.
 * A missing Dist is a match: the miner did not constrain the clock.
 */
export function clockCovers(dist, seconds, pad = 3) {
  if (!dist || !Number.isFinite(seconds)) return true;
  if (Number.isFinite(dist.p10) && Number.isFinite(dist.p90)) {
    return seconds >= dist.p10 - pad && seconds <= dist.p90 + pad;
  }
  if (Number.isFinite(dist.mean)) {
    const sd = Number.isFinite(dist.sd) ? dist.sd : 8;
    return Math.abs(seconds - dist.mean) <= sd + pad;
  }
  return true;
}

/**
 * Validate and wrap a parsed knowledge JSON.
 *
 * @param {object} json
 * @returns {{
 *   map: string,
 *   rounds: number,
 *   tablesFor: Function,
 *   anglesFor: Function,
 *   utilityFor: Function,
 *   spacingFor: Function
 * }}
 */
export function loadKnowledge(json) {
  if (!json || json.v !== KNOWLEDGE_VERSION) {
    throw new Error(`knowledge: bake version ${json?.v} is not ${KNOWLEDGE_VERSION}`);
  }
  const tables = json.tables || {};

  function tablesFor(keyParts) {
    let fallback = null;
    for (const k of lookupChain(keyParts)) {
      const t = tables[k];
      if (!t) continue;
      if ((t.n || 0) >= MIN_ROWS) return t;
      if (!fallback) fallback = t;
    }
    return fallback;
  }

  /**
   * Anchors winners occupied, with the facing they held. Ranked by share.
   * `yaw` is degrees (circular mean from the miner), or null when nobody stood.
   */
  function anglesFor(keyParts) {
    const t = tablesFor(keyParts);
    return (t?.occupancy || []).map((o) => ({
      anchor: o.anchor,
      share: o.share || 0,
      yaw: o.yaw ?? null,
      seconds: o.seconds
    }));
  }

  /** Utility rows: {type, from, at, clock Dist, share, n}. */
  function utilityFor(keyParts) {
    return tablesFor(keyParts)?.utility || [];
  }

  /** other-contract -> Dist of geodesic gap. */
  function spacingFor(keyParts) {
    return tablesFor(keyParts)?.spacing || {};
  }

  return {
    map: json.map,
    rounds: json.rounds || 0,
    wonRounds: json.wonRounds || 0,
    tablesFor,
    anglesFor,
    utilityFor,
    spacingFor
  };
}
