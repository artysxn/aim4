// Run: node shared/sim/saving.test.js

import {
  SAVEABLE_WEAPONS,
  SAVE_BUY_FLOOR,
  SAVE_PWIN_MAX,
  averageMoney,
  isSaveable,
  shouldSave
} from './saving.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- the three conditions, each one necessary ----------------------------

{
  const lost = { pWin: 0.05, weapon: 'm4a1', moneyAvg: 2000 };
  assert(shouldSave(lost).save === true, 'gone round, thin economy, rifle: save');

  assert(
    shouldSave({ ...lost, pWin: 0.35 }).save === false,
    'a round still worth playing is not a save'
  );
  assert(
    shouldSave({ ...lost, moneyAvg: 9000 }).save === false,
    'a side that can rebuy loses nothing by dying with it'
  );
  assert(
    shouldSave({ ...lost, weapon: 'p250' }).save === false,
    'running away with a pistol is just running away'
  );
  assert(shouldSave({ ...lost, alive: false }).save === false, 'the dead do not save');
}

{
  // The boundaries are inclusive where the operator stated them: "10% or
  // less", "less than 7.5k".
  const at = { weapon: 'awp', moneyAvg: 2000 };
  assert(shouldSave({ ...at, pWin: SAVE_PWIN_MAX }).save === true, '10% exactly still saves');
  assert(
    shouldSave({ ...at, pWin: SAVE_PWIN_MAX + 0.001 }).save === false,
    'just over 10% does not'
  );
  const poor = { pWin: 0.05, weapon: 'awp' };
  assert(
    shouldSave({ ...poor, moneyAvg: SAVE_BUY_FLOOR - 1 }).save === true,
    'just under the floor saves'
  );
  assert(
    shouldSave({ ...poor, moneyAvg: SAVE_BUY_FLOOR }).save === false,
    'exactly two full buys does not'
  );
}

// ---- what counts as a gun ------------------------------------------------

{
  assert(isSaveable('awp') && isSaveable('ak47'), 'AWP and AK');
  assert(isSaveable('m4a1') && isSaveable('m4a1_silencer'), 'both M4s are the M4');
  assert(isSaveable('M4A1') === true, 'case does not decide this');
  assert(!isSaveable('deagle') && !isSaveable('mp9'), 'a deagle is not a save');
  assert(!isSaveable(null) && !isSaveable(undefined), 'and neither is nothing');
  assert(SAVEABLE_WEAPONS.length === 4, 'four ids, all present in the weapon table');
}

// ---- a missing number is not permission to throw the gun away ------------

{
  // No money frame: the round is gone and there is a rifle in hand. Saving on
  // a missing field is recoverable; dying with the rifle because a field was
  // absent is not.
  const r = shouldSave({ pWin: 0.02, weapon: 'ak47', moneyAvg: null });
  assert(r.save === true, 'no money frame still saves');
  assert(/thin economy/.test(r.reason), 'and says the number was missing');
  // No read on the round at all is different: that is not evidence of loss.
  assert(shouldSave({ pWin: null, weapon: 'ak47', moneyAvg: 0 }).save === false, 'no read, no save');
}

// ---- the money average ---------------------------------------------------

{
  const money = { 0: 1000, 1: 2000, 2: 3000, 3: 4000, 4: 5000 };
  assert(averageMoney(money, [0, 1, 2, 3, 4]) === 3000, 'plain mean');
  // Dead players still hold money and still buy next round, so the average is
  // over the SIDE, not over the survivors.
  assert(averageMoney(money, [0, 1]) === 1500, 'over whatever slots it is given');
  assert(averageMoney(null, [0]) === null, 'no frame, no number');
  assert(averageMoney(money, []) === null, 'no slots, no number');
  assert(averageMoney({ 0: 1000, 1: undefined }, [0, 1]) === 1000, 'gaps are skipped, not zeroed');
}

// ---- the reason is readable ----------------------------------------------

{
  const r = shouldSave({ pWin: 0.04, weapon: 'awp', moneyAvg: 1200 });
  assert(/awp/.test(r.reason), 'the motive names the gun');
  assert(/4%/.test(r.reason), 'and the read that condemned the round');
  assert(/\$1200/.test(r.reason), 'and the money that made it worth doing');
}

console.log('saving: ok');
