// Run: node shared/sim/callerNet.test.js

import {
  CALLER_FEATURES,
  CALLER_NET_VERSION,
  SUPPORT_MIN,
  callerFeatures,
  featuresFor,
  loadCallerNet
} from './callerNet.js';
import { blendMemory } from './callValue.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

function throws(fn, re, msg) {
  try {
    fn();
  } catch (err) {
    if (re && !re.test(err.message)) throw new Error(`${msg}: wrong error "${err.message}"`);
    return;
  }
  throw new Error(msg || 'expected a throw');
}

// ---- the feature vector --------------------------------------------------

{
  const f = callerFeatures({ side: 'T', alive: 5, enemyAlive: 5, clock: 0, secondsLeft: 115 });
  assert(f.length === CALLER_FEATURES.length, 'one slot per named feature');
  assert(f[0] === 0, 'T is zero');
  assert(callerFeatures({ side: 'CT' })[0] === 1, 'CT is one');
  assert(f[9] === 1, 'no contact is its own slot, not an absent one');

  const late = callerFeatures(
    { side: 'CT', alive: 2, enemyAlive: 4, clock: 80, secondsLeft: 35, contactRel: 'site' },
    { econ: 4 }
  );
  assert(late[3] === (2 - 4) / 5, 'man disadvantage is negative');
  assert(late[11] === 1 && late[9] === 0, 'contact at the site moves the one-hot');
  assert(late[17] === 1, 'econ 4 lands in its own slot');

  // An unplanted round has no bomb clock, and writing a zero would read as
  // "no time left" to anything monotone in that feature.
  assert(callerFeatures({ side: 'T', planted: false })[7] === 1, 'no plant, full bomb feature');
  assert(
    callerFeatures({ side: 'T', planted: true, bombSecondsLeft: 20 })[7] === 0.5,
    'planted, half the timer'
  );
  // Out-of-range econ sets no bucket rather than the wrong one.
  const noEcon = callerFeatures({ side: 'T' }, { econ: 9 });
  assert(noEcon.slice(13, 19).every((v) => v === 0), 'an econ off the scale sets nothing');
}

// ---- a hand-built model, so the arithmetic is checkable -------------------

const CALLS = [
  { side: 'T', call: 'a-exec' },
  { side: 'T', call: 'b-exec' },
  { side: 'CT', call: 'default' }
];

/** Zero weights and a chosen bias: every output is exactly sigmoid(bias). */
function flatModel({ bias = 0, support = {}, withCall = true } = {}) {
  const nIn = CALLER_FEATURES.length + CALLS.length;
  const zeros = (rows, cols) => Array.from({ length: rows }, () => new Array(cols).fill(0));
  return {
    v: CALLER_NET_VERSION,
    kind: 'caller',
    name: 'igl-test-1',
    map: 'CCH',
    features: [...CALLER_FEATURES],
    calls: CALLS,
    support,
    win: {
      layers: [
        { W: zeros(4, nIn), b: [0, 0, 0, 0] },
        { W: [[0, 0, 0, 0]], b: [bias] }
      ]
    },
    call: withCall
      ? {
          layers: [
            { W: zeros(4, CALLER_FEATURES.length), b: [0, 0, 0, 0] },
            { W: zeros(CALLS.length, 4), b: [0, 2, 0] }
          ]
        }
      : null
  };
}

{
  const net = loadCallerNet(flatModel({ bias: 0, support: { 'T:a-exec': 100 } }));
  const picture = { side: 'T', alive: 5, enemyAlive: 5 };
  const hit = net.winOf(picture, 'a-exec');
  assert(Math.abs(hit.p - 0.5) < 1e-9, `flat weights give sigmoid(0): ${hit.p}`);
  assert(hit.n === 100, 'and carry the support the trainer measured');

  // A call this side cannot make is not a call. Returning a number for it
  // would price a plan that cannot be run.
  assert(net.winOf(picture, 'default') === null, 'a CT call is unknown to a T picture');
  assert(net.winOf(picture, 'never-mined') === null, 'and so is one nobody mined');
}

// ---- the memoryOf contract -----------------------------------------------

{
  const net = loadCallerNet(
    flatModel({ bias: 2, support: { 'T:a-exec': 10000, 'T:b-exec': SUPPORT_MIN - 1 } })
  );
  const picture = { side: 'T', alive: 5, enemyAlive: 5 };
  const head = net.headFor(picture);

  const strong = head('a-exec');
  assert(strong && strong.n === 10000, 'a well-supported call answers');
  assert(strong.lower <= strong.mean, 'the bound is not above the estimate');
  assert(strong.mean > 0.88, `sigmoid(2) is about 0.88, got ${strong.mean}`);
  // 10,000 rows behind it: the discount should be nearly nothing.
  assert(strong.mean - strong.lower < 0.01, 'deep support is barely discounted');

  // Below the support floor the head declines to speak, which is what keeps
  // blendMemory from being moved by a cell that has seen nothing.
  assert(head('b-exec') === null, 'a thin call returns no memory at all');
  assert(head('default') === null, 'and neither does an illegal one');

  // The shape is the one callValue.js consumes, and it must survive the trip.
  const base = 0.5;
  assert(blendMemory(base, strong) > base, 'a confident head pulls the picture up');
  assert(blendMemory(base, head('b-exec')) === base, 'and silence leaves it exactly alone');
}

{
  // The discount is what makes support mean something: same prediction, less
  // evidence, a number the caller trusts less.
  const deep = loadCallerNet(flatModel({ bias: 1, support: { 'T:a-exec': 10000 } }));
  const thin = loadCallerNet(flatModel({ bias: 1, support: { 'T:a-exec': 20 } }));
  const picture = { side: 'T' };
  const a = deep.headFor(picture)('a-exec');
  const b = thin.headFor(picture)('a-exec');
  assert(Math.abs(a.mean - b.mean) < 1e-9, 'the same weights predict the same thing');
  assert(b.lower < a.lower, 'but the thin one is trusted less');
}

// ---- the call prior ------------------------------------------------------

{
  const net = loadCallerNet(flatModel({ support: {} }));
  const prior = net.callPrior({ side: 'T', alive: 5, enemyAlive: 5 });
  assert(prior.length === 2, 'a T caller is offered T calls only');
  const total = prior.reduce((s, c) => s + c.p, 0);
  assert(Math.abs(total - 1) < 1e-9, `the prior is renormalized over them: ${total}`);
  // Bias put the mass on b-exec; it must survive dropping the CT column.
  assert(prior[0].call === 'b-exec', `top call: ${prior[0].call}`);
  assert(net.topCall({ side: 'T' }) === 'b-exec', 'topCall is the head of that list');

  const ct = net.callPrior({ side: 'CT' });
  assert(ct.length === 1 && Math.abs(ct[0].p - 1) < 1e-9, 'one legal call takes all of it');
  assert(net.callPrior({ side: 'T' }, 'ZZ').length === 0, 'a side with no calls gets none');
}

{
  // The call head is optional; stage 1 works without stage 4.
  const net = loadCallerNet(flatModel({ withCall: false, support: { 'T:a-exec': 99 } }));
  assert(net.hasCallHead === false, 'the file says so');
  assert(net.callPrior({ side: 'T' }).length === 0, 'and asking gets nothing rather than a throw');
  assert(net.headFor({ side: 'T' })('a-exec') !== null, 'while the value head still answers');
}

// ---- what a bad file must not do -----------------------------------------

{
  throws(() => loadCallerNet(null), /not an object/, 'nothing');
  throws(() => loadCallerNet({ kind: 'policyNet' }), /kind/, 'the bot model is not the caller');
  throws(
    () => loadCallerNet({ ...flatModel(), v: CALLER_NET_VERSION + 1 }),
    /speaks v/,
    'a future version'
  );
  // The one that matters: a drifted feature list still multiplies, still
  // returns a probability, and is silently wrong.
  throws(
    () => loadCallerNet({ ...flatModel(), features: ['side_ct', 'alive'] }),
    /feature list/,
    'a short feature list'
  );
  const renamed = [...CALLER_FEATURES];
  renamed[4] = 'tick';
  throws(
    () => loadCallerNet({ ...flatModel(), features: renamed }),
    /feature list/,
    'a renamed feature'
  );
  throws(() => loadCallerNet({ ...flatModel(), calls: [] }), /vocabulary/, 'no calls');
  // A vocabulary that grew without the weights growing with it.
  throws(
    () => loadCallerNet({ ...flatModel(), calls: [...CALLS, { side: 'T', call: 'extra' }] }),
    /input does not match/,
    'a vocabulary the win head was not fitted for'
  );
}

// ---- cross-map heads -------------------------------------------------------
//
// The caller's picture is map-agnostic, so one head is fitted over every map at
// once and told which map it is on by a one-hot. Two things must hold: the
// feature geometry has to grow by exactly the number of maps, and the shared
// softmax must never offer a call that belongs to a different map.
{
  const MAPS = ['ANC', 'MIR', 'NUK'];
  const XCALLS = [
    { side: 'T', call: 'default' },
    { side: 'T', call: 'anc-b-split' },
    { side: 'T', call: 'mir-3mid' },
    { side: 'CT', call: 'default' }
  ];

  assert(
    featuresFor(MAPS).length === CALLER_FEATURES.length + 3,
    'a cross-map feature list is the base plus one column per map'
  );
  assert(
    featuresFor(['ANC']).length === CALLER_FEATURES.length,
    'and a single-map model keeps the exact old geometry'
  );

  const pic = { side: 'T', alive: 5, enemyAlive: 5, clock: 0, secondsLeft: 115 };
  const onNuke = callerFeatures(pic, { map: 'NUK', maps: MAPS });
  assert(
    onNuke[CALLER_FEATURES.length + 2] === 1 && onNuke[CALLER_FEATURES.length] === 0,
    'the map one-hot lands in the slot its position in `maps` says'
  );

  const nIn = featuresFor(MAPS).length + XCALLS.length;
  const zeros = (rows, cols) => Array.from({ length: rows }, () => new Array(cols).fill(0));
  const cross = {
    v: CALLER_NET_VERSION,
    kind: 'caller',
    name: 'igl-cross-1',
    map: 'ALL',
    maps: MAPS,
    features: featuresFor(MAPS),
    calls: XCALLS,
    callsByMap: {
      ANC: ['T:default', 'T:anc-b-split', 'CT:default'],
      MIR: ['T:default', 'T:mir-3mid', 'CT:default'],
      NUK: ['T:default', 'CT:default']
    },
    support: {},
    win: { layers: [{ W: zeros(4, nIn), b: [0, 0, 0, 0] }, { W: [[0, 0, 0, 0]], b: [0] }] },
    // Flat logits: every legal call ends up equally likely, so what the prior
    // contains is purely a question of what the mask let through.
    call: {
      layers: [
        { W: zeros(4, featuresFor(MAPS).length), b: [0, 0, 0, 0] },
        { W: zeros(XCALLS.length, 4), b: [0, 0, 0, 0] }
      ]
    }
  };

  const net = loadCallerNet(cross);
  assert(net.maps.length === 3, 'the head reports the maps it was fitted over');

  const anc = net.callPrior(pic, 'T', 'ANC').map((c) => c.call).sort();
  const nuke = net.callPrior(pic, 'T', 'NUK').map((c) => c.call).sort();
  assert(
    anc.join(',') === 'anc-b-split,default',
    `an Ancient round is offered Ancient calls (${anc.join(',')})`
  );
  assert(
    nuke.join(',') === 'default',
    `and a Nuke round is never offered mir-3mid (${nuke.join(',')})`
  );
  assert(
    Math.abs(net.callPrior(pic, 'T', 'ANC').reduce((s, c) => s + c.p, 0) - 1) < 1e-9,
    'the masked prior still sums to one'
  );

  // Nothing wires the call head yet, so the first caller to forget the map
  // must hear about it rather than get another map's calls back.
  throws(
    () => net.callPrior(pic, 'T'),
    /needs the map/,
    'a cross-map head asked without a map'
  );
  throws(
    () => net.callPrior(pic, 'T', 'DD2'),
    /needs the map/,
    'and one asked for a map it was never fitted on'
  );

  // The geometry guard has to survive the change, or a cross-map artifact
  // could be run by a build that cannot featurize it.
  throws(
    () => loadCallerNet({ ...cross, maps: ['ANC', 'MIR'] }),
    /feature list does not match/,
    'a model whose map list disagrees with its features'
  );
}

console.log('callerNet: ok');
