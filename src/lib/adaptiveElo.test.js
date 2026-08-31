// ---------------------------------------------------------------------------
// lib/adaptiveElo.test.js
//   node --test src/lib/adaptiveElo.test.js
//
// The adaptive rating and its grip on the game. Two promises are pinned hard:
// the per-run step stays inside ±10..±50, and the difficulty knobs move
// SLIGHTLY - 200 ELO is a few percent, never planet-sized targets.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

// Storage-backed parts need a localStorage; give the module a real-enough one.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

const {
  DEFAULT_ELO,
  MAX_STEP,
  MIN_STEP,
  applyAdaptiveDifficulty,
  difficultyFor,
  eloDeltaFor,
  eloFor,
  recordAdaptiveRun
} = await import('./adaptiveElo.js');

// ---- the update -------------------------------------------------------------

test('the first run moves nothing, it only sets the baseline', () => {
  assert.equal(eloDeltaFor(500, []), 0);
  assert.equal(eloDeltaFor(500, null), 0);
});

test('matching your own median is the smallest step up', () => {
  assert.equal(eloDeltaFor(100, [100, 100, 100]), MIN_STEP);
});

test('the step scales with how far off your usual score the run was', () => {
  const history = [1000];
  const slight = eloDeltaFor(1040, history); // +4%
  const solid = eloDeltaFor(1100, history); // +10%
  const huge = eloDeltaFor(1500, history); // +50%
  assert.ok(slight > MIN_STEP && slight < solid, `4% is a small step, got ${slight}`);
  assert.ok(solid < MAX_STEP, `10% is not yet the full step, got ${solid}`);
  assert.equal(huge, MAX_STEP, 'a blowout caps at the full step');
  assert.equal(eloDeltaFor(500, history), -MAX_STEP, 'and a collapse caps the same way down');
});

test('every step lands inside the promised band', () => {
  for (const score of [0, 1, 50, 99, 100, 101, 150, 10000]) {
    const d = eloDeltaFor(score, [100, 110, 90]);
    assert.ok(Math.abs(d) >= MIN_STEP && Math.abs(d) <= MAX_STEP, `${score} stepped ${d}`);
  }
});

test('a history of zeros cannot divide the rating away', () => {
  assert.ok(eloDeltaFor(50, [0, 0, 0]) > 0, 'scoring anything beats a zero median');
  assert.equal(eloDeltaFor(0, [0, 0]), -MIN_STEP, 'scoring nothing again steps gently down');
});

// ---- the knobs --------------------------------------------------------------

test('difficulty at the default ELO is exactly the competitive preset', () => {
  assert.deepEqual(difficultyFor(DEFAULT_ELO), { size: 1, speed: 1, track: 1 });
});

test('200 ELO moves the knobs by percent, not planets', () => {
  const easier = difficultyFor(DEFAULT_ELO - 200);
  assert.ok(easier.size > 1 && easier.size < 1.1, `size at -200 is ${easier.size}`);
  assert.ok(easier.speed < 1 && easier.speed > 0.9, `speed at -200 is ${easier.speed}`);
  const harder = difficultyFor(DEFAULT_ELO + 200);
  assert.ok(harder.size < 1 && harder.size > 0.9, `size at +200 is ${harder.size}`);
});

test('even absurd ratings stay inside the clamps', () => {
  const floor = difficultyFor(-99999);
  const ceil = difficultyFor(99999);
  assert.ok(floor.size <= 1.3 && floor.speed >= 0.75 && floor.track >= 0.7);
  assert.ok(ceil.size >= 0.75 && ceil.speed <= 1.35 && ceil.track <= 1.5);
});

test('only difficulty fields are scaled, and only ones the preset has', () => {
  const preset = {
    targetSize: 0.35,
    targetCount: 5, // layout: untouched
    travelSpeed: 25,
    trackTime: 0.4,
    boundsScaleX: 1.2 // layout: untouched
  };
  const harder = applyAdaptiveDifficulty(preset, DEFAULT_ELO + 300);
  assert.ok(harder.targetSize < preset.targetSize, 'targets shrink');
  assert.ok(harder.travelSpeed > preset.travelSpeed, 'movement speeds up');
  assert.ok(harder.trackTime > preset.trackTime, 'holds lengthen');
  assert.equal(harder.targetCount, 5, 'layout is not difficulty');
  assert.equal(harder.boundsScaleX, 1.2);
  // A preset with no such fields comes back unchanged.
  assert.deepEqual(applyAdaptiveDifficulty({ columns: 5 }, 1400), { columns: 5 });
  assert.equal(applyAdaptiveDifficulty(null, 1400), null);
});

test('the default ELO leaves the preset byte-identical in value', () => {
  const preset = { targetSize: 0.35, travelSpeed: 25, trackTime: 0.4 };
  assert.deepEqual(applyAdaptiveDifficulty(preset, DEFAULT_ELO), preset);
});

// ---- the store --------------------------------------------------------------

test('a mode starts at the default and remembers its runs', () => {
  store.clear();
  assert.equal(eloFor('gridshot'), DEFAULT_ELO);

  const first = recordAdaptiveRun('gridshot', 900);
  assert.equal(first.delta, 0, 'first run is the baseline');
  assert.equal(first.elo, DEFAULT_ELO);

  const second = recordAdaptiveRun('gridshot', 1080); // 20% over the median
  assert.ok(second.delta >= MIN_STEP, 'a better run climbs');
  assert.equal(second.elo, second.prevElo + second.delta);
  assert.equal(eloFor('gridshot'), second.elo, 'and the store agrees');
});

test('modes rate independently', () => {
  store.clear();
  recordAdaptiveRun('gridshot', 100);
  recordAdaptiveRun('gridshot', 200);
  assert.equal(eloFor('tracking'), DEFAULT_ELO, 'an unplayed mode is untouched');
});

test('history is bounded, so one mode cannot grow storage forever', () => {
  store.clear();
  for (let i = 0; i < 40; i++) recordAdaptiveRun('gridshot', 100 + i);
  const raw = JSON.parse(store.get('aimtrainer:adaptiveElo'));
  assert.ok(raw.gridshot.runs.length <= 10, `kept ${raw.gridshot.runs.length} runs`);
});

test('corrupted storage falls back to the default instead of crashing', () => {
  store.set('aimtrainer:adaptiveElo', 'not json');
  assert.equal(eloFor('gridshot'), DEFAULT_ELO);
  store.set('aimtrainer:adaptiveElo', JSON.stringify({ gridshot: { elo: 'soup' } }));
  assert.equal(eloFor('gridshot'), DEFAULT_ELO);
  const rec = recordAdaptiveRun('gridshot', 100);
  assert.equal(rec.prevElo, DEFAULT_ELO);
});
