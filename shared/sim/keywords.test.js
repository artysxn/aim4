// Run: node shared/sim/keywords.test.js
//
// SIM-PLAN 20.6. A keyword is a restriction plus a risk distortion, so the
// assertions are the properties a wrong preset would break:
//
//   every named keyword exists and produces a preset
//   applyKeyword never adds option ids (intersection only, cannot promote)
//   VP without tradeCover drops wide_swing
//   Freeze leaves hold_angle
//   Joker: the initiator keeps wide_swing, the others do not
//   an unknown id throws
//
// Masks are checked against OPTION_IDS at import time in keywords.js; a
// renamed option fails there rather than silently no-opping a VP call.

import { OPTION_IDS } from './options.js';
import {
  KEYWORDS,
  applyKeyword,
  freezeLegal,
  jokerPreset,
  keywordMotive,
  keywordPreset
} from './keywords.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- each keyword exists ----------------------------------------------------

{
  assert(KEYWORDS.length >= 4, 'the four chapter-4 keywords');
  for (const id of KEYWORDS) {
    const p = keywordPreset(id);
    assert(p.id === id, `${id} round-trips`);
    assert(p.masks instanceof Set, `${id} masks is a Set`);
    assert(typeof p.motive === 'string' && p.motive.length > 0, `${id} carries a motive`);
    assert(keywordMotive(p) === p.motive, 'keywordMotive reads the one-liner');
    for (const opt of p.masks) {
      assert(OPTION_IDS.includes(opt), `${id} mask ${opt} is a real option id`);
    }
  }
  assert(keywordPreset(null).id === 'default', 'null is the undistorted arbiter');
  assert(keywordPreset('default').masks.size === 0, 'default masks nothing');
}

{
  const vp = keywordPreset('vp');
  assert(vp.risk === 'cvar' && vp.quantileBias < 0, 'VP is CVaR, below the baseline');
  assert(vp.soloIllegal && vp.tradeCoverRequired, 'VP forbids solo peeks and requires cover');
  assert(vp.uncoveredMassFloor != null, 'VP names an uncovered-mass floor');

  const liquid = keywordPreset('liquid');
  assert(liquid.risk === 'mean' && liquid.quantileBias === 0, 'Liquid prices the mean');
  assert(liquid.groupingMin >= 4, 'Liquid grouping is a core of four');
  assert(
    liquid.commitWindowSeconds > 5 && liquid.commitWindowSeconds < 10,
    'Liquid commit window sits inside 5 to 10 s'
  );
  assert(vp.quantileBias < liquid.quantileBias, 'VP is the more averse of the two');

  const freeze = keywordPreset('freeze');
  assert(freeze.risk === 'neutral', 'Freeze does not distort the quantile');
  for (const id of freezeLegal) assert(!freeze.masks.has(id), `Freeze keeps ${id}`);
}

// ---- applyKeyword never adds ids --------------------------------------------

{
  const subset = new Set(['wide_swing', 'hold_angle', 'execute_entry', 'jiggle', 'save', 'trade']);
  for (const id of [...KEYWORDS, 'default']) {
    const preset = id === 'joker' ? jokerPreset({ initiatorSlot: 2 }) : keywordPreset(id);
    for (const slot of [0, 2]) {
      const out = applyKeyword(subset, preset, { slot, hasTradeCover: true, uncoveredMass: 0 });
      for (const x of out) {
        assert(subset.has(x), `${id} promoted ${x}`);
      }
    }
    const uncovered = applyKeyword(subset, preset, { slot: 0, hasTradeCover: false, uncoveredMass: 1 });
    for (const x of uncovered) assert(subset.has(x), `${id} promoted ${x} under the live restrictions`);
  }
}

{
  // An empty initiation stays empty: the preset cannot invent a want.
  const vp = keywordPreset('vp');
  assert(applyKeyword(new Set(), vp, { hasTradeCover: true }).size === 0, 'empty in, empty out');
}

// ---- VP without tradeCover drops wide_swing ---------------------------------

{
  const vp = keywordPreset('vp');
  const start = new Set(['wide_swing', 'hold_angle', 'trade', 'repeek']);
  const uncovered = applyKeyword(start, vp, { hasTradeCover: false });
  assert(!uncovered.has('wide_swing'), 'VP without tradeCover drops wide_swing');
  assert(uncovered.has('hold_angle'), 'and still leaves a hold');
  assert(uncovered.has('trade'), 'trade is the cover, it stays');
  assert(!uncovered.has('repeek'), 'live peeks without cover go too');

  const covered = applyKeyword(start, vp, { hasTradeCover: true });
  assert(!covered.has('wide_swing'), 'wide_swing is solo even with cover nearby');
  assert(covered.has('trade'), 'trade survives with cover');
}

{
  // Uncovered mass drops the execute, never promotes a replacement.
  const vp = keywordPreset('vp');
  const start = new Set(['execute_entry', 'hold_angle']);
  const high = applyKeyword(start, vp, { hasTradeCover: true, uncoveredMass: 1 });
  assert(!high.has('execute_entry'), 'VP refuses an execute whose uncovered mass is above the floor');
  assert(high.has('hold_angle'), 'and does not invent a different want');
  const low = applyKeyword(start, vp, { hasTradeCover: true, uncoveredMass: 0 });
  assert(low.has('execute_entry'), 'a cheap uncovered set still permits the execute');
}

// ---- Freeze leaves hold_angle -----------------------------------------------

{
  const freeze = keywordPreset('freeze');
  const start = new Set(OPTION_IDS);
  const out = applyKeyword(start, freeze);
  assert(out.has('hold_angle'), 'Freeze leaves hold_angle');
  assert(out.has('fall_back') && out.has('save'), 'and the rest of freezeLegal');
  assert(!out.has('wide_swing'), 'and it is not a peek');
  assert(!out.has('execute_entry'), 'and it is not a take');
  for (const id of freezeLegal) assert(out.has(id), `Freeze keeps ${id}`);
  assert(out.size === freezeLegal.length, 'Freeze is exactly freezeLegal');
}

// ---- Joker: initiator keeps wide_swing, the others do not -------------------

{
  const preset = jokerPreset({ initiatorSlot: 2 });
  assert(preset.gait === 'walk' && preset.silent, 'the four walk and emit nothing');
  const start = new Set(OPTION_IDS);
  const initiator = applyKeyword(start, preset, { slot: 2 });
  const other = applyKeyword(start, preset, { slot: 0 });
  assert(initiator.has('wide_swing'), 'Joker initiator keeps wide_swing');
  assert(!other.has('wide_swing'), 'the others do not');
  assert(other.has('hold_angle'), 'the others hold');
  assert(other.size === 1, 'and hold is all they have');
  // Still cannot promote: initiator of a thin set stays thin.
  const thin = applyKeyword(new Set(['hold_angle']), preset, { slot: 2 });
  assert(!thin.has('wide_swing'), 'unmasking is not promotion');
}

// ---- unknown id throws ------------------------------------------------------

{
  let threw = false;
  try {
    keywordPreset('not-a-team');
  } catch (err) {
    threw = /unknown/.test(err.message);
  }
  assert(threw, 'unknown id throws');
}

console.log('keywords: ok');
