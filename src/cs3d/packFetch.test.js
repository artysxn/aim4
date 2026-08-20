// node src/cs3d/packFetch.test.js
//
// The retry policy that keeps a rate-limited CDN from silently deleting map
// geometry. Every case here is a shape the live bucket actually produced on
// 2026-08-19: a 429 with and without `Retry-After`, a dropped connection
// (bare TypeError, which the browser also reports as a CORS failure), and a
// 404, which must NOT be retried because it repeats forever.

import assert from 'node:assert';

const orig = globalThis.fetch;
const origPerf = globalThis.performance;

// Deterministic backoff: no jitter, no real waiting.
const realTimeout = globalThis.setTimeout;
let slept = 0;
globalThis.setTimeout = (fn, ms) => {
  slept += ms || 0;
  return realTimeout(fn, 0);
};
const realRandom = Math.random;
Math.random = () => 0.5;

const { packFetch, packFetchOk, packFetchStats, loadWithRetry, packCdnUrl } = await import('./packFetch.js');

const reset = () => {
  slept = 0;
  packFetchStats.requests = 0;
  packFetchStats.retries = 0;
  packFetchStats.rateLimited = 0;
  packFetchStats.failures = 0;
};

/** A Response-alike: only `status`, `ok` and `headers.get` are read. */
const res = (status, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null }
});

assert.equal(
  packCdnUrl('/api/cs3d/weapons/manifest.json'),
  'https://pub-2cbbca6c60604cc7a9fde25f012821d9.r2.dev/weapons/manifest.json'
);
assert.equal(packCdnUrl('https://cdn/x.glb'), null);

// ---- a 200 goes straight through --------------------------------------------
reset();
globalThis.fetch = async () => res(200);
{
  const r = await packFetch('https://cdn/x.glb');
  assert.equal(r.status, 200);
  assert.equal(packFetchStats.retries, 0, 'a 200 must not retry');
  assert.equal(slept, 0, 'a 200 must not back off');
}

// ---- a 404 is final ---------------------------------------------------------
// The whole point of not retrying: before this, a typo'd pack path cost five
// round trips and still failed.
reset();
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return res(404);
};
{
  const r = await packFetch('https://cdn/missing.glb');
  assert.equal(r.status, 404);
  assert.equal(calls, 1, 'a 404 must be requested exactly once');
  assert.equal(packFetchStats.retries, 0);
}

// ---- a 404 under /api/cs3d/ falls through to the public bucket --------------
reset();
calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  if (String(url).includes('r2.dev')) return res(200);
  return res(404);
};
{
  const r = await packFetch('/api/cs3d/weapons/manifest.json');
  assert.equal(r.status, 200, 'a missing local pack file must come from the CDN');
  assert.equal(calls, 2);
  assert.equal(packFetchStats.retries, 0, 'a CDN fallback is not a retry');
}

reset();
calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  if (String(url).includes('r2.dev')) return res(200);
  throw new TypeError('Failed to fetch');
};
{
  const r = await packFetch('http://127.0.0.1:5173/api/cs3d/weapons/manifest.json');
  assert.equal(r.status, 200, 'a dead local API must still load the pack from the CDN');
  assert.equal(calls, 2);
}

// ---- a 429 that clears is recovered, not lost -------------------------------
// This is the live failure: the first attempts are rate-limited, a later one
// succeeds, and the caller sees only the success.
reset();
calls = 0;
globalThis.fetch = async () => {
  calls++;
  return calls <= 2 ? res(429) : res(200);
};
{
  const r = await packFetch('https://cdn/g22.glb');
  assert.equal(r.status, 200, 'a 429 that clears must come back as the eventual 200');
  assert.equal(calls, 3);
  assert.equal(packFetchStats.rateLimited, 2);
  assert.ok(packFetchStats.retries >= 2);
}

// ---- a dropped connection is retried ----------------------------------------
// `fetch` rejecting with a TypeError is what the browser reports for both a
// killed socket and a CORS rejection; on this origin it is nearly always the
// former, so it has to be retryable.
reset();
calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls === 1) throw new TypeError('NetworkError when attempting to fetch resource.');
  return res(200);
};
{
  const r = await packFetch('https://cdn/g27.glb');
  assert.equal(r.status, 200);
  assert.equal(calls, 2);
}

// ---- a connection that never comes back rejects, it does not resolve --------
reset();
globalThis.fetch = async () => {
  throw new TypeError('NetworkError when attempting to fetch resource.');
};
await assert.rejects(() => packFetch('https://cdn/gone.glb'), /NetworkError/);
assert.equal(packFetchStats.failures, 1);

// ---- `Retry-After` is honoured, and capped ----------------------------------
// A cooperative edge says how long to wait. An uncooperative one can say an
// hour, and a map load must not stall on it.
reset();
calls = 0;
globalThis.fetch = async () => {
  calls++;
  return calls === 1 ? res(429, { 'retry-after': '2' }) : res(200);
};
{
  await packFetch('https://cdn/g35.glb');
  assert.ok(slept >= 2000, `Retry-After: 2 should hold ~2s, held ${slept}ms`);
}
reset();
calls = 0;
globalThis.fetch = async () => {
  calls++;
  return calls === 1 ? res(429, { 'retry-after': '3600' }) : res(200);
};
{
  await packFetch('https://cdn/g46.glb');
  assert.ok(slept < 60_000, `an hour-long Retry-After must be capped, held ${slept}ms`);
}

// ---- the cooldown is SHARED across concurrent requests ----------------------
// The rate limit counts requests to the origin. One worker backing off while
// three others keep hammering only moves which request fails, which is exactly
// what the four geometry workers used to do.
reset();
let seen = 0;
globalThis.fetch = async () => {
  seen++;
  return seen === 1 ? res(429, { 'retry-after': '1' }) : res(200);
};
{
  const before = slept;
  await Promise.all([
    packFetch('https://cdn/a.glb'),
    packFetch('https://cdn/b.glb'),
    packFetch('https://cdn/c.glb'),
    packFetch('https://cdn/d.glb')
  ]);
  assert.ok(slept > before, 'a 429 on one request must make the others wait too');
}

// ---- packFetchOk turns a non-ok into an error naming the file ---------------
reset();
globalThis.fetch = async () => res(404);
await assert.rejects(() => packFetchOk('https://cdn/anubis/geo/g72.glb', 'geometry'), /geometry: 404.*g72\.glb/);

// ---- concurrency is capped --------------------------------------------------
// Ten subsystems open at once; between them they must not open thirty sockets.
reset();
let live = 0;
let peak = 0;
globalThis.fetch = async () => {
  live++;
  peak = Math.max(peak, live);
  await new Promise((r) => realTimeout(r, 1));
  live--;
  return res(200);
};
await Promise.all(Array.from({ length: 40 }, (_, i) => packFetch(`https://cdn/t${i}.glb`)));
assert.ok(peak <= 6, `pack requests in flight peaked at ${peak}, cap is 6`);

// ---- loadWithRetry wraps a THREE-style loader -------------------------------
// The sprite sheets and the sky HDR go through a loader that does its own
// networking, so they cannot share the queue — but they must share the retry.
reset();
{
  let n = 0;
  const loader = {
    load(url, onLoad, _onProgress, onError) {
      n++;
      if (n < 3) onError(new Error('network'));
      else onLoad({ url });
    }
  };
  const out = await loadWithRetry(loader, 'https://cdn/fx/smoke.webp');
  assert.equal(out.url, 'https://cdn/fx/smoke.webp');
  assert.equal(n, 3);
}
reset();
{
  const loader = {
    load(_url, _onLoad, _onProgress, onError) {
      onError(new Error('always down'));
    }
  };
  await assert.rejects(() => loadWithRetry(loader, 'https://cdn/fx/gone.webp'), /always down/);
}

globalThis.fetch = orig;
globalThis.performance = origPerf;
globalThis.setTimeout = realTimeout;
Math.random = realRandom;
console.log('packFetch.test.js OK');
