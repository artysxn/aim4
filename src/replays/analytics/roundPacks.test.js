// Run: node src/replays/analytics/roundPacks.test.js
//
// How the Pattern Finder's "Matching selections…" phase talks to the network.
//
// That phase used to be a loop over WINDOWS that awaited `fetchRoundMeta` and
// then `fetchRoundTicks` inline, one at a time. Three things were wrong with
// it, and every one of them is felt rather than seen:
//
//   1. **Serial.** Each distinct round file cost two round-trips end to end
//      before the next one started, so the phase was pure latency with an idle
//      CPU behind it. A map with 20,000 rounds is 40,000 requests in a queue
//      of one.
//   2. **Ticks nobody asked for.** A tick buffer is ~200 KB against ~10 KB of
//      meta, and `grenade_in` says in its own comment that it needs none — the
//      landing point comes off the round's grenade events. A clock-only or
//      utility-only filter never calls `shapePassesWindow` at all. Both fetched
//      one per round anyway.
//   3. **Silent.** The loop did not know how many files it would touch, so the
//      UI could only say "Matching selections…" — for a minute or more, with
//      no way to tell whether it was nearly done or had barely started.

import assert from 'node:assert/strict';
import { loadRoundPacks, searchNeedsTicks, PACK_CONCURRENCY } from './shapeFilters.js';
import { COARSE_STRIDE } from '../tickStore.js';

// ---- which searches need a tick buffer --------------------------------------
{
  assert.equal(searchNeedsTicks([{ feature: 'player_in' }]), true, 'player_in reads positions');
  assert.equal(searchNeedsTicks([{ feature: 'kill_from' }]), true, 'kill_from falls back to positions');
  assert.equal(searchNeedsTicks([{ feature: 'death_from' }]), true, 'death_from too');
  assert.equal(searchNeedsTicks([{ feature: 'first_duel_in' }]), true, 'and first_duel_in');

  // The one that pays for itself: a grenade search answers off the events.
  assert.equal(searchNeedsTicks([{ feature: 'grenade_in' }]), false, 'grenade_in needs no ticks');
  assert.equal(searchNeedsTicks([]), false, 'a clock- or utility-only filter needs none');

  // A shape with no feature is a player position by default — the old default.
  assert.equal(searchNeedsTicks([{}]), true, 'an unlabelled shape defaults to player_in');
  // Mixed: one shape that needs them is enough.
  assert.equal(
    searchNeedsTicks([{ feature: 'grenade_in' }, { feature: 'player_in' }]),
    true,
    'any shape needing ticks means fetching them'
  );
}

// ---- a stand-in for the network ---------------------------------------------
function tracker({ delay = 0 } = {}) {
  const t = { meta: [], ticks: [], strides: [], inFlight: 0, peak: 0 };
  const gate = async () => {
    t.inFlight += 1;
    t.peak = Math.max(t.peak, t.inFlight);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    else await Promise.resolve();
    t.inFlight -= 1;
  };
  t.fetchMeta = async (file) => {
    await gate();
    t.meta.push(file);
    return { id: file, players: [], events: {} };
  };
  t.fetchTicks = async (file, stride) => {
    await gate();
    t.ticks.push(file);
    t.strides.push(stride);
    return new ArrayBuffer(8);
  };
  return t;
}

const files = (n) => Array.from({ length: n }, (_, i) => `r${i}`);

// ---- the pool actually overlaps ---------------------------------------------
{
  const t = tracker({ delay: 5 });
  const cache = new Map();
  await loadRoundPacks(files(24), cache, {
    ticks: false,
    concurrency: 8,
    fetchMeta: t.fetchMeta,
    fetchTicks: t.fetchTicks
  });
  assert.equal(cache.size, 24, 'every file landed in the cache');
  assert.equal(t.meta.length, 24, 'each fetched once');
  assert.ok(t.peak > 1, `requests overlap (peak in flight ${t.peak})`);
  assert.ok(t.peak <= 8, `and stay inside the pool (peak ${t.peak})`);
}

// ---- ...and does not exceed the file count ----------------------------------
{
  const t = tracker({ delay: 2 });
  await loadRoundPacks(files(3), new Map(), {
    ticks: false,
    concurrency: 8,
    fetchMeta: t.fetchMeta,
    fetchTicks: t.fetchTicks
  });
  assert.ok(t.peak <= 3, `three files never open more than three requests (peak ${t.peak})`);
}

// ---- ticks are skipped when the search does not read positions --------------
{
  const t = tracker();
  await loadRoundPacks(files(10), new Map(), {
    ticks: false,
    fetchMeta: t.fetchMeta,
    fetchTicks: t.fetchTicks
  });
  assert.equal(t.meta.length, 10, 'meta for every file');
  assert.equal(t.ticks.length, 0, 'and not one tick buffer — half the requests, and the big half');
}

{
  const t = tracker();
  await loadRoundPacks(files(10), new Map(), {
    ticks: true,
    fetchMeta: t.fetchMeta,
    fetchTicks: t.fetchTicks
  });
  assert.equal(t.ticks.length, 10, 'and fetched when a shape does read positions');

  // The stride is not free to choose. The server precomputes one thinned pass
  // per round (`.c100.bin`) and serves it as a file read; every other stride
  // misses it and decompresses the whole 1.1 MB round to answer, ~4.2 ms of
  // synchronous server CPU on every round of every position search. This
  // asked for 64 for months, which is exactly that miss.
  assert.deepEqual(
    [...new Set(t.strides)],
    [COARSE_STRIDE],
    'ticks are fetched at the stride the server has precomputed'
  );
}

// ---- a round whose meta fails costs nothing more ----------------------------
{
  const t = tracker();
  const cache = new Map();
  await loadRoundPacks(['ok', 'bad'], cache, {
    ticks: true,
    fetchMeta: async (f) => {
      if (f === 'bad') throw new Error('gone');
      return t.fetchMeta(f);
    },
    fetchTicks: t.fetchTicks
  });
  assert.equal(cache.get('bad').meta, null, 'a failed round is cached as a miss');
  assert.equal(t.ticks.includes('bad'), false, 'and its ticks are never asked for');
  assert.equal(cache.size, 2, 'both are remembered, so the next search does not retry the bad one');
}

// ---- progress counts distinct FILES, and reaches the total ------------------
{
  const seen = [];
  await loadRoundPacks(files(12), new Map(), {
    ticks: false,
    concurrency: 4,
    onProgress: (p) => seen.push(p),
    fetchMeta: async () => ({ players: [] }),
    fetchTicks: async () => null
  });
  assert.ok(seen.length >= 13, 'an opening event and one per file');
  assert.deepEqual(seen[0], { done: 0, total: 12 }, 'it opens by saying how many there are');
  assert.deepEqual(seen.at(-1), { done: 12, total: 12 }, 'and finishes on the total');
  // Monotonic, because a progress line that goes backwards is worse than none.
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].done >= seen[i - 1].done, 'progress never goes backwards');
    assert.equal(seen[i].total, 12, 'and the total never moves');
  }
}

// ---- a second search only pays for what it has not seen ---------------------
{
  const t = tracker();
  const cache = new Map();
  const opts = { ticks: false, fetchMeta: t.fetchMeta, fetchTicks: t.fetchTicks };
  await loadRoundPacks(files(10), cache, opts);
  assert.equal(t.meta.length, 10);
  // Edit a shape, search again over the same rounds plus two new ones.
  const progress = [];
  await loadRoundPacks([...files(10), 'r10', 'r11'], cache, { ...opts, onProgress: (p) => progress.push(p) });
  assert.equal(t.meta.length, 12, 'only the two new rounds are fetched');
  assert.deepEqual(progress[0], { done: 0, total: 2 }, 'and the count reflects the work left, not the whole map');
}

// ---- nothing to do is not a spinner -----------------------------------------
{
  const cache = new Map([['r0', { meta: {}, ticks: null }]]);
  const progress = [];
  await loadRoundPacks(['r0'], cache, {
    onProgress: (p) => progress.push(p),
    fetchMeta: async () => assert.fail('should not fetch a cached round'),
    fetchTicks: async () => assert.fail('should not fetch a cached round')
  });
  assert.deepEqual(progress, [{ done: 0, total: 0 }], 'a fully cached search reports no work');
}

assert.ok(PACK_CONCURRENCY > 1, 'the default pool is not one');

console.log('roundPacks.test.js: ok');
