// ---------------------------------------------------------------------------
// lib/routines.test.js
//   node --test src/lib/routines.test.js
//
// The recommender: tags to mechanics, weakness ranking, and whether the
// routine it builds actually trains what was asked and fits the time given.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MECHANIC_KEYS,
  SWITCH_SECONDS,
  TAG_HELPS,
  mechanicsHelpedBy,
  rankModesFor,
  recommendRoutine,
  weakestMechanics
} from './routines.js';
import { SCENARIO_META, isChallengeMode } from './gamemodeCatalog.js';
import { AIM_V2_MOTION_KEYS } from '../replays/shared/aimMetrics.js';
import { AIM_OUTCOME_KEYS } from '../replays/performance/aimChapter.js';

test('every mechanic a tag claims to help is a real mechanic', () => {
  for (const [tag, list] of Object.entries(TAG_HELPS)) {
    for (const key of list) {
      assert.ok(MECHANIC_KEYS.includes(key), `${tag} names unknown mechanic ${key}`);
    }
  }
});

test('every mechanic is reachable through some tag', () => {
  // A mechanic no tag helps could be selected and then silently ignored, and
  // the routine built for it would train everything except the thing asked.
  const reachable = new Set(Object.values(TAG_HELPS).flat());
  for (const key of MECHANIC_KEYS) {
    assert.ok(reachable.has(key), `no tag trains ${key}`);
  }
});

test('a mode helps the union of its tags, once each', () => {
  const helped = mechanicsHelpedBy(['Speed', 'Accuracy']);
  // accuracy and underflick appear in both tags; a Set holds them once.
  assert.ok(helped.has('accuracy'));
  assert.ok(helped.has('precision'), 'from Accuracy');
  assert.ok(helped.has('reaction'), 'from Speed');
  assert.equal(mechanicsHelpedBy([]).size, 0);
  assert.equal(mechanicsHelpedBy(['NotATag']).size, 0);
});

test('weakest mechanics rank by score and skip the unmeasured', () => {
  const scores = { tracking: 0.4, speed: 1.4, tension: 0.6, precision: null, reaction: 1.0 };
  assert.deepEqual(weakestMechanics(scores, 2), ['tracking', 'tension']);
  // Unmeasured precision must not appear: no data is not the same as bad.
  assert.ok(!weakestMechanics(scores, 5).includes('precision'));
  assert.deepEqual(weakestMechanics(null, 5), []);
});

test('ranked modes actually cover the asked mechanics', () => {
  const ranked = rankModesFor(['tracking', 'tension']);
  assert.ok(ranked.length > 0);
  for (const r of ranked) {
    assert.ok(r.covered.length > 0, `${r.mode} covers nothing yet was ranked`);
    assert.ok(!isChallengeMode(r.mode), 'challenges are fixed-rule and stay out of routines');
  }
  // Best first: no later entry covers more than the first.
  for (const r of ranked) assert.ok(r.covered.length <= ranked[0].covered.length);
});

test('a routine fits the time it was asked for', () => {
  const routine = recommendRoutine({ minutes: 15, mechanics: ['tracking', 'tension'] });
  assert.ok(routine, 'two coverable mechanics make a routine');
  const est = routine.estimatedSeconds;
  assert.ok(est >= 15 * 60 * 0.7 && est <= 15 * 60 * 1.2, `15 min asked, ${est}s planned`);
  for (const item of routine.items) {
    assert.equal(item.config.duration.type, 'time');
    assert.ok(item.config.duration.value >= 30, 'no ten-second drills');
    assert.ok(item.config.duration.value % 15 === 0, 'durations read as chosen, not computed');
  }
});

test('a short ask still trains and a long ask does not fragment', () => {
  const short = recommendRoutine({ minutes: 2, mechanics: ['accuracy'] });
  assert.ok(short.items.length >= 3, 'a routine is at least three modes');
  const long = recommendRoutine({ minutes: 120, mechanics: MECHANIC_KEYS });
  assert.ok(long.items.length <= 12, 'and at most twelve');
  assert.ok(
    long.items.every((i) => i.config.duration.value <= 180),
    'long asks lengthen runs rather than adding a fortieth mode'
  );
});

test('every wanted mechanic is covered by at least one picked mode', () => {
  // The greedy balance this guards: without it, five mechanics asked means the
  // two easiest to cover fill the routine and the rest ride along in name.
  const wanted = ['tracking', 'crosshairError', 'speed', 'underflick', 'adjustments'];
  const routine = recommendRoutine({ minutes: 20, mechanics: wanted });
  const covered = new Set();
  for (const item of routine.items) {
    for (const key of mechanicsHelpedBy(SCENARIO_META[item.scenario].tags)) covered.add(key);
  }
  for (const key of wanted) assert.ok(covered.has(key), `${key} is asked for but untrained`);
});

test('nothing to train, no routine', () => {
  assert.equal(recommendRoutine({ minutes: 10, mechanics: [] }), null);
  assert.equal(recommendRoutine({ minutes: 10, mechanics: ['nonsense'] }), null);
});

test('the same ask always builds the same routine', () => {
  const a = recommendRoutine({ minutes: 10, mechanics: ['flicks', 'reaction'] });
  const b = recommendRoutine({ minutes: 10, mechanics: ['flicks', 'reaction'] });
  assert.deepEqual(a, b, 'recommendation is deterministic');
});

test('switch overhead is accounted, not imagined', () => {
  const routine = recommendRoutine({ minutes: 10, mechanics: ['accuracy'] });
  const runSeconds = routine.items.reduce((s, i) => s + i.config.duration.value, 0);
  assert.equal(
    routine.estimatedSeconds,
    runSeconds + routine.items.length * SWITCH_SECONDS,
    'estimate = runs + switches'
  );
});

test('a mechanic and an aim component are the same thing, by the same name', () => {
  // The Routines page preselects the five weakest straight off the player row
  // Performance's Aim chapter is built from, with no translation table in
  // between: `weakestMechanics(row.aimComponents)`. That only works while the
  // two vocabularies are identical, and it fails SILENTLY when they are not,
  // because an unknown key is simply skipped and the page preselects four
  // mechanics, or three, and says nothing. Rename either side and this fails
  // here instead of in front of a player.
  const chapter = [
    ...AIM_V2_MOTION_KEYS.map((k) => k.key),
    ...AIM_OUTCOME_KEYS.map((k) => k.key)
  ];
  const mechanics = [...MECHANIC_KEYS];
  assert.deepEqual(
    [...mechanics].sort(),
    [...chapter].sort(),
    'every mechanic is scored by the Aim chapter, and every score is a mechanic'
  );
});

test('the weakest five come off an aim row untranslated', () => {
  // The shape the page actually receives: a `derivePlayers` row's components,
  // 0 to 100, some of them null where the sample was too thin to score.
  const row = {
    precision: 71, speed: 44, flicks: 66, adjustments: 58, reaction: 39,
    tension: null, tracking: 22, crosshairError: 51, readyRate: 63,
    accuracy: 48, firstBullet: 35, overflick: 69, underflick: 57
  };
  const weakest = weakestMechanics(row, 5);
  assert.deepEqual(weakest, ['tracking', 'firstBullet', 'reaction', 'speed', 'accuracy']);
  assert.ok(!weakest.includes('tension'), 'an unscored category is not a weakness');
});
