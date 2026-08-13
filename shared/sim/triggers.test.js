// Run: node shared/sim/triggers.test.js
//
// The trigger table. What matters:
//
//   the rows are the plan's rows, each with a lead and a motive in English
//   conditions fire on the context and only on the context
//   anticipation gates twice: fewer reads, later starts
//   the draw is deterministic under the seed

import { TRIGGERS, firedTriggers } from './triggers.js';
import { OPTION_DEFS } from './options.js';
import { Rng } from './rng.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

// ---- the table is well-formed -----------------------------------------------

{
  assert(TRIGGERS.length >= 7, `the plan's seven rows (${TRIGGERS.length})`);
  for (const t of TRIGGERS) {
    assert(typeof t.when === 'function', `${t.id} has a condition`);
    assert(t.leadSeconds >= 0, `${t.id} has a lead`);
    assert(typeof t.motive === 'string' && t.motive.length > 0, `${t.id} explains itself`);
    for (const o of t.arms) assert(OPTION_DEFS[o], `${t.id} arms a real option (${o})`);
  }
}

// ---- conditions read the context --------------------------------------------

{
  const pro = { anticipation: 1, rng: new Rng(1) };

  const awp = firedTriggers({ enemyAwpCycling: true }, pro);
  assert(awp.length === 1 && awp[0].id === 'awp_cycling', 'a cycling AWP arms the punish');
  assert(awp[0].arms.includes('punish_window'), 'with the right options');

  const none = firedTriggers({}, pro);
  assert(none.length === 0, 'a quiet context arms nothing');

  const split = firedTriggers(
    { accountedOneSide: 2, unaccounted: 3, otherSideReachable: true },
    pro
  );
  assert(split.some((t) => t.id === 'split_read'), 'two accounted plus silence reads a split');

  const noRoom = firedTriggers(
    { accountedOneSide: 2, unaccounted: 1, otherSideReachable: true },
    pro
  );
  assert(!noRoom.some((t) => t.id === 'split_read'), 'one unaccounted body is not a read');

  const ground = firedTriggers(
    { beliefMassOnMyAngle: 0.05, earliestOccupyEdgeSeconds: 1.5 },
    pro
  );
  assert(ground.some((t) => t.id === 'free_ground'), 'an empty angle I win the race to fires');

  const losing = firedTriggers({ matePfw: 0.2 }, pro);
  assert(losing.some((t) => t.id === 'mate_losing'), 'a teammate at 20% arms the trade');
  const winning = firedTriggers({ matePfw: 0.7 }, pro);
  assert(!winning.some((t) => t.id === 'mate_losing'), 'a teammate at 70% needs no help');
}

// ---- anticipation gates twice -----------------------------------------------

{
  const ctx = { enemyAwpCycling: true };
  const trials = 2000;

  let proFires = 0;
  let mixFires = 0;
  const proRng = new Rng(5);
  const mixRng = new Rng(5);
  for (let i = 0; i < trials; i += 1) {
    if (firedTriggers(ctx, { anticipation: 1, rng: proRng }).length) proFires += 1;
    if (firedTriggers(ctx, { anticipation: 0, rng: mixRng }).length) mixFires += 1;
  }
  assert(proFires === trials, 'full anticipation misses nothing');
  const mixRate = mixFires / trials;
  assert(
    mixRate > 0.15 && mixRate < 0.35,
    `no anticipation misses most reads (${mixRate.toFixed(2)})`
  );

  // A low-anticipation bot misses this read on most seeds; find one where it
  // fires at all, then check the read it does make starts later.
  const proLead = firedTriggers(ctx, { anticipation: 1, rng: new Rng(2) })[0].leadSeconds;
  let slowLead = null;
  for (let seed = 1; seed < 100 && slowLead === null; seed += 1) {
    const fired = firedTriggers(ctx, { anticipation: 0.3, rng: new Rng(seed) });
    if (fired.length) slowLead = fired[0].leadSeconds;
  }
  assert(slowLead !== null, 'a 0.3 bot still makes the read sometimes');
  assert(proLead > slowLead, `the weaker read also starts later (${proLead}s vs ${slowLead}s)`);
}

// ---- determinism ------------------------------------------------------------

{
  const ctx = { enemyAwpCycling: true, matePfw: 0.2 };
  const a = firedTriggers(ctx, { anticipation: 0.5, rng: new Rng(9) });
  const b = firedTriggers(ctx, { anticipation: 0.5, rng: new Rng(9) });
  assert(JSON.stringify(a) === JSON.stringify(b), 'the same seed reads the same round');
}

console.log('triggers: ok');
