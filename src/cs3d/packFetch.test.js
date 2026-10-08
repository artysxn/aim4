// node src/cs3d/packFetch.test.js
//
// The retry policy that keeps a dropped request from silently deleting map
// geometry. Loading a map opens four geometry workers, the texture bundle, the
// lightmap, the shadow mask, the probe grid and the agent/weapon packs all at
// once, and a map with holes in it is what a single failed read looks like.
//
// This file used to also pin the Cloudflare R2 fallback that filled a missing
// local pack from the public bucket. That is gone: the packs are read off this
// machine now and a local install must not reach for the network to cover a
// hole in them. The cases below are the policy that stayed.

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

const { packFetch, packFetchOk, packFetchStats, loadWithRetry } = await import('./packFetch.js');

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

// ---- there is no bucket to fall back to --------------------------------------
const mod = await import('./packFetch.js');
assert.equal('PACK_CDN' in mod, false, 'the R2 bucket constant must be gone');
assert.equal('packCdnUrl' in mod, false, 'the /api/cs3d/ -> bucket rewrite must be gone');

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

// ---- a missing local pack file is just missing -------------------------------
// The old behaviour rewrote this URL onto the public bucket. Now it must be
// asked once, answered once, and reported as the 404 it is: going out to the
// network to paper over a hole in a local pack is exactly what this deployment
// is not allowed to do.
reset();
calls = 0;
const seenUrls = [];
globalThis.fetch = async (url) => {
  calls++;
  seenUrls.push(String(url));
  return res(404);
};
{
  const r = await packFetch('/api/cs3d/weapons/manifest.json');
  assert.equal(r.status, 404);
  assert.equal(calls, 1, 'a missing pack file must be requested exactly once');
  assert.equal(packFetchStats.retries, 0);
  assert.ok(
    seenUrls.every((u) => !u.includes('r2.dev')),
    'a local miss must not go out to the bucket'
  );
}

reset();
const deadUrls = [];
globalThis.fetch = async (url) => {
  calls++;
  deadUrls.push(String(url));
  throw new TypeError('Failed to fetch');
};
{
  await assert.rejects(() => packFetch('http://127.0.0.1:3784/api/cs3d/weapons/manifest.json'));
  assert.ok(calls > 1, `a dead request is still retried, got ${calls} call(s)`);
  assert.ok(
    deadUrls.every((u) => u.startsWith('http://127.0.0.1:3784/')),
    `every retry must stay on the local host, got ${deadUrls.join(', ')}`
  );
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
