import assert from 'node:assert/strict';
import {
  FORMATIONS,
  PACE_TYPES,
  PATTERN_MAP_CODES,
  clockSeconds,
  formatFormation,
  paceType
} from './patternDefs.js';

// Every covered map has a formation definition, and vice versa.
assert.deepEqual(
  [...PATTERN_MAP_CODES].sort(),
  Object.keys(FORMATIONS).sort(),
  'map codes and formation defs agree'
);
for (const [code, def] of Object.entries(FORMATIONS)) {
  assert.ok(def.t.length >= 2 && def.t.length <= 3, `${code} has 2 or 3 T lanes`);
  assert.ok(def.ct.length === def.t.length || def.ct.length === 3 || def.ct.length === 2);
  assert.ok(clockSeconds(def.snapshot) !== null, `${code} snapshot clock parses`);
  if (def.skip) {
    assert.ok(
      def.t.some((l) => l.key === def.skip.lane),
      `${code} skip rule names a real lane`
    );
  }
  for (const lane of def.t) {
    assert.ok(lane.regions.length > 0, `${code} lane ${lane.key} maps to regions`);
  }
}

// Notation: the worked examples from the plan.
assert.equal(formatFormation('DD2', [2, 2, 1]), '2-2-1', 'Dust2 full spread');
assert.equal(formatFormation('DD2', [2, 3, 0]), '2-3', 'Dust2 skips an empty long');
assert.equal(formatFormation('MIR', [2, 3, 0]), '2-3-0', 'Mirage always writes the zero');
assert.equal(formatFormation('MIR', [1, 3, 1]), '1-3-1');
assert.equal(formatFormation('ANC', [1, 4, 0]), '1-4', 'Ancient skips an empty A');
assert.equal(formatFormation('INF', [2, 3]), '2-3', 'two-lane map');
assert.equal(formatFormation('NUK', [4, 1]), '4-1');

// The 5-stack form replaces zeros entirely.
assert.equal(formatFormation('DD2', [5, 0, 0]), '5B');
assert.equal(formatFormation('MIR', [0, 5, 0]), '5 Mid');
assert.equal(formatFormation('ANU', [0, 0, 5]), '5A', 'Con / A five-stack uses the short token');
assert.equal(formatFormation('INF', [0, 5]), '5A');

// Bad input answers empty rather than inventing a notation.
assert.equal(formatFormation('DD2', [2, 2]), '', 'wrong lane count');
assert.equal(formatFormation('XXX', [2, 2, 1]), '', 'unknown map');

// Clocks count down and parse strictly.
assert.equal(clockSeconds('1:42'), 102);
assert.equal(clockSeconds('0:30'), 30);
assert.equal(clockSeconds('142'), null);
assert.equal(clockSeconds(''), null);

// Pace catalogue: six paces, orderable, resolvable by key.
assert.equal(PACE_TYPES.length, 6);
assert.equal(paceType('rush')?.label, 'Rush');
assert.equal(paceType('slow-default')?.label, 'Slow default');
assert.equal(paceType('nope'), null);
for (const p of PACE_TYPES) {
  assert.ok(p.desc && !p.desc.includes('—'), `${p.key} desc has no em dash`);
}

console.log('patternDefs: all assertions passed');
