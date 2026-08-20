// ---------------------------------------------------------------------------
// src/cs3d/packFetch.js
// One fetch for every pack file, with the retry the CDN turns out to need.
//
// The packs are served from a Cloudflare R2 bucket through its `pub-*.r2.dev`
// domain, and that domain is RATE LIMITED — Cloudflare says so in as many
// words, and a burst of parallel requests against it comes back as HTTP 429 or
// as a dropped connection (which the browser reports as a CORS failure with a
// null status, because an error page carries no `Access-Control-Allow-Origin`).
//
// Loading a map is exactly such a burst: four geometry workers, the texture
// bundle, the lightmap, the shadow mask, the probe grid, and the player,
// weapon, fx and bullet packs, all opening at once. Measured against the live
// bucket on 2026-08-19, twelve concurrent HEADs were enough to turn ~100
// objects into 429s in a row; four sequential ones a second apart never
// failed. What the user saw was a map with holes in it — `_loadGroups` logged
// a warning per dropped group and carried on, so a tile of Anubis' geometry
// simply never existed for the rest of the session.
//
// So: every pack request goes through here, and this file does three things
// the bare `fetch` did not.
//
//   1. RETRIES what is worth retrying — a network error, a 429, a 408, a 5xx —
//      with exponential backoff and jitter. A 404 is not retried: it repeats
//      forever and the useful thing is to fail on the first one.
//   2. HOLDS EVERYONE OFF after a 429. The limit is per-origin, so a single
//      worker backing off while three others keep hammering just spreads the
//      failure around. One shared cooldown, honouring `Retry-After` when the
//      edge sends one.
//   3. CAPS THE BURST. A small semaphore over all pack requests, so the ten
//      subsystems that load in parallel cannot between them open thirty
//      connections in the first second.
//
// The real fix is a custom domain in front of the bucket (r2.dev is documented
// as unsuitable for production traffic); this is what makes the loader survive
// until there is one, and it is worth keeping afterwards anyway — a CDN edge
// drops connections occasionally whatever the domain.
// ---------------------------------------------------------------------------

/** Public pack bucket. Same origin as scripts/cs3d-fetch.mjs and the API fill. */
export const PACK_CDN = 'https://pub-2cbbca6c60604cc7a9fde25f012821d9.r2.dev';

/**
 * The CDN twin of an `/api/cs3d/...` pack URL.
 *
 * Localhost often 404s these: Vite's pack middleware serves only what is on
 * disk and does not fill from the bucket, and a host with only one map still
 * lacks `weapons/`, `fx/`, and other maps' `interactives.json`. The website
 * already reads this bucket; falling back here makes the 3D viewer match.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function packCdnUrl(url) {
  const s = String(url || '');
  if (!s || s.startsWith(PACK_CDN)) return null;
  const marker = '/api/cs3d/';
  const i = s.indexOf(marker);
  if (i < 0) return null;
  return `${PACK_CDN}/${s.slice(i + marker.length)}`;
}

/** Total pack requests allowed in flight at once, across every subsystem. */
const MAX_INFLIGHT = 6;
/** Tries per request, so four retries after the first attempt. */
const ATTEMPTS = 5;
/** Backoff base; attempt n waits BASE_MS * 2^(n-1), jittered ±50%. */
const BASE_MS = 400;
/** However long `Retry-After` asks for, never hold longer than this. */
const MAX_COOLDOWN_MS = 8000;

let inFlight = 0;
/** Resolvers for requests waiting on a slot, FIFO. */
const queue = [];
/** Shared backoff deadline (ms, `performance.now()` clock). */
let cooldownUntil = 0;

/** Counters, for the loader to report what the network cost it. */
export const packFetchStats = {
  requests: 0,
  retries: 0,
  rateLimited: 0,
  failures: 0
};

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function acquire() {
  if (inFlight < MAX_INFLIGHT) {
    inFlight++;
    return;
  }
  await new Promise((resolve) => queue.push(resolve));
  inFlight++;
}

function release() {
  inFlight--;
  const next = queue.shift();
  if (next) next();
}

/**
 * A 429 puts every pack request on hold, not just this one: the limit counts
 * requests to the origin, so backing one worker off while the others keep
 * going only moves which request fails.
 */
function holdOff(res) {
  const header = res?.headers?.get?.('retry-after');
  let ms = 0;
  if (header) {
    const secs = Number(header);
    // `Retry-After` is either delta-seconds or an HTTP date.
    ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
  }
  if (!(ms > 0)) ms = BASE_MS * 2;
  ms = Math.min(MAX_COOLDOWN_MS, ms);
  cooldownUntil = Math.max(cooldownUntil, now() + ms);
}

/** 429/408/5xx are the edge saying "not now"; everything else 4xx is final. */
const retryableStatus = (s) => s === 429 || s === 408 || (s >= 500 && s < 600);

/**
 * Fetch a pack file, retrying what the CDN is likely to serve again.
 *
 * Resolves with the `Response` — including a non-retryable failure like a 404,
 * which callers already handle by checking `res.ok`. Rejects only when the
 * request never completed after every attempt, with the last error.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function packFetch(url, init) {
  packFetchStats.requests++;
  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const wait = cooldownUntil - now();
    if (wait > 0) await sleep(wait);
    await acquire();
    let res = null;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // A dropped connection. Indistinguishable from a CORS rejection at this
      // level (both are a bare TypeError), and on this origin it is nearly
      // always the rate limiter closing the socket, so treat it as retryable.
      lastError = e;
    } finally {
      release();
    }
    if (!res && lastError) {
      const alt = packCdnUrl(url);
      if (alt) {
        packFetchStats.requests++;
        await acquire();
        try {
          res = await fetch(alt, init);
          if (res?.ok) return res;
        } catch {
          /* keep lastError and retry the original */
        } finally {
          release();
        }
      }
    }
    if (res && !retryableStatus(res.status)) {
      if (res.status === 404) {
        const alt = packCdnUrl(url);
        if (alt) {
          packFetchStats.requests++;
          await acquire();
          try {
            const cdnRes = await fetch(alt, init);
            if (cdnRes?.ok) return cdnRes;
          } catch {
            /* keep the original 404 */
          } finally {
            release();
          }
        }
      }
      return res;
    }
    if (res?.status === 429) {
      packFetchStats.rateLimited++;
      holdOff(res);
    }
    if (attempt === ATTEMPTS) {
      packFetchStats.failures++;
      if (res) return res; // a 429/5xx that never cleared: let the caller see it
      throw lastError || new Error(`packFetch: ${url} failed`);
    }
    packFetchStats.retries++;
    // Exponential with jitter, on top of any shared cooldown a 429 just set.
    await sleep(BASE_MS * 2 ** (attempt - 1) * (0.5 + Math.random()));
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw lastError || new Error(`packFetch: ${url} failed`);
}

/**
 * `packFetch` plus the `res.ok` check, for the callers that only ever wanted
 * the bytes. The message carries the URL because a pack failure is nearly
 * always about WHICH file is missing.
 *
 * @param {string} url
 * @param {string} what  short label for the error, e.g. 'lightmap'
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function packFetchOk(url, what, init) {
  const res = await packFetch(url, init);
  if (!res.ok) throw new Error(`${what}: ${res.status} from ${url}`);
  return res;
}

/**
 * A `THREE.TextureLoader`-shaped load with the same retry policy.
 *
 * The loader takes a URL and goes to the network itself, so it cannot share
 * `packFetch`'s queue; what it can share is the retry, which is the part that
 * matters. Used for the sprite sheets and decal atlases, which are small but
 * are fetched in the same burst as everything else.
 *
 * @param {{load: Function}} loader  a THREE loader with (url, onLoad, onProgress, onError)
 * @param {string} url
 * @returns {Promise<any>}
 */
export async function loadWithRetry(loader, url) {
  const tryLoad = (u) => new Promise((resolve, reject) => loader.load(u, resolve, undefined, reject));
  const alt = packCdnUrl(url);
  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const wait = cooldownUntil - now();
    if (wait > 0) await sleep(wait);
    try {
      return await tryLoad(url);
    } catch (e) {
      lastError = e;
      if (alt && attempt === 1) {
        try {
          return await tryLoad(alt);
        } catch (cdnErr) {
          lastError = cdnErr;
        }
      }
      if (attempt === ATTEMPTS) break;
      packFetchStats.retries++;
      await sleep(BASE_MS * 2 ** (attempt - 1) * (0.5 + Math.random()));
    }
  }
  packFetchStats.failures++;
  throw lastError || new Error(`loadWithRetry: ${url} failed`);
}
