// ---------------------------------------------------------------------------
// server/insights/polymarket.js
// Read-only Polymarket HTTP: Gamma (events), Data API v2 (trades, wallets,
// price history) and the CLOB book. No keys: all of this is public data.
//
// One queue for every request, a few in flight at a time, well under the
// published limits (Data API v2: 800 req / 10 s, /v2/trades 300 / 10 s).
// A 429 waits for its Retry-After, once, then gives up on that call.
// ---------------------------------------------------------------------------

export const GAMMA = 'https://gamma-api.polymarket.com';
export const DATA = 'https://data-api.polymarket.com';
export const CLOB = 'https://clob.polymarket.com';
export const GEOBLOCK = 'https://polymarket.com/api/geoblock';

const MAX_IN_FLIGHT = 4;
const TIMEOUT_MS = 15000;
let inFlight = 0;
const waiting = [];

/** Requests made since boot, by host, for the status line. */
export const requestStats = { total: 0, failed: 0, throttled: 0, lastError: '' };

function acquire() {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else inFlight--;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a JSON document. Throws an Error carrying `.status` on a non-2xx.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function getJson(url, opts = {}) {
  const f = opts.fetchImpl || globalThis.fetch;
  await acquire();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      requestStats.total++;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await f(url, { headers: { Accept: 'application/json', 'User-Agent': 'aim4-insights/1.0' }, signal: ctl.signal });
      } catch (err) {
        requestStats.failed++;
        requestStats.lastError = `${new URL(url).host}: ${err.name === 'AbortError' ? 'timeout' : err.message}`;
        throw err;
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 && attempt === 0) {
        requestStats.throttled++;
        const after = Number(res.headers.get('retry-after')) || 2;
        await sleep(Math.min(30, after) * 1000);
        continue;
      }
      if (!res.ok) {
        requestStats.failed++;
        const body = await res.text().catch(() => '');
        const err = new Error(`${new URL(url).host}${new URL(url).pathname} ${res.status} ${body.slice(0, 160)}`);
        err.status = res.status;
        requestStats.lastError = err.message;
        throw err;
      }
      return await res.json();
    }
    throw new Error('rate limited');
  } finally {
    release();
  }
}

function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  return q.toString();
}

// ---- Gamma ------------------------------------------------------------------

/** One page of CS2 events. */
export function listEvents(params, opts) {
  return getJson(`${GAMMA}/events?${qs(params)}`, opts);
}

export function getEvent(id, opts) {
  return getJson(`${GAMMA}/events/${encodeURIComponent(id)}`, opts);
}

// ---- Data API v2 --------------------------------------------------------------

/**
 * Trades on up to 20 conditions, newest first. `taker_only=false` so a whale's
 * resting (maker) order shows up too: with the default, a limit bid that got
 * hit appears only as the seller's SELL.
 */
export function listTrades(params, opts) {
  return getJson(`${DATA}/v2/trades?${qs({ taker_only: false, ...params })}`, opts);
}

export function userStats(user, opts) {
  return getJson(`${DATA}/v2/user-stats?${qs({ user })}`, opts);
}

export function portfolioValue(user, opts) {
  return getJson(`${DATA}/v2/value?${qs({ user })}`, opts);
}

export function priceHistory(params, opts) {
  return getJson(`${DATA}/v2/prices-history?${qs(params)}`, opts);
}

export function positions(params, opts) {
  return getJson(`${DATA}/v2/positions?${qs(params)}`, opts);
}

// ---- CLOB ---------------------------------------------------------------------

/** Order book for one outcome token. */
export function orderBook(tokenId, opts) {
  return getJson(`${CLOB}/book?${qs({ token_id: tokenId })}`, opts);
}

/**
 * What buying `cash` USD of this book would cost: the volume-weighted price
 * over the asks, cheapest first, never above `maxPrice`.
 * @returns {{ shares: number, cost: number, avg: number, filled: boolean, best: number }}
 */
export function walkAsks(book, cash, maxPrice = 1) {
  const asks = (book?.asks || [])
    .map((l) => ({ p: Number(l.price), s: Number(l.size) }))
    .filter((l) => l.p > 0 && l.s > 0)
    .sort((a, b) => a.p - b.p);
  let left = cash;
  let shares = 0;
  let cost = 0;
  for (const l of asks) {
    if (l.p > maxPrice || left <= 1e-9) break;
    const take = Math.min(l.s, left / l.p);
    shares += take;
    cost += take * l.p;
    left -= take * l.p;
  }
  return { shares, cost, avg: shares ? cost / shares : 0, filled: left <= cash * 0.02, best: asks[0]?.p || 0 };
}

/** What selling `shares` into the bids returns, never below `minPrice`. */
export function walkBids(book, shares, minPrice = 0) {
  const bids = (book?.bids || [])
    .map((l) => ({ p: Number(l.price), s: Number(l.size) }))
    .filter((l) => l.p > 0 && l.s > 0)
    .sort((a, b) => b.p - a.p);
  let left = shares;
  let got = 0;
  let sold = 0;
  for (const l of bids) {
    if (l.p < minPrice || left <= 1e-9) break;
    const take = Math.min(l.s, left);
    sold += take;
    got += take * l.p;
    left -= take;
  }
  return { sold, proceeds: got, avg: sold ? got / sold : 0, filled: left <= shares * 0.02, best: bids[0]?.p || 0 };
}

/** Polymarket's own check: is this machine's IP allowed to trade. */
export function geoblock(opts) {
  return getJson(GEOBLOCK, opts);
}

/**
 * Taker fee on a fill, the sports schedule's shape: rate x min(p, 1 - p) x shares.
 * An estimate for paper fills; real fills report what was charged.
 */
export function takerFee(rate, price, shares) {
  if (!rate) return 0;
  return rate * Math.min(price, 1 - price) * shares;
}
