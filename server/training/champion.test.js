// The promotion rule, which is the only thing standing between a bad seed and
// the live model.
//
// Training is one run per press and each run is a different seed, so most runs
// are worse than what is already deployed. The store has to keep the champion,
// record the attempt, and never let a regression through. It also has to notice
// when the parameter layout changed, because then the two losses are not
// measuring the same model and comparing them is meaningless.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aim4-champion-'));
process.env.AIM4_MODELS_DIR = path.join(tmp, 'models');
process.env.AIM4_TRAINING_DIR = path.join(tmp, 'training');

const { offerChampion, readChampion, totalImprovement } = await import('./champion.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const base = {
  specHash: 'abc123',
  values: { manW: 1 },
  generation: 5,
  seed: 1,
  trainedOn: 100
};

// First run has nothing to beat.
{
  const r = await offerChampion('round', { ...base, validLoss: 0.5 });
  assert(r.promoted, 'the first champion is always promoted');
  assert(r.reason === 'first champion', r.reason);
  const c = await readChampion('round');
  assert(close(c.validLoss, 0.5), 'stored loss');
  assert(close(c.baselineLoss, 0.5), 'baseline starts at the first loss');
  assert(c.promotions === 1, 'promotion counted');
  assert(c.history.length === 1 && c.history[0].promoted, 'attempt recorded');
}

// A better run takes over, and improvement accumulates from the baseline.
{
  const r = await offerChampion('round', { ...base, validLoss: 0.45, seed: 2, generation: 9 });
  assert(r.promoted, 'a lower loss must be promoted');
  assert(close(r.improvement, 0.05), `improvement ${r.improvement}`);
  const c = await readChampion('round');
  assert(close(c.validLoss, 0.45) && c.seed === 2, 'champion replaced');
  assert(close(c.baselineLoss, 0.5), 'baseline is not moved by a promotion');
  assert(close(totalImprovement(c), 0.05), 'total improvement since the first');
  assert(c.promotions === 2, 'promotions accumulate');
}

// A worse run is recorded and rejected. This is the case that matters most:
// most seeds lose, and losing must be free.
{
  const r = await offerChampion('round', { ...base, validLoss: 0.6, seed: 3 });
  assert(!r.promoted, 'a higher loss must not be promoted');
  const c = await readChampion('round');
  assert(close(c.validLoss, 0.45) && c.seed === 2, 'champion untouched by a worse run');
  assert(c.history.length === 3, 'the failed attempt is still recorded');
  assert(c.history[2].promoted === false && c.history[2].seed === 3, 'recorded as a loss');
}

// An exact tie is not an improvement.
{
  const r = await offerChampion('round', { ...base, validLoss: 0.45, seed: 4 });
  assert(!r.promoted, 'a tie is not an improvement');
}

// A run that produced no loss at all cannot win by default.
{
  const r = await offerChampion('round', { ...base, validLoss: NaN, seed: 5 });
  assert(!r.promoted, 'a run with no held-out loss cannot be promoted');
  const c = await readChampion('round');
  assert(close(c.validLoss, 0.45), 'champion survives a broken run');
}

// A parameter layout change starts a fresh lineage rather than comparing across
// two different meanings of the same weight names.
{
  const r = await offerChampion('round', {
    ...base,
    specHash: 'different',
    validLoss: 0.9,
    seed: 6
  });
  assert(r.promoted, 'a new layout starts a new lineage');
  const c = await readChampion('round');
  assert(c.specHash === 'different', 'new spec stored');
  assert(close(c.baselineLoss, 0.9), 'baseline restarts with the lineage');
  assert(c.promotions === 1, 'promotion count restarts');
  assert(c.history.length === 1, 'history restarts, old losses are not comparable');
}

// The two models are stored apart.
{
  assert((await readChampion('duel')) === null, 'duel starts empty');
  await offerChampion('duel', { ...base, validLoss: 0.7 });
  const duel = await readChampion('duel');
  const round = await readChampion('round');
  assert(close(duel.validLoss, 0.7), 'duel champion stored');
  assert(close(round.validLoss, 0.9), 'round champion unaffected');
}

await fs.rm(tmp, { recursive: true, force: true });
console.log('champion.test.js: ok');
