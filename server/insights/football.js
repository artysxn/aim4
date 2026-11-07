// ---------------------------------------------------------------------------
// server/insights/football.js
// Lower-tier football: watch the money on Polymarket's small leagues, score
// each big buy for how suspicious it looks, and paper-copy the strong ones.
// Separate from the esports engine on purpose: a football match is three
// Yes/No markets (team A wins / draw / team B wins), not one two-team market.
//
// Suspicion (0-100) per wallet and outcome, buys within 30 minutes summed:
//   size        up to 35   ($200 ~ 9, $1k ~ 20, $10k+ 35)
//   share       up to 25   the buy against everything traded on the match so far
//                          (a $500 buy into a $300 market is the loudest tell)
//   wallet      up to 25   brand new, or almost no trading history
//   underdog    up to 15   buying an outcome priced at 30% or less
//   timing      up to 10   the last 3 hours before kickoff, or in play
// ---------------------------------------------------------------------------

import { col, touch, logLine } from './store.js';
import * as pm from './polymarket.js';

const MIN = 60e3;
const HOUR = 3600e3;

/** Polymarket series ids of lower-tier and smaller football leagues (gamma /sports). */
export const FOOTBALL_SERIES = {
  'England League One': 11435, 'England League Two': 11436, 'Germany 3. Liga': 12891, 'Spain Primera RFEF': 12890,
  'Spain Segunda': 10672, 'France Ligue 2': 10675, 'Portugal Liga 2': 12895, 'Netherlands Eerste Divisie': 12353,
  'Japan J3': 12894, 'Korea K League 2': 11879, 'Norway OBOS-ligaen': 11871, 'Sweden Superettan': 11872,
  'Finland Veikkausliiga': 11864, 'Iceland': 11865, 'Ireland': 11866, 'Denmark': 10363, 'Faroe Islands': 11878,
  'Estonia': 11873, 'Latvia': 11874, 'Lithuania': 11875, 'Belarus': 11876, 'Georgia': 11877, 'Kazakhstan': 11867,
  'Uzbekistan': 11868, 'Bulgaria': 11643, 'Slovenia': 11641, 'Croatia': 11451, 'Hungary': 11640, 'Austria': 11636,
  'Switzerland': 12319, 'Poland': 12320, 'Czechia': 12325, 'Greece': 12356, 'Israel': 11638,
  'UAE': 12354, 'Qatar': 12355, 'South Africa': 12360, // Turkey's Süper Lig left out: top-flight money (Galatasaray) drowns the signal
 'Guatemala': 11438, 'Paraguay': 12361, 'Uruguay': 11862,
  'Ecuador': 11863, 'Colombia Primera B': 11881, 'Chile Primera B': 11880, 'Brazil Serie C': 11869, 'Mexico Liga de Expansion': 12889,
  'USL Championship': 12318, "England WSL 2": 12875
};

// maxFlagPrice: money on a strong favourite tells nothing (2026-11-07: $74k in play on Galatasaray scored 70).
const DEFAULTS = { on: true, minScore: 55, minCash: 100, maxFlagPrice: 0.65, copy: true, copyMinScore: 65, maxPrice: 0.6, stake: 20, paperBankroll: 1000 };

export const fb = () => col('football');
export const fbSettings = () => ({ ...DEFAULTS, ...(fb().settings || {}) });
export function setFootballSettings(patch) {
  const s = fb();
  const next = { ...(s.settings || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    next[k] = typeof DEFAULTS[k] === 'boolean' ? v === true || v === 'true' || v === 1 : Number(v);
    if (typeof DEFAULTS[k] === 'number' && !Number.isFinite(next[k])) delete next[k];
  }
  s.settings = next;
  touch('football');
  return fbSettings();
}

const run = { seen: new Set(), timers: [], started: false, lastDiscover: 0, lastWatch: 0, lastError: '' };
const listeners = new Set();
/** Telegram and others: called with { type: 'flag'|'bet'|'result', ... }. */
export const onFootball = (fn) => listeners.add(fn);
const emit = (e) => {
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      /* a listener never breaks the scan */
    }
  }
};

const parseArr = (v) => {
  if (Array.isArray(v)) return v;
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

/** A gamma event into { teams, markets: A / draw / B }, or null when it is not a match. */
export function normalizeFootball(e, league) {
  const ml = (e?.markets || []).filter((m) => m.sportsMarketType === 'moneyline');
  if (ml.length !== 3) return null;
  const teams = Array.isArray(e.teams) && e.teams.length >= 2 ? [e.teams[0].name, e.teams[1].name] : String(e.title || '').split(/\s+vs\.?\s+/i);
  if (teams.length < 2) return null;
  const markets = ml.map((m) => {
    const label = String(m.groupItemTitle || '');
    const kind = /^draw/i.test(label) ? 'draw' : label === teams[0] || String(m.question).includes(`Will ${teams[0]} win`) ? 'A' : 'B';
    const [yes, no] = parseArr(m.clobTokenIds).map(String);
    const prices = parseArr(m.outcomePrices).map(Number);
    return { kind, label: kind === 'draw' ? 'Draw' : kind === 'A' ? teams[0] : teams[1], conditionId: String(m.conditionId), yes, no, price: Number.isFinite(prices[0]) ? prices[0] : null, bid: Number(m.bestBid) || null, ask: Number(m.bestAsk) || null, closed: Boolean(m.closed), fee: Number(m.feeSchedule?.rate) || 0, volume: Number(m.volume) || 0 };
  });
  if (new Set(markets.map((m) => m.kind)).size !== 3) return null;
  return { id: String(e.id), title: String(e.title || teams.join(' vs ')), league, start: Date.parse(e.startTime || e.startDate || '') || 0, teams: [String(teams[0]).trim(), String(teams[1]).trim()], markets };
}

/** The settled outcome ('A' | 'draw' | 'B') once every market is closed and one Yes paid 1. */
export function winnerOf(ev) {
  if (!ev.markets.every((m) => m.closed)) return null;
  const w = ev.markets.find((m) => m.price !== null && m.price >= 0.99);
  return w ? w.kind : null;
}

// ---- discovery ----------------------------------------------------------------------

async function discover() {
  const s = fb();
  s.events ||= {};
  const since = new Date(Date.now() - 6 * HOUR).toISOString();
  for (const [league, id] of Object.entries(FOOTBALL_SERIES)) {
    let rows = [];
    try {
      rows = await pm.listEvents({ series_id: id, active: true, closed: false, end_date_min: since, limit: 200 });
    } catch (err) {
      run.lastError = `discover ${league}: ${err.message}`;
      continue;
    }
    for (const raw of Array.isArray(rows) ? rows : []) {
      const ev = normalizeFootball(raw, league);
      if (!ev || !ev.start || ev.start > Date.now() + 48 * HOUR) continue;
      s.events[ev.id] = { ...(s.events[ev.id] || {}), ...ev, refreshedAt: Date.now() };
    }
  }
  // Past kickoff and not settled: read again until all three markets close.
  for (const ev of Object.values(s.events)) {
    if (ev.settledAt || Date.now() < ev.start + 100 * MIN) continue;
    if (ev.checkedAt && Date.now() - ev.checkedAt < 10 * MIN) continue;
    ev.checkedAt = Date.now();
    try {
      const raw = await pm.getEvent(ev.id);
      const next = normalizeFootball(raw, ev.league);
      if (next) Object.assign(ev, { markets: next.markets });
      const w = winnerOf(ev);
      if (w) settle(ev, w);
      else if (Date.now() > ev.start + 3 * 86400e3) ev.settledAt = Date.now(); // void or never resolved
    } catch (err) {
      if (err.status === 404) ev.settledAt = Date.now();
    }
  }
  // Keep a week of history.
  for (const [id, ev] of Object.entries(s.events)) if (ev.start < Date.now() - 7 * 86400e3) delete s.events[id];
  run.lastDiscover = Date.now();
  touch('football');
}

// ---- trades and scoring -------------------------------------------------------------

const hot = (ev, now = Date.now()) => !ev.settledAt && ev.start - now <= 6 * HOUR && now - ev.start <= 150 * MIN;

async function walletOf(addr) {
  const s = fb();
  s.wallets ||= {};
  const key = String(addr || '').toLowerCase();
  let w = s.wallets[key];
  if (w && Date.now() - w.at < 6 * HOUR) return w;
  w = { at: Date.now(), joinedAt: 0, trades: null };
  try {
    const d = (await pm.userStats(key))?.data || {};
    w.joinedAt = d.join_date ? d.join_date * 1000 : 0;
    w.trades = Number.isFinite(d.trades) ? d.trades : null;
  } catch {
    /* unknown: no wallet points */
  }
  s.wallets[key] = w;
  return w;
}

/** Points for one wallet's buys of one outcome. Pure, so it can be tested. */
export function scoreBuy({ cash, priorVolume, price, wallet, start, at }) {
  const reasons = [];
  const add = (label, pts) => pts > 0 && reasons.push({ label, pts: Math.round(pts) });
  add(`$${Math.round(cash)} bet`, Math.max(0, Math.min(35, 15 * Math.log10(cash / 50))));
  const share = cash / Math.max(50, priorVolume);
  add(`${Math.round(share * 100)}% of all money on the match`, share >= 1 ? 25 : share >= 0.5 ? 20 : share >= 0.25 ? 12 : share >= 0.1 ? 6 : 0);
  const ageDays = wallet?.joinedAt ? (at - wallet.joinedAt) / 86400e3 : null;
  if (ageDays !== null && ageDays < 7) add('wallet under a week old', 15);
  else if (ageDays !== null && ageDays < 30) add('wallet under a month old', 8);
  if (wallet?.trades !== null && wallet?.trades !== undefined && wallet.trades < 10) add(`only ${wallet.trades} trades ever`, 10);
  else if (wallet?.trades !== null && wallet?.trades !== undefined && wallet.trades < 30) add(`${wallet.trades} trades ever`, 5);
  add(`buying at ${Math.round(price * 100)}%`, price <= 0.2 ? 15 : price <= 0.3 ? 10 : 0);
  const toKick = start - at;
  add(at >= start ? 'in play' : 'last 3 hours before kickoff', at >= start ? 10 : toKick <= 3 * HOUR ? 8 : 0);
  return { score: Math.min(100, reasons.reduce((s, r) => s + r.pts, 0)), reasons, share };
}

async function watch() {
  const s = fb();
  const set = fbSettings();
  const evs = Object.values(s.events || {}).filter((ev) => hot(ev));
  const byCond = new Map();
  for (const ev of evs) for (const m of ev.markets) byCond.set(m.conditionId, { ev, m });
  const conds = [...byCond.keys()];
  for (let i = 0; i < conds.length; i += 15) {
    const batch = conds.slice(i, i + 15);
    let rows = [];
    try {
      const body = await pm.listTrades({ condition: batch.join(','), filter_type: 'CASH', filter_amount: Math.max(5, set.minCash / 4), limit: 500 });
      rows = Array.isArray(body?.data) ? body.data.slice().reverse() : [];
    } catch (err) {
      run.lastError = `watch: ${err.message}`;
      continue;
    }
    for (const t of rows) {
      const key = `${t.transaction_hash}|${t.proxy_wallet}|${t.token_id}|${t.side}|${t.size}`;
      if (run.seen.has(key)) continue;
      run.seen.add(key);
      const hit = byCond.get(String(t.condition_id));
      if (hit) await handleTrade(t, hit.ev, hit.m, set);
    }
  }
  if (run.seen.size > 200000) run.seen = new Set([...run.seen].slice(-50000));
  run.lastWatch = Date.now();
  touch('football');
}

async function handleTrade(t, ev, m, set) {
  const at = (Number(t.timestamp) || 0) * 1000;
  const price = Number(t.price) || 0;
  const cash = price * (Number(t.size) || 0);
  ev.volume = (ev.volume || 0) + cash;
  // Only buys of Yes back a specific outcome; a Yes price moves the market price too.
  if (String(t.token_id) === m.yes) m.price = price;
  if (String(t.side).toUpperCase() !== 'BUY' || String(t.token_id) !== m.yes) return;
  // Same wallet, same outcome, within 30 minutes: one stacked buy.
  const flags = (fb().flags ||= []);
  const wkey = String(t.proxy_wallet).toLowerCase();
  let f = flags.find((x) => x.eventId === ev.id && x.wallet === wkey && x.kind === m.kind && at - x.lastAt < 30 * MIN);
  // Money on the match before this wallet's stack: Polymarket's own volume, or what we saw.
  const listed = ev.markets.reduce((s2, x) => s2 + (x.volume || 0), 0);
  const priorVolume = Math.max(0, Math.max(listed, ev.volume || 0) - cash - (f ? f.cash : 0));
  if (!f && cash < set.minCash / 4) return;
  const wallet = await walletOf(wkey);
  if (!f) {
    f = { id: `ff_${ev.id}_${wkey.slice(2, 10)}_${m.kind}_${at}`, eventId: ev.id, wallet: wkey, name: String(t.name || t.pseudonym || '').slice(0, 40), kind: m.kind, label: m.label, at, lastAt: at, cash: 0, shares: 0, fills: 0, score: 0, reasons: [], alerted: 0, copied: null };
    flags.push(f);
    if (flags.length > 4000) flags.splice(0, flags.length - 3000);
  }
  f.cash += cash;
  f.shares += Number(t.size) || 0;
  f.fills++;
  f.lastAt = at;
  f.avgPrice = f.shares ? f.cash / f.shares : price;
  const sc = scoreBuy({ cash: f.cash, priorVolume, price: f.avgPrice, wallet, start: ev.start, at });
  f.score = sc.score;
  f.reasons = sc.reasons;
  f.share = sc.share;
  if (f.avgPrice > set.maxFlagPrice) return; // tracked, never flagged or copied
  if (f.cash >= set.minCash && f.score >= set.minScore && f.score >= (f.alerted || 0) + 10) {
    f.alerted = f.score;
    emit({ type: 'flag', flag: f, ev });
  }
  if (set.copy && !f.copied && f.cash >= set.minCash && f.score >= set.copyMinScore && !ev.settledAt) await copy(f, ev, m, set);
}

// ---- paper copy ----------------------------------------------------------------------

export function footballPaper() {
  const bets = col('bets').filter((b) => b.botId === 'football-sus');
  const settled = bets.filter((b) => ['won', 'lost', 'void'].includes(b.status));
  const realized = settled.reduce((s, b) => s + (b.payout || 0) - (b.cost || 0), 0);
  const open = bets.filter((b) => b.status === 'open');
  return { bets: bets.length, open: open.length, won: settled.filter((b) => b.status === 'won').length, lost: settled.filter((b) => b.status === 'lost').length, realized, staked: settled.reduce((s, b) => s + (b.cost || 0), 0), equity: fbSettings().paperBankroll + realized - open.reduce((s, b) => s + (b.cost || 0), 0) };
}

async function copy(f, ev, m, set) {
  if (col('bets').some((b) => b.botId === 'football-sus' && b.eventId === ev.id)) return; // one bet per match
  let ask = m.ask;
  try {
    const book = await pm.orderBook(m.yes);
    const asks = (book?.asks || []).map((l) => Number(l.price)).filter((p) => p > 0).sort((a, b) => a - b);
    if (asks.length) ask = asks[0];
  } catch {
    /* fall back to the listed ask */
  }
  if (!ask || ask > set.maxPrice) return;
  const shares = set.stake / ask;
  const fee = pm.takerFee(m.fee, ask, shares);
  const bet = { id: `fb_${f.id}`, mode: 'sim', botId: 'football-sus', strategy: 'football', status: 'open', eventId: ev.id, title: `${ev.title} · ${ev.league}`, conditionId: m.conditionId, tokenId: m.yes, outcome: m.label, kind: m.kind, market: 'match', marketLabel: 'Match', placedAt: Date.now(), shares, price: ask, fee, cost: set.stake + fee, mark: ask, amount: set.stake, sourceWallet: f.wallet, whalePrice: f.avgPrice, score: f.score, live: Date.now() >= ev.start };
  col('bets').push(bet);
  touch('bets');
  f.copied = bet.id;
  emit({ type: 'bet', bet, flag: f, ev });
}

function settle(ev, winner) {
  ev.winner = winner;
  ev.settledAt = Date.now();
  for (const f of fb().flags || []) if (f.eventId === ev.id) f.result = f.kind === winner ? 'won' : 'lost';
  for (const b of col('bets')) {
    if (b.botId !== 'football-sus' || b.eventId !== ev.id || b.status !== 'open') continue;
    b.status = b.kind === winner ? 'won' : 'lost';
    b.payout = b.status === 'won' ? b.shares : 0;
    b.mark = b.status === 'won' ? 1 : 0;
    b.settledAt = Date.now();
    emit({ type: 'result', bet: b, ev });
  }
  touch('bets');
  logLine('info', `Football settled: ${ev.title} -> ${winner === 'draw' ? 'draw' : ev.teams[winner === 'A' ? 0 : 1]}`);
}

// ---- lifecycle and views ----------------------------------------------------------------

function loop(fn, every) {
  const go = async () => {
    if (fbSettings().on) await fn().catch((err) => (run.lastError = err.message));
    run.timers.push(setTimeout(go, typeof every === 'function' ? every() : every));
    if (run.timers.length > 20) run.timers.splice(0, 10);
  };
  run.timers.push(setTimeout(go, 5000));
}

export function startFootball() {
  if (run.started) return;
  run.started = true;
  loop(discover, 10 * MIN);
  loop(watch, () => (Object.values(fb().events || {}).some((ev) => !ev.settledAt && Date.now() >= ev.start && Date.now() - ev.start < 150 * MIN) ? 20e3 : 60e3));
  logLine('info', 'Football scanner started');
}

/** Suspicious football matches, strongest first: one row per match and backed outcome. */
export function footballSuspicious({ minScore = fbSettings().minScore, hours = 48 } = {}) {
  const evs = fb().events || {};
  const rows = new Map();
  for (const f of fb().flags || []) {
    const ev = evs[f.eventId];
    if (!ev || f.score < minScore || f.cash < fbSettings().minCash || f.avgPrice > fbSettings().maxFlagPrice || Date.now() - f.lastAt > hours * HOUR) continue;
    const k = `${ev.id}|${f.kind}`;
    const r = rows.get(k) || { ev, kind: f.kind, label: f.label, score: 0, cash: 0, wallets: 0, reasons: [], result: f.result || null };
    r.score = Math.max(r.score, f.score);
    r.cash += f.cash;
    r.wallets++;
    if (f.score >= r.score) r.reasons = f.reasons;
    rows.set(k, r);
  }
  return [...rows.values()].sort((a, b) => b.score - a.score);
}

export function footballStatus() {
  const evs = Object.values(fb().events || {});
  return { on: fbSettings().on, events: evs.length, hot: evs.filter((ev) => hot(ev)).length, flags: (fb().flags || []).length, lastDiscover: run.lastDiscover, lastWatch: run.lastWatch, lastError: run.lastError };
}

export { discover as _discover, watch as _watch, handleTrade as _handleTrade, settle as _settle };
