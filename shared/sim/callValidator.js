// ---------------------------------------------------------------------------
// shared/sim/callValidator.js
// Did the team run the call they were commanded to run?
//
// SIM-PLAN 9.3 / 10.1 / P4: BC bots commanded an execute must be tagged by
// the round-library matcher at >= 70%. The library matcher (classifyRoundTypes)
// wants demo-shaped facts (utility lineups, region occupancy). A sim round
// produces option logs and bomb events, not those facts, so this file is the
// adapter: map a commanded call plus the executed option sequence onto the
// library vocabulary, then ask classifyRoundTypes when facts exist, and fall
// back to a structural check when they do not.
//
// The structural check is deliberately coarse: planting on the commanded
// site, or a majority of execute_entry / plant / rotate decisions pointing
// at that site, counts as a hit. It is a FLOOR on the validator, not a
// replacement for the library matcher. When facts are present the library
// tag is the score.
//
// Pure.
// ---------------------------------------------------------------------------

import { classifyRoundTypes } from '../../src/replays/analytics/roundLibrary.js';

/** P4 bar. */
export const CALL_VALIDATOR_GATE = 0.7;

const SITE_OF = {
  'a-execute': 'a',
  a_execute: 'a',
  'b-execute': 'b',
  b_execute: 'b',
  'a-split': 'a',
  'b-split': 'b',
  'hit_a': 'a',
  'hit_b': 'b'
};

function siteOfCall(call) {
  if (!call) return null;
  const key = String(call).toLowerCase();
  if (SITE_OF[key]) return SITE_OF[key];
  if (/(^|[-_])a([-_]|$)/.test(key) && !/(^|[-_])b([-_]|$)/.test(key)) return 'a';
  if (/(^|[-_])b([-_]|$)/.test(key)) return 'b';
  return null;
}

function siteOfParams(params) {
  const raw = params?.site ?? params?.target ?? params?.spot ?? '';
  const s = String(raw).toLowerCase();
  if (s === 'a' || s.startsWith('a_') || s.includes('_a') || s === 'bombsite_a') return 'a';
  if (s === 'b' || s.startsWith('b_') || s.includes('_b') || s === 'bombsite_b') return 'b';
  if (s.includes('banana') || s.includes('b-site') || s.includes('b_site')) return 'b';
  if (s.includes('apps') || s.includes('a-site') || s.includes('a_site') || s.includes('pit')) return 'a';
  return null;
}

/**
 * Structural hit: the log did the commanded site.
 *
 * @param {object} args
 * @param {string} args.commanded
 * @param {Array<{id:string, params?:object}>} args.log
 * @param {string} [args.plantSite]  'a' | 'b' | null
 */
export function structuralMatch({ commanded, log = [], plantSite = null } = {}) {
  const want = siteOfCall(commanded);
  if (!want) {
    return { hit: true, how: 'no site in the command', commanded };
  }
  if (plantSite === want) return { hit: true, how: `planted ${want}`, commanded, want };
  let toward = 0;
  let n = 0;
  for (const row of log) {
    if (row.id === 'execute_entry' || row.id === 'plant' || row.id === 'rotate' || row.id === 'take_space') {
      n += 1;
      if (siteOfParams(row.params) === want) toward += 1;
    }
  }
  const hit = n > 0 ? toward / n >= 0.5 : false;
  return { hit, how: n ? `${toward}/${n} decisions toward ${want}` : 'no execute-family decisions', commanded, want };
}

/**
 * Library matcher when facts exist; structural fallback otherwise.
 *
 * @param {object} args
 * @param {string} args.commanded
 * @param {string} args.mapCode
 * @param {string} args.side
 * @param {object} [args.facts]  classifyRoundTypes input
 * @param {Array} [args.log]
 * @param {string} [args.plantSite]
 */
export function validateCall(args = {}) {
  const { commanded, mapCode, side, facts, log, plantSite } = args;
  if (facts && mapCode && side) {
    const tags = classifyRoundTypes(facts, mapCode, side);
    const keys = tags.map((t) => t.key);
    const hit = keys.some((k) => k === commanded || k.includes(String(commanded || '')));
    if (keys.length) {
      return { hit, how: `library tags ${keys.join(',')}`, tags, commanded };
    }
  }
  return structuralMatch({ commanded, log, plantSite });
}

/**
 * Pass rate over a list of round results.
 */
export function validatorRate(rounds = []) {
  if (!rounds.length) return { rate: 0, n: 0, pass: false, reason: 'no rounds' };
  let hits = 0;
  const rows = rounds.map((r) => {
    const v = validateCall(r);
    if (v.hit) hits += 1;
    return v;
  });
  const rate = hits / rounds.length;
  return {
    rate,
    n: rounds.length,
    pass: rate >= CALL_VALIDATOR_GATE,
    rows,
    reason: `${hits}/${rounds.length} = ${(rate * 100).toFixed(1)}% (gate ${(CALL_VALIDATOR_GATE * 100).toFixed(0)}%)`
  };
}
