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

/** The highest model version this build loads; v1 and v2 files still load. */
export const POLICY_VERSION = 3;

/** Past observations the v3 temporal encoder reads, plus the current step. */
export const POLICY_HISTORY_STEPS = 12;

/**
 * Below this top-probability over the CANDIDATE set the head is guessing,
 * and the scripted desire decides instead. `[calibrate against val accuracy]`
 */
export const CONFIDENCE_FLOOR = 0.15;

function gemv(W, b, x) {
  const y = new Array(W.length);
  for (let i = 0; i < W.length; i += 1) {
    let s = b ? b[i] : 0;
    const row = W[i];
    for (let j = 0; j < row.length; j += 1) s += row[j] * x[j];
    y[i] = s;
  }
  return y;
}

function tanhVec(v) {
  const y = new Array(v.length);
  for (let i = 0; i < v.length; i += 1) y[i] = Math.tanh(v[i]);
  return y;
}

function checkRow(row, dim, label) {
  if (!Array.isArray(row) || row.length !== dim) {
    throw new Error(`policy: ${label} is ${row?.length} floats, dim says ${dim}`);
  }
}

function tableEmbed(spec, label) {
  if (!spec || !Number.isInteger(spec.dim) || spec.dim < 1) {
    throw new Error(`policy: ${label} carries no usable dim (${spec?.dim})`);
  }
  checkRow(spec.default, spec.dim, `${label} default`);
  const rows = new Map(
    Object.entries(spec.keys ?? spec.players ?? spec.maps ?? spec.contracts ?? {})
  );
  for (const [key, row] of rows) checkRow(row, spec.dim, `${label} ${key}`);
  return { dim: spec.dim, default: spec.default, rows };
}

function lookupEmbed(table, key) {
  if (!table) return [];
  if (key == null || key === '') return table.default;
  return table.rows.get(String(key)) ?? table.default;
}

/** Last-query causal attention over T encoded steps (SIM-PLAN 9.3b). */
function lastQueryAttn(frames, temporal) {
  const { inProj, attnOut } = temporal;
  const Z = frames.map((f) => tanhVec(gemv(inProj.W, inProj.b, f)));
  const q = Z[Z.length - 1];
  const scale = 1 / Math.sqrt(q.length);
  const scores = new Array(Z.length);
  let max = -Infinity;
  for (let t = 0; t < Z.length; t += 1) {
    let s = 0;
    const z = Z[t];
    for (let d = 0; d < q.length; d += 1) s += q[d] * z[d];
    s *= scale;
    scores[t] = s;
    if (s > max) max = s;
  }
  let sum = 0;
  const w = new Array(Z.length);
  for (let t = 0; t < Z.length; t += 1) {
    const e = Math.exp(scores[t] - max);
    w[t] = e;
    sum += e;
  }
  const ctx = new Array(q.length).fill(0);
  for (let t = 0; t < Z.length; t += 1) {
    const a = w[t] / sum;
    const z = Z[t];
    for (let d = 0; d < q.length; d += 1) ctx[d] += a * z[d];
  }
  return tanhVec(gemv(attnOut.W, attnOut.b, ctx));
}

function padHistory(obs, history, steps) {
  const past = Array.isArray(history)
    ? history.filter((h) => Array.isArray(h) && h.length === obs.length)
    : [];
  const frames = past.slice(-(steps - 1));
  while (frames.length < steps - 1) frames.unshift(obs);
  frames.push(obs);
  return frames;
}

/**
 * Load and validate a trained policy.
 *
 * @param {object} json  the trainer's artifact:
 *   {v, obsVersion, vocab: string[], activation: 'tanh',
 *    layers: [{W: number[][], b: number[]}, ...]}
 *   v2 adds {embed: {dim, default, players}}
 *   v3 adds last-query history attention plus map/contract tables (9.3b)
 * @returns {{vocab: string[],
 *            probs(obs: number[], playerKey?: string|object): Map<string, number>}}
 */
export function loadPolicy(json) {
  if (!json || !Number.isInteger(json.v) || json.v < 1 || json.v > POLICY_VERSION) {
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

  // v2/v3 player embedding. A Map keeps hostile keys ("toString") off Object.prototype.
  let playerEmbed = null;
  let mapEmbed = null;
  let contractEmbed = null;
  if (json.v === 2) {
    playerEmbed = tableEmbed(json.embed, 'embed');
  } else if (json.v >= 3 && json.embed && Number.isInteger(json.embed.dim) && json.embed.dim > 0) {
    playerEmbed = tableEmbed(json.embed, 'embed');
  }
  if (json.v >= 3) {
    if (json.embed?.map) mapEmbed = tableEmbed(json.embed.map, 'map embed');
    if (json.embed?.contract) contractEmbed = tableEmbed(json.embed.contract, 'contract embed');
  }

  const temporal = json.v >= 3 ? json.temporal : null;
  if (json.v >= 3) {
    if (!temporal || !Number.isInteger(temporal.steps) || temporal.steps < 2) {
      throw new Error(`policy: v3 model carries no usable temporal.steps (${temporal?.steps})`);
    }
    if (!Number.isInteger(temporal.dModel) || temporal.dModel < 1) {
      throw new Error(`policy: v3 model carries no usable temporal.dModel (${temporal?.dModel})`);
    }
    const { inProj, attnOut } = temporal;
    if (!inProj?.W || inProj.W.length !== temporal.dModel || inProj.W[0].length !== OBSERVATION_SIZE) {
      throw new Error('policy: temporal.inProj does not map observations to dModel');
    }
    if (!attnOut?.W || attnOut.W.length !== temporal.dModel || attnOut.W[0].length !== temporal.dModel) {
      throw new Error('policy: temporal.attnOut is not dModel by dModel');
    }
  }

  const condWidth =
    (playerEmbed ? playerEmbed.dim : 0) +
    (mapEmbed ? mapEmbed.dim : 0) +
    (contractEmbed ? contractEmbed.dim : 0);
  const inputWidth = temporal
    ? temporal.dModel + condWidth
    : OBSERVATION_SIZE + (playerEmbed ? playerEmbed.dim : 0);

  const layers = json.layers;
  if (!Array.isArray(layers) || layers.length < 1) throw new Error('policy: no layers');
  if (layers[0].W[0].length !== inputWidth) {
    throw new Error(
      `policy: first layer reads ${layers[0].W[0].length} floats, trunk carries ${inputWidth}`
    );
  }
  const lastW = layers[layers.length - 1].W;
  if (lastW.length !== json.vocab.length) {
    throw new Error(
      `policy: head emits ${lastW.length} logits for a ${json.vocab.length}-word vocabulary`
    );
  }

  function mlp(obs) {
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
     * Second argument is a player key (v2) or `{ player, map, contract, history }` (v3).
     * v1 ignores it. Missing keys ride the default row.
     */
    probs(obs, playerKey) {
      if (obs.length !== OBSERVATION_SIZE) {
        throw new Error(`policy: observation is ${obs.length} floats, expected ${OBSERVATION_SIZE}`);
      }
      const ctx =
        playerKey && typeof playerKey === 'object'
          ? playerKey
          : { player: playerKey };
      let x;
      if (temporal) {
        const frames = padHistory(obs, ctx.history, temporal.steps);
        x = lastQueryAttn(frames, temporal);
        if (playerEmbed) x = x.concat(lookupEmbed(playerEmbed, ctx.player));
        if (mapEmbed) x = x.concat(lookupEmbed(mapEmbed, ctx.map));
        if (contractEmbed) x = x.concat(lookupEmbed(contractEmbed, ctx.contract));
      } else {
        x = playerEmbed ? obs.concat(lookupEmbed(playerEmbed, ctx.player ?? playerKey)) : obs;
      }
      const logits = mlp(x);
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
