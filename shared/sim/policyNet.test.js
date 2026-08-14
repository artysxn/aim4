// ---------------------------------------------------------------------------
// shared/sim/policyNet.test.js
// node shared/sim/policyNet.test.js   ->  "policyNet: ok"
//
// What this guards, in the order it matters:
//
//   1. THE HISTORY WINDOW. Samples do not carry their past; the trainer and
//      this file both rebuild it from `seq`. If the two disagree the network is
//      served frames it was never trained on and nothing else here can detect
//      it. Zero-padding at a round start and the gaps in `i` are both asserted.
//   2. THE EXPORT SCHEMA. A hand-built model round-trips: every shape the
//      trainer writes is a shape this loader reads.
//   3. LOUD REFUSALS. Wrong observation version, wrong observation width,
//      wrong vocabulary length, wrong history length all fail at LOAD, because
//      a silently mis-shaped model is a bot that confidently wants the wrong
//      things for a whole match.
//   4. QUIET FALLBACK. An unknown call, contract or player rides the trained
//      default row instead of throwing: a commanded call the corpus never saw
//      is an operator typo, not a reason to kill the round.
//
// With POLICYNET_PARITY=<file> (written by sim-train-demos.py --parity) it also
// checks this forward pass against the trainer's own numbers on real samples,
// which is the only thing that catches a transposed weight.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OBSERVATION_SIZE, OBSERVE_VERSION } from './observe.js';
import { OPTION_IDS } from './options.js';
import { loadPolicyNet, groupBySeq, historyWindow, POLICYNET_HISTORY_STEPS } from './policyNet.js';

// A tiny deterministic rng, so a failure is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

const STEPS = POLICYNET_HISTORY_STEPS;
const D = 8;
const HEADS = 2;
const FF = 6;
const WIDTH = 5;

const VOCAB = {
  option: OPTION_IDS.slice(0, 4),
  moveTo: ['__none__', 'banana', 'ct', '__other__'],
  gait: ['stand', 'walk', 'run'],
  peek: ['none', 'hold', 'jiggle', 'shoulder', 'wide', 'repeek'],
  aim: ['on', 'near', 'off', 'away'],
  utility: ['none', 'smokegrenade']
};

/** A hand-built model in exactly the shape scripts/sim-train-demos.py writes. */
function tinyModel(over = {}) {
  const r = rng(1234);
  const mat = (rows, cols) =>
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => r()));
  const bias = (n) => Array.from({ length: n }, () => r() * 0.1);
  const ln = (n) => ({ g: Array.from({ length: n }, () => 1 + r() * 0.1), b: bias(n) });
  const lin = (rows, cols) => ({ W: mat(rows, cols), b: bias(rows) });
  const table = (dim, keys) => ({
    dim,
    default: Array.from({ length: dim }, () => r()),
    keys: Object.fromEntries(keys.map((k) => [k, Array.from({ length: dim }, () => r())]))
  });
  const block = () => ({
    ln1: ln(D),
    wq: lin(D, D),
    wk: lin(D, D),
    wv: lin(D, D),
    wo: lin(D, D),
    ln2: ln(D),
    fc1: lin(FF, D),
    fc2: lin(D, FF)
  });
  const model = {
    v: 1,
    kind: 'policyNet',
    obsVersion: OBSERVE_VERSION,
    obsSize: OBSERVATION_SIZE,
    datasetVersion: 1,
    history: { steps: STEPS, hz: 4, pad: 'zero' },
    vocab: VOCAB,
    embed: {
      map: table(3, ['INF', 'MIR']),
      contract: table(4, ['banana', 'ct']),
      call: table(4, ['passive-b', 'banana-pop']),
      player: table(4, ['76561198000000001'])
    },
    temporal: {
      dModel: D,
      heads: HEADS,
      ff: FF,
      inProj: lin(D, OBSERVATION_SIZE),
      pos: mat(STEPS, D),
      blocks: [block(), block()],
      lnOut: ln(D)
    },
    torso: {
      activation: 'tanh',
      layers: [lin(WIDTH, D + 3 + 4 + 4 + 4), lin(WIDTH, WIDTH)]
    },
    heads: Object.fromEntries(Object.entries(VOCAB).map(([k, v]) => [k, lin(v.length, WIDTH)])),
    trained: { samples: 0 }
  };
  return { ...model, ...over };
}

const obsOf = (seed) => {
  const r = rng(seed);
  return Array.from({ length: OBSERVATION_SIZE }, () => r());
};

const sum = (m) => [...m.values()].reduce((s, v) => s + v, 0);
const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
const refuses = (fn, why) => {
  assert.throws(fn, /policyNet:/, `expected a loud refusal: ${why}`);
};

// ---------------------------------------------------------------------------
// 1. the history window, rebuilt from seq
// ---------------------------------------------------------------------------

const mkSample = (round, slot, i) => ({
  seq: { round, slot, i },
  obs: new Array(OBSERVATION_SIZE).fill(i + 1)
});

{
  // Grouping never mixes two players, or one player's two rounds.
  const mixed = [
    mkSample('r1', 0, 1), mkSample('r1', 1, 0), mkSample('r1', 0, 0),
    mkSample('r2', 0, 0), mkSample('r1', 1, 1)
  ];
  const groups = groupBySeq(mixed);
  assert.equal(groups.size, 3, 'three (round, slot) sequences');
  assert.deepEqual(groups.get('r1|0').map((s) => s.seq.i), [0, 1], 'sorted by i');

  // A round start: everything before step 0 is ZERO, not a copy of the present.
  const g = [mkSample('r1', 0, 0), mkSample('r1', 0, 1), mkSample('r1', 0, 2)];
  const w = historyWindow(g, 2);
  assert.equal(w.length, STEPS, `${STEPS} frames`);
  for (let k = 0; k < STEPS - 3; k += 1) {
    assert.ok(w[k].every((v) => v === 0), `frame ${k} before the round start is zero-padded`);
  }
  assert.equal(w[STEPS - 3][0], 1, 'step 0 lands three from the end');
  assert.equal(w[STEPS - 2][0], 2, 'step 1 lands two from the end');
  assert.equal(w[STEPS - 1][0], 3, 'the last frame is the sample itself');

  // A window may never reach into the previous round even when steps line up.
  const two = [mkSample('r1', 0, 4), mkSample('r2', 0, 5)];
  const byRound = groupBySeq(two);
  const w2 = historyWindow(byRound.get('r2|0'), 0);
  for (let k = 0; k < STEPS - 1; k += 1) {
    assert.ok(w2[k].every((v) => v === 0), 'no frame crosses a round boundary');
  }

  // A GAP in `i` (the extractor dropped a step) becomes a zero frame. The
  // naive "previous row in the array" version slides step 1 into step 2's
  // slot here and teaches a tempo that never happened.
  const gap = [mkSample('r1', 0, 0), mkSample('r1', 0, 1), mkSample('r1', 0, 3)];
  const w3 = historyWindow(gap, 2);
  assert.equal(w3[STEPS - 1][0], 4, 'own observation last');
  assert.ok(w3[STEPS - 2].every((v) => v === 0), 'the missing step 2 is a zero frame');
  assert.equal(w3[STEPS - 3][0], 2, 'step 1 keeps its own slot');
  assert.equal(w3[STEPS - 4][0], 1, 'step 0 keeps its own slot');

  // Full window, no padding at all.
  const full = Array.from({ length: 20 }, (_, i) => mkSample('r1', 0, i));
  const w4 = historyWindow(full, 19);
  assert.equal(w4.length, STEPS);
  assert.ok(w4.every((f) => f.some((v) => v !== 0)), 'a mid-round window has no pad');
  assert.deepEqual(w4.map((f) => f[0]), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

  // Never mutate: the window is a copy.
  w4[0][0] = -999;
  assert.equal(full[8].obs[0], 9, 'historyWindow copies, it does not alias');
}

// ---------------------------------------------------------------------------
// 2. the export schema round-trips
// ---------------------------------------------------------------------------

const net = loadPolicyNet(tinyModel());
assert.equal(net.obsSize, OBSERVATION_SIZE);
assert.equal(net.steps, STEPS);
assert.deepEqual(net.vocab.option, VOCAB.option);
assert.deepEqual([...net.condKeys.call], ['passive-b', 'banana-pop']);

const obs = obsOf(99);
const history = Array.from({ length: STEPS - 1 }, (_, i) => obsOf(200 + i));
const base = net.probs(obs, { history, map: 'INF', call: 'passive-b', contract: 'banana', player: null });

assert.equal(base.size, VOCAB.option.length, 'one probability per option');
assert.ok(Math.abs(sum(base) - 1) < 1e-6, `probs sums to 1 (got ${sum(base)})`);
for (const v of base.values()) assert.ok(v >= 0 && v <= 1, 'probabilities are in [0, 1]');

// Deterministic: the scratch buffers are reused, so a stale-buffer bug would
// show up as a second call disagreeing with the first.
const again = net.probs(obs, { history, map: 'INF', call: 'passive-b', contract: 'banana', player: null });
assert.deepEqual([...again], [...base], 'probs is deterministic');
net.probs(obsOf(7), { history, call: 'banana-pop' }); // dirty the buffers
const third = net.probs(obs, { history, map: 'INF', call: 'passive-b', contract: 'banana', player: null });
assert.deepEqual([...third], [...base], 'probs does not depend on the previous call');

// Every head answers, and every head is a distribution.
const all = net.forward(obs, { history, map: 'INF', call: 'passive-b' });
assert.deepEqual(Object.keys(all).sort(), Object.keys(VOCAB).sort(), 'all six heads');
for (const [name, m] of Object.entries(all)) {
  assert.equal(m.size, VOCAB[name].length, `${name} head is ${VOCAB[name].length} wide`);
  assert.ok(Math.abs(sum(m) - 1) < 1e-6, `${name} sums to 1`);
}

// The inputs are not mutated.
const obsCopy = [...obs];
const histCopy = history.map((f) => [...f]);
net.probs(obs, { history, map: 'INF', call: 'passive-b' });
assert.deepEqual(obs, obsCopy, 'the observation is not mutated');
assert.deepEqual(history, histCopy, 'the history is not mutated');

// A short history is the ordinary case at a round start, and is zero-padded
// rather than refused.
const shortRun = net.probs(obs, { history: history.slice(-2), call: 'passive-b' });
assert.ok(Math.abs(sum(shortRun) - 1) < 1e-6, 'a short history still produces a distribution');
assert.ok(Math.abs(sum(net.probs(obs)) - 1) < 1e-6, 'no history at all still works');

// ---------------------------------------------------------------------------
// 3. loud refusals
// ---------------------------------------------------------------------------

refuses(() => loadPolicyNet(tinyModel({ obsVersion: OBSERVE_VERSION + 1 })), 'obsVersion mismatch');
refuses(() => loadPolicyNet(tinyModel({ obsSize: OBSERVATION_SIZE - 1 })), 'obsSize mismatch');
refuses(() => loadPolicyNet(tinyModel({ kind: 'policy' })), 'not a policyNet artifact');
refuses(() => loadPolicyNet(tinyModel({ v: 99 })), 'schema version');
refuses(() => loadPolicyNet(tinyModel({ history: { steps: STEPS, hz: 4, pad: 'repeat' } })), 'pad rule');

{
  // wrong obs width: the input projection reads a different observation
  const m = tinyModel();
  m.temporal.inProj.W = m.temporal.inProj.W.map((row) => row.slice(0, OBSERVATION_SIZE - 1));
  refuses(() => loadPolicyNet(m), 'inProj is not obsSize wide');
}
{
  // wrong vocab length: the head emits a different number of logits
  const m = tinyModel();
  m.heads.option.W = m.heads.option.W.slice(0, VOCAB.option.length - 1);
  m.heads.option.b = m.heads.option.b.slice(0, VOCAB.option.length - 1);
  refuses(() => loadPolicyNet(m), 'option head is shorter than its vocabulary');
}
{
  const m = tinyModel();
  m.vocab = { ...VOCAB, aim: ['on', 'near'] };
  refuses(() => loadPolicyNet(m), 'aim vocabulary shorter than its head');
}
{
  // wrong history length: the positional table does not cover the window
  const m = tinyModel();
  m.temporal.pos = m.temporal.pos.slice(0, STEPS - 1);
  refuses(() => loadPolicyNet(m), 'positional table is not steps long');
}
{
  const m = tinyModel();
  m.history = { steps: 1, hz: 4, pad: 'zero' };
  refuses(() => loadPolicyNet(m), 'a one-step window is not a window');
}
{
  // a head with no vocabulary, and a vocabulary with no head
  const m = tinyModel();
  delete m.heads.peek;
  refuses(() => loadPolicyNet(m), 'peek vocabulary has no head');
}
{
  const m = tinyModel();
  m.embed.call.keys['banana-pop'] = [1, 2];
  refuses(() => loadPolicyNet(m), 'a call row is not dim wide');
}
{
  const m = tinyModel();
  m.torso.activation = 'relu';
  refuses(() => loadPolicyNet(m), 'unknown torso activation');
}
{
  const m = tinyModel();
  m.vocab = { ...VOCAB, option: ['not_an_option', ...VOCAB.option.slice(1)] };
  refuses(() => loadPolicyNet(m), 'vocab entry is not a real option');
}

// at inference: a wrong-width observation or history frame is refused too
refuses(() => net.probs(obs.slice(0, 10), { history }), 'short observation');
refuses(() => net.probs([...obs, 0], { history }), 'long observation');
refuses(() => net.probs(obs, { history: [obs.slice(0, 5)] }), 'a history frame of the wrong width');

// ---------------------------------------------------------------------------
// 4. unknown conditioners fall back, known ones actually matter
// ---------------------------------------------------------------------------

const ctx = { history, map: 'INF', call: 'passive-b', contract: 'banana', player: '76561198000000001' };
const known = net.probs(obs, ctx);

for (const [field, bogus] of [['call', 'no-such-call'], ['contract', 'no-such-contract'],
  ['player', '76561190000000000'], ['map', 'ZZZ']]) {
  const missing = net.probs(obs, { ...ctx, [field]: bogus });
  const omitted = net.probs(obs, { ...ctx, [field]: undefined });
  assert.deepEqual([...missing], [...omitted],
    `an unknown ${field} rides the same default row as an absent one`);
  assert.ok(Math.abs(sum(missing) - 1) < 1e-6, `unknown ${field} still yields a distribution`);
  assert.notDeepEqual([...missing], [...known],
    `the ${field} conditioner is actually read (default differs from a known key)`);
}

// The call conditioner is the operator's core requirement: two calls, same
// observation, different answer.
const passive = net.probs(obs, { ...ctx, call: 'passive-b' });
const pop = net.probs(obs, { ...ctx, call: 'banana-pop' });
assert.notDeepEqual([...passive], [...pop], 'a different call gives a different distribution');

// ---------------------------------------------------------------------------
// 5. optional parity against the trainer's own numbers
// ---------------------------------------------------------------------------

if (process.env.POLICYNET_PARITY && process.env.POLICYNET_MODEL) {
  const probe = JSON.parse(fs.readFileSync(process.env.POLICYNET_PARITY, 'utf8'));
  const real = loadPolicyNet(JSON.parse(fs.readFileSync(process.env.POLICYNET_MODEL, 'utf8')));
  let worst = 0;
  for (const c of probe.cases) {
    const got = real.forward(c.obs, { history: c.history, ...c.cond });
    for (const [head, want] of Object.entries(c.probs)) {
      const mine = [...got[head].values()];
      assert.equal(mine.length, want.length, `${head} width matches torch`);
      for (let i = 0; i < want.length; i += 1) worst = Math.max(worst, Math.abs(mine[i] - want[i]));
    }
  }
  assert.ok(worst < 2e-3, `JS matches torch within 2e-3 (worst ${worst.toExponential(2)})`);
  console.log(`policyNet: parity with torch over ${probe.cases.length} real samples, worst |delta| ${worst.toExponential(2)}`);
}

console.log('policyNet: ok');
