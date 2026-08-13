// Run: node shared/sim/surprise.test.js

import { entropy, insideBand, ksDistance, surpriseBand } from './surprise.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

{
  const a = Array.from({ length: 80 }, (_, i) => i / 80);
  const b = Array.from({ length: 80 }, (_, i) => i / 80);
  const same = ksDistance(a, b);
  assert(same.pass && same.d < 0.05, `identical samples pass KS (${same.d})`);

  const shifted = ksDistance(
    a,
    Array.from({ length: 80 }, (_, i) => 0.5 + i / 160)
  );
  assert(!shifted.pass, 'a shifted sample fails');
}

{
  assert(entropy({ a: 1 }) === 0, 'one bucket is zero entropy');
  assert(Math.abs(entropy({ a: 1, b: 1 }) - 1) < 1e-9, 'two equal buckets are 1 bit');
}

{
  const inBand = insideBand(0.12, 0.05, 0.2, 'offAngle');
  assert(inBand.pass, inBand.reason);
  const out = insideBand(0.4, 0.05, 0.2, 'offAngle');
  assert(!out.pass, out.reason);
  const skip = insideBand(0.4, undefined, undefined, 'offAngle');
  assert(skip.skipped && skip.pass, 'no library band is a skip, not a fail');
}

{
  const report = surpriseBand({ offAngle: 0.1, smokeCross: 0.02, dryEntry: 0.3 });
  assert(report.ungated, report.reason);
  const gated = surpriseBand(
    { offAngle: 0.1, smokeCross: 0.02, mollyCross: 0.01, dryEntry: 0.3, contactEntropy: 2, meanPfw: 0.5 },
    { offAngle: { lo: 0.05, hi: 0.2 }, dryEntry: { lo: 0.1, hi: 0.5 } }
  );
  assert(gated.pass && !gated.ungated, gated.reason);
}

console.log('surprise: ok');
