// ---------------------------------------------------------------------------
// server/entitlements/codes.test.js
//   node --test server/entitlements/codes.test.js
//
// Code generation, and the reasons a code is refused. Redemption itself writes
// to three tables through grants.js, so it is covered by the parts that can be
// tested without one: the shape of generated codes, normalisation of what a
// human types, and the refusal rules.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import { codeProblem, generateCode, normaliseCode } from './codes.js';

test('generated codes avoid the characters people misread', () => {
  // O/0 and I/1 are the classic misreadings off a stream or a screenshot.
  const codes = Array.from({ length: 200 }, () => generateCode({ prefix: 'AIM4' }));
  for (const code of codes) {
    const body = code.slice('AIM4-'.length);
    assert.doesNotMatch(body, /[OIU01]/, `${code} contains an ambiguous character`);
    assert.match(code, /^AIM4-[A-Z2-9]{4}-[A-Z2-9]{4}$/, `${code} has the wrong shape`);
  }
});

test('generated codes do not repeat', () => {
  const seen = new Set(Array.from({ length: 500 }, () => generateCode()));
  assert.equal(seen.size, 500, 'a collision in 500 draws means the alphabet or length is wrong');
});

test('block count and length are configurable', () => {
  assert.match(generateCode({ blocks: 3, blockLength: 5 }), /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.match(generateCode({ prefix: 'X', blocks: 1 }), /^X-[A-Z2-9]{4}$/);
});

test('what a human types is normalised to what is stored', () => {
  assert.equal(normaliseCode('  aim4-x7k2  '), 'AIM4-X7K2');
  assert.equal(normaliseCode('aim4 x7k2'), 'AIM4X7K2', 'spaces are dropped, not turned into dashes');
  assert.equal(normaliseCode('AIM4_X7K2!'), 'AIM4X7K2', 'punctuation that is not a dash is dropped');
  assert.equal(normaliseCode(''), '');
  assert.equal(normaliseCode(null), '');
});

test('a code is refused once it has been used up', () => {
  const base = { archived_at: null, expires_at: null, max_redemptions: 1, times_redeemed: 0 };
  assert.equal(codeProblem({ ...base }), null, 'an unused single-use code works');
  assert.match(codeProblem({ ...base, times_redeemed: 1 }), /already been used/);
});

test('an unlimited code is never used up', () => {
  const row = { archived_at: null, expires_at: null, max_redemptions: null, times_redeemed: 9999 };
  assert.equal(codeProblem(row), null);
});

test('an expired or archived code is refused', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const base = { archived_at: null, max_redemptions: null, times_redeemed: 0 };
  assert.match(
    codeProblem({ ...base, expires_at: '2026-05-31T23:59:00Z' }, now),
    /expired/
  );
  assert.equal(codeProblem({ ...base, expires_at: '2026-06-02T00:00:00Z' }, now), null);
  assert.match(codeProblem({ ...base, expires_at: null, archived_at: '2026-05-01' }, now), /no longer active/);
});

test('an unknown code says so without hinting at what would work', () => {
  const problem = codeProblem(null);
  assert.match(problem, /not recognised/);
  // Enumeration is the attack a code faces, so the refusal must not leak
  // whether a code exists but is spent versus never existed at all... except
  // that "already been used" necessarily does. The distinction kept here is
  // that an unknown code reveals nothing about format or validity.
  assert.doesNotMatch(problem, /expired|used|archived/);
});
