// ---------------------------------------------------------------------------
// shared/sim/firewall.js
// The one-directional rule, as code (12.1).
//
// The sim reads the library, the zone network, the fitted models, and the
// analysis code. It writes nowhere the site can see. Nothing derived from
// simulated play is ever fed back into anything a user touches: not the round
// library, not the pattern finder, not the duel model, not the round model,
// not the stats index, not team pages.
//
// 12.1 gives two reasons and both of them are load-bearing. Analytics that
// users trust must describe games that were played, so the moment a simulated
// round can move a real number, every number on the site becomes a claim about
// this engine's fidelity instead of about Counter-Strike. And the secrecy
// requirement is only as strong as its weakest write path, so there is no
// write path.
//
// Two independent checks, because either one alone has a hole:
//
//   The NAME check (`sim` is a reserved library key) stops the sim tree from
//   being walked as if it were somebody's demo folder. It cannot help once a
//   file has been copied somewhere else.
//
//   The MARKER check (`synthetic: true` in every meta) travels with the file.
//   It cannot help a raw `.ticks` buffer, which carries no meta at all.
//
// Together they cover the two ways a sim round actually reaches an ingest: the
// walker that enumerates directories, and the file that got moved.
//
// This module is pure on purpose — no `node:` imports — because `encode.js`
// stamps the marker and `encode.js` is shared with the browser. Path-level
// enforcement lives where ROOT lives, in `server/replays/demoStore.js`.
// ---------------------------------------------------------------------------

/**
 * The directory under `AIM4_REPLAY_DIR` that the sim owns, and therefore the
 * one library key that may never be read as a library.
 */
export const SIM_LIBRARY_KEY = 'sim';

/**
 * Names under ROOT that are not demo libraries.
 *
 * `zones` was already excluded by hand in `listLibraryUsers`; it is here so
 * that the list of "things under ROOT that are not somebody's demos" is
 * written down once instead of being rediscovered per walker.
 */
export const RESERVED_LIBRARY_KEYS = Object.freeze([SIM_LIBRARY_KEY, 'zones']);

/** The field every sim-written meta carries. Never absent, never false. */
export const SYNTHETIC_KEY = 'synthetic';

/**
 * True when this meta describes a round that was simulated rather than played.
 *
 * Deliberately not `Boolean(meta?.synthetic)`: a meta carrying `synthetic:
 * "false"` (a string, e.g. survived a round trip through form data or a CSV)
 * is exactly the case where a loose truthiness check does the wrong thing in
 * the dangerous direction. Anything present and not explicitly the boolean
 * `false` is treated as synthetic.
 *
 * @param {object|null|undefined} meta
 * @returns {boolean}
 */
export function isSynthetic(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const v = meta[SYNTHETIC_KEY];
  if (v === undefined || v === null) return false;
  return v !== false && v !== 'false';
}

/**
 * True when this library key names the sim tree, or anything else under ROOT
 * that is not a demo library.
 *
 * Compared case-insensitively. On a case-insensitive volume (which is the
 * default on macOS, and `checkCaseSensitivity` exists in the demo store
 * precisely because this repo runs on both) `Sim/` and `sim/` are one
 * directory, so a check that only matched the lowercase spelling would be a
 * check that passes on the developer's laptop and fails on the server.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isReservedLibraryKey(key) {
  const s = String(key || '')
    .trim()
    .toLowerCase();
  return RESERVED_LIBRARY_KEYS.includes(s);
}

/**
 * The error every refusal throws, so a caller can tell the firewall apart
 * from a missing file without parsing prose.
 */
export class FirewallError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'FirewallError';
    /** Machine-readable, for callers that skip rather than abort. */
    this.firewall = true;
  }
}

/**
 * Refuse a library key that names the sim tree.
 *
 * Throws rather than falling back to the default library. A silent redirect
 * would mean a script that asked for sim rounds quietly trains on real ones
 * instead, which is a different wrong answer rather than a refusal.
 *
 * @param {string} key
 * @param {string} [who] caller name, for the message
 */
export function assertNotReservedKey(key, who = 'this reader') {
  if (!isReservedLibraryKey(key)) return;
  throw new FirewallError(
    `${who}: "${key}" is not a demo library (12.1). The sim tree is written, never ingested.`
  );
}

/**
 * Refuse a round whose meta says it was simulated.
 *
 * @param {object|null} meta
 * @param {string} [who] caller name, for the message
 */
export function assertReal(meta, who = 'this reader') {
  if (!isSynthetic(meta)) return;
  throw new FirewallError(
    `${who}: refusing a synthetic round (12.1). Simulated play never feeds the analysis stack.`
  );
}

/**
 * Stamp the marker on a meta on its way to disk.
 *
 * Applied last, after any caller-supplied fields, so nothing upstream can
 * un-set it by passing `synthetic: false` through an `extra` bag. The flag is
 * a fact about where the round came from, not a preference.
 *
 * @template {object} T
 * @param {T} meta
 * @returns {T & {synthetic: true}}
 */
export function markSynthetic(meta) {
  return { ...meta, [SYNTHETIC_KEY]: true };
}

/**
 * The field a round carries when a human called it (6.1 / 11.5).
 *
 * A second firewall beside the synthetic one, and for the same reason: a
 * human call is not evidence about what the Strategy AI would have chosen.
 * Letting one into the experience index teaches the bots that a call they did
 * not make worked; letting one into a BC shard teaches the next generation to
 * imitate a human's decisions through the bots' hands. Both are silent.
 */
export const HUMAN_KEY = 'humanCalled';

/** True when a viewer issued an order in this round, refused or not. */
export function isHumanCalled(meta) {
  if (!meta || typeof meta !== 'object') return false;
  const v = meta[HUMAN_KEY];
  if (v === undefined || v === null) return false;
  return v !== false && v !== 'false';
}

/** Stamp a round as human-called. */
export function markHumanCalled(meta) {
  return { ...meta, [HUMAN_KEY]: true };
}

/**
 * Refuse a round that a human called, for readers that train on rounds.
 *
 * The mirror of `assertReal`: that one keeps simulated rounds out of the demo
 * library, this one keeps human-called rounds out of the learning paths.
 */
export function assertNotHumanCalled(meta, who = 'this reader') {
  if (isHumanCalled(meta)) {
    throw new FirewallError(
      `${who} was handed a human-called round. A human call is not evidence ` +
        'about what the Strategy AI would have chosen (11.5).'
    );
  }
}
