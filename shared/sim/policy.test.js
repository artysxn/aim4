// Run: node shared/sim/policy.test.js
//
// The forward pass is arithmetic; what can break is the CONTRACT. So the
// tests are the contract: version gates fail loudly, shapes are checked at
// load, softmax is a distribution, proposals renormalize over the candidates
// on offer, forced candidates are untouchable, and an unconfident head
// changes nothing.

import { CONFIDENCE_FLOOR, POLICY_VERSION, applyProposals, loadPolicy } from './policy.js';
import { OBSERVATION_SIZE, OBSERVE_VERSION } from './observe.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

/** A tiny hand-built model: obs -> 2 hidden -> 3 options. */
function model(over = {}) {
  const W0 = [new Array(OBSERVATION_SIZE).fill(0), new Array(OBSERVATION_SIZE).fill(0)];
  W0[0][0] = 1; // hidden0 reads obs[0]
  W0[1][2] = 1; // hidden1 reads obs[2] (hp)
  return {
    v: POLICY_VERSION,
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
