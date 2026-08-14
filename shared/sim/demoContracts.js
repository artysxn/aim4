// ---------------------------------------------------------------------------
// shared/sim/demoContracts.js
// The file formats the demo-driven knowledge pipeline agrees on.
//
// SIM-PLAN 9.3b splits learning from 3,100 real demos into two artefacts, and
// this file is the contract between the four programs that touch them: the
// miner writes tables, the extractor writes samples, the trainer reads both,
// and the bot reads the tables at runtime. Putting the shapes here rather than
// in each script is what lets those four be written and changed independently.
//
// The pipeline, and why it is in this order:
//
//   K0  knowledge tables   what a Banana player KNOWS about Banana before any
//                          gradient step: when it is taken, from where, with
//                          what utility, at what spacing
//   K1  BC samples         what a human actually DID given that knowledge, so
//                          the network learns the residual rather than
//                          rediscovering that Banana T arrives around 1:42
//
// Two rules run through every shape below, and both come from the operator's
// own brief rather than from the plan:
//
//   ONLY WINNERS TEACH. Every table and every training sample is drawn from
//   the side that WON the round. Losing behaviour is still recorded (as the
//   opponent context a winner faced) but never as a label. A bot that learns
//   the average of winners and losers learns to lose half the time.
//
//   THE CALL IS AN INPUT, NOT AN OUTPUT. Every table is keyed by the round
//   library's call and every sample carries it, so "B rush" is a thing that
//   can be COMMANDED at runtime rather than a behaviour that has to be
//   coaxed out of a policy that learned one average round.
// ---------------------------------------------------------------------------

/** Bumped when a table's meaning changes, so a stale bake is refused loudly. */
export const KNOWLEDGE_VERSION = 1;
/** Bumped when the sample schema changes. The trainer refuses a mismatch. */
export const DEMO_DATASET_VERSION = 1;

/**
 * The key every table and every sample is filed under.
 *
 * `contract` is the map position a player occupied (decision 31's contract
 * table): Banana, Apps, Mid. It is the unit of knowledge, because "what does a
 * T do here" has a different answer per position and the same answer across
 * every demo where somebody stood there.
 *
 * @typedef {object} KnowledgeKey
 * @property {string} map       three-letter map code, INF / MIR / ...
 * @property {'T'|'CT'} side
 * @property {string} call      round-library tag key, or 'default'
 * @property {string} contract  contract position id, or 'any'
 */

/**
 * K0's artefact, one file per map:
 *   AIM4_REPLAY_DIR/sim/knowledge/<MAP>.json
 *
 * Every table is a DISTRIBUTION, never a single number. The variance is the
 * honest bound on how much a bot may deviate and still be doing the thing
 * humans do; collapsing it to a median is what makes bots feel scripted.
 *
 * @typedef {object} KnowledgeBake
 * @property {number} v             KNOWLEDGE_VERSION
 * @property {string} map
 * @property {number} rounds        rounds that fed this bake
 * @property {number} wonRounds     of those, the ones that taught it
 * @property {string} builtAt
 * @property {Record<string, ContractTables>} tables  keyed by keyOf()
 */

/**
 * @typedef {object} ContractTables
 * @property {KnowledgeKey} key
 * @property {number} n                      round-tracks behind these numbers
 * @property {Record<string, Dist>} arrival  anchor id -> seconds after live
 *   when a winner first stood there. The timing half of the brief: bots take
 *   the timings winners take.
 * @property {Array<{anchor: string, share: number, seconds: Dist}>} occupancy
 *   where winners actually stood, and for how long. The angle half of the
 *   brief: the anchors a bot should remember, ranked by how often a winning
 *   player was on them.
 * @property {Array<{anchor: string, yaw: Dist, share: number}>} holds
 *   which way they faced while holding, so a remembered angle is an angle and
 *   not just a cell.
 * @property {Array<UtilityRow>} utility     what they threw, from where, when
 * @property {Record<string, Dist>} spacing  other contract -> geodesic gap
 * @property {Record<string, number>} coOccupancy  other contract -> P(alive
 *   and held while this contract is held)
 * @property {Array<{after: string, option: string, p: number}>} reactions
 *   percept class -> what a winner did within 1.5 s. Mini-plays live here.
 * @property {Array<{chain: string[], n: number}>} nGrams  3-option chains
 */

/**
 * @typedef {object} UtilityRow
 * @property {string} type      smokegrenade | flashbang | hegrenade | molotov | incgrenade | decoy
 * @property {string} from      anchor thrown from
 * @property {string} at        anchor it landed on
 * @property {Dist} clock       seconds after live it left the hand
 * @property {number} n
 * @property {number} share     of rounds in this key that threw it at all
 */

/**
 * A distribution, summarized. Enough to sample from and to bound a deviation,
 * small enough that a map's whole bake stays a few megabytes.
 *
 * @typedef {object} Dist
 * @property {number} n
 * @property {number} mean
 * @property {number} sd
 * @property {number} p10
 * @property {number} p50
 * @property {number} p90
 */

/** The one key builder, so the miner and the reader can never disagree. */
export function keyOf({ map, side, call = 'default', contract = 'any' }) {
  return `${map}|${side}|${call || 'default'}|${contract || 'any'}`;
}

export function parseKey(key) {
  const [map, side, call, contract] = String(key).split('|');
  return { map, side, call, contract };
}

/**
 * Summarize samples into a Dist. Percentiles rather than a full histogram:
 * p10/p50/p90 is what a timing window needs, and the tails of a CS timing are
 * mostly rounds that went wrong.
 *
 * @param {number[]} values
 * @returns {Dist|null} null when there is nothing to summarize
 */
export function summarize(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const n = xs.length;
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  const varSum = xs.reduce((s, v) => s + (v - mean) * (v - mean), 0);
  const at = (q) => xs[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  return {
    n,
    mean: round4(mean),
    sd: round4(Math.sqrt(varSum / Math.max(1, n - 1))),
    p10: round4(at(0.1)),
    p50: round4(at(0.5)),
    p90: round4(at(0.9))
  };
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * The minimum evidence a table row needs before a bot is allowed to believe
 * it. Below this the row falls back to the same key with a wider scope (drop
 * the call, then drop the contract), which is the sample-size discipline the
 * plan applies to mimicry and which matters more here: one round is an
 * anecdote and a bot that acts on it looks broken. `[calibrate]`
 */
export const MIN_ROWS = 8;

/**
 * The fallback ladder for a lookup: exact key, then the same contract on any
 * call, then the map/side default. Returns keys in the order to try them.
 */
export function lookupChain({ map, side, call, contract }) {
  const out = [keyOf({ map, side, call, contract })];
  if (contract && contract !== 'any') out.push(keyOf({ map, side, call, contract: 'any' }));
  if (call && call !== 'default') out.push(keyOf({ map, side, call: 'default', contract }));
  out.push(keyOf({ map, side, call: 'default', contract: 'any' }));
  return [...new Set(out)];
}

/**
 * K1's artefact: JSONL, one meta line then one line per decision step.
 *
 * The trainer reads this and nothing else, so everything the network is
 * conditioned on has to be ON the line. That is what makes a commanded call
 * work at inference: the same field that said "this human was running B rush"
 * during training is the field the operator sets at runtime.
 *
 * meta line:
 *   {type:'meta', v, obsVersion, obsSize, vocab, maps, calls, contracts,
 *    players, source, rounds, wonRounds}
 *
 * sample line:
 *   {obs:[float], hist:[[float]], cond:{map,side,call,contract,player},
 *    y:{option, utility, spacingDx, spacingDy, reaction, ttc}, w}
 *
 * `hist` is the last HISTORY_STEPS observations at HISTORY_HZ, oldest first,
 * zero-padded at the start of a round: the plan's temporal encoder needs
 * "wait for the flash, then peek" to be visible in one sample, and an
 * independent 8 Hz cross-entropy cannot see it.
 * `w` is the sample weight (utility and reactions outweigh holds).
 */
export const HISTORY_STEPS = 12;
export const HISTORY_HZ = 4;

/**
 * How a player showed himself. Mined from the pose trace rather than declared,
 * because the operator's ask is that bots COPY how real players peek, and a
 * peek is a shape in position and yaw over about a second:
 *
 *   jiggle       out and back inside the window, minimal ground given
 *   shoulder     a sliver of exposure, back before the shot lands
 *   wide         committed swing at speed, taking the angle outright
 *   hold         planted, letting them come
 *   repeek       out again within a few seconds of the last look
 */
export const PEEK_STYLES = Object.freeze(['none', 'hold', 'jiggle', 'shoulder', 'wide', 'repeek']);

/**
 * The refrag window: a teammate died near me, recently, and what I did next
 * is the thing worth copying. SIM-PLAN 19.9 prices this as a decision; here it
 * is a LABEL, because the demos already contain thousands of humans doing it
 * well. Seconds, and the radius in world units. `[calibrate]`
 */
export const REFRAG_WINDOW_SECONDS = 3.5;
export const REFRAG_RADIUS = 900;

/**
 * Aim, as the label a bot can actually reproduce: the offset in degrees
 * between where the player looked and the bearing to the thing that mattered
 * (the last known enemy, or the cell a teammate just died in). Absolute yaw is
 * map trivia; the offset is the skill.
 */
export const AIM_BUCKETS = Object.freeze([
  'on',      // within 10 degrees: pre-aimed at it
  'near',    // 10 to 35: shoulder of the angle
  'off',     // 35 to 90: watching something else
  'away'     // past 90: back turned to it
]);

/** Percept classes a reaction label is measured against. */
export const PERCEPT_CLASSES = Object.freeze([
  'none',
  'enemy_seen',
  'shot_heard',
  'teammate_died',
  'flash_pop',
  'molotov_landed',
  'smoke_landed',
  'bomb_planted'
]);
