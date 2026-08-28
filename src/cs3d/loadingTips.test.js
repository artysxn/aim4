// node src/cs3d/loadingTips.test.js
import assert from 'node:assert/strict';
import { TIPS, tipCycle, loadingShotUrl } from './loadingTips.js';

// The ask was fifty, and fifty it is. Pinned exactly: a shrinking list means a
// tip was deleted without a replacement, a growing one deserves a look at the
// rotation cadence.
assert.equal(TIPS.length, 50, `50 tips, found ${TIPS.length}`);

// Each tip is one readable sentence, not an essay and not a stub.
for (const tip of TIPS) {
  assert.ok(tip.trim().length >= 20, `too short to be worth screen time: "${tip}"`);
  assert.ok(tip.length <= 120, `too long for one loading-screen line: "${tip}"`);
}

// No duplicates, which is what a rotation that repeats too early feels like.
assert.equal(new Set(TIPS).size, TIPS.length, 'every tip is distinct');

// The cycle shows all fifty before showing anything twice.
{
  const next = tipCycle();
  const seen = new Set();
  for (let i = 0; i < TIPS.length; i++) seen.add(next());
  assert.equal(seen.size, TIPS.length, 'one full pass covers every tip');
  assert.ok(seen.has(next()) === true, 'then it wraps rather than running dry');
}

// A deterministic "random" still yields every tip: the shuffle must permute,
// never drop.
{
  const next = tipCycle(() => 0.42);
  const seen = new Set();
  for (let i = 0; i < TIPS.length; i++) seen.add(next());
  assert.equal(seen.size, TIPS.length);
}

// Every ported map has its screenshot; anything else gets none rather than a
// broken image.
for (const slug of ['ancient', 'anubis', 'cache', 'dust2', 'inferno', 'mirage', 'nuke']) {
  assert.equal(loadingShotUrl(slug), `/maps/loading/${slug}.jpg`);
  assert.equal(loadingShotUrl(slug.toUpperCase()), `/maps/loading/${slug}.jpg`, 'case-blind');
}
assert.equal(loadingShotUrl('train'), '', 'no screenshot, no url');
assert.equal(loadingShotUrl(''), '');
assert.equal(loadingShotUrl(null), '');

console.log('loadingTips: all assertions passed');
