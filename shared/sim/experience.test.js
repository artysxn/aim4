// Run: node shared/sim/experience.test.js

import { ExperienceIndex, wilsonLower } from './experience.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const lucky = wilsonLower(2, 2);
  const solid = wilsonLower(25, 40);
  assert(solid > lucky, `2-and-0 (${lucky.toFixed(3)}) does not outrank 40-and-25 (${solid.toFixed(3)})`);
}

{
  const idx = new ExperienceIndex();
  idx.seedPrior('k', { n: 20, w: 10 });
  idx.write({ key: 'k', call: 'b-split', won: true, attrib: 'call' });
  idx.write({ key: 'k', call: 'b-split', won: true, attrib: 'call' });
  const r = idx.read('k', 'b-split');
  assert(r.n > 2, 'the library prior is in the mix');
  assert(r.lower > 0, 'lower bound is a number');
}

{
  const idx = new ExperienceIndex({ maxRows: 2 });
  idx.write({ key: 'a', won: true, scopes: ['career'] });
  idx.write({ key: 'b', won: true, scopes: ['career'] });
  idx.write({ key: 'c', won: true, scopes: ['career'] });
  assert(idx.career.size <= 2, 'LRU caps the career shard');
}

{
  const idx = new ExperienceIndex();
  const before = idx.seq;
  idx.write({ key: 'k', won: false, attrib: 'exec' });
  assert(idx.seq === before + 1, 'recency is a seq, not a wall clock');
}

// ---- the match boundary (18.8) -------------------------------------------

{
  // In-match memory resets; experience persists. The failure mode is silent
  // in both directions — an index that forgets everything makes a trainee
  // arrive at every match as new as the first, and one that forgets nothing
  // quotes last match's series read at this one — so both halves are pinned.
  const idx = new ExperienceIndex();
  for (let i = 0; i < 12; i += 1) idx.write({ key: 'sit', call: 'a-exec', won: true });
  idx.writeCalibration({ key: 'sit', residual: 0.2 });
  idx.writeCalibration({ key: 'sit', residual: 0.2 });
  idx.writeCalibration({ key: 'sit', residual: 0.2 });
  idx.writeCalibration({ key: 'sit', residual: 0.2 });
  idx.write({ key: 'sit', call: 'a-exec', won: true, scopes: ['opponent'] });

  const learned = idx.read('sit', 'a-exec').n;
  const bias = idx.calibrationFor('sit');
  assert(learned > 0 && idx.session.size === 1, 'a match leaves both kinds of trace');
  assert(bias !== 0, 'including the calibration it earned');

  const same = idx.endSession();
  assert(same === idx, 'endSession is chainable on the index it cleared');
  assert(idx.session.size === 0, 'what was true about THAT match is gone');
  assert(idx.career.size === 1, 'what was learned is not');
  assert(idx.opponent.size === 1, 'and the read on this opponent survives the boundary');
  assert(idx.calibrationFor('sit') === bias, 'so does the calibration table');
  // The whole point: the next match starts knowing things.
  assert(idx.read('sit', 'a-exec').n > 0, 'the trainee does not arrive as new as the first time');
  assert(idx.seq > 0, 'and recency keeps counting across the boundary');
}

// ---- the index survives disk (18.8 / 6.2) ---------------------------------

{
  // Grind's whole premise: match 200 starts knowing what 1-199 cost, and the
  // knowing goes through a file. What survives is CAREER and calibration --
  // the same line endSession draws.
  const idx = new ExperienceIndex();
  idx.write({ key: 'sit', call: 'a-exec', won: true, attrib: 'call' });
  idx.write({ key: 'sit', call: 'a-exec', won: false, attrib: 'call' });
  idx.write({ key: 'other', call: 'b-exec', won: true, attrib: 'exec' });
  idx.writeCalibration({ key: 'sit', residual: 0.2 });
  idx.writeCalibration({ key: 'sit', residual: 0.4 });

  const back = ExperienceIndex.fromJSON(JSON.parse(JSON.stringify(idx.toJSON())));
  assert(back.career.size === idx.career.size, 'every career row comes back');
  // Compared AFTER endSession, which is the state a grind checkpoints in:
  // read() weights session 4x over career, so an unended index would read
  // higher than any file could and the mismatch would mean nothing.
  idx.endSession();
  assert(back.read('sit', 'a-exec').n === idx.read('sit', 'a-exec').n, 'with its counts');
  assert(back.session.size === 0, 'and no session scope, which does not cross a boundary');
  // The bias is arithmetic over the raw sum; a file that only kept the rounded
  // mean would come back subtly different and nothing would say so.
  assert(
    Math.abs(back.calibrationFor('sit') - idx.calibrationFor('sit')) < 1e-12,
    'the calibration bias is identical, not merely close'
  );

  let threw = false;
  try {
    ExperienceIndex.fromJSON({ v: 0, rows: [] });
  } catch {
    threw = true;
  }
  assert(threw, 'a file from another build is refused, not half-read');
}

// ---- 18.8: what may reach career, and what may not ------------------------

{
  const ex = ExperienceIndex.scopesFor({ opponentRole: 'main-exploiter', opponentElo: 2000 });
  assert(!ex.scopes.includes('career'), 'an exploiter never feeds career, however strong');
  assert(ex.scopes.includes('quarantine'), 'its lessons are kept, in their own scope');

  const weak = ExperienceIndex.scopesFor({ opponentElo: -50, eloFloor: 0 });
  assert(!weak.scopes.includes('career'), 'an opponent under the floor does not feed career');
  assert(weak.scopes.includes('session'), 'but the match still knows what it learned');

  const strong = ExperienceIndex.scopesFor({ opponentElo: 120, eloFloor: 0 });
  assert(strong.scopes.includes('career'), 'a strong opponent is evidence');

  // The gap the floor would otherwise leave: the first matches of a pool have
  // no ratings at all, and treating unrated as "fine" is the same bug.
  const unrated = ExperienceIndex.scopesFor({ opponentElo: null });
  assert(!unrated.scopes.includes('career'), 'an unrated opponent is not assumed strong');
}

{
  // Quarantine is a real bag, not a discard.
  const idx = new ExperienceIndex();
  idx.write({ key: 'sit', call: 'a', won: true, scopes: ['session', 'quarantine'] });
  assert(idx.quarantine.size === 1, 'the exploiter lesson is stored');
  assert(idx.career.size === 0, 'and career never saw it');
  assert(JSON.parse(JSON.stringify(idx.toJSON())).rows.length === 0, 'so nothing inherits it');
}

// ---- 18.10: the index is read-only during a round -------------------------

{
  const idx = new ExperienceIndex();
  idx.beginRound();
  let threw = 0;
  try { idx.write({ key: 'k', call: 'a', won: true }); } catch { threw += 1; }
  try { idx.writeCalibration({ key: 'k', residual: 0.1 }); } catch { threw += 1; }
  assert(threw === 2, 'a mid-round commit is refused, not silently allowed');
  assert(idx.read('k').n === 0, 'reads still work: retrieval is what a round does');
  idx.endRound();
  idx.write({ key: 'k', call: 'a', won: true });
  assert(idx.career.size === 1, 'and the commit lands at round end');
}

// ---- 12.3: the index hash ------------------------------------------------

{
  const a = new ExperienceIndex();
  const b = new ExperienceIndex();
  assert(a.hash() === b.hash(), 'two empty indexes are the same memory');
  a.write({ key: 'x', call: 'c', won: true });
  assert(a.hash() !== b.hash(), 'a written row changes the fingerprint');
  b.write({ key: 'x', call: 'c', won: true });
  assert(a.hash() === b.hash(), 'the same rows hash the same');
  // Order-independent: two indexes holding the same rows ARE the same memory.
  const c = new ExperienceIndex();
  const d = new ExperienceIndex();
  c.write({ key: 'p', call: 'c', won: true });
  c.write({ key: 'q', call: 'c', won: false });
  d.write({ key: 'q', call: 'c', won: false });
  d.write({ key: 'p', call: 'c', won: true });
  assert(c.hash() === d.hash(), 'and write order does not change it');
}

// ---- 18.10: the backoff ladder --------------------------------------------

{
  // Measured before this existed: 2,999 reads in one match, 11 of which found
  // anything. Exact-match retrieval against a thirteen-field key essentially
  // never hits, and a memory that cannot be reached is not a memory.
  const K = (clock, men, shape) =>
    `1|INF|T|early|${clock}|${men}|eco-vs-full|none|default|${shape}|spread|us:med,them:med|staffed`;

  const idx = new ExperienceIndex();
  for (let i = 0; i < 8; i += 1) {
    idx.write({ key: K('100-120', '5v5', 'core5'), call: 'b-exec', won: true });
  }

  // The exact key still wins outright.
  const exact = idx.read(K('100-120', '5v5', 'core5'), 'b-exec');
  assert(exact.n >= 8 && !exact.backoff, 'an exact key answers without backing off');

  // A round that differs only in the tail: same map, side, phase, clock and
  // man count, different formation. Nothing exact, and the class still knows
  // something.
  const near = idx.read(K('100-120', '5v5', 'core4,lurk1'), 'b-exec');
  assert(near.n > 0, 'a near-miss now finds the class it belongs to');
  assert(near.backoff, 'and says it did');
  assert(near.backoff.level === 9, `matched at the 9-field rung, got ${near.backoff.level}`);
  assert(near.n < exact.n, 'discounted below the exact read, never above it');

  // A different man count is a different situation, and the ladder stops
  // before pretending otherwise: 6 fields still carries `men`.
  const far = idx.read(K('100-120', '1v5', 'core5'), 'b-exec');
  assert(!far.n || far.backoff, 'a 1v5 does not silently inherit a 5v5 record');
  assert(far.n === 0, 'because men is above the lowest rung, so nothing matches');

  // A bandit key is not a situation and must never be aggregated as one.
  idx.write({ key: 'open|T|eco|pistol-even', call: 'b-exec', won: true });
  const bandit = idx.read('open|T|eco|pistol-even', 'b-exec');
  assert(!bandit.backoff, 'a short key has no ladder to walk');
}

{
  // The ladder is derived, not stored: an inherited index must retrieve
  // exactly like the one that wrote it, or the whole mechanism is dead in
  // every process that loads from disk.
  const K = (shape) =>
    `1|INF|CT|mid|60-80|4v4|full-vs-full|none|default|${shape}|spread|us:med,them:med|staffed`;
  const src = new ExperienceIndex();
  for (let i = 0; i < 6; i += 1) src.write({ key: K('core4'), call: 'retake', won: true });

  const back = ExperienceIndex.fromJSON(JSON.parse(JSON.stringify(src.toJSON())));
  const r = back.read(K('core3,lurk1'), 'retake');
  assert(r.n > 0 && r.backoff, 'a loaded index walks the ladder too');
}

console.log('experience: ok');
