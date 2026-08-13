// Run: node shared/sim/zstat.test.js
//
// 9.11 is a keying scheme. The assertions are that the key is stable, the
// buckets cut where they say they cut, and sampling is the rng's, not ours.

import { Rng } from './rng.js';
import { commitBucket, encodeZ, sampleZ, utilSig, zKey } from './zstat.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  assert(utilSig(5) === 'full' && utilSig(6) === 'full', '5+ nades is full');
  assert(utilSig(2) === 'half' && utilSig(4) === 'half', '2–4 is half');
  assert(utilSig(1) === 'eco' && utilSig(0) === 'eco', 'else eco');
  assert(utilSig({ smoke: 2, flash: 3 }) === 'full', 'object counts sum');
  assert(utilSig([1, 1, 0]) === 'half', 'and so do arrays');
}

{
  assert(commitBucket(0) === 'early' && commitBucket(24.9) === 'early', 'before 25 s is early');
  assert(commitBucket(25) === 'mid' && commitBucket(54.9) === 'mid', '25–55 is mid');
  assert(commitBucket(55) === 'late' && commitBucket(90) === 'late', '55+ is late');
}

{
  const key = zKey({
    call: 'a-execute',
    utilSig: 'full',
    commitBucket: 'early',
    spawnShape: 'stack',
    lurk: true
  });
  assert(key === 'a-execute|full|early|stack|lurk', `canonical key (${key})`);
  assert(
    zKey({
      call: 'b-default',
      utilSig: 'eco',
      commitBucket: 'late',
      spawnShape: 'spread',
      lurk: false
    }) === 'b-default|eco|late|spread|nolurk',
    'absent lurk is the nolurk token'
  );
}

{
  const vocab = ['a-execute|full|early|stack|lurk', 'b-default|eco|late|spread|nolurk'];
  assert(encodeZ('a-execute|full|early|stack|lurk', vocab) === 0, 'encodeZ is a vocab index');
  assert(encodeZ('nope', vocab) === -1, 'unseen z is −1, not a throw');
  assert(
    encodeZ(
      { call: 'b-default', utilSig: 'eco', commitBucket: 'late', spawnShape: 'spread', lurk: false },
      vocab
    ) === 1,
    'a z-bag encodes as its key'
  );
}

{
  const rows = ['a-execute|full|early|stack|lurk', 'b-default|eco|late|spread|nolurk'];
  const a = sampleZ(new Rng(7), rows);
  const b = sampleZ(new Rng(7), rows);
  assert(a === b, 'sampleZ is deterministic given the rng');
  assert(rows.includes(a), 'and lands on a library row');
  assert(sampleZ(new Rng(1), []) === null, 'an empty library yields null');
}

console.log('zstat: ok (utilSig, commitBucket, zKey, encodeZ, sampleZ)');
