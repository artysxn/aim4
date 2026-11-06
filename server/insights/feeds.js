// ---------------------------------------------------------------------------
// server/insights/feeds.js
// Polymarket's two live feeds, held as current state.
//
//   market  wss://ws-subscriptions-clob.polymarket.com/ws/market
//           order books (snapshot + level deltas), trades, best bid/ask
//   sports  wss://sports-api.polymarket.com/ws
//           live scores for every running match ("rounds|maps|BoN"), keyed by
//           the gamma event's gameId
//
// Kept per token: the book (price -> size both sides), the trade tape (30 min)
// and a mid-price ring (one point per 5 s, 6 h). Kept per event: the score.
// Everything that arrives is also handed to the recorder (recorder.js), and
// listeners get 'book', 'trade' and 'score' callbacks to react in under a
// second instead of on the next poll.
// ---------------------------------------------------------------------------

import WebSocket from 'ws';

const MARKET_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const SPORTS_URL = 'wss://sports-api.polymarket.com/ws';
const TAPE_MS = 30 * 60e3;
const MID_EVERY_MS = 5000;
const MID_KEEP = 6 * 720; // 6 h at 5 s

/** @type {Map<string, any>} token -> live book state */
export const books = new Map();
/** @type {Map<string, {eventId:string, conditionId:string, outcomeIndex:number, kind:string, other:string}>} */
export const tokenInfo = new Map();
/** @type {Map<string, {score:string, period:string, live:boolean, ended:boolean, at:number, history:Array}>} eventId -> score */
export const scores = new Map();
/** gameId -> eventId */
const gameToEvent = new Map();

const listeners = { book: new Set(), trade: new Set(), score: new Set(), raw: new Set() };
export function on(kind, fn) {
  listeners[kind].add(fn);
  return () => listeners[kind].delete(fn);
}
function emit(kind, ...args) {
  for (const fn of listeners[kind]) {
    try {
      fn(...args);
    } catch (err) {
      status.lastError = `${kind} listener: ${err.message}`;
    }
  }
}

export const status = { market: 'idle', sports: 'idle', marketMsgs: 0, sportsMsgs: 0, subscribed: 0, lastError: '', connectedAt: 0, reconnects: 0 };

function bookOf(token) {
  let b = books.get(token);
  if (!b) {
    b = { bids: new Map(), asks: new Map(), bestBid: null, bestAsk: null, tick: 0.01, at: 0, last: null, tape: [], mids: [], lastMidAt: 0 };
    books.set(token, b);
  }
  return b;
}

function refreshBest(b) {
  let bid = null;
  let ask = null;
  for (const [p, s] of b.bids) if (s > 0 && (bid === null || p > bid)) bid = p;
  for (const [p, s] of b.asks) if (s > 0 && (ask === null || p < ask)) ask = p;
  b.bestBid = bid;
  b.bestAsk = ask;
}

/** Mid price, or the last trade when the spread is too wide to mean anything. */
export function midOf(token) {
  const b = books.get(token);
  if (!b) return null;
  if (b.bestBid !== null && b.bestAsk !== null && b.bestAsk - b.bestBid <= 0.1) return (b.bestBid + b.bestAsk) / 2;
  return b.last?.p ?? (b.bestBid !== null && b.bestAsk !== null ? (b.bestBid + b.bestAsk) / 2 : null);
}

function sampleMid(token, b, at) {
  if (at - b.lastMidAt < MID_EVERY_MS) return;
  const m = midOf(token);
  if (m === null) return;
  b.lastMidAt = at;
  b.mids.push([at, Math.round(m * 1000) / 1000]);
  if (b.mids.length > MID_KEEP) b.mids.splice(0, b.mids.length - MID_KEEP);
}

/** Depth on one side within `cents` of the best price, in shares and dollars. */
export function depth(token, side, cents = 0.05) {
  const b = books.get(token);
  if (!b) return { shares: 0, usd: 0 };
  const best = side === 'bid' ? b.bestBid : b.bestAsk;
  if (best === null) return { shares: 0, usd: 0 };
  let shares = 0;
  let usd = 0;
  for (const [p, s] of side === 'bid' ? b.bids : b.asks) {
    if (Math.abs(p - best) <= cents + 1e-9) {
      shares += s;
      usd += s * p;
    }
  }
  return { shares, usd };
}

/** The book as the CLOB REST shape, so polymarket.js walkAsks/walkBids work on it. */
export function bookSnapshot(token) {
  const b = books.get(token);
  if (!b || !b.at) return null;
  const lv = (m) => [...m].filter(([, s]) => s > 0).map(([p, s]) => ({ price: String(p), size: String(s) }));
  return { asks: lv(b.asks), bids: lv(b.bids), at: b.at };
}

/** Taker volume on this token in the last `ms`: buys and sells in USD. */
export function flowOf(token, ms = 5 * 60e3, now = Date.now()) {
  const b = books.get(token);
  const out = { buy: 0, sell: 0, n: 0 };
  if (!b) return out;
  for (const t of b.tape) {
    if (now - t.at > ms) continue;
    out.n++;
    if (t.side === 'BUY') out.buy += t.p * t.s;
    else out.sell += t.p * t.s;
  }
  return out;
}

// ---- market socket --------------------------------------------------------------

let market = null;
let marketPing = null;
let wanted = new Set();
let subscribed = new Set();
let backoff = 1000;
let stopped = true;

function handleMarket(raw) {
  const text = raw.toString();
  if (text === 'PONG') return;
  let msgs;
  try {
    msgs = [].concat(JSON.parse(text));
  } catch {
    return;
  }
  const now = Date.now();
  for (const m of msgs) {
    status.marketMsgs++;
    emit('raw', 'market', m, now);
    const type = m.event_type;
    if (type === 'book') {
      const b = bookOf(m.asset_id);
      b.bids = new Map((m.bids || []).map((l) => [Number(l.price), Number(l.size)]));
      b.asks = new Map((m.asks || []).map((l) => [Number(l.price), Number(l.size)]));
      if (m.tick_size) b.tick = Number(m.tick_size) || b.tick;
      if (m.last_trade_price && !b.last) b.last = { p: Number(m.last_trade_price), s: 0, side: '', at: now };
      b.at = now;
      refreshBest(b);
      sampleMid(m.asset_id, b, now);
      emit('book', m.asset_id, now);
    } else if (type === 'price_change') {
      const touched = new Set();
      for (const c of m.price_changes || []) {
        const b = bookOf(c.asset_id);
        const side = c.side === 'BUY' ? b.bids : b.asks;
        const p = Number(c.price);
        const s = Number(c.size);
        if (s > 0) side.set(p, s);
        else side.delete(p);
        b.at = now;
        touched.add(c.asset_id);
      }
      for (const token of touched) {
        const b = books.get(token);
        refreshBest(b);
        sampleMid(token, b, now);
        emit('book', token, now);
      }
    } else if (type === 'last_trade_price') {
      const b = bookOf(m.asset_id);
      const t = { p: Number(m.price), s: Number(m.size), side: m.side, at: Number(m.timestamp) || now };
      b.last = t;
      b.tape.push(t);
      while (b.tape.length && now - b.tape[0].at > TAPE_MS) b.tape.shift();
      sampleMid(m.asset_id, b, now);
      emit('trade', m.asset_id, t);
    } else if (type === 'tick_size_change') {
      bookOf(m.asset_id).tick = Number(m.new_tick_size) || 0.01;
    } else if (type === 'best_bid_ask') {
      // Books already carry this; kept for the recorder only.
    }
  }
}

function connectMarket() {
  if (stopped) return;
  status.market = 'connecting';
  market = new WebSocket(MARKET_URL);
  subscribed = new Set();
  market.on('open', () => {
    status.market = 'open';
    status.connectedAt = Date.now();
    backoff = 1000;
    const ids = [...wanted];
    // initial_dump sends a book snapshot for every asset, which seeds state.
    market.send(JSON.stringify({ assets_ids: ids, type: 'market', initial_dump: true }));
    subscribed = new Set(ids);
    status.subscribed = subscribed.size;
    marketPing = setInterval(() => market?.readyState === 1 && market.send('PING'), 9000);
  });
  market.on('message', handleMarket);
  market.on('error', (err) => {
    status.lastError = `market: ${err.message}`;
  });
  market.on('close', () => {
    clearInterval(marketPing);
    status.market = 'closed';
    market = null;
    if (stopped) return;
    status.reconnects++;
    setTimeout(connectMarket, backoff).unref?.();
    backoff = Math.min(30000, backoff * 2);
  });
}

/** Keep the market socket subscribed to exactly these tokens. */
export function setTokens(tokens) {
  wanted = new Set(tokens);
  if (!market || market.readyState !== 1) return;
  const add = [...wanted].filter((t) => !subscribed.has(t));
  const drop = [...subscribed].filter((t) => !wanted.has(t));
  if (add.length) market.send(JSON.stringify({ operation: 'subscribe', assets_ids: add }));
  if (drop.length) market.send(JSON.stringify({ operation: 'unsubscribe', assets_ids: drop }));
  for (const t of add) subscribed.add(t);
  for (const t of drop) {
    subscribed.delete(t);
    books.delete(t);
  }
  status.subscribed = subscribed.size;
}

// ---- sports socket ----------------------------------------------------------------

let sports = null;
let sportsBackoff = 1000;

function connectSports() {
  if (stopped) return;
  status.sports = 'connecting';
  sports = new WebSocket(SPORTS_URL);
  sports.on('open', () => {
    status.sports = 'open';
    sportsBackoff = 1000;
  });
  sports.on('message', (raw) => {
    const text = raw.toString();
    if (text === 'ping') {
      sports.send('pong');
      return;
    }
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    status.sportsMsgs++;
    if (m.leagueAbbreviation && m.leagueAbbreviation !== 'cs2') return;
    const eventId = gameToEvent.get(String(m.gameId));
    emit('raw', 'sports', m, Date.now());
    if (!eventId) return;
    const prev = scores.get(eventId);
    const next = { score: String(m.score || ''), period: String(m.period || ''), live: Boolean(m.live), ended: Boolean(m.ended), at: Date.now(), history: prev?.history || [] };
    if (!prev || prev.score !== next.score || prev.live !== next.live || prev.ended !== next.ended) {
      next.history.push([next.at, next.score]);
      if (next.history.length > 400) next.history.shift();
      scores.set(eventId, next);
      emit('score', eventId, prev || null, next);
    } else {
      prev.at = next.at;
    }
  });
  sports.on('error', (err) => {
    status.lastError = `sports: ${err.message}`;
  });
  sports.on('close', () => {
    status.sports = 'closed';
    sports = null;
    if (stopped) return;
    setTimeout(connectSports, sportsBackoff).unref?.();
    sportsBackoff = Math.min(30000, sportsBackoff * 2);
  });
}

/**
 * Tell the feeds which events and tokens matter. Called by the engine after
 * each discovery with the tracked, hot events.
 */
export function track(events) {
  const tokens = [];
  for (const ev of events) {
    if (ev.gameId) gameToEvent.set(String(ev.gameId), ev.id);
    for (const m of ev.markets) {
      if (m.closed) continue;
      m.tokens.forEach((t, i) => {
        tokenInfo.set(t, { eventId: ev.id, conditionId: m.conditionId, outcomeIndex: i, kind: m.kind, other: m.tokens[1 - i] });
        tokens.push(t);
      });
    }
  }
  setTokens(tokens);
}

export function startFeeds() {
  if (!stopped) return;
  stopped = false;
  connectMarket();
  connectSports();
}

export function stopFeeds() {
  stopped = true;
  try {
    market?.close();
  } catch {
    /* closing */
  }
  try {
    sports?.close();
  } catch {
    /* closing */
  }
}

/** Test helper: feed one raw market message through the parser. */
export function _ingestMarket(obj) {
  handleMarket(Buffer.from(JSON.stringify(obj)));
}
