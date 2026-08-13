// ---------------------------------------------------------------------------
// shared/sim/policy.js
// The JS forward pass: a trained policy, run where the bots run.
//
// SIM-PLAN 9.3's split: the trainer is Python (scripts/sim-train-bc.py), the
// inference is THIS file, and the artifact between them is a JSON weights
// file small enough to read and version. No runtime dependency crosses the
// boundary — the sim must run the policy at 780x realtime in node and in the
// browser, and a tensor library in the hot loop is how that dies.
//
// The contract is checked at load, loudly: the model carries the observation
// version it was trained on (observe.js) and the option vocabulary its head
// indexes. A vector laid out for a different version fails at load time, not
// as a bot that confidently wants the wrong things.
//
// What the policy returns is PROPOSALS: probabilities over the option
// vocabulary. Selection stays with the arbiter (6.17) — the learned desire
// proposes, foresight prices the top few, forced rules still outrank
// everything, and an unconfident head falls through to the scripted desire,
// which is Dota's nil pattern and the reason a half-trained model degrades
// to P3b instead of to chaos.
//
// Version 2 adds the player-mimic embedding of SIM-PLAN 9.3 — a 16-d vector
// per player key, trained jointly with the head — which is 10.3's layer 1:
// setting a bot to a key biases tempo, aggression and habits toward that
// player. The embedding is appended to the observation BEFORE the first
// layer, so the forward loop does not change shape-wise; the model just
// reads a wider input. probs() takes the key as an optional second argument:
// a v1 model ignores it, a v2 model looks it up and falls back to the shared
// default row (the average player) for unseen keys, so every existing call
// site — the arbiter tap in desireBot.js included — keeps working unchanged.
// ---------------------------------------------------------------------------

import { OBSERVATION_SIZE, OBSERVE_VERSION } from './observe.js';
import { OPTION_DEFS } from './options.js';

/** The highest model version this build loads; v1 files still load. */
export const POLICY_VERSION = 2;

/**
 * Below this top-probability over the CANDIDATE set the head is guessing,
 * and the scripted desire decides instead. `[calibrate against val accuracy]`
 */
export const CONFIDENCE_FLOOR = 0.15;

/**
 * Load and validate a trained policy.
 *
 * @param {object} json  the trainer's artifact:
 *   {v, obsVersion, vocab: string[], activation: 'tanh',
 *    layers: [{W: number[][], b: number[]}, ...]}
 *   and, when v === 2, the jointly trained player embedding (SIM-PLAN 9.3):
 *   {embed: {dim, default: number[], players: {key: number[]}}}
 * @returns {{vocab: string[],
 *            probs(obs: number[], playerKey?: string): Map<string, number>}}
 */
export function loadPolicy(json) {
  if (!json || (json.v !== 1 && json.v !== POLICY_VERSION)) {
    throw new Error(`policy: version ${json?.v} is not 1..${POLICY_VERSION}`);
  }
  if (json.obsVersion !== OBSERVE_VERSION) {
    throw new Error(
      `policy: trained on observation v${json.obsVersion}, this build speaks v${OBSERVE_VERSION}`
    );
  }
  if (!Array.isArray(json.vocab) || !json.vocab.length) {
    throw new Error('policy: no vocabulary');
  }
  for (const id of json.vocab) {
    if (!OPTION_DEFS[id]) throw new Error(`policy: vocab entry ${id} is not an option`);
  }
  if (json.activation !== 'tanh') {
    throw new Error(`policy: unknown activation ${json.activation}`);
  }

  // The v2 embedding, checked as loudly as everything else: every row —
  // default included — must be exactly `dim` floats, and the first layer
  // must read exactly obs + dim. A Map keeps hostile keys ("toString")
  // from reaching Object.prototype.
  const embed = json.v === 2 ? json.embed : null;
  let embedRows = null;
  if (json.v === 2) {
    if (!embed || !Number.isInteger(embed.dim) || embed.dim < 1) {
      throw new Error(`policy: v2 model carries no usable embed.dim (${embed?.dim})`);
    }
    if (!Array.isArray(embed.default) || embed.default.length !== embed.dim) {
      throw new Error(
        `policy: embed default row is ${embed.default?.length} floats, dim says ${embed.dim}`
      );
    }
    embedRows = new Map(Object.entries(embed.players ?? {}));
    for (const [key, row] of embedRows) {
      if (!Array.isArray(row) || row.length !== embed.dim) {
        throw new Error(`policy: embed row for ${key} is ${row?.length} floats, dim says ${embed.dim}`);
      }
    }
  }
  const inputWidth = OBSERVATION_SIZE + (embed ? embed.dim : 0);

  const layers = json.layers;
  if (!Array.isArray(layers) || layers.length < 1) throw new Error('policy: no layers');
  if (layers[0].W[0].length !== inputWidth) {
    throw new Error(
      `policy: first layer reads ${layers[0].W[0].length} floats, observations${
        embed ? ' + embedding' : ''
      } carry ${inputWidth}`
    );
  }
  const lastW = layers[layers.length - 1].W;
  if (lastW.length !== json.vocab.length) {
    throw new Error(
      `policy: head emits ${lastW.length} logits for a ${json.vocab.length}-word vocabulary`
    );
  }

  function forward(obs) {
    let x = obs;
    for (let l = 0; l < layers.length; l += 1) {
      const { W, b } = layers[l];
      const y = new Array(W.length);
      for (let i = 0; i < W.length; i += 1) {
        let s = b[i];
        const row = W[i];
        for (let j = 0; j < row.length; j += 1) s += row[j] * x[j];
        y[i] = l < layers.length - 1 ? Math.tanh(s) : s;
      }
      x = y;
    }
    return x;
  }

  return {
    vocab: [...json.vocab],

    /**
     * Softmax over the vocabulary. Stable: the max logit is subtracted.
     * `playerKey` is 10.3's conditioning knob: a v1 model ignores it, a v2
     * model appends that player's embedding — or the default row when the
     * key is absent or unseen — to the observation before the forward pass.
     */
    probs(obs, playerKey) {
      if (obs.length !== OBSERVATION_SIZE) {
        throw new Error(`policy: observation is ${obs.length} floats, expected ${OBSERVATION_SIZE}`);
      }
      const x = embed ? obs.concat(embedRows.get(playerKey) ?? embed.default) : obs;
      const logits = forward(x);
      let max = -Infinity;
      for (const z of logits) if (z > max) max = z;
      let total = 0;
      const exps = logits.map((z) => {
        const e = Math.exp(z - max);
        total += e;
        return e;
      });
      const out = new Map();
      for (let i = 0; i < json.vocab.length; i += 1) out.set(json.vocab[i], exps[i] / total);
      return out;
    }
  };
}

/**
 * Fold a policy's proposals into a candidate list as priors (6.17's hybrid):
 * the learned desire proposes, the arbiter still decides. Probabilities are
 * renormalized over the candidates actually on offer, and a head whose best
 * candidate is below the confidence floor changes nothing — the nil pattern.
 *
 * @param {Array} candidates  arbiter candidates, mutated in place
 * @param {Map<string, number>} probs  from policy.probs
 * @returns {boolean} whether the proposals were applied
 */
export function applyProposals(candidates, probs) {
  let total = 0;
  for (const c of candidates) total += probs.get(c.id) ?? 0;
  if (!(total > 0)) return false;
  let best = 0;
  for (const c of candidates) best = Math.max(best, (probs.get(c.id) ?? 0) / total);
  if (best < CONFIDENCE_FLOOR) return false;
  for (const c of candidates) {
    if (c.forced) continue; // rules outrank learning, always
    c.prior = (probs.get(c.id) ?? 0) / total;
  }
  return true;
}
