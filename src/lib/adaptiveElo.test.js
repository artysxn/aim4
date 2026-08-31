// ---------------------------------------------------------------------------
// lib/adaptiveElo.test.js
//   node --test src/lib/adaptiveElo.test.js
//
// The rating is per MECHANIC and a gamemode is played at the mean of the ones
// it is made of, so the tests are about the split: a result has to move the
// mechanic that was behind far more than the one that was ahead, and the
// difficulty knobs have to keep moving SLIGHTLY, a few percent per 200 ELO and
// never planet-sized targets.
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
  DECISIVE,
  DEFAULT_ELO,
  K_FACTOR,
  allCategoryElos,
  applyAdaptiveDifficulty,
  categoriesFor,
  categoryElo,
  difficultyFor,
  eloFor,
  expectedScore,
  outcomeFor,
  recordAdaptiveRun
} = await import('./adaptiveElo.js');

const KEY = 'aimtrainer:adaptiveElo';
const read = () => JSON.parse(store.get(KEY));

/** Put a mechanic on a known rating without playing to it. */
function seed(cats) {
  store.set(KEY, JSON.stringify({ v: 2, cats, runs: {} }));
}

// ---- the result ------------------------------------------------------------

test('the first run has nothing to be judged against', () => {
  assert.equal(outcomeFor(500, []), null);
  assert.equal(outcomeFor(500, null), null);
});

test('matching your own median is a draw', () => {
  // Not a small win. The difficulty was set from the rating, so performing
  // exactly to it is evidence the rating was already right.
  assert.equal(outcomeFor(100, [100, 100, 100]), 0.5);
});

test('the result scales with how far off your usual score the run was', () => {
  const history = [1000];
  assert.ok(outcomeFor(1040, history) > 0.5, 'a better run is a win');
  assert.ok(outcomeFor(1040, history) < outcomeFor(1100, history), 'and more so further out');
  // A hair under 1, because 1000 * 1.16 is not exactly 1160 in binary.
  assert.ok(outcomeFor(1000 * (1 + DECISIVE), history) > 0.999, 'a decisive win saturates');
  assert.equal(outcomeFor(1500, history), 1, 'and cannot go past it');
  assert.ok(outcomeFor(1000 * (1 - DECISIVE), history) < 0.001, 'a decisive loss saturates');
  assert.equal(outcomeFor(0, history), 0);
});

test('a history of zeros cannot divide the rating away', () => {
  assert.equal(outcomeFor(50, [0, 0, 0]), 1, 'scoring anything beats a zero median');
  assert.ok(outcomeFor(0, [0, 0]) < 0.5, 'scoring nothing again is a mild loss');
});

// ---- the split ---------------------------------------------------------------

test('expected score is ordinary Elo', () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  assert.ok(Math.abs(expectedScore(1000, 1250) - 0.1917) < 0.001);
  assert.ok(Math.abs(expectedScore(1500, 1250) - 0.8083) < 0.001);
  // Symmetric: what one side is expected to win, the other is expected to lose.
  assert.ok(Math.abs(expectedScore(1000, 1250) + expectedScore(1250, 1000) - 1) < 1e-12);
});

test('a mode is played at the mean of the mechanics it is made of', () => {
  store.clear();
  // Gridshot is Speed + Accuracy.
  assert.deepEqual(categoriesFor('gridshot').sort(), ['Accuracy', 'Speed']);
  seed({ Speed: 1000, Accuracy: 1500 });
  assert.equal(eloFor('gridshot'), 1250);
  seed({ Speed: 1000, Accuracy: 1000 });
  assert.equal(eloFor('gridshot'), 1000);
});

test('a win pays the mechanic that was behind far more than the one ahead', () => {
  // The whole point. Speed 1000 and Accuracy 1500 play Gridshot at 1250; the
  // 1000 was not expected to beat a 1250 and is paid for doing it.
  store.clear();
  seed({ Speed: 1000, Accuracy: 1500 });
  recordAdaptiveRun('gridshot', 1000); // baseline
  const res = recordAdaptiveRun('gridshot', 1000 * (1 + DECISIVE)); // decisive win

  const speed = res.categories.find((c) => c.category === 'Speed');
  const acc = res.categories.find((c) => c.category === 'Accuracy');
  assert.ok(speed.delta > 0 && acc.delta > 0, 'a win moves both up');
  assert.ok(speed.delta > acc.delta * 3, `behind gained ${speed.delta}, ahead ${acc.delta}`);
  assert.equal(speed.delta, Math.round(K_FACTOR * (1 - expectedScore(1000, 1250))));
  assert.equal(acc.delta, Math.round(K_FACTOR * (1 - expectedScore(1500, 1250))));
});

test('a loss costs the mechanic that was ahead far more than the one behind', () => {
  store.clear();
  seed({ Speed: 1000, Accuracy: 1500 });
  recordAdaptiveRun('gridshot', 1000);
  const res = recordAdaptiveRun('gridshot', 1000 * (1 - DECISIVE));
  const speed = res.categories.find((c) => c.category === 'Speed');
  const acc = res.categories.find((c) => c.category === 'Accuracy');
  assert.ok(speed.delta < 0 && acc.delta < 0);
  assert.ok(Math.abs(acc.delta) > Math.abs(speed.delta) * 3, 'the favourite pays for losing');
});

test('an even matchup splits a result evenly', () => {
  store.clear();
  seed({ Speed: 1200, Accuracy: 1200 });
  recordAdaptiveRun('gridshot', 500);
  const res = recordAdaptiveRun('gridshot', 500 * (1 + DECISIVE));
  const [a, b] = res.categories;
  assert.equal(a.delta, b.delta, 'nothing to tell them apart');
  assert.equal(a.delta, Math.round(K_FACTOR * 0.5));
});

test('a draw still converges a lopsided pair', () => {
  // Performing exactly to a difficulty built out of 1000 and 1500 is evidence
  // for 1250 twice over, not for the gap.
  store.clear();
  seed({ Speed: 1000, Accuracy: 1500 });
  recordAdaptiveRun('gridshot', 800);
  const res = recordAdaptiveRun('gridshot', 800); // exactly the median: a draw
  const speed = res.categories.find((c) => c.category === 'Speed');
  const acc = res.categories.find((c) => c.category === 'Accuracy');
  assert.ok(speed.delta > 0, 'the one behind comes up');
  assert.ok(acc.delta < 0, 'the one ahead comes down');
  assert.equal(speed.delta, -acc.delta, 'and the mode itself has not moved');
  assert.equal(res.delta, 0);
});

test('a mechanic climbs from any mode that trains it', () => {
  // The reason ratings are per mechanic at all: Speed learned in Gridshot is
  // Speed, and the next Speed mode starts from what was learned.
  store.clear();
  recordAdaptiveRun('gridshot', 100); // Speed + Accuracy
  recordAdaptiveRun('gridshot', 200); // a big win
  assert.ok(categoryElo('Speed') > DEFAULT_ELO, 'Speed went up');
  assert.ok(eloFor('reactiontime') > DEFAULT_ELO, 'and Speed + Reactions felt it');
});

test('a mechanic the mode does not train is untouched', () => {
  store.clear();
  recordAdaptiveRun('gridshot', 100);
  recordAdaptiveRun('gridshot', 200);
  assert.equal(categoryElo('Movement'), DEFAULT_ELO, 'Gridshot is not a Movement mode');
});

test('the ratings a build knows about are all readable', () => {
  store.clear();
  const all = allCategoryElos();
  assert.deepEqual(Object.keys(all).sort(), ['Accuracy', 'Control', 'Movement', 'Reactions', 'Speed']);
  for (const v of Object.values(all)) assert.equal(v, DEFAULT_ELO);
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
  assert.equal(first.outcome, null);
  assert.equal(first.elo, DEFAULT_ELO);

  const second = recordAdaptiveRun('gridshot', 1080); // 8% over the median
  assert.ok(second.delta > 0, 'a better run climbs');
  assert.equal(second.elo, eloFor('gridshot'), 'and the store agrees');
});

test('runs are counted per mode, ratings per mechanic', () => {
  store.clear();
  recordAdaptiveRun('gridshot', 100);
  recordAdaptiveRun('gridshot', 200);
  // Tracking is Accuracy only, and Accuracy did move.
  assert.notEqual(eloFor('tracking'), DEFAULT_ELO);
  // But its own run history is its own: the first Tracking run is a baseline.
  const first = recordAdaptiveRun('tracking', 5);
  assert.equal(first.outcome, null, 'a mode nobody has played has no median');
});

test('history is bounded, so one mode cannot grow storage forever', () => {
  store.clear();
  for (let i = 0; i < 40; i++) recordAdaptiveRun('gridshot', 100 + i);
  assert.ok(read().runs.gridshot.length <= 10, `kept ${read().runs.gridshot.length} runs`);
});

test('a rating cannot run away, however many wins in a row', () => {
  store.clear();
  for (let i = 0; i < 500; i++) recordAdaptiveRun('gridshot', 100 * 2 ** Math.min(i, 30));
  const all = allCategoryElos();
  for (const [cat, v] of Object.entries(all)) {
    assert.ok(v <= 3000, `${cat} reached ${v}`);
  }
  assert.ok(eloFor('gridshot') <= 3000);
});

test('a per-gamemode store from the old build is carried over, not dropped', () => {
  // v1 held one rating per MODE. Each mechanic is seeded with the mean of the
  // modes that trained it, because throwing them away would silently reset
  // everyone who had played adaptive with no way to tell.
  store.clear();
  store.set(
    KEY,
    JSON.stringify({
      gridshot: { elo: 1400, runs: [100, 110] }, // Speed + Accuracy
      tracking: { elo: 1200, runs: [50] } // Accuracy
    })
  );
  assert.equal(categoryElo('Speed'), 1400, 'only Gridshot rated Speed');
  assert.equal(categoryElo('Accuracy'), 1300, 'both rated Accuracy, so the mean');
  assert.equal(categoryElo('Movement'), DEFAULT_ELO, 'nothing rated Movement');
  assert.deepEqual(read().gridshot.runs, [100, 110], 'and the old runs are still there to migrate');
  // Recording once rewrites the store in the new shape, carrying the ratings
  // and the run history. The run itself is a draw against a difficulty built
  // from those carried numbers, so Speed drifts a little toward it rather than
  // resetting: what must not happen is 1400 becoming 1000.
  const res = recordAdaptiveRun('gridshot', 105); // the median of [100, 110]
  assert.equal(read().v, 2);
  assert.equal(res.outcome, 0.5, 'the carried runs were used as the median');
  assert.ok(Math.abs(read().cats.Speed - 1400) < 10, `Speed came through at ${read().cats.Speed}`);
  assert.equal(read().runs.gridshot.length, 3, 'and the carried runs kept accumulating');
});

test('junk in storage cannot take the rating with it', () => {
  for (const junk of ['null', '[]', '"nope"', '{"v":2}', '{"v":2,"cats":{"Speed":"x"}}']) {
    store.clear();
    store.set(KEY, junk);
    assert.equal(eloFor('gridshot'), DEFAULT_ELO, `survived ${junk}`);
  }
});
