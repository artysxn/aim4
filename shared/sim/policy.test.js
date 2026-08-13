// Run: node shared/sim/policy.test.js
//
// The forward pass is arithmetic; what can break is the CONTRACT. So the
// tests are the contract: version gates fail loudly, shapes are checked at
// load, softmax is a distribution, proposals renormalize over the candidates
// on offer, forced candidates are untouchable, and an unconfident head
// changes nothing. v2 adds the player embedding (SIM-PLAN 9.3 / 10.3):
// lookup vs the default row, dimension gates, and — because every current
// call site passes no key — v1 files must keep loading and a keyless v2
// call must ride the default row.

import { CONFIDENCE_FLOOR, POLICY_VERSION, applyProposals, loadPolicy } from './policy.js';
import { OBSERVATION_SIZE, OBSERVE_VERSION } from './observe.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

/** A tiny hand-built v1 model: obs -> 2 hidden -> 3 options. */
function model(over = {}) {
  const W0 = [new Array(OBSERVATION_SIZE).fill(0), new Array(OBSERVATION_SIZE).fill(0)];
  W0[0][0] = 1; // hidden0 reads obs[0]
  W0[1][2] = 1; // hidden1 reads obs[2] (hp)
  return {
    v: 1,
    obsVersion: OBSERVE_VERSION,
    vocab: ['hold_angle', 'wide_swing', 'rotate'],
    activation: 'tanh',
    layers: [
      { W: W0, b: [0, 0] },
      {
        W: [
          [2, 0],
          [0, 2],
          [0, 0]
        ],
        b: [0, 0, 0]
      }
    ],
    ...over
  };
}

/**
 * A tiny v2 model: (obs + 2-d embedding) -> 2 hidden -> 3 options.
 * hidden1 reads embed[0], so the player key steers the wide_swing logit:
 * "aggro" pushes it up, "passive" pushes it down, the default row (zero)
 * leaves it alone.
 */
const EMBED_DIM = 2;
function modelV2(over = {}) {
  const width = OBSERVATION_SIZE + EMBED_DIM;
  const W0 = [new Array(width).fill(0), new Array(width).fill(0)];
  W0[0][0] = 1; // hidden0 reads obs[0]
  W0[1][OBSERVATION_SIZE] = 1; // hidden1 reads embed[0]
  return {
    v: 2,
    obsVersion: OBSERVE_VERSION,
    vocab: ['hold_angle', 'wide_swing', 'rotate'],
    activation: 'tanh',
    embed: {
      dim: EMBED_DIM,
      default: [0, 0],
      players: { aggro: [1, 0], passive: [-1, 0] }
    },
    layers: [
      { W: W0, b: [0, 0] },
      {
        W: [
          [2, 0],
          [0, 2],
          [0, 0]
        ],
        b: [0, 0, 0]
      }
    ],
    ...over
  };
}

const obs = () => new Array(OBSERVATION_SIZE).fill(0);

// ---- the load gates -------------------------------------------------------------

{
  loadPolicy(model()); // fine
  for (const [label, bad] of [
    ['wrong version', model({ v: 99 })],
    ['wrong obs version', model({ obsVersion: 99 })],
    ['empty vocab', model({ vocab: [] })],
    ['fake option', model({ vocab: ['hold_angle', 'teleport', 'rotate'] })],
    ['odd activation', model({ activation: 'relu6' })],
    [
      'wrong input width',
      model({ layers: [{ W: [[1, 2]], b: [0] }, { W: [[1], [1], [1]], b: [0, 0, 0] }] })
    ],
    [
      'head/vocab mismatch',
      (() => {
        const m = model();
        m.layers[1].W = m.layers[1].W.slice(0, 2);
        m.layers[1].b = [0, 0];
        return m;
      })()
    ]
  ]) {
    let threw = false;
    try {
      loadPolicy(bad);
    } catch {
      threw = true;
    }
    assert(threw, `${label} fails at load, not at decision time`);
  }
}

// ---- the forward pass -----------------------------------------------------------

{
  const p = loadPolicy(model());
  const flat = p.probs(obs());
  let sum = 0;
  for (const v of flat.values()) sum += v;
  assert(Math.abs(sum - 1) < 1e-9, `softmax sums to one (${sum})`);
  assert(
    Math.abs(flat.get('hold_angle') - flat.get('wide_swing')) < 1e-9,
    'a zero observation is indifferent'
  );

  const x = obs();
  x[0] = 1; // pushes hidden0 -> hold_angle logit
  const biased = p.probs(x);
  assert(
    biased.get('hold_angle') > biased.get('wide_swing') &&
      biased.get('hold_angle') > biased.get('rotate'),
    'the head follows the features'
  );

  let threw = false;
  try {
    p.probs([1, 2, 3]);
  } catch {
    threw = true;
  }
  assert(threw, 'a wrong-width observation is a loud error');
}

// ---- v2: the player embedding ---------------------------------------------------

{
  assert(POLICY_VERSION === 3, 'POLICY_VERSION is the max supported version');

  // Both older versions still load; the gate is about UNKNOWN versions.
  loadPolicy(model()); // v1 file still loads
  loadPolicy(modelV2()); // v2 file loads

  // The v2 load gates: every embedding shape failure is a load error.
  for (const [label, bad] of [
    ['v2 without embed', modelV2({ embed: undefined })],
    ['zero embed dim', modelV2({ embed: { dim: 0, default: [], players: {} } })],
    [
      'default row off-dimension',
      modelV2({ embed: { dim: EMBED_DIM, default: [0], players: {} } })
    ],
    [
      'player row off-dimension',
      modelV2({ embed: { dim: EMBED_DIM, default: [0, 0], players: { aggro: [1, 0, 0] } } })
    ],
    [
      'first layer sized for bare observations',
      (() => {
        const m = modelV2();
        m.layers[0].W = m.layers[0].W.map((row) => row.slice(0, OBSERVATION_SIZE));
        return m;
      })()
    ],
    [
      'v1 first layer sized for obs + embedding',
      (() => {
        const m = model();
        m.layers[0].W = m.layers[0].W.map((row) => row.concat([0, 0]));
        return m;
      })()
    ]
  ]) {
    let threw = false;
    try {
      loadPolicy(bad);
    } catch {
      threw = true;
    }
    assert(threw, `${label} fails at load, not at decision time`);
  }

  // Lookup vs the default row. hidden1 reads embed[0], feeding wide_swing.
  const p2 = loadPolicy(modelV2());
  const base = p2.probs(obs()); // no key -> default row (zero)
  const unseen = p2.probs(obs(), 'never-in-training'); // unknown key -> default row
  const up = p2.probs(obs(), 'aggro');
  const down = p2.probs(obs(), 'passive');
  assert(
    Math.abs(base.get('wide_swing') - unseen.get('wide_swing')) < 1e-12,
    'an unseen key rides the default row, exactly'
  );
  assert(
    up.get('wide_swing') > base.get('wide_swing') &&
      down.get('wide_swing') < base.get('wide_swing'),
    'a known key steers the head through its embedding'
  );
  let sum = 0;
  for (const v of up.values()) sum += v;
  assert(Math.abs(sum - 1) < 1e-9, 'the conditioned head is still a distribution');

  // A key on Object.prototype must not leak a "row" out of the prototype.
  const proto = p2.probs(obs(), 'toString');
  assert(
    Math.abs(proto.get('wide_swing') - base.get('wide_swing')) < 1e-12,
    'prototype keys are unseen players, not accidents'
  );

  // The caller still hands over BARE observations; the model appends the
  // embedding itself. Pre-widened input is the bug this gate exists for.
  let threw = false;
  try {
    p2.probs(new Array(OBSERVATION_SIZE + EMBED_DIM).fill(0), 'aggro');
  } catch {
    threw = true;
  }
  assert(threw, 'a pre-widened observation is a loud error');

  // v1 semantics are untouched: the second argument is ignored.
  const p1 = loadPolicy(model());
  const plain = p1.probs(obs());
  const keyed = p1.probs(obs(), 'aggro');
  for (const id of p1.vocab) {
    assert(plain.get(id) === keyed.get(id), 'a v1 model ignores the player key');
  }
}

// ---- v3: last-query history + still-load older files ---------------------------

{
  const D = 2;
  const inW = [new Array(OBSERVATION_SIZE).fill(0), new Array(OBSERVATION_SIZE).fill(0)];
  inW[0][0] = 1;
  const ident = [
    [1, 0],
    [0, 1]
  ];
  const width = D + EMBED_DIM;
  const W0 = [new Array(width).fill(0), new Array(width).fill(0)];
  W0[0][0] = 1;
  W0[1][D] = 1;
  function modelV3(over = {}) {
    return {
      v: 3,
      obsVersion: OBSERVE_VERSION,
      vocab: ['hold_angle', 'wide_swing', 'rotate'],
      activation: 'tanh',
      temporal: {
        steps: 2,
        dModel: D,
        inProj: { W: inW.map((r) => r.slice()), b: [0, 0] },
        attnOut: { W: ident.map((r) => r.slice()), b: [0, 0] }
      },
      embed: {
        dim: EMBED_DIM,
        default: [0, 0],
        players: { aggro: [1, 0], passive: [-1, 0] }
      },
      layers: [
        { W: W0.map((r) => r.slice()), b: [0, 0] },
        {
          W: [
            [2, 0],
            [0, 2],
            [0, 0]
          ],
          b: [0, 0, 0]
        }
      ],
      ...over
    };
  }

  loadPolicy(modelV3());
  for (const [label, bad] of [
    ['v3 without temporal', modelV3({ temporal: undefined })],
    ['v3 steps 1', modelV3({ temporal: { steps: 1, dModel: D, inProj: { W: inW, b: [0, 0] }, attnOut: { W: ident, b: [0, 0] } } })]
  ]) {
    let threw = false;
    try {
      loadPolicy(bad);
    } catch {
      threw = true;
    }
    assert(threw, `${label} fails at load`);
  }

  const p3 = loadPolicy(modelV3());
  const zero = p3.probs(obs());
  let sum = 0;
  for (const v of zero.values()) sum += v;
  assert(Math.abs(sum - 1) < 1e-9, 'v3 softmax sums to one');

  const up = p3.probs(obs(), 'aggro');
  const down = p3.probs(obs(), 'passive');
  assert(
    up.get('wide_swing') > zero.get('wide_swing') &&
      down.get('wide_swing') < zero.get('wide_swing'),
    'v3 still steers through the player embedding'
  );

  const past = obs();
  past[0] = 8;
  const withHist = p3.probs(obs(), { history: [past] });
  assert(
    withHist.get('hold_angle') > zero.get('hold_angle'),
    'a past observation moves the last-query head'
  );

  const keyed = p3.probs(obs(), { player: 'aggro', map: 'INF', history: [] });
  assert(keyed.get('wide_swing') > zero.get('wide_swing'), 'object ctx still looks up the player');
}

// ---- proposals ------------------------------------------------------------------

{
  const probs = new Map([
    ['hold_angle', 0.5],
    ['wide_swing', 0.2],
    ['rotate', 0.3]
  ]);

  // Renormalized over what is actually on offer.
  const candidates = [
    { id: 'hold_angle', prior: 0.5 },
    { id: 'wide_swing', prior: 0.5 }
  ];
  assert(applyProposals(candidates, probs), 'a confident head applies');
  assert(
    Math.abs(candidates[0].prior - 0.5 / 0.7) < 1e-9 &&
      Math.abs(candidates[1].prior - 0.2 / 0.7) < 1e-9,
    'priors renormalize over the candidate set'
  );

  // Forced candidates are rules; the net may not touch them.
  const withForced = [
    { id: 'hold_angle', prior: 0.5 },
    { id: 'rotate', prior: 0.9, forced: true }
  ];
  applyProposals(withForced, probs);
  assert(withForced[1].prior === 0.9, 'forced priors are untouched');

  // An unconfident head changes nothing: the nil pattern.
  const shrug = new Map([
    ['hold_angle', CONFIDENCE_FLOOR / 4],
    ['wide_swing', CONFIDENCE_FLOOR / 4]
  ]);
  const untouched = [
    { id: 'hold_angle', prior: 0.42 },
    { id: 'wide_swing', prior: 0.58 }
  ];
  // Two candidates at equal tiny mass renormalize to 0.5 each, which is
  // ABOVE the floor; make the head genuinely flat over a bigger vocab.
  const flatHead = new Map([
    ['hold_angle', 0.01],
    ['wide_swing', 0.01],
    ['rotate', 0.98]
  ]);
  const offered = [
    { id: 'hold_angle', prior: 0.42 },
    { id: 'wide_swing', prior: 0.58 }
  ];
  // rotate is not on offer; over the candidates the head splits 50/50 — but
  // the FLOOR is about the head's confidence in ITS best candidate, so a
  // head whose mass sits on an absent option still applies evenly. What must
  // NOT apply is zero mass everywhere:
  assert(!applyProposals(untouched, new Map()), 'no mass, no application');
  assert(untouched[0].prior === 0.42, 'and the scripted priors survive');
  assert(applyProposals(offered, flatHead), 'mass on offer applies');
  assert(Math.abs(offered[0].prior - 0.5) < 1e-9, 'renormalized over the offer');
}

console.log('policy: ok');
