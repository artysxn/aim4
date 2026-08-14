// ---------------------------------------------------------------------------
// shared/sim/policyNet.js
// The JS forward pass for SIM-PLAN 9.3b's demo-trained network.
//
// Sibling of policy.js, same discipline and same reason for existing: the
// trainer is Python (scripts/sim-train-demos.py), the inference is here, and
// the artifact between them is a JSON file that carries its own versions. No
// tensor library crosses that boundary, because the sim runs these bots far
// faster than realtime and a matrix package in the hot loop is how that dies.
//
// policy.js stays as it is. This file is for the BIGGER architecture the demo
// corpus supports and its small MLP cannot express:
//
//   * a real 2-layer CAUSAL transformer over the last 12 observations, which
//     is what makes "wait for the flash, THEN peek" representable at all;
//   * four conditioner tables instead of two, the important one being CALL:
//     the same weights produce different behaviour when the operator commands
//     `banana-pop` instead of `passive-b`, which is the whole point of keeping
//     the call an input rather than something a policy has to be coaxed into;
//   * six heads instead of one. probs() answers the option question because
//     that is what the arbiter consumes, and forward() exposes the rest.
//
// Three rules, all inherited:
//   VALIDATE LOUDLY AT LOAD. A model laid out for a different observation
//   version, vocabulary or history length fails here and now, not later as a
//   bot that confidently wants the wrong things.
//   FALL BACK, NEVER THROW, AT INFERENCE. An unknown call/contract/player is
//   an operator typo or a new map, and it rides the trained default row. A bot
//   that behaves averagely is a bug report; a bot that throws is a dead round.
//   NEVER MUTATE. Not the model, not the observation, not the history.
// ---------------------------------------------------------------------------

import { OBSERVATION_SIZE, OBSERVE_VERSION } from './observe.js';
import { OPTION_DEFS } from './options.js';

/** The export schema version this build reads. */
export const POLICYNET_VERSION = 1;

/** Steps in the causal window, current step included. Mirrors demoContracts. */
export const POLICYNET_HISTORY_STEPS = 12;

/**
 * The pad the trainer used, and therefore the only pad that is correct here:
 * a missing step is ZEROS, not a copy of the present. At the start of a round
 * nothing has happened yet, and telling the network that three seconds of
 * identical observations just went by is telling it a lie it was never
 * trained on. (This is the one place policyNet deliberately differs from
 * policy.js, whose v3 path repeats the current frame.)
 */
const PAD = 'zero';

// ---------------------------------------------------------------------------
// small dense kernels — flat Float32Array, no allocation in the inner loops
// ---------------------------------------------------------------------------

function flatten(W, rows, cols, label) {
  if (!Array.isArray(W) || W.length !== rows) {
    throw new Error(`policyNet: ${label} has ${W?.length} rows, expected ${rows}`);
  }
  const out = new Float32Array(rows * cols);
  for (let i = 0; i < rows; i += 1) {
    const row = W[i];
    if (!Array.isArray(row) || row.length !== cols) {
      throw new Error(`policyNet: ${label} row ${i} is ${row?.length} wide, expected ${cols}`);
    }
    for (let j = 0; j < cols; j += 1) out[i * cols + j] = row[j];
  }
  return out;
}

function vec(b, n, label) {
  if (!Array.isArray(b) || b.length !== n) {
    throw new Error(`policyNet: ${label} is ${b?.length} long, expected ${n}`);
  }
  return Float32Array.from(b);
}

function linear(spec, rows, cols, label) {
  if (!spec) throw new Error(`policyNet: ${label} is missing`);
  return { W: flatten(spec.W, rows, cols, `${label}.W`), b: vec(spec.b, rows, `${label}.b`), rows, cols };
}

function norm(spec, n, label) {
  if (!spec) throw new Error(`policyNet: ${label} is missing`);
  return { g: vec(spec.g, n, `${label}.g`), b: vec(spec.b, n, `${label}.b`) };
}

/** dst[0..rows) = W @ src[srcOff..] + b */
function matvec(m, src, srcOff, dst, dstOff) {
  const { W, b, rows, cols } = m;
  for (let i = 0; i < rows; i += 1) {
    let s = b[i];
    const base = i * cols;
    for (let j = 0; j < cols; j += 1) s += W[base + j] * src[srcOff + j];
    dst[dstOff + i] = s;
  }
}

/** PyTorch LayerNorm over the last dim: biased variance, eps 1e-5. */
const LN_EPS = 1e-5;
function layerNorm(ln, src, srcOff, dst, dstOff, n) {
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += src[srcOff + i];
  mean /= n;
  let varSum = 0;
  for (let i = 0; i < n; i += 1) {
    const d = src[srcOff + i] - mean;
    varSum += d * d;
  }
  const inv = 1 / Math.sqrt(varSum / n + LN_EPS);
  for (let i = 0; i < n; i += 1) {
    dst[dstOff + i] = (src[srcOff + i] - mean) * inv * ln.g[i] + ln.b[i];
  }
}

function softmaxInto(arr, off, n) {
  let max = -Infinity;
  for (let i = 0; i < n; i += 1) if (arr[off + i] > max) max = arr[off + i];
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const e = Math.exp(arr[off + i] - max);
    arr[off + i] = e;
    sum += e;
  }
  for (let i = 0; i < n; i += 1) arr[off + i] /= sum;
}

// ---------------------------------------------------------------------------
// conditioner tables
// ---------------------------------------------------------------------------

function embedTable(spec, label) {
  if (!spec || !Number.isInteger(spec.dim) || spec.dim < 1) {
    throw new Error(`policyNet: ${label} carries no usable dim (${spec?.dim})`);
  }
  const dim = spec.dim;
  if (!Array.isArray(spec.default) || spec.default.length !== dim) {
    throw new Error(`policyNet: ${label} default row is ${spec.default?.length} wide, dim says ${dim}`);
  }
  // A Map, so a key like "toString" or "__proto__" cannot reach Object.prototype.
  const rows = new Map();
  for (const [key, row] of Object.entries(spec.keys ?? {})) {
    if (!Array.isArray(row) || row.length !== dim) {
      throw new Error(`policyNet: ${label} row ${key} is ${row?.length} wide, dim says ${dim}`);
    }
    rows.set(key, Float32Array.from(row));
  }
  return { dim, def: Float32Array.from(spec.default), rows, label };
}

/** Unknown key -> the trained default row. Never throws: see the header. */
function lookup(table, key) {
  if (key == null || key === '') return table.def;
  return table.rows.get(String(key)) ?? table.def;
}

// ---------------------------------------------------------------------------
// history reconstruction — the mirror of build_history() in the trainer
// ---------------------------------------------------------------------------

/**
 * Group extractor samples into the sequences the causal window is built over.
 * Samples for one (round, slot) are one player's trajectory through one round;
 * a window may never cross that boundary.
 *
 * @param {Array<{seq: {round: string, slot: number, i: number}}>} samples
 * @returns {Map<string, Array>} key `${round}|${slot}` -> samples sorted by i
 */
export function groupBySeq(samples) {
  const groups = new Map();
  for (const s of samples) {
    const key = `${s.seq.round}|${s.seq.slot}`;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  for (const list of groups.values()) list.sort((a, b) => a.seq.i - b.seq.i);
  return groups;
}

/**
 * Rebuild one sample's causal window from `seq`, the way the trainer does.
 *
 * Samples do not carry their history — writing 12 observations onto every line
 * would have cost hundreds of gigabytes — so the window is reconstructed from
 * the step index. Two details that the naive "take the previous 11 rows"
 * version gets wrong, and both occur in the real dataset:
 *
 *   * the start of a round has no past, and is ZERO-padded;
 *   * `i` has gaps where the extractor dropped a step, so the lookup is by
 *     step VALUE (i - back), never by position in the array. Sliding an older
 *     observation into a slot it does not belong in would teach the network a
 *     tempo that never happened.
 *
 * @param {Array} group   samples for ONE (round, slot), sorted by seq.i
 * @param {number} at     index into `group` of the sample to build a window for
 * @param {number} [steps]
 * @returns {number[][]}  `steps` frames, oldest first; the last is the sample's
 *                        own observation. Missing steps are zero frames.
 */
export function historyWindow(group, at, steps = POLICYNET_HISTORY_STEPS) {
  const self = group[at];
  if (!self) throw new Error(`policyNet: no sample at index ${at}`);
  const width = self.obs.length;
  const byStep = new Map();
  for (const s of group) byStep.set(s.seq.i, s);
  const frames = [];
  for (let back = steps - 1; back >= 1; back -= 1) {
    const prev = byStep.get(self.seq.i - back);
    frames.push(prev ? [...prev.obs] : new Array(width).fill(0));
  }
  frames.push([...self.obs]);
  return frames;
}

/**
 * Pad or trim a caller's history to exactly `steps - 1` past frames.
 * A frame of the wrong width is a contract violation and is refused; a short
 * history is the ordinary case at the start of a round and is zero-padded.
 */
function padHistory(history, steps, obsSize) {
  const want = steps - 1;
  const past = Array.isArray(history) ? history : [];
  for (const f of past) {
    if (!f || f.length !== obsSize) {
      throw new Error(`policyNet: history frame is ${f?.length} floats, expected ${obsSize}`);
    }
  }
  const kept = past.slice(-want);
  const out = [];
  for (let i = kept.length; i < want; i += 1) out.push(null); // null == zero frame
  for (const f of kept) out.push(f);
  return out;
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

/**
 * Load and validate a trained demo policy.
 *
 * @param {object} json  scripts/sim-train-demos.py's artifact
 * @returns {{vocab: object, obsSize: number, steps: number,
 *            forward(obs: number[], ctx?: object): Record<string, Map<string, number>>,
 *            probs(obs: number[], ctx?: object): Map<string, number>}}
 */
export function loadPolicyNet(json) {
  if (!json || json.kind !== 'policyNet') {
    throw new Error(`policyNet: not a policyNet artifact (kind ${json?.kind})`);
  }
  if (json.v !== POLICYNET_VERSION) {
    throw new Error(`policyNet: schema v${json.v}, this build reads v${POLICYNET_VERSION}`);
  }
  if (json.obsVersion !== OBSERVE_VERSION) {
    throw new Error(
      `policyNet: trained on observation v${json.obsVersion}, this build speaks v${OBSERVE_VERSION}`
    );
  }
  const obsSize = json.obsSize;
  if (obsSize !== OBSERVATION_SIZE) {
    throw new Error(`policyNet: model reads ${obsSize} floats, observe.js builds ${OBSERVATION_SIZE}`);
  }
  const steps = json.history?.steps;
  if (!Number.isInteger(steps) || steps < 2) {
    throw new Error(`policyNet: history.steps is ${steps}, expected an integer >= 2`);
  }
  if (json.history?.pad !== PAD) {
    throw new Error(`policyNet: model pads history with '${json.history?.pad}', this build pads '${PAD}'`);
  }

  // vocabularies
  const vocab = json.vocab;
  if (!vocab || typeof vocab !== 'object') throw new Error('policyNet: no vocabularies');
  for (const [head, list] of Object.entries(vocab)) {
    if (!Array.isArray(list) || !list.length) throw new Error(`policyNet: ${head} vocabulary is empty`);
  }
  if (!Array.isArray(vocab.option)) throw new Error('policyNet: no option vocabulary');
  for (const id of vocab.option) {
    if (!OPTION_DEFS[id]) throw new Error(`policyNet: vocab entry ${id} is not an option`);
  }

  // conditioners. Order here IS the concatenation order in the trainer's
  // trunk(); changing it silently mis-reads every weight in the first torso
  // layer, so it is written once, here.
  const condOrder = ['map', 'contract', 'call', 'player'];
  const embeds = condOrder.map((k) => embedTable(json.embed?.[k], `embed.${k}`));
  const condWidth = embeds.reduce((s, e) => s + e.dim, 0);

  // temporal stack
  const t = json.temporal;
  const d = t?.dModel;
  if (!Number.isInteger(d) || d < 1) throw new Error(`policyNet: temporal.dModel is ${d}`);
  const nHeads = t.heads;
  if (!Number.isInteger(nHeads) || nHeads < 1 || d % nHeads !== 0) {
    throw new Error(`policyNet: ${nHeads} heads do not divide dModel ${d}`);
  }
  const ff = t.ff;
  if (!Number.isInteger(ff) || ff < 1) throw new Error(`policyNet: temporal.ff is ${ff}`);
  const inProj = linear(t.inProj, d, obsSize, 'temporal.inProj');
  const pos = flatten(t.pos, steps, d, 'temporal.pos');
  const lnOut = norm(t.lnOut, d, 'temporal.lnOut');
  if (!Array.isArray(t.blocks) || !t.blocks.length) throw new Error('policyNet: no temporal blocks');
  const blocks = t.blocks.map((b, i) => ({
    ln1: norm(b.ln1, d, `block${i}.ln1`),
    wq: linear(b.wq, d, d, `block${i}.wq`),
    wk: linear(b.wk, d, d, `block${i}.wk`),
    wv: linear(b.wv, d, d, `block${i}.wv`),
    wo: linear(b.wo, d, d, `block${i}.wo`),
    ln2: norm(b.ln2, d, `block${i}.ln2`),
    fc1: linear(b.fc1, ff, d, `block${i}.fc1`),
    fc2: linear(b.fc2, d, ff, `block${i}.fc2`)
  }));

  // torso
  if (json.torso?.activation !== 'tanh') {
    throw new Error(`policyNet: unknown torso activation ${json.torso?.activation}`);
  }
  const torsoSpecs = json.torso?.layers;
  if (!Array.isArray(torsoSpecs) || torsoSpecs.length < 1) throw new Error('policyNet: no torso layers');
  const torso = [];
  let inWidth = d + condWidth;
  for (let i = 0; i < torsoSpecs.length; i += 1) {
    const rows = torsoSpecs[i].W?.length;
    if (!Number.isInteger(rows) || rows < 1) throw new Error(`policyNet: torso layer ${i} has no rows`);
    torso.push(linear(torsoSpecs[i], rows, inWidth, `torso.${i}`));
    inWidth = rows;
  }
  const width = inWidth;

  const heads = {};
  for (const [name, list] of Object.entries(vocab)) {
    const spec = json.heads?.[name];
    if (!spec) throw new Error(`policyNet: vocabulary ${name} has no head`);
    heads[name] = linear(spec, list.length, width, `heads.${name}`);
  }
  for (const name of Object.keys(json.heads ?? {})) {
    if (!vocab[name]) throw new Error(`policyNet: head ${name} has no vocabulary`);
  }

  const dh = d / nHeads;
  const scale = 1 / Math.sqrt(dh);

  // Scratch buffers, allocated once. The forward pass is called at 8 Hz per
  // bot; allocating per call is what turns that into garbage-collector time.
  const X = new Float32Array(steps * d);
  const H = new Float32Array(steps * d);
  const Q = new Float32Array(steps * d);
  const K = new Float32Array(steps * d);
  const V = new Float32Array(steps * d);
  const ctx = new Float32Array(d);
  const attn = new Float32Array(steps);
  const proj = new Float32Array(d);
  const hidFF = new Float32Array(ff);
  const frame = new Float32Array(obsSize);
  const trunkIn = new Float32Array(d + condWidth);
  const scratchWidth = Math.max(d + condWidth, ...torso.map((l) => l.rows));
  const bufA = new Float32Array(scratchWidth);
  const bufB = new Float32Array(scratchWidth);

  function runBlock(blk, last) {
    // Pre-norm, then attention. `last` = only the final position's output is
    // needed downstream, so its feed-forward runs once instead of `steps`
    // times. Mathematically identical under a causal mask: the final position
    // attends to everything, and nothing attends to it.
    for (let s = 0; s < steps; s += 1) layerNorm(blk.ln1, X, s * d, H, s * d, d);
    for (let s = 0; s < steps; s += 1) {
      matvec(blk.wk, H, s * d, K, s * d);
      matvec(blk.wv, H, s * d, V, s * d);
    }
    const first = last ? steps - 1 : 0;
    for (let s = first; s < steps; s += 1) matvec(blk.wq, H, s * d, Q, s * d);

    for (let s = first; s < steps; s += 1) {
      ctx.fill(0);
      for (let h = 0; h < nHeads; h += 1) {
        const off = h * dh;
        for (let u = 0; u <= s; u += 1) {
          let dot = 0;
          for (let j = 0; j < dh; j += 1) dot += Q[s * d + off + j] * K[u * d + off + j];
          attn[u] = dot * scale;
        }
        softmaxInto(attn, 0, s + 1); // causal: only 0..s are in the softmax
        for (let u = 0; u <= s; u += 1) {
          const a = attn[u];
          for (let j = 0; j < dh; j += 1) ctx[off + j] += a * V[u * d + off + j];
        }
      }
      matvec(blk.wo, ctx, 0, proj, 0);
      for (let j = 0; j < d; j += 1) X[s * d + j] += proj[j];
    }
    for (let s = first; s < steps; s += 1) {
      layerNorm(blk.ln2, X, s * d, H, s * d, d);
      matvec(blk.fc1, H, s * d, hidFF, 0);
      for (let j = 0; j < ff; j += 1) hidFF[j] = Math.tanh(hidFF[j]);
      matvec(blk.fc2, hidFF, 0, proj, 0);
      for (let j = 0; j < d; j += 1) X[s * d + j] += proj[j];
    }
  }

  function trunk(obs, c) {
    const past = padHistory(c.history, steps, obsSize);
    for (let s = 0; s < steps; s += 1) {
      if (s < steps - 1) {
        const f = past[s];
        if (f === null) frame.fill(0);
        else for (let j = 0; j < obsSize; j += 1) frame[j] = f[j];
      } else {
        for (let j = 0; j < obsSize; j += 1) frame[j] = obs[j];
      }
      matvec(inProj, frame, 0, X, s * d);
      for (let j = 0; j < d; j += 1) X[s * d + j] += pos[s * d + j];
    }
    for (let i = 0; i < blocks.length; i += 1) runBlock(blocks[i], i === blocks.length - 1);
    layerNorm(lnOut, X, (steps - 1) * d, trunkIn, 0, d);
    let off = d;
    const keys = [c.map, c.contract, c.call, c.player];
    for (let i = 0; i < embeds.length; i += 1) {
      const row = lookup(embeds[i], keys[i]);
      trunkIn.set(row, off);
      off += embeds[i].dim;
    }
    let src = trunkIn;
    let a = bufA;
    let b = bufB;
    for (let i = 0; i < torso.length; i += 1) {
      matvec(torso[i], src, 0, a, 0);
      for (let j = 0; j < torso[i].rows; j += 1) a[j] = Math.tanh(a[j]);
      src = a;
      const swap = a;
      a = b;
      b = swap;
    }
    return src;
  }

  function headProbs(name, hidden) {
    const m = heads[name];
    const logits = new Float32Array(m.rows);
    matvec(m, hidden, 0, logits, 0);
    softmaxInto(logits, 0, m.rows);
    const out = new Map();
    const list = vocab[name];
    for (let i = 0; i < list.length; i += 1) out.set(list[i], logits[i]);
    return out;
  }

  function checkObs(obs) {
    if (!obs || obs.length !== obsSize) {
      throw new Error(`policyNet: observation is ${obs?.length} floats, expected ${obsSize}`);
    }
  }

  return {
    /** Frozen copies: a caller cannot reach in and reindex a head. */
    vocab: Object.freeze(Object.fromEntries(
      Object.entries(vocab).map(([k, v]) => [k, Object.freeze([...v])])
    )),
    obsSize,
    steps,
    dModel: d,
    condKeys: Object.freeze({
      map: Object.freeze([...embeds[0].rows.keys()]),
      contract: Object.freeze([...embeds[1].rows.keys()]),
      call: Object.freeze([...embeds[2].rows.keys()]),
      player: Object.freeze([...embeds[3].rows.keys()])
    }),
    trained: json.trained ?? null,

    /**
     * Every head at once.
     * @param {number[]} obs  the CURRENT observation, OBSERVATION_SIZE floats
     * @param {object} [c] {history, map, call, contract, player}. `history` is
     *   the past frames oldest-first (at most steps-1 are read); anything
     *   missing is zero-padded. Unknown conditioner keys ride the default row.
     * @returns {Record<string, Map<string, number>>} head -> label -> probability
     */
    forward(obs, c = {}) {
      checkObs(obs);
      const hidden = trunk(obs, c);
      const out = {};
      for (const name of Object.keys(heads)) out[name] = headProbs(name, hidden);
      return out;
    },

    /**
     * Proposals over the option vocabulary, for applyProposals() in policy.js.
     * Sums to 1 and is deterministic for a given input.
     */
    probs(obs, c = {}) {
      checkObs(obs);
      return headProbs('option', trunk(obs, c));
    }
  };
}
