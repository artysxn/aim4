// ---------------------------------------------------------------------------
// server/insights/vision.js
// Vision: paper trading on Polymarket's 5- and 15-minute crypto Up/Down
// markets, around the clock, for every enabled bot of type 'vision'.
//
// The pricing model and the entry rules are the backtested ones from
// polymarket-updown (copied into updown-core.cjs). This module only supplies
// the live inputs (order books, the Chainlink price and its 60 s average) and
// writes fills into the same bets collection the other bots use, so wallets,
// P&L and the bets table work unchanged.
//
// Backtest, 72 h of BTC, 2026-11-06..09: the 15m favourite rule (buy the side
// priced 65-95c between 270 s and 60 s before the end) returned +6.2% on
// stake, 95% interval -0.4% to +12.4%. Unproven: Vision V1 is seeded on paper.
//
// Real money works like the other bots: the owner moves the bot to real, arms
// real trading, and the order goes into the intents queue that the Mac
// executor (insights-bot) places as a market order. Real mode only buys the
// favourite: no two-leg arbitrage (one leg can fill without the other) and no
// model-edge trading or sales; a lock is a second buy.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { col, touch, logLine } from './store.js';
import { activeBots, autoStake } from './bots.js';
import { walletFor, realBlocker } from './brain.js';

const C = createRequire(import.meta.url)('./updown-core.cjs');

const GAMMA = 'https://gamma-api.polymarket.com';
const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const CLOB_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const LEN = { '5m': 300, '15m': 900 };
const TW_SHIFT = 3; // the 60 s average stamped T covers Chainlink ticks in (T-63, T-3]
const SLIP = 0.02; // a taker order is skipped when the book is more than this past the quote

const state = {
  started: false,
  settings: () => ({}),
  queueIntent: null,
  markets: new Map(), // `${asset}-${tf}` -> current market
  pending: new Map(), // slug -> { slug, conditionId, tokens, nextCheck, tries }
  assets: new Map(), // asset -> { cl: Map, tw: Map, vol, last, lastAt, warm }
  rtds: null,
  rtdsAssets: '',
  stats: { fills: 0, settled: 0, errors: 0 }
};

const now = () => Date.now() / 1000;
const newId = () => `b${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ---- Chainlink price and 60 s average (Polymarket's live data socket) ---------------------

function assetState(a) {
  if (!state.assets.has(a)) {
    const v = C.DEFAULTS.model.vol;
    state.assets.set(a, { cl: new Map(), tw: new Map(), vol: new C.Vol(v.hl, v.w), last: null, lastSec: 0, lastAt: 0, volSec: 0, warm: 0 });
  }
  return state.assets.get(a);
}
function prune(m, keep = 1800) {
  if (m.size <= keep + 200) return;
  let n = m.size - keep;
  for (const k of m.keys()) {
    m.delete(k);
    if (--n <= 0) break;
  }
}

function connectRtds(assets) {
  const key = [...assets].sort().join(',');
  if (state.rtds && state.rtdsAssets === key && state.rtds.readyState <= 1) return;
  if (state.rtds) {
    state.rtds.removeAllListeners();
    state.rtds.terminate();
  }
  state.rtdsAssets = key;
  if (!assets.size) return (state.rtds = null);
  const ws = new WebSocket(RTDS_URL);
  state.rtds = ws;
  ws.on('open', () => {
    const subs = [];
    for (const a of assets) {
      const f = JSON.stringify({ symbol: `${a}/usd` });
      subs.push({ topic: 'crypto_prices_chainlink', type: '*', filters: f }, { topic: 'crypto_prices_twap_sixty', type: 'update', filters: f });
    }
    ws.send(JSON.stringify({ action: 'subscribe', subscriptions: subs }));
  });
  ws.on('message', (buf) => {
    const s = buf.toString();
    if (s[0] !== '{') return;
    let j;
    try {
      j = JSON.parse(s);
    } catch {
      return;
    }
    const p = j.payload;
    if (!p || !p.symbol) return;
    const a = String(p.symbol).split('/')[0].toLowerCase();
    const st = assetState(a);
    const map = j.topic === 'crypto_prices_twap_sixty' ? st.tw : j.topic === 'crypto_prices_chainlink' ? st.cl : null;
    if (!map) return;
    const put = (ts, v) => {
      const sec = Math.round(ts / 1000);
      const x = Number(v);
      if (!(x > 0)) return;
      map.set(sec, x);
      if (map === st.cl && sec >= st.lastSec) Object.assign(st, { last: x, lastSec: sec, lastAt: Date.now() });
    };
    if (Array.isArray(p.data)) for (const d of p.data) put(d.timestamp, d.value);
    else if (p.timestamp && p.value != null) put(p.timestamp, p.value);
    prune(map);
  });
  ws.on('close', () => {
    if (state.rtds === ws) setTimeout(() => state.rtds === ws && connectRtds(assets), 3000).unref?.();
  });
  ws.on('error', () => ws.terminate());
}

// one tick per second into the volatility estimate
function feedVol(st) {
  if (!st.lastSec) return;
  if (!st.volSec) st.volSec = st.lastSec - 1;
  let guard = 0;
  while (st.volSec < st.lastSec && guard++ < 600) {
    st.volSec++;
    const v = st.cl.get(st.volSec);
    if (v != null) st.volLast = v;
    if (st.volLast) {
      st.vol.push(st.volLast);
      st.warm++;
    }
  }
}

// ---- markets and order books ------------------------------------------------------------

async function openMarket(asset, tf, start) {
  const len = LEN[tf];
  const slug = `${asset}-updown-${tf}-${start}`;
  const m = { slug, asset, tf, start, end: start + len, len, ready: false, book: [{ bids: new Map(), asks: new Map() }, { bids: new Map(), asks: new Map() }], bookAt: 0, byBot: new Map(), K: null, feeRate: 0.07, twapL: 60 };
  try {
    const ev = (await getJson(`${GAMMA}/events?slug=${slug}`))[0];
    const mk = ev?.markets?.[0];
    if (!mk) throw new Error('not listed');
    m.title = mk.question || ev.title || slug;
    m.eventId = String(ev.id || slug);
    m.tokens = JSON.parse(mk.clobTokenIds);
    m.conditionId = mk.conditionId;
    if (mk.feeSchedule?.rate != null) m.feeRate = mk.feeSchedule.rate;
    else if (mk.feesEnabled === false) m.feeRate = 0;
    const cc = mk.cryptoMarketConfig;
    m.twapL = cc && cc.twapEnabled === false ? 0 : cc?.twapLookbackSeconds || 60;
    if (ev.eventMetadata?.priceToBeat) m.K = ev.eventMetadata.priceToBeat;
    m.ready = true;
    connectBook(m);
  } catch (err) {
    m.error = err.message;
    m.retryAt = Date.now() + 15000;
  }
  return m;
}

function connectBook(m) {
  const ws = new WebSocket(CLOB_URL);
  m.ws = ws;
  const sideOf = (id) => (id === m.tokens[0] ? 0 : id === m.tokens[1] ? 1 : -1);
  const one = (e) => {
    if (e.event_type === 'book') {
      const i = sideOf(e.asset_id);
      if (i < 0) return;
      const b = m.book[i];
      b.bids.clear();
      b.asks.clear();
      for (const l of e.bids || []) b.bids.set(+l.price, +l.size);
      for (const l of e.asks || []) b.asks.set(+l.price, +l.size);
      m.bookAt = Date.now();
    } else if (e.event_type === 'price_change') {
      for (const c of e.price_changes || []) {
        const i = sideOf(c.asset_id);
        if (i < 0) continue;
        const mp = c.side === 'BUY' ? m.book[i].bids : m.book[i].asks;
        if (+c.size > 0) mp.set(+c.price, +c.size);
        else mp.delete(+c.price);
      }
      m.bookAt = Date.now();
    }
  };
  ws.on('open', () => ws.send(JSON.stringify({ assets_ids: m.tokens, type: 'market' })));
  ws.on('message', (buf) => {
    const s = buf.toString();
    if (s[0] !== '{' && s[0] !== '[') return;
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) j.forEach(one);
      else one(j);
    } catch {
      /* ignore */
    }
  });
  ws.on('close', () => {
    if (m.ws === ws && !m.closed) setTimeout(() => m.ws === ws && !m.closed && connectBook(m), 2000).unref?.();
  });
  ws.on('error', () => ws.terminate());
}
function closeMarket(m) {
  m.closed = true;
  if (m.ws) {
    m.ws.removeAllListeners();
    m.ws.terminate();
  }
}

const bestOf = (mp, bid) => {
  let b = null;
  for (const [p, s] of mp) if (s > 0 && (b === null || (bid ? p > b : p < b))) b = p;
  return b;
};
function quotes(m) {
  const [u, d] = m.book;
  const q = { bidUp: bestOf(u.bids, true), askUp: bestOf(u.asks, false), bidDn: bestOf(d.bids, true), askDn: bestOf(d.asks, false) };
  q.askUpSize = q.askUp != null ? u.asks.get(q.askUp) : null;
  q.askDnSize = q.askDn != null ? d.asks.get(q.askDn) : null;
  return q;
}
// average and worst price for taking `shares` from one side of a book; null when too thin
function walk(m, idx, action, shares) {
  const mp = action === 'BUY' ? m.book[idx].asks : m.book[idx].bids;
  const lv = [...mp.entries()].filter(([, s]) => s > 0).sort((a, b) => (action === 'BUY' ? a[0] - b[0] : b[0] - a[0]));
  let need = shares;
  let cost = 0;
  let worst = null;
  for (const [p, s] of lv) {
    const take = Math.min(need, s);
    cost += take * p;
    need -= take;
    worst = p;
    if (need <= 1e-9) break;
  }
  return need > 1e-9 ? null : { avg: cost / shares, worst };
}

// ---- the model: fair chance of Up from the Chainlink price -------------------------------

// the price to beat from polymarket.com (what the market page shows), at most every 15 s per market
async function loadStrike(m) {
  if (m.strikeAt && Date.now() - m.strikeAt < 15000) return;
  m.strikeAt = Date.now();
  const iso = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
  const variant = m.tf === "5m" ? "fiveminute" : "fifteen";
  try {
    const j = await getJson(`https://polymarket.com/api/crypto/crypto-price?symbol=${m.asset.toUpperCase()}&eventStartTime=${iso(m.start)}&variant=${variant}&endDate=${iso(m.end)}&twapEnabled=${m.twapL > 0}&twapLookbackSeconds=${m.twapL || 60}`);
    if (j && j.openPrice > 0 && !m.K) m.K = j.openPrice;
  } catch {
    /* next try in 15 s */
  }
}

function fair(m) {
  const st = state.assets.get(m.asset);
  if (!st || !st.last || Date.now() - st.lastAt > 10000) return null;
  if (!m.K) {
    // the price to beat is the 60 s average stamped at the start; joined late, ask Polymarket for it
    const k = m.twapL > 0 ? st.tw.get(m.start) : st.cl.get(m.start);
    if (k) m.K = k;
    else {
      loadStrike(m);
      return null;
    }
  }
  if (st.warm < 240) return null;
  const S = st.last;
  const tS = st.lastSec;
  const L = m.twapL;
  const wEnd = m.end - (L > 0 ? TW_SHIFT : 0);
  const wStart = wEnd - L;
  let tau;
  let avg = S;
  if (L === 0 || tS <= wStart) tau = Math.max(0, wEnd - tS);
  else {
    let sum = 0;
    let n = 0;
    for (let s = wStart + 1; s <= Math.min(tS, wEnd); s++) {
      const v = st.cl.get(s);
      sum += v == null ? S : v;
      n++;
    }
    avg = sum / n;
    tau = L - n;
  }
  const P = { ...C.DEFAULTS.model, ...(C.DEFAULTS.modelByTf[m.tf] || {}) };
  return C.fair(S, m.K, tau, L, avg, st.vol.sigma2(), P);
}

// ---- bots ---------------------------------------------------------------------------------

function stakeFor(bot, wallet) {
  let s;
  if (bot.sizing.kind === 'fixed') s = bot.sizing.value;
  else if (bot.sizing.kind === 'auto') s = autoStake({ bankroll: wallet.bankroll, maxStake: bot.maxStake, minStake: bot.minStake }).stake;
  else s = (wallet.bankroll * bot.sizing.value) / 100;
  return Math.floor(Math.min(bot.maxStake, Math.max(bot.minStake, s)) * 100) / 100;
}

/** Why this bot may not open anything right now, or ''. */
function blocker(bot, wallet, stake) {
  if (wallet.bankroll < 10) return 'Wallet under $10';
  if (wallet.today <= -(wallet.bankroll * bot.dailyLossPct) / 100) return 'Daily loss limit';
  if (wallet.mineCost + stake > (wallet.bankroll * bot.maxOpenPct) / 100) return 'Open bets at the limit';
  return '';
}

function record(bot, m, o, fill, f) {
  const idx = o.side === 'UP' ? 0 : 1;
  const fee = o.shares * C.feePerShare(fill.avg, m.feeRate);
  const q = quotes(m);
  const mid = idx === 0 ? (q.bidUp != null && q.askUp != null ? (q.bidUp + q.askUp) / 2 : null) : q.bidDn != null && q.askDn != null ? (q.bidDn + q.askDn) / 2 : null;
  const bet = {
    id: newId(),
    mode: 'sim',
    botId: bot.id,
    strategy: 'vision',
    variant: bot.id,
    status: 'open',
    eventId: m.slug,
    title: m.title,
    conditionId: m.conditionId,
    market: 'match',
    marketLabel: `Up or Down ${m.tf}`,
    tokenId: m.tokens[idx],
    outcome: idx === 0 ? 'Up' : 'Down',
    outcomeIndex: idx,
    placedAt: Date.now(),
    live: true,
    midAt: mid,
    shares: o.shares,
    price: fill.avg,
    fee,
    cost: o.shares * fill.avg + fee,
    mark: fill.avg,
    amount: o.shares * fill.avg + fee,
    reason: o.reason,
    secondsLeft: Math.round(m.end - now()),
    fairUp: f ? Math.round(f.p * 1000) / 1000 : null,
    slug: m.slug
  };
  col('bets').push(bet);
  touch('bets');
  state.stats.fills++;
  logLine('info', `PAPER ${bot.name}: ${m.title} ${bet.outcome} ${o.shares} @ ${(fill.avg * 100).toFixed(1)}% (${o.reason})`);
  if (!state.pending.has(m.slug)) state.pending.set(m.slug, { slug: m.slug, conditionId: m.conditionId, tokens: m.tokens, nextCheck: (m.end + 5) * 1000, tries: 0 });
}

// a sale out of the bot's open bets on one token, oldest first
function sell(bot, m, idx, shares, fill) {
  let left = shares;
  const fee = shares * C.feePerShare(fill.avg, m.feeRate);
  for (const b of col('bets')) {
    if (left <= 0) break;
    if (b.botId !== bot.id || b.status !== 'open' || b.tokenId !== m.tokens[idx]) continue;
    const take = Math.min(left, b.shares);
    const proceeds = take * fill.avg - (fee * take) / shares;
    b.exitShares = (b.exitShares || 0) + take;
    b.exitProceeds = (b.exitProceeds || 0) + proceeds;
    b.shares -= take;
    if (b.shares <= 0.01) Object.assign(b, { shares: 0, status: 'sold', payout: b.exitProceeds, settledAt: Date.now() });
    left -= take;
  }
  touch('bets');
}

// a real-money buy: queued for the Mac executor; reportIntent() fills the pending bet
function queueReal(bot, m, o, stake, f) {
  const idx = o.side === 'UP' ? 0 : 1;
  const maxPrice = Math.min(0.99, Math.round((o.limit + SLIP) * 100) / 100);
  const intent = state.queueIntent({ type: 'market', side: 'BUY', tokenId: m.tokens[idx], conditionId: m.conditionId, amount: stake, maxPrice });
  const bet = {
    id: newId(), mode: 'real', botId: bot.id, strategy: 'vision', variant: bot.id, status: 'pending', eventId: m.slug, title: m.title, conditionId: m.conditionId,
    market: 'match', marketLabel: `Up or Down ${m.tf}`, tokenId: m.tokens[idx], outcome: idx === 0 ? 'Up' : 'Down', outcomeIndex: idx, placedAt: Date.now(), live: true,
    midAt: o.limit, amount: stake, maxPrice, intentId: intent.id, reason: o.reason, secondsLeft: Math.round(m.end - now()), fairUp: f ? Math.round(f.p * 1000) / 1000 : null, slug: m.slug
  };
  col('bets').push(bet);
  touch('bets');
  state.stats.fills++;
  logLine('info', `REAL ${bot.name}: ${m.title} ${bet.outcome} $${stake.toFixed(2)} up to ${(maxPrice * 100).toFixed(0)}% (${o.reason})`);
  if (!state.pending.has(m.slug)) state.pending.set(m.slug, { slug: m.slug, conditionId: m.conditionId, tokens: m.tokens, nextCheck: (m.end + 5) * 1000, tries: 0 });
}

// The bot follows the panel's advice (Core.advise): buy the favourite in the window when the
// price model does not rate it lower (model check), then hold to the end, or lock / take profit
// at lockPct when that is set. One entry per market.
function adviceSettings(p, real) {
  return {
    fav: p.fav, favLo: p.favLo, favHi: p.favHi, favFrom: p.favFrom, favTo: p.favTo,
    edge: p.edge && !real, entryEdge: p.entryEdge,
    arb: p.arb && !real, // real money: no two-leg arbitrage (one leg can fill without the other)
    lockPct: p.lockPct, takeProfit: !real, // real money: no sales, the lock is a second buy
    favVeto: p.modelCheck ? p.favVeto : null
  };
}

function trade(bot, m, q, f) {
  const p = bot.params;
  if (!p.assets.includes(m.asset) || !p.timeframes.includes(m.tf)) return;
  const t = now();
  if (t < m.start + 2 || t >= m.end - 1 || Date.now() - m.bookAt > 5000) return;
  const bm = m.byBot.get(bot.id) || { pos: { up: 0, dn: 0, cost: 0, fees: 0 }, entered: false, orders: 0, lastTrade: 0 };
  m.byBot.set(bot.id, bm);
  if (bm.orders >= 12) return;
  const real = bot.mode === 'real';
  if (real && (!state.queueIntent || realBlocker())) return;
  const wallet = walletFor(bot);
  const stake = stakeFor(bot, wallet);
  const flat = bm.pos.up < 1 && bm.pos.dn < 1;
  if (flat && !bm.entered && blocker(bot, wallet, stake)) return;
  // with the model check on, no entry until the model has a value
  const noEntry = (flat && bm.entered) || (p.modelCheck && !f);
  const a = C.advise(q, f, bm.pos, { tau: m.end - t, len: m.len, stake, feeRate: m.feeRate, noEntry }, adviceSettings(p, real));
  if (!['arb', 'buy', 'lock', 'take'].includes(a.kind)) return;
  if (a.kind === 'buy' || a.kind === 'arb') bm.entered = true;
  m.lastAdvice = a.kind;
  for (const o of a.orders) {
    const idx = o.side === 'UP' ? 0 : 1;
    const fill = walk(m, idx, o.action, o.shares);
    if (!fill || (o.action === 'BUY' ? fill.worst > o.limit + SLIP : fill.worst < o.limit - SLIP)) break;
    if (real) {
      if (o.action !== 'BUY' || o.limit < 0.05) break;
      // the position is tracked at the expected fill so the lock logic can follow it; the bet itself
      // gets the real fill from the executor's report
      C.applyFill(bm.pos, o.side, 'BUY', o.shares, fill.avg, m.feeRate);
      queueReal(bot, m, o, Math.round(o.shares * fill.avg * 100) / 100, f);
    } else {
      C.applyFill(bm.pos, o.side, o.action, o.shares, fill.avg, m.feeRate);
      if (o.action === 'BUY') record(bot, m, o, fill, f);
      else sell(bot, m, idx, o.shares, fill);
    }
    bm.orders++;
    bm.lastTrade = Date.now();
  }
}

// ---- marks and settlement -----------------------------------------------------------------

function markOpen() {
  const byToken = new Map();
  for (const m of state.markets.values()) {
    if (!m.ready) continue;
    const q = quotes(m);
    if (q.bidUp != null && q.askUp != null) byToken.set(m.tokens[0], (q.bidUp + q.askUp) / 2);
    if (q.bidDn != null && q.askDn != null) byToken.set(m.tokens[1], (q.bidDn + q.askDn) / 2);
  }
  let changed = false;
  for (const b of col('bets')) {
    if (b.strategy !== 'vision' || b.status !== 'open') continue;
    const v = byToken.get(b.tokenId);
    if (v != null && v !== b.mark) {
      b.mark = v;
      changed = true;
    }
  }
  if (changed) touch('bets');
}

async function settlePending() {
  const t = Date.now();
  for (const p of state.pending.values()) {
    if (t < p.nextCheck) continue;
    p.tries++;
    p.nextCheck = t + Math.min(60e3, 10e3 * p.tries);
    try {
      const ev = (await getJson(`${GAMMA}/events?slug=${p.slug}`))[0];
      const mk = ev?.markets?.[0];
      if (!ev?.closed || !mk) continue;
      const px = JSON.parse(mk.outcomePrices).map(Number);
      const win = px[0] >= 0.99 ? 0 : px[1] >= 0.99 ? 1 : Math.abs(px[0] - 0.5) < 0.01 ? -1 : null;
      if (win === null) continue;
      for (const b of col('bets')) {
        if (b.strategy !== 'vision' || b.conditionId !== mk.conditionId) continue;
        if (b.status === 'pending') {
          Object.assign(b, { status: 'missed', error: 'Not filled before the market closed', settledAt: Date.now() });
          continue;
        }
        if (b.status !== 'open') continue;
        const payout = (win === -1 ? b.shares * 0.5 : win === b.outcomeIndex ? b.shares : 0) + (b.exitProceeds || 0);
        Object.assign(b, { payout, status: win === -1 ? 'void' : payout > 0 ? 'won' : 'lost', settledAt: Date.now(), mark: win === -1 ? 0.5 : win === b.outcomeIndex ? 1 : 0, finalPrice: ev.eventMetadata?.finalPrice ?? null, priceToBeat: ev.eventMetadata?.priceToBeat ?? null });
        logLine('info', `SIM ${b.status} ${b.title}: ${b.outcome} $${(payout - b.cost).toFixed(2)}`);
        state.stats.settled++;
      }
      touch('bets');
      state.pending.delete(p.slug);
    } catch (err) {
      if (p.tries > 120) {
        logLine('warn', `Vision: gave up settling ${p.slug}: ${err.message}`);
        state.pending.delete(p.slug);
      }
    }
  }
}

// ---- main loop ------------------------------------------------------------------------------

let busy = false;
async function loop() {
  if (busy) return;
  busy = true;
  try {
    const s = state.settings();
    const bots = s.tracking === false ? [] : activeBots('vision', s.botsOn !== false);
    const want = new Set();
    for (const b of bots) for (const a of b.params.assets) for (const tf of b.params.timeframes) want.add(`${a}-${tf}`);
    connectRtds(new Set([...want].map((k) => k.split('-')[0])));
    for (const st of state.assets.values()) feedVol(st);
    // close what no bot wants any more
    for (const [k, m] of state.markets) {
      if (!want.has(k)) {
        closeMarket(m);
        state.markets.delete(k);
      }
    }
    const t = now();
    for (const k of want) {
      const [a, tf] = k.split('-');
      const start = Math.floor(t / LEN[tf]) * LEN[tf];
      let m = state.markets.get(k);
      if (!m || m.start !== start || (!m.ready && Date.now() > m.retryAt)) {
        if (m) closeMarket(m);
        m = { start, ready: false, retryAt: Infinity };
        state.markets.set(k, m);
        state.markets.set(k, await openMarket(a, tf, start));
        continue;
      }
      if (!m.ready) continue;
      const q = quotes(m);
      const f = fair(m);
      m.lastFair = f ? f.p : null;
      for (const bot of bots) trade(bot, m, q, f);
    }
    markOpen();
    await settlePending();
  } catch (err) {
    state.stats.errors++;
    logLine('error', `Vision: ${err.message}`);
  } finally {
    busy = false;
  }
}

/** Start the Vision loop. `settings` is the engine's settings getter. Safe to call twice. */
export function startVision({ settings, queueIntent }) {
  if (state.started) return;
  state.started = true;
  state.settings = settings;
  state.queueIntent = queueIntent || null;
  // bets left open by a restart still get settled
  for (const b of col('bets')) {
    if (b.strategy === 'vision' && (b.status === 'open' || b.status === 'pending') && b.slug && !state.pending.has(b.slug)) state.pending.set(b.slug, { slug: b.slug, conditionId: b.conditionId, nextCheck: Date.now() + 5000, tries: 0 });
  }
  const t = setInterval(() => loop(), 1000);
  t.unref?.();
  logLine('info', 'Vision started');
}

/** What the Vision loop is watching, for the status endpoint. */
export function visionStatus() {
  const t = now();
  return {
    running: state.started,
    feed: [...state.assets].map(([a, st]) => ({ asset: a, price: st.last, ageSec: st.lastAt ? Math.round((Date.now() - st.lastAt) / 1000) : null, warm: st.warm })),
    markets: [...state.markets.values()].filter((m) => m.slug).map((m) => {
      const q = m.ready ? quotes(m) : {};
      return { slug: m.slug, title: m.title, secondsLeft: Math.round(m.end - t), ready: m.ready, error: m.error || null, askUp: q.askUp ?? null, askDown: q.askDn ?? null, fairUp: m.lastFair ?? null, priceToBeat: m.K };
    }),
    unsettled: state.pending.size,
    ...state.stats
  };
}

export const _state = state;
export { loop as _loop };
