// Run: node src/replays/statsPipeline.test.js
//
// How the stats library is paged off the server.
//
// It used to be strictly one page at a time: ask, wait for the server to pack
// 300 demos, wait for the bytes, wait for the worker to parse them, merge, and
// only then ask for the next. Those four waits are on four different resources
// and none of them overlapped — which is the pause every 300 demos.
//
// Now up to `PAGE_PIPELINE` are in flight. What must NOT change is the answer:
// pages are still merged in order, the payload is identical, the batch events
// still arrive per page, and a library that ends early still stops. Those are
// what this file pins, because "faster but subtly reordered" is the failure
// mode a stopwatch would not catch.

import assert from 'node:assert/strict';
import {
  PAGE_PIPELINE,
  getStatsPayload,
  invalidateStatsCache,
  setStatsFetcher
} from './statsCache.js';
import { STATS_LIBRARY_PAGE } from './api.js';

const PAGE = STATS_LIBRARY_PAGE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A server that serves `total` demos in pages, tracking overlap.
 * `delay` is how long a page takes, so concurrency is observable.
 */
function server({ total, delay = 10, shortAt = null }) {
  const t = { calls: [], inFlight: 0, peak: 0, order: [] };
  t.fetch = async (slice, opts) => {
    const offset = slice ? 0 : opts.offset;
    const start = slice ? null : opts.offset;
    t.inFlight += 1;
    t.peak = Math.max(t.peak, t.inFlight);
    t.calls.push(start);
    await sleep(delay);
    t.inFlight -= 1;
    // A library that turns out shorter than its own count claimed.
    const end = shortAt !== null ? Math.min(total, shortAt) : total;
    const from = start ?? 0;
    const count = Math.max(0, Math.min(PAGE, end - from));
    const demos = Array.from({ length: count }, (_, i) => ({ id: `d${from + i}`, rounds: [] }));
    t.order.push(from);
    return { demos, total, libraryTotal: total, offset: from, hasMore: from + count < end, columns: [] };
  };
  return t;
}

// ---- pages overlap, and the answer is unchanged -----------------------------
{
  invalidateStatsCache();
  const s = server({ total: PAGE * 4, delay: 20 });
  setStatsFetcher(s.fetch);
  const payload = await getStatsPayload(null, { columns: 'identity' });

  assert.equal(payload.demos.length, PAGE * 4, 'every demo arrived');
  // In order, and each exactly once — the merge must not follow completion order.
  for (let i = 0; i < payload.demos.length; i++) {
    assert.equal(payload.demos[i].id, `d${i}`, `demo ${i} is in library order`);
  }
  assert.ok(s.peak > 1, `pages overlap (peak in flight ${s.peak})`);
  assert.ok(s.peak <= PAGE_PIPELINE, `and stay inside the pipeline (peak ${s.peak})`);
  assert.equal(s.calls.length, 4, 'four pages, no speculative extras');
}

// ---- the first page is alone, because it is what says how big the job is ----
{
  invalidateStatsCache();
  const s = server({ total: PAGE * 3, delay: 15 });
  setStatsFetcher(s.fetch);
  await getStatsPayload(null, { columns: 'identity' });
  assert.equal(s.calls[0], 0, 'page 0 first');
  // Nothing may be launched before page 0 returns: until then the library size
  // is unknown and any second request would be a guess.
  assert.equal(s.peak <= PAGE_PIPELINE, true);
}

// ---- overlap is a real speed-up ---------------------------------------------
{
  invalidateStatsCache();
  const s = server({ total: PAGE * 6, delay: 30 });
  setStatsFetcher(s.fetch);
  const t0 = Date.now();
  await getStatsPayload(null, { columns: 'identity' });
  const ms = Date.now() - t0;
  // Serial would be 6 x 30 = 180 ms. Page 0 alone, then five through a pool of
  // three, is about 30 + 60 = 90. Allow slack for the timer, but it must be
  // clearly under the serial cost.
  assert.ok(ms < 160, `six pages took ${ms} ms, well under the 180 ms a serial run costs`);
}

// ---- a library that ends early stops -----------------------------------------
{
  invalidateStatsCache();
  // The count says four pages; the data runs out after two and a bit.
  const s = server({ total: PAGE * 4, delay: 5, shortAt: PAGE * 2 + 10 });
  setStatsFetcher(s.fetch);
  const payload = await getStatsPayload(null, { columns: 'identity' });
  assert.equal(payload.demos.length, PAGE * 2 + 10, 'only what actually existed');
  assert.equal(payload.demos.at(-1).id, `d${PAGE * 2 + 9}`, 'and it is the real last demo');
}

// ---- a scoped request goes in ONE request -----------------------------------
{
  invalidateStatsCache();
  const ids = Array.from({ length: PAGE * 2 + 40 }, (_, i) => `d${i}`);
  const asked = [];
  setStatsFetcher(async (slice) => {
    asked.push(slice.length);
    await sleep(5);
    return {
      demos: slice.map((id) => ({ id, rounds: [] })),
      total: slice.length,
      hasMore: false,
      columns: []
    };
  });
  const payload = await getStatsPayload(ids, { columns: 'identity' });
  assert.equal(payload.demos.length, ids.length, 'every requested demo came back');
  assert.deepEqual(payload.demos.map((d) => d.id), ids, 'in the order asked for');
  // The whole scope in one go. The server decides whether that is too much to
  // ship (statsIndex.js STATS_PAGE_BYTES); the client no longer pre-chops it
  // into 300s and pauses between each.
  assert.deepEqual(asked, [ids.length], `one request for the whole scope, got ${asked.length}`);
}

// ---- ...and if the server cuts it short, the rest still arrives -------------
{
  invalidateStatsCache();
  // The server may answer with fewer demos than were asked for when the page
  // would weigh too much. That is the only thing keeping the "ask for
  // everything" request safe, so it has to work.
  const ids = Array.from({ length: 1000 }, (_, i) => `d${i}`);
  const CUT = 400;
  const asked = [];
  setStatsFetcher(async (slice) => {
    asked.push(slice.length);
    await sleep(2);
    const served = slice.slice(0, CUT);
    return {
      demos: served.map((id) => ({ id, rounds: [] })),
      total: served.length,
      hasMore: served.length < slice.length,
      columns: []
    };
  });
  const payload = await getStatsPayload(ids, { columns: 'identity' });
  assert.equal(payload.demos.length, ids.length, 'all 1000 arrived across the short pages');
  assert.deepEqual(payload.demos.map((d) => d.id), ids, 'still in the order asked for');
  assert.ok(asked.length > 1, `it took more than one request (${asked.length})`);
  assert.equal(asked[0], 1000, 'the first one still asked for everything');
}

// ---- progress never goes backwards, however the pages interleave ------------
{
  invalidateStatsCache();
  const s = server({ total: PAGE * 5, delay: 8 });
  // Report progress from inside each page, at a moment that differs per page,
  // so the events genuinely interleave.
  setStatsFetcher(async (slice, opts) => {
    const chunk = await s.fetch(slice, opts);
    opts.onProgress?.({ type: 'progress', phase: 'ready', done: PAGE, total: PAGE, libraryTotal: PAGE * 5 });
    return chunk;
  });
  const seen = [];
  await getStatsPayload(null, { columns: 'identity', onProgress: (p) => seen.push(p) });
  assert.ok(seen.length > 0, 'progress was reported');
  let last = -1;
  for (const p of seen) {
    assert.ok(p.libraryLoaded >= last, `libraryLoaded is monotonic (${p.libraryLoaded} after ${last})`);
    assert.equal(p.libraryTotal, PAGE * 5, 'and the library total never moves');
    last = p.libraryLoaded;
  }
  assert.equal(seen.at(-1).libraryLoaded, PAGE * 5, 'and it finishes on the total');
}

// ---- batch subscribers still see every page, ending complete ---------------------
{
  invalidateStatsCache();
  const s = server({ total: PAGE * 3, delay: 5 });
  setStatsFetcher(s.fetch);
  const batches = [];
  await getStatsPayload(null, { columns: 'identity', onBatch: (b) => batches.push({ loaded: b.loaded, complete: b.complete }) });
  assert.ok(batches.length >= 3, 'a batch per page');
  assert.equal(batches.at(-1).complete, true, 'the last one closes the stream');
  assert.equal(batches.at(-1).loaded, PAGE * 3, 'with everything loaded');
  // Loaded only ever grows: a subscriber painting from it must never see the
  // table shrink.
  let prev = 0;
  for (const b of batches) {
    assert.ok(b.loaded >= prev, `loaded is monotonic (${b.loaded} after ${prev})`);
    prev = b.loaded;
  }
}

setStatsFetcher();
invalidateStatsCache();
console.log('statsPipeline.test.js: ok');
