// The model's structural guarantees, and that each input pushes the odds the
// way the game does.
//
// These are not accuracy tests. Accuracy is what the exam in the trainer
// measures against real duels. These check the things that must hold for any
// parameter vector at all, including ones training has not produced yet: if
// P(a) + P(b) ever stops being 1, or a better crosshair ever stops helping,
// the numbers on screen are wrong no matter how well the fit scored.

import { BUCKET_IDS, bucketize } from './buckets.js';
import { contextLogit, predictDuel, sigmoid, threatScore } from './duelModel.js';
import { initialVector } from './paramSpec.js';
import { examPoints, logLoss, brier } from './scoring.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const v = initialVector();

/** A featureless player, so each test changes exactly one thing. */
function player(over = {}) {
  return {
    slot: 0,
    weapon: 'ak47',
    category: 'rifle',
    price: 2700,
    oneTap: true,
    cycleSeconds: 0.1,
    speed: 0,
    hp: 100,
    armor: 100,
    helmet: true,
    flash: 0,
    scoped: false,
    ducking: false,
    airborne: false,
    reloading: false,
    magFraction: 1,
    sinceShot: Infinity,
    ...over
  };
}

function ctx(aOver = {}, bOver = {}, over = {}) {
  const a = player({ slot: 0, ...aOver });
  const b = player({ slot: 1, ...bOver });
  return {
    pair: {
      aSlot: 0,
      bSlot: 1,
      a,
      b,
      dist: over.dist ?? 800,
      offA: over.offA ?? 5,
      offB: over.offB ?? 5,
      infoAdvSecs: over.infoAdvSecs ?? 0,
      losClear: true
    },
    threatsOnA: over.threatsOnA ?? [],
    threatsOnB: over.threatsOnB ?? [],
    spreadA: over.spreadA ?? 0,
    spreadB: over.spreadB ?? 0
  };
}

/** The same duel with the two players swapped. */
function mirror(c) {
  const p = c.pair;
  return {
    pair: {
      aSlot: p.bSlot,
      bSlot: p.aSlot,
      a: p.b,
      b: p.a,
      dist: p.dist,
      offA: p.offB,
      offB: p.offA,
      infoAdvSecs: -p.infoAdvSecs,
      losClear: p.losClear
    },
    threatsOnA: c.threatsOnB,
    threatsOnB: c.threatsOnA,
    spreadA: c.spreadB,
    spreadB: c.spreadA
  };
}

// --- probabilities are probabilities ---------------------------------------
{
  const cases = [
    ctx(),
    ctx({ weapon: 'awp', category: 'sniper', price: 4750 }, { weapon: 'glock', category: 'pistol', price: 200 }),
    ctx({ hp: 5, flash: 4, reloading: true }, {}, { offA: 170, dist: 3000 }),
    ctx({}, {}, { threatsOnA: [{ p: player({ slot: 2 }), dist: 500, off: 2 }], spreadA: 90 })
  ];
  for (const c of cases) {
    const p = predictDuel(c, v);
    assert(p > 0 && p < 1, `probability out of range: ${p}`);
    assert(Number.isFinite(p), 'probability must be finite');
  }
}

// --- the antisymmetry the whole design rests on ----------------------------
// P(a) + P(b) must be exactly 1, before and after the outnumbered coupling.
{
  const cases = [
    ctx(),
    ctx({ weapon: 'awp', category: 'sniper', price: 4750, scoped: true }, { speed: 240 }, { offA: 1, offB: 44 }),
    ctx({ hp: 30, helmet: false }, { hp: 100, armor: 0 }, { dist: 2400, infoAdvSecs: 3 }),
    ctx(
      {},
      {},
      {
        threatsOnA: [
          { p: player({ slot: 2, weapon: 'awp', category: 'sniper', price: 4750 }), dist: 900, off: 3 },
          { p: player({ slot: 3 }), dist: 1500, off: 20 }
        ],
        threatsOnB: [{ p: player({ slot: 4 }), dist: 600, off: 8 }],
        spreadA: 110,
        spreadB: 15
      }
    )
  ];
  for (const [i, c] of cases.entries()) {
    const pa = predictDuel(c, v);
    const pb = predictDuel(mirror(c), v);
    assert(close(pa + pb, 1, 1e-12), `case ${i}: P(a)+P(b) = ${pa + pb}, must be 1`);
    assert(close(contextLogit(c, v), -contextLogit(mirror(c), v), 1e-9), `case ${i}: logit not antisymmetric`);
  }
}

// An even fight between identical players is a coin flip, by construction.
{
  assert(close(predictDuel(ctx(), v), 0.5, 1e-12), 'identical players must be 50/50');
}

// --- each input moves the odds the way the game does -----------------------
{
  const base = predictDuel(ctx({}, {}, { offA: 20, offB: 20 }), v);

  // Crosshair already on target beats crosshair off it.
  assert(predictDuel(ctx({}, {}, { offA: 1, offB: 20 }), v) > base, 'better crosshair should help');
  assert(predictDuel(ctx({}, {}, { offA: 40, offB: 20 }), v) < base, 'worse crosshair should hurt');

  // The falloff is not linear: the first few degrees are worth far more than
  // the difference between badly off and hopelessly off.
  const near = threatScore(player(), player(), 1, 800, v) - threatScore(player(), player(), 6, 800, v);
  const far = threatScore(player(), player(), 60, 800, v) - threatScore(player(), player(), 180, 800, v);
  assert(near > far * 3, 'crosshair curve should be steep near zero and flat far out');

  // Guns, condition, and state.
  assert(
    predictDuel(ctx({ weapon: 'awp', category: 'sniper', price: 4750 }, {}, { offA: 20, offB: 20 }), v) > base,
    'the better gun should help'
  );
  assert(predictDuel(ctx({ hp: 20 }, {}, { offA: 20, offB: 20 }), v) < base, 'being hurt should hurt');
  assert(predictDuel(ctx({}, { flash: 3 }, { offA: 20, offB: 20 }), v) > base, 'a flashed opponent should help');
  assert(predictDuel(ctx({ reloading: true }, {}, { offA: 20, offB: 20 }), v) < base, 'reloading should hurt');
  assert(predictDuel(ctx({ speed: 250 }, {}, { offA: 20, offB: 20 }), v) < base, 'running should hurt');
  assert(
    predictDuel(ctx({}, {}, { offA: 20, offB: 20, infoAdvSecs: 3 }), v) > base,
    'seeing them first should help'
  );

  // A bolt gun that has just fired is mid-cycle and briefly helpless.
  const awp = { weapon: 'awp', category: 'sniper', price: 4750, cycleSeconds: 1.46 };
  const ready = predictDuel(ctx({ ...awp, sinceShot: Infinity }, {}, { offA: 20, offB: 20 }), v);
  const cycling = predictDuel(ctx({ ...awp, sinceShot: 0.1 }, {}, { offA: 20, offB: 20 }), v);
  assert(cycling < ready, 'an AWP mid-cycle should be worse off than one ready to fire');
}

// --- being outnumbered, and the shape of it -------------------------------
{
  const solo = predictDuel(ctx(), v);
  const watcher = (over = {}) => ({ p: player({ slot: 2, ...over }), dist: 800, off: 5 });

  const one = predictDuel(ctx({}, {}, { threatsOnA: [watcher()], spreadA: 40 }), v);
  const two = predictDuel(ctx({}, {}, { threatsOnA: [watcher(), watcher()], spreadA: 40 }), v);
  assert(one < solo, 'a second enemy watching should hurt');
  assert(two < one, 'a third should hurt more');

  // The inverse, from the other end: a team mate on the opponent helps.
  assert(predictDuel(ctx({}, {}, { threatsOnB: [watcher()] }), v) > solo, 'help on the opponent should favour A');

  // Two enemies in a crossfire are worse than the same two stood together.
  const tight = predictDuel(ctx({}, {}, { threatsOnA: [watcher()], spreadA: 10 }), v);
  const wide = predictDuel(ctx({}, {}, { threatsOnA: [watcher()], spreadA: 150 }), v);
  assert(wide < tight, 'a wide crossfire should be worse than a clumped pair');

  // Spread only means something once there is more than one enemy.
  assert(
    close(predictDuel(ctx({}, {}, { spreadA: 150 }), v), solo, 1e-12),
    'spread with a single opponent must not change anything'
  );
}

// --- scoring ---------------------------------------------------------------
{
  // The exam: confidence above even money, signed by whether it was right.
  assert(close(examPoints(0.5, 1), 0), 'a 50/50 call scores nothing');
  assert(close(examPoints(0.5, 0), 0), 'a 50/50 call scores nothing either way');
  assert(close(examPoints(0.6, 1), 2), '60/40 right is +2');
  assert(close(examPoints(0.6, 0), -2), '60/40 wrong is -2');
  assert(close(examPoints(0.4, 0), 2), 'the rule is symmetric in which player won');
  assert(close(examPoints(1, 1), 10), 'a certain correct call is +10');

  // Log loss: a coin flip on everything scores ln 2, and overclaiming is
  // punished far harder than it is rewarded. This is the property that stops
  // the model bluffing its way to a good exam score.
  assert(close(logLoss(0.5, 1), Math.log(2), 1e-12), 'a coin flip scores ln 2');
  assert(logLoss(0.99, 0) > 20 * logLoss(0.99, 1), 'a confident miss must cost far more than it gains');
  assert(logLoss(0.6, 1) < logLoss(0.5, 1), 'being right and confident beats being unsure');
  assert(close(brier(0.5, 1), 0.25), 'brier at even money');
}

// --- buckets ---------------------------------------------------------------
{
  const ids = new Set(BUCKET_IDS);
  const solo = bucketize(ctx({}, {}, { dist: 300 }));
  assert(solo.includes('1v1_close'), 'a short 1v1 is close range');
  assert(solo.includes('tier_even'), 'two AKs are an even matchup');
  assert(solo.every((b) => ids.has(b)), 'every bucket must be a declared id');

  const hard = bucketize(
    ctx(
      { flash: 2, speed: 200, reloading: true, weapon: 'glock', category: 'pistol', price: 200 },
      { weapon: 'awp', category: 'sniper', price: 4750 },
      {
        dist: 2000,
        threatsOnA: [
          { p: player({ slot: 2 }), dist: 900, off: 4 },
          { p: player({ slot: 3 }), dist: 900, off: 4 }
        ],
        spreadA: 120
      }
    )
  );
  for (const want of ['1v3plus', 'tier_down', 'flashed', 'moving', 'reloading', 'spread_wide']) {
    assert(hard.includes(want), `expected bucket ${want}, got ${hard.join(',')}`);
  }
  // Being outnumbered replaces the range bucket rather than adding to it, so a
  // 1v3 cannot also be counted as a clean 1v1.
  assert(!hard.some((b) => b.startsWith('1v1')), 'a 1v3 must not also file as a 1v1');
}

// --- sigmoid stays sane at the extremes ------------------------------------
{
  assert(close(sigmoid(0), 0.5), 'sigmoid(0)');
  assert(sigmoid(800) === 1 || sigmoid(800) > 0.999999, 'no overflow going up');
  assert(sigmoid(-800) >= 0 && sigmoid(-800) < 1e-6, 'no overflow going down');
  assert(Number.isFinite(sigmoid(-800)), 'still finite at the bottom');
}

console.log('duelModel.test.js: ok');
