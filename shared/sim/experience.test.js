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

console.log('experience: ok');
