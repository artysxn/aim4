// Run: node shared/sim/clutch.test.js
//
// Both halves of this file distort how a bot prices risk, so the assertions
// are the properties a wrong distortion would break:
//
//   the mask is a RESTRICTION: nothing outside it ever survives, and it never
//     reorders, promotes, or invents a want
//   a 1vN masks exactly what 20.12 says and keeps exactly what it says
//   the time and plant discipline is arithmetic: no channel the clock cannot
//     finish, and the last window to start one is forced
//   the quantile follows the state: an anchor or a save round sits below a bot
//     that is behind on the scoreboard
//   the collapse is the median at 0.5 and the bad tail at a low q, and no
//     extreme produces NaN on a one-element distribution
//   the 82 percent is checked and reported, never assumed

import {
  FIRST_PICK_ANCHOR,
  QUANTILE_CAPS,
  QUANTILE_MAX,
  QUANTILE_MIN,
  QUANTILE_NEUTRAL,
  applyQuantile,
  checkFirstPickAnchor,
  clutchMask,
  defuseSeconds,
  explainRiskQuantile,
  maskInitiation,
  quantileOf,
  riskAdjustedPrice,
  riskQuantile
} from './clutch.js';
import { OPTION_DEFS, OPTION_IDS } from './options.js';
import { DEFUSE_SECONDS, DEFUSE_SECONDS_KIT, PLANT_SECONDS } from './constants.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const peekFamily = OPTION_IDS.filter((id) => OPTION_DEFS[id].family === 'peek');

// ---- 1vN: what stops being a legal want ------------------------------------

{
  // 1v3, bomb down, T side, no defuse running. E8's state.
  const m = clutchMask({
    side: 'T',
    alive: 1,
    enemiesAlive: 3,
    bombDown: true,
    bombSecondsLeft: 30,
    secondsLeft: 20
  });

  // Nobody to fill the parameter.
  for (const id of ['trade', 'bait', 'crossfire_hold', 'follow', 'overlap', 'show_short']) {
    assert(!m.legal.has(id), `${id} needs a teammate and there is none`);
  }
  // The bomb-cover half: wandering forfeits a round the clock is winning.
  for (const id of ['take_space', 'advance', 'rotate', 'flank', 'save', 'execute_entry']) {
    assert(!m.legal.has(id), `${id} takes me off the bomb`);
  }
  // And what it keeps: covering the bomb, and the local fights around it.
  for (const id of ['hold_angle', 'off_angle_hold', 'lurk', 'fall_back', 'utility_setup']) {
    assert(m.legal.has(id), `${id} is how a lone T covers the bomb`);
  }
  assert(m.legal.has('wide_swing'), 'a peek returns to where it started, so it stays legal');
  assert(m.restricted && m.motive.includes('clock'), `the motive explains itself: ${m.motive}`);
  assert(m.legal.size > 0, 'a mask never leaves a bot with nothing to want');

  // The moment they touch the bomb, the clock is theirs and the fight is all
  // that is left.
  const contested = clutchMask({
    side: 'T',
    alive: 1,
    enemiesAlive: 3,
    bombDown: true,
    bombSecondsLeft: 30,
    defusing: true
  });
  assert(contested.legal.has('advance'), 'a running defuse lifts the wandering mask');
  assert(!contested.legal.has('trade'), 'but there is still nobody to trade with');
}

// ---- the mask is a restriction, never a re-ranking ---------------------------

{
  const m = clutchMask({ side: 'T', alive: 1, enemiesAlive: 2, bombDown: true });
  const initiation = new Set(['hold_angle', 'take_space', 'trade', 'lurk', 'defuse']);
  const out = maskInitiation(initiation, m);

  for (const id of out) {
    assert(m.legal.has(id), `${id} survived the mask without being in it`);
    assert(initiation.has(id), `${id} was invented by the mask`);
  }
  assert(out.has('hold_angle') && out.has('lurk'), 'what was legal on both sides survives');
  assert(!out.has('take_space') && !out.has('trade'), 'what the mask forbids does not');
  assert(out.size < initiation.size, 'a restriction only ever shrinks the set');
  assert(out instanceof Set, 'and it is a set of ids: no scores, no order');

  // Nothing the mask returns is outside the vocabulary it restricts.
  for (const id of m.legal) assert(OPTION_IDS.includes(id), `${id} is not an option id`);
  assert(m.legal.size + m.masked.length === OPTION_IDS.length, 'legal and masked partition it');

  // A state with no clutch in it restricts nothing at all.
  const calm = clutchMask({ side: 'CT', alive: 5, enemiesAlive: 5 });
  assert(calm.legal.size === OPTION_IDS.length && !calm.restricted, 'a 5v5 is not a clutch');
  assert(maskInitiation(null, calm).size === OPTION_IDS.length, 'a null initiation is the whole set');
}

// ---- the sync rule: at +2, everyone peeks or nobody does ---------------------

{
  const at2 = (over = {}) =>
    clutchMask({ side: 'CT', alive: 3, enemiesAlive: 1, syncPeers: 0, ...over });

  const solo = at2();
  for (const id of peekFamily) assert(!solo.legal.has(id), `${id} is an isolated duel at +2`);
  assert(solo.legal.has('hold_angle'), 'holding is not');
  assert(solo.motive.includes('arrive at once'), `and it says why: ${solo.motive}`);

  assert(at2({ syncPeers: 2 }).legal.has('wide_swing'), 'two mates on the same space lifts it');
  assert(!at2({ syncPeers: 1 }).legal.has('wide_swing'), 'one does not');
  assert(at2({ posture: 'hold' }).legal.has('wide_swing'), 'and a hold posture lifts it');
  assert(
    clutchMask({ side: 'CT', alive: 2, enemiesAlive: 1 }).legal.has('wide_swing'),
    '+1 is not +2: the rule is chapter 15\'s, not a general fear of peeking'
  );
}

// ---- the time and plant discipline is arithmetic ----------------------------

{
  const ct = (over = {}) =>
    clutchMask({ side: 'CT', alive: 1, enemiesAlive: 1, bombDown: true, ...over });

  assert(defuseSeconds(true) === DEFUSE_SECONDS_KIT, 'a kit defuse is the kit constant');
  assert(defuseSeconds(false) === DEFUSE_SECONDS, 'and a bare one is not');

  // Comfortably ahead of the timer: nothing is forced.
  assert(ct({ bombSecondsLeft: 30, hasKit: false }).legal.has('hold_angle'), '30s is not a window');

  // The last window in which the defuse can still start.
  const window = ct({ bombSecondsLeft: DEFUSE_SECONDS + 1, hasKit: false });
  assert(window.legal.has('defuse') && window.legal.has('retake'), 'the defuse is still on');
  assert(!window.legal.has('hold_angle'), 'and holding an angle now loses the round');
  assert(window.motive.includes('now or not at all'), `the motive is the clock: ${window.motive}`);

  // A kit moves the window, which is the whole point of carrying one.
  assert(
    ct({ bombSecondsLeft: DEFUSE_SECONDS - 1, hasKit: true }).legal.has('defuse'),
    'a kit still makes it'
  );
  const lost = ct({ bombSecondsLeft: DEFUSE_SECONDS - 1, hasKit: false });
  assert(!lost.legal.has('defuse'), 'a channel that cannot finish is not a want');
  assert(lost.legal.has('save') && lost.legal.size === 2, 'what is left is the gun');
  assert(lost.motive.includes('the gun is not'), `and it says so: ${lost.motive}`);

  // Travel time counts against the same clock.
  assert(
    !ct({ bombSecondsLeft: DEFUSE_SECONDS + 2, hasKit: false, secondsToObjective: 6 }).legal.has(
      'defuse'
    ),
    'a defuse I cannot reach in time is the same dead channel'
  );

  // The plant side of the same rule.
  const t = (over = {}) =>
    clutchMask({ side: 'T', alive: 1, enemiesAlive: 2, hasBomb: true, ...over });
  const plantWindow = t({ secondsLeft: PLANT_SECONDS + 1 });
  assert(plantWindow.legal.has('plant'), 'the bomb can still go down');
  assert(!plantWindow.legal.has('hold_angle'), 'so nothing else is worth wanting');
  const noPlant = t({ secondsLeft: PLANT_SECONDS - 0.5 });
  assert(!noPlant.legal.has('plant'), 'and once it cannot, the plant stops being a want');
  assert(noPlant.legal.has('hold_angle'), 'while killing the last two still is');

  // Scoped to being alone: with a teammate up, a doomed channel is a bait and
  // a plant is coverable, so the arithmetic is not the whole story.
  const pair = clutchMask({
    side: 'CT',
    alive: 2,
    enemiesAlive: 2,
    bombDown: true,
    bombSecondsLeft: 3,
    hasKit: false
  });
  assert(pair.legal.has('defuse') && !pair.restricted, 'two alive is not a clutch');
}

// ---- the quantile follows the state ------------------------------------------

{
  const behind = riskQuantile({ pWin: 0.3, manDelta: -2 });
  const level = riskQuantile({ pWin: 0.5, manDelta: 0 });
  const ahead = riskQuantile({ pWin: 0.72, manDelta: 2 });
  assert(ahead < level && level < behind, `ahead ${ahead} < level ${level} < behind ${behind}`);
  assert(level === QUANTILE_NEUTRAL, 'a level state is the trait baseline, untouched');

  const anchor = riskQuantile({ pWin: 0.5, manDelta: 0, role: 'anchor' });
  const saving = riskQuantile({ pWin: 0.5, manDelta: 0, saving: true });
  assert(anchor < behind, `an anchor sits below a bot that is behind (${anchor} vs ${behind})`);
  assert(saving < behind, `and a save round sits lower still (${saving} vs ${behind})`);
  assert(saving <= anchor, 'a save round is the most averse state there is');
  assert(anchor <= QUANTILE_CAPS.anchor + 1e-9, 'the cap is a cap');

  // The cap is one-sided: an anchor two men down is still an anchor.
  const desperateAnchor = riskQuantile({ pWin: 0.2, manDelta: -3, role: 'anchor' });
  assert(desperateAnchor <= QUANTILE_CAPS.anchor + 1e-9, 'the state cannot buy past the cap');

  // The trait is the baseline, audacity is the spread around it.
  const shy = riskQuantile({ baseline: 0.5, audacity: 0 });
  const bold = riskQuantile({ baseline: 0.5, audacity: 1 });
  assert(shy < 0.5 && bold > 0.5, `audacity spreads around the baseline (${shy}, ${bold})`);
  assert(riskQuantile({ baseline: 0.7 }) > riskQuantile({ baseline: 0.3 }), 'the trait moves it');

  // A keyword is an order (20.6).
  assert(riskQuantile({ pWin: 0.2, manDelta: -2, posture: 'vp' }) <= QUANTILE_CAPS.vp + 1e-9, 'VP caps');
  assert(riskQuantile({ pWin: 0.2, posture: 'liquid' }) === QUANTILE_NEUTRAL, 'Liquid is neutral');

  // Nothing escapes the band, and nothing produces a non-number.
  for (const s of [
    {},
    { pWin: NaN, manDelta: NaN, baseline: NaN, audacity: NaN },
    { pWin: 5, manDelta: -99, audacity: 3 },
    { pWin: -1, manDelta: 99, audacity: -3 }
  ]) {
    const q = riskQuantile(s);
    assert(Number.isFinite(q), `a quantile is always a number (${JSON.stringify(s)})`);
    assert(q >= QUANTILE_MIN && q <= QUANTILE_MAX, `and always in band (${q})`);
  }

  const why = explainRiskQuantile({ pWin: 0.75, manDelta: 2 });
  assert(why.motive.includes('low quantile'), `the log line is English: ${why.motive}`);
  assert(why.advantage > 0, 'and carries the read that produced it');
}

// ---- collapsing a distribution somewhere other than its middle ---------------

{
  const even = [0.2, 0.4, 0.6, 0.8];
  assert(Math.abs(applyQuantile(even, 0.5) - 0.5) < 1e-12, 'q = 0.5 on an even count is the median');
  const odd = [0.9, 0.1, 0.5];
  assert(applyQuantile(odd, 0.5) === 0.5, 'and on an odd count it is the middle value');
  assert(quantileOf(odd, 0.5) === applyQuantile(odd, 0.5), 'at neutral there is no tail weighting');

  // One bad layout in four: the mean says 0.65, a low quantile says otherwise.
  const skewed = [0.05, 0.8, 0.85, 0.9];
  const mean = skewed.reduce((a, b) => a + b, 0) / skewed.length;
  const low = applyQuantile(skewed, 0.1);
  assert(low < mean, `a low q is not the mean (${low} vs ${mean})`);
  assert(low < applyQuantile(skewed, 0.5), 'nor the median');
  assert(low < 0.2, `it is dominated by the bad outcome (${low})`);
  assert(applyQuantile(skewed, 0.9) > mean, 'and a high q leans on the good ones');
  assert(applyQuantile(skewed, 0) === 0.05, 'q = 0 is the worst outcome exactly');
  assert(applyQuantile(skewed, 1) === 0.9, 'q = 1 is the best');

  // Monotone in q, which is what makes it a quantile at all.
  let prev = -Infinity;
  for (let q = 0; q <= 1.0001; q += 0.05) {
    const v = applyQuantile(skewed, q);
    assert(v >= prev - 1e-12, `collapse is monotone in q (${q})`);
    prev = v;
  }

  // The extremes on a one-element distribution: a number, never NaN.
  for (const q of [0, 0.001, 0.5, 0.999, 1]) {
    const v = applyQuantile([0.42], q);
    assert(v === 0.42, `a single outcome collapses to itself at q = ${q} (got ${v})`);
  }
  assert(Number.isFinite(applyQuantile([0.42], NaN)), 'and a broken q falls back to neutral');
  assert(Number.isNaN(applyQuantile([], 0.2)), 'an empty distribution is loudly not a price');
  assert(applyQuantile([0.1, NaN, 0.3], 0.5) === 0.2, 'a layout that failed to price is dropped');

  // foresight-shaped records go in as they come out.
  const priced = [{ pWin: 0.1 }, { pWin: 0.5 }, { pWin: 0.9 }];
  assert(applyQuantile(priced, 0.5) === 0.5, 'a {pWin} record is an outcome');

  // The arbiter's price contract, in one call.
  const r = riskAdjustedPrice({ samples: priced, state: { pWin: 0.8, manDelta: 2 } });
  assert(r.samples === 3 && Number.isFinite(r.pWin), 'riskAdjustedPrice returns a price');
  assert(r.pWin < 0.5, 'an ahead bot prices the option at its bad tail');
  assert(typeof r.motive === 'string' && r.motive.length > 0, 'with a motive for the log');
}

// ---- the 82 percent is checked, not assumed ----------------------------------

{
  assert(FIRST_PICK_ANCHOR === 0.82, 'the anchor is chapter 13\'s figure');

  const agreeing = checkFirstPickAnchor({
    predictions: Array.from({ length: 200 }, () => 0.81)
  });
  assert(agreeing.agrees, 'a model that reproduces it agrees');
  assert(agreeing.report.includes('81.0%') && agreeing.report.includes('82.0%'), 'and reports both');

  const off = checkFirstPickAnchor({
    predictions: Array.from({ length: 200 }, () => 0.62),
    outcomes: Array.from({ length: 200 }, (_, i) => (i < 150 ? 1 : 0))
  });
  assert(!off.agrees, 'a model that does not, does not');
  assert(off.report.includes('report rather than patch'), `the verdict is a finding: ${off.report}`);
  assert(off.report.includes('75.0%'), 'and the library\'s own rate sits next to it');
  assert(Math.abs(off.delta + 0.2) < 1e-9, 'the gap is reported signed');

  // A thin sample widens the band rather than pretending to a verdict.
  const thin = checkFirstPickAnchor({ predictions: [0.75, 0.78, 0.9] });
  assert(thin.band > 0.2 && thin.agrees, `three states cannot fail the anchor (${thin.band})`);
  assert(checkFirstPickAnchor({}).report.includes('unchecked'), 'and no states is no verdict');
}

console.log('clutch: ok');
