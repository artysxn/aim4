// ---------------------------------------------------------------------------
// server/insights/engine.js
// The Insights loop. One instance per server, owned by the site owner.
//
//   discover   every 3 min: open CS2 events from Gamma, kept when trackDecision
//              says so (team list, VRS line, tournament keywords)
//   watch      every 5 s while a tracked match is live or close to starting,
//              20 s otherwise: new trades on its markets from the Data API,
//              each one scored (signals.js) and the unusual ones stored
//   live       every 15 s: live events re-read for prices and the scoreboard
//   settle     when a market closes: wallet records, our bets, team stats
//   copy       a qualifying signal becomes a paper bet (sim) or an order
//              intent for the linked PC executor (real)
//   backfill   on request: finished matches of the last N days, so the whale
//              table and team stats are useful before a week of watching
//
// Nothing here holds a key or places an order. Real orders are intents that
// executor.js, running on the owner's PC, picks up and places.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import * as pm from './polymarket.js';
import { CS2_TAG_ID, sanitizeSettings } from './config.js';
import { normalizeEvent, normName, parseScore, trackDecision } from './matching.js';
import { scoreTrade, teamBehind } from './signals.js';
import { betTotals, walletRecord } from './stats.js';
import { CAPS, col, logLine, touch } from './store.js';
import * as brain from './brain.js';
import { allBots } from './bots.js';
import * as feeds from './feeds.js';
import { startRecorder, setRecordFilter } from './recorder.js';
import { restoreModels, scheduleTraining, runTraining } from './learn.js';

const MIN = 60e3;
const HOUR = 3600e3;
/** A signal older than this is history, not something to copy. */
const FRESH_MS = 3 * MIN;
const STACK_MS = 15 * MIN;
const CLUSTER_MS = 30 * MIN;
const ENRICH_TTL = 6 * HOUR;
const INTENT_BUY_TTL = 45e3;
const INTENT_SELL_TTL = 120e3;
const DEVICE_ONLINE_MS = 20e3;

const run = {
  started: false,
  startedAt: 0,
  timers: [],
  busy: { discover: false, watch: false, live: false, backfill: false },
  lastDiscover: 0,
  lastWatch: 0,
  lastLive: 0,
  lastError: '',
  ranks: null,
  ranksAt: 0,
  seen: new Set(),
  /** token -> [{ wallet, at }] recent flagged entries, for clustering */
  cluster: new Map(),
  /** wallet|token -> [{ at, cash, shares }] recent buys, for stacking */
  stack: new Map(),
  openEventsSeen: 0
};

// ---- small helpers -----------------------------------------------------------

export const settings = () => col('settings');
const newId = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const tradeKey = (t) => `${t.transaction_hash}|${t.proxy_wallet}|${t.token_id}|${t.side}|${t.size}`;

function ranks() {
  if (!run.ranks || Date.now() - run.ranksAt > 6 * HOUR) {
    run.ranksAt = Date.now();
    run.ranks = null;
    // Lazy: the standings module reads markdown from disk once and caches it.
    import('../replays/teamStandingsDb.js')
      .then((m) => {
        run.ranks = m.loadGlobalRanks();
      })
      .catch((err) => logLine('warn', `VRS ranks unavailable: ${err.message}`));
  }
  return run.ranks;
}

/** Load VRS before the first discovery so the rule is not applied to an empty ladder. */
async function ensureRanks() {
  if (run.ranks) return run.ranks;
  try {
    const m = await import('../replays/teamStandingsDb.js');
    run.ranks = m.loadGlobalRanks();
    run.ranksAt = Date.now();
  } catch (err) {
    logLine('warn', `VRS ranks unavailable: ${err.message}`);
  }
  return run.ranks;
}

function outcomeIndex(market, trade) {
  const i = Number(trade.outcome_index);
  if (i === 0 || i === 1) return i;
  const t = market.tokens.indexOf(String(trade.token_id));
  return t >= 0 ? t : -1;
}

/** Event team order index of an outcome name (the score string follows event order). */
function teamIndexOf(ev, outcomeName) {
  const n = normName(outcomeName);
  const i = ev.teams.findIndex((t) => normName(t) === n);
  return i;
}

function findMarket(conditionId) {
  const events = col('events');
  for (const ev of Object.values(events)) {
    const m = ev.markets.find((x) => x.conditionId === conditionId);
    if (m) return { ev, m };
  }
  return null;
}

// ---- prices -------------------------------------------------------------------

/** Record an observed price for both outcomes of a market (p is outcome 0's price). */
function samplePrice(ev, m, p0, at = Date.now()) {
  if (!Number.isFinite(p0) || p0 <= 0 || p0 >= 1) return;
  const prices = col('prices');
  let tr = prices[m.conditionId];
  if (!tr) {
    tr = prices[m.conditionId] = { min: [p0, 1 - p0], max: [p0, 1 - p0], pre: null, last: [p0, 1 - p0], lastAt: at, series: [] };
  }
  const pair = [p0, 1 - p0];
  for (let i = 0; i < 2; i++) {
    tr.min[i] = Math.min(tr.min[i], pair[i]);
    tr.max[i] = Math.max(tr.max[i], pair[i]);
  }
  touch('prices');
  // Older observations (a first read returns the last few hundred trades)
  // count for the range only; the latest price and the series move forward.
  if (at < (tr.lastAt || 0) - 1000) return;
  tr.last = pair;
  tr.lastAt = at;
  if (ev.start && at < ev.start) tr.pre = pair;
  const prev = tr.series[tr.series.length - 1];
  if (!prev || at - prev[0] >= 60e3 || Math.abs(prev[1] - p0) >= 0.02) {
    tr.series.push([at, Math.round(p0 * 1000) / 1000]);
    if (tr.series.length > 1500) tr.series.splice(0, tr.series.length - 1500);
  }
  touch('prices');
}

// ---- wallets ------------------------------------------------------------------

function wallet(addr, trade) {
  const wallets = col('wallets');
  const key = String(addr || '').toLowerCase();
  let w = wallets[key];
  if (!w) {
    w = wallets[key] = { addr: key, name: '', pseudonym: '', joinedAt: 0, markets: null, value: null, cs2Share: null, enrichedAt: 0, follow: false, ignore: false, note: '', firstSeen: Date.now(), entries: [] };
  }
  if (trade) {
    if (trade.name) w.name = String(trade.name).slice(0, 60);
    if (trade.pseudonym) w.pseudonym = String(trade.pseudonym).slice(0, 60);
  }
  return w;
}

/** Profile age, market count, portfolio value and CS2 share. Six-hour cache. */
async function enrich(w, force = false) {
  if (!force && w.enrichedAt && Date.now() - w.enrichedAt < ENRICH_TTL) return w;
  w.enrichedAt = Date.now();
  const [stats, value, recent] = await Promise.allSettled([
    pm.userStats(w.addr),
    pm.portfolioValue(w.addr),
    pm.listTrades({ user: w.addr, limit: 200 })
  ]);
  if (stats.status === 'fulfilled' && stats.value?.data) {
    const d = stats.value.data;
    w.joinedAt = d.join_date ? d.join_date * 1000 : 0;
    w.markets = Number.isFinite(d.trades) ? d.trades : null;
    w.allTimePnl = Number(d.all_time_pnl?.realized_pnl);
    if (!Number.isFinite(w.allTimePnl)) w.allTimePnl = null;
    w.biggestWin = Number(d.biggest_win) || 0;
  }
  if (value.status === 'fulfilled' && value.value?.data) w.value = Number(value.value.data.value) || 0;
  if (recent.status === 'fulfilled' && Array.isArray(recent.value?.data)) {
    const rows = recent.value.data;
    const cs2 = rows.filter((r) => String(r.slug || r.event_slug || '').startsWith('cs2-')).length;
    w.cs2Share = rows.length ? cs2 / rows.length : null;
  }
  touch('wallets');
  return w;
}

function recordOf(w) {
  return walletRecord(w.entries);
}

// ---- events -------------------------------------------------------------------

function upsertEvent(raw, decisionOverride) {
  const ev = normalizeEvent(raw);
  if (!ev) return null;
  const s = settings();
  const d = decisionOverride || trackDecision(ev, s, ranks());
  const events = col('events');
  const prev = events[ev.id];
  if (!d.track && !prev) return null;
  const next = {
    ...(prev || {}),
    ...ev,
    track: d.track,
    reasons: d.reasons,
    vrs: d.ranks,
    listed: d.listed,
    firstSeen: prev?.firstSeen || Date.now(),
    refreshedAt: Date.now()
  };
  events[ev.id] = next;
  touch('events');
  for (const m of next.markets) {
    if (m.prices && !m.closed) samplePrice(next, m, m.prices[0]);
  }
  return next;
}

/** Tracked events the watch loop polls: live, starting within the window, or just ended. */
export function hotEvents(now = Date.now()) {
  const s = settings();
  return Object.values(col('events')).filter((ev) => {
    if (!ev.track || ev.settledAt) return false;
    if (ev.live) return true;
    if (ev.start && ev.start - now <= s.prematchHours * HOUR && now - ev.start <= 8 * HOUR) return true;
    return false;
  });
}

async function discover() {
  if (run.busy.discover) return;
  run.busy.discover = true;
  try {
    await ensureRanks();
    const since = new Date(Date.now() - 2 * 86400e3).toISOString();
    const seenIds = new Set();
    for (let page = 0; page < 6; page++) {
      const rows = await pm.listEvents({ tag_id: CS2_TAG_ID, active: true, closed: false, end_date_min: since, limit: 200, offset: page * 200 });
      if (!Array.isArray(rows) || !rows.length) break;
      for (const raw of rows) {
        seenIds.add(String(raw.id));
        upsertEvent(raw);
      }
      if (rows.length < 200) break;
    }
    run.openEventsSeen = seenIds.size;
    // Tracked events that dropped out of the open list closed: read them once
    // more for their final prices, then settle.
    const events = col('events');
    for (const ev of Object.values(events)) {
      if (!ev.track || ev.settledAt || seenIds.has(ev.id)) continue;
      if (ev.checkedClosedAt && Date.now() - ev.checkedClosedAt < 5 * MIN) continue;
      ev.checkedClosedAt = Date.now();
      try {
        const raw = await pm.getEvent(ev.id);
        upsertEvent(raw, { track: true, reasons: ev.reasons, ranks: ev.vrs, listed: ev.listed });
      } catch (err) {
        if (err.status === 404) ev.settledAt = Date.now();
      }
    }
    await settleClosed();
    markOpenBets();
    prune();
    run.lastDiscover = Date.now();
    feeds.track(hotEvents());
  } catch (err) {
    run.lastError = `discover: ${err.message}`;
    logLine('error', run.lastError);
  } finally {
    run.busy.discover = false;
  }
}

/** Live events re-read for prices and the scoreboard. */
async function refreshLive() {
  if (run.busy.live) return;
  run.busy.live = true;
  try {
    const now = Date.now();
    const live = Object.values(col('events')).filter((ev) => ev.track && !ev.settledAt && (ev.live || (ev.start && Math.abs(now - ev.start) < 30 * MIN)));
    for (const ev of live.slice(0, 20)) {
      try {
        const raw = await pm.getEvent(ev.id);
        upsertEvent(raw, { track: true, reasons: ev.reasons, ranks: ev.vrs, listed: ev.listed });
      } catch {
        /* next round */
      }
    }
    run.lastLive = Date.now();
  } finally {
    run.busy.live = false;
  }
}

/** Drop untracked leftovers and settled events older than 120 days. */
function prune() {
  const events = col('events');
  const cutoff = Date.now() - 120 * 86400e3;
  const withBets = new Set(col('bets').map((b) => b.eventId));
  for (const [id, ev] of Object.entries(events)) {
    const old = ev.settledAt && ev.settledAt < cutoff;
    const dropped = !ev.track && !ev.settledAt;
    if ((old || dropped) && !withBets.has(id)) {
      delete events[id];
      touch('events');
    }
  }
}

// ---- watching trades ----------------------------------------------------------

async function watch() {
  if (run.busy.watch) return;
  const s = settings();
  run.busy.watch = true;
  try {
    const hot = hotEvents();
    const targets = [];
    for (const ev of hot) {
      for (const m of ev.markets) {
        if (m.closed) continue;
        if (m.kind === 'map' && !s.mapMarkets) continue;
        targets.push({ ev, m });
      }
    }
    const byCond = new Map(targets.map((t) => [t.m.conditionId, t]));
    const conds = [...byCond.keys()];
    for (let i = 0; i < conds.length; i += 20) {
      const batch = conds.slice(i, i + 20);
      const body = await pm.listTrades({ condition: batch.join(','), filter_type: 'CASH', filter_amount: Math.min(10, s.minCash), limit: 500 });
      const rows = Array.isArray(body?.data) ? body.data.slice().reverse() : [];
      for (const t of rows) {
        const key = tradeKey(t);
        if (run.seen.has(key)) continue;
        run.seen.add(key);
        const hit = byCond.get(String(t.condition_id));
        if (!hit) continue;
        await handleTrade(t, hit.ev, hit.m, 'live');
      }
    }
    if (run.seen.size > 250000) run.seen = new Set([...run.seen].slice(-100000));
    run.lastWatch = Date.now();
    await expireIntents();
  } catch (err) {
    run.lastError = `watch: ${err.message}`;
    logLine('error', run.lastError);
  } finally {
    run.busy.watch = false;
  }
}

function recentList(map, key, windowMs, now) {
  const list = (map.get(key) || []).filter((r) => now - r.at <= windowMs);
  map.set(key, list);
  return list;
}

/**
 * One trade from the feed: price sample, score, store when unusual, then copy
 * or mirror an exit. `source` is 'live' or 'backfill'.
 */
export async function handleTrade(t, ev, m, source = 'live', resultIdx = null) {
  const s = settings();
  const idx = outcomeIndex(m, t);
  if (idx < 0) return null;
  const price = Number(t.price) || 0;
  const at = (Number(t.timestamp) || 0) * 1000;
  const side = String(t.side || '').toUpperCase();
  const prices = col('prices')[m.conditionId];
  const prevPrice = prices?.last?.[idx];
  if (source === 'live') samplePrice(ev, m, idx === 0 ? price : 1 - price, at);

  const w = wallet(t.proxy_wallet, t);
  const token = String(t.token_id);
  const cash = (Number(t.size) || 0) * price;

  let stackFills = 0;
  let stackCash = 0;
  if (side === 'BUY') {
    const list = recentList(run.stack, `${w.addr}|${token}`, STACK_MS, at);
    list.push({ at, cash, shares: Number(t.size) || 0 });
    stackFills = list.length;
    stackCash = list.reduce((sum, r) => sum + r.cash, 0);
  }
  const clusterList = recentList(run.cluster, token, CLUSTER_MS, at);
  const clusterWallets = new Set(clusterList.filter((r) => r.wallet !== w.addr).map((r) => r.wallet)).size;
  const hasEntry = w.entries.some((e) => e.tokenId === token && (e.shares || 0) - (e.exitShares || 0) > 0.01);
  const ti = teamIndexOf(ev, m.outcomes[idx]);
  const live = source === 'live' ? ev.live : false;
  const ctx = {
    kind: m.kind,
    prevPrice,
    live,
    start: ev.start,
    behind: live ? teamBehind(parseScore(ev.score), ti >= 0 ? ti : idx, m.kind) : false,
    stackFills,
    stackCash,
    clusterWallets,
    hasEntry
  };
  // Only bets placed before this one count toward the record: history is
  // loaded out of order, and a record that knew later results would flatter
  // the score after the fact.
  const recordBefore = () => walletRecord(w.entries.filter((e) => e.at < at));
  let verdict = scoreTrade({ trade: t, settings: s, wallet: { ...w, record: recordBefore() }, ctx });
  if (!verdict.kind) return null;
  if (verdict.kind === 'entry' && source === 'live') {
    await enrich(w).catch(() => {});
    verdict = scoreTrade({ trade: t, settings: s, wallet: { ...w, record: recordBefore() }, ctx });
  }

  const flag = {
    id: newId('f'),
    at,
    seenAt: Date.now(),
    source,
    eventId: ev.id,
    conditionId: m.conditionId,
    market: m.kind,
    marketLabel: m.label,
    tokenId: token,
    outcome: m.outcomes[idx],
    outcomeIndex: idx,
    side,
    price,
    shares: Number(t.size) || 0,
    cash,
    wallet: w.addr,
    tx: String(t.transaction_hash || ''),
    kind: verdict.kind,
    score: verdict.score,
    reasons: verdict.reasons,
    // Split buys: what this wallet put on this team in the last 15 minutes.
    stackCash: stackFills > 1 ? stackCash : 0,
    stackFills: stackFills > 1 ? stackFills : 0,
    live,
    action: 'none',
    actionReason: ''
  };

  if (verdict.kind === 'entry') {
    clusterList.push({ wallet: w.addr, at });
    // Fills of one position build into one entry.
    const open = w.entries.find((e) => e.tokenId === token && at - (e.lastAt || e.at) <= STACK_MS && at >= e.at);
    if (open) {
      open.shares += flag.shares;
      open.cash += cash;
      open.price = open.cash / open.shares;
      open.lastAt = at;
      open.fills = (open.fills || 1) + 1;
      open.score = Math.max(open.score || 0, flag.score);
    } else {
      w.entries.push({
        flagId: flag.id,
        eventId: ev.id,
        conditionId: m.conditionId,
        tokenId: token,
        market: m.kind,
        outcome: flag.outcome,
        outcomeIndex: idx,
        price,
        cash,
        shares: flag.shares,
        at,
        lastAt: at,
        fills: 1,
        score: flag.score,
        live,
        result: resultIdx === null ? null : resultIdx === -1 ? 'void' : resultIdx === idx ? 'won' : 'lost'
      });
      if (w.entries.length > CAPS.walletEntries) w.entries.splice(0, w.entries.length - CAPS.walletEntries);
    }
    w.lastAt = Math.max(w.lastAt || 0, at);
    touch('wallets');
  } else if (verdict.kind === 'exit') {
    let left = flag.shares;
    for (const e of w.entries) {
      if (e.tokenId !== token || left <= 0) continue;
      const held = (e.shares || 0) - (e.exitShares || 0);
      if (held <= 0) continue;
      const take = Math.min(held, left);
      e.exitShares = (e.exitShares || 0) + take;
      e.exitCash = (e.exitCash || 0) + take * price;
      left -= take;
    }
    touch('wallets');
  }

  if (source === 'live') {
    if (verdict.kind === 'entry') {
      if (Date.now() - at > FRESH_MS) {
        flag.action = 'skip';
        flag.actionReason = 'Seen too late to copy';
      } else {
        await brain.onWhaleEntry(flag, ev, m, w);
      }
    } else if (verdict.kind === 'exit') {
      await brain.mirrorWhaleExit(flag, w);
    }
  } else {
    flag.action = 'history';
  }

  col('flags').push(flag);
  touch('flags');
  return flag;
}

// ---- bankroll -----------------------------------------------------------------

function betsFor(mode) {
  const meta = col('meta');
  return col('bets').filter((b) => b.mode === mode && (mode !== 'sim' || b.placedAt >= (meta.simEpoch || 0)));
}

/** All paper bots together: the sum of their paper wallets. */
export function simWallet() {
  const bots = allBots().filter((b) => b.mode === 'paper');
  const bets = col('bets').filter((b) => b.mode === 'sim' && bots.some((x) => x.id === b.botId && b.placedAt >= (x.paperEpoch || 0)));
  const t = betTotals(bets);
  const start = bots.reduce((sum, b) => sum + b.paperBankroll, 0);
  const cash = start + t.realized - t.openCost;
  return { cash, equity: cash + t.openMark, openCost: t.openCost, realized: t.realized, today: t.today, totals: t, bots: bots.length };
}

export function realWallet() {
  const dev = onlineDevice();
  const t = betTotals(betsFor('real'));
  const cash = Number.isFinite(dev?.info?.balance) ? dev.info.balance : null;
  return { cash, equity: cash === null ? null : cash + t.openMark, openCost: t.openCost, realized: t.realized, today: t.today, todayStaked: t.todayStaked, totals: t };
}

/**
 * Shares sold out of an open bet. Cost stays whole; what the sale returned is
 * kept in exitProceeds and counted into the payout. Selling everything closes it.
 */
export function applyExit(bet, sold, proceeds) {
  const take = Math.min(sold, bet.shares);
  bet.exitShares = (bet.exitShares || 0) + take;
  bet.exitProceeds = (bet.exitProceeds || 0) + proceeds;
  bet.shares = Math.max(0, bet.shares - take);
  bet.exitPrice = take ? proceeds / take : bet.exitPrice;
  if (bet.shares <= 0.01) {
    bet.shares = 0;
    bet.status = 'sold';
    bet.payout = bet.exitProceeds;
    bet.settledAt = Date.now();
  }
}

function fmtUsd(v) {
  return `$${(Math.round(v * 100) / 100).toFixed(2)}`;
}
function pct(p) {
  return `${Math.round(p * 1000) / 10}%`;
}

// ---- marks and settlement -----------------------------------------------------

function markOpenBets() {
  const prices = col('prices');
  for (const b of col('bets')) {
    if (b.status !== 'open') continue;
    const tr = prices[b.conditionId];
    if (tr?.last) b.mark = tr.last[b.outcomeIndex];
  }
  touch('bets');
}

/** Winner index of a closed market: 0/1, -1 for a 50-50 void, null while unresolved. */
export function winnerOf(m) {
  if (!m.closed || !m.prices) return null;
  const [a, b] = m.prices;
  if (a >= 0.99 && b <= 0.01) return 0;
  if (b >= 0.99 && a <= 0.01) return 1;
  if (Math.abs(a - 0.5) < 0.01 && Math.abs(b - 0.5) < 0.01) return -1;
  return null;
}

async function settleClosed() {
  const events = col('events');
  for (const ev of Object.values(events)) {
    if (!ev.track || ev.settledAt) continue;
    let allDone = true;
    for (const m of ev.markets) {
      if (m.settled) continue;
      const win = winnerOf(m);
      if (win === null) {
        allDone = false;
        continue;
      }
      settleMarket(ev, m, win);
      if (m.kind === 'match') await recordTeamMatch(ev, m, win, 'live').catch((err) => logLine('warn', `team stats ${ev.title}: ${err.message}`));
      m.settled = true;
    }
    if (allDone && ev.markets.some((m) => m.kind === 'match' && m.settled)) {
      ev.settledAt = Date.now();
      ev.live = false;
    }
    touch('events');
  }
}

function settleMarket(ev, m, win) {
  const wallets = col('wallets');
  for (const w of Object.values(wallets)) {
    for (const e of w.entries) {
      if (e.conditionId !== m.conditionId || e.result) continue;
      e.result = win === -1 ? 'void' : win === e.outcomeIndex ? 'won' : 'lost';
    }
  }
  touch('wallets');
  for (const b of col('bets')) {
    if (b.conditionId !== m.conditionId || b.status !== 'open') continue;
    const payout = (win === -1 ? b.shares * 0.5 : win === b.outcomeIndex ? b.shares : 0) + (b.exitProceeds || 0);
    b.payout = payout;
    b.status = win === -1 ? 'void' : payout > 0 ? 'won' : 'lost';
    b.settledAt = Date.now();
    b.mark = win === -1 ? 0.5 : win === b.outcomeIndex ? 1 : 0;
    if (b.mode !== 'shadow') logLine('info', `${b.mode.toUpperCase()} ${b.status} ${b.title}: ${b.outcome} ${fmtUsd(payout - b.cost)}`);
  }
  touch('bets');
  try {
    brain.onSettle(m.conditionId, m.tokens, win);
  } catch (err) {
    logLine('warn', `decision results: ${err.message}`);
  }
}

/**
 * Price before the start and the lowest price at any moment, per team, read
 * from the Data API's price history (5-minute buckets around the match).
 */
async function priceRange(tokenId, start, end) {
  const from = Math.floor((start ? start - 2 * 86400e3 : end - 3 * 86400e3) / 1000);
  const to = Math.floor(Math.min(Date.now(), end || Date.now()) / 1000) + 300;
  const body = await pm.priceHistory({ token_id: tokenId, start: from, end: to, bucket_seconds: 300, limit: 2000 });
  const pts = (body?.data || []).map((p) => ({ t: p.timestamp * 1000, p: Number(p.price) })).filter((p) => p.p > 0 && p.p < 1);
  if (!pts.length) return null;
  const before = pts.filter((p) => !start || p.t <= start);
  const during = pts.filter((p) => !start || p.t >= start - 6 * HOUR);
  const pre = before.length ? before[before.length - 1].p : pts[0].p;
  const minOf = (list) => list.reduce((mn, p) => Math.min(mn, p.p), 1);
  return { pre, min: minOf(during.length ? during : pts), series: pts };
}

const historyCache = new Map();
/**
 * The match-winner price track from Polymarket's own history (5-minute
 * buckets from a day before the start), merged under what was sampled live.
 * Fills in the start price and the low for matches first seen after they began.
 */
export async function matchHistory(ev) {
  const m = ev.markets.find((x) => x.kind === 'match');
  if (!m) return null;
  const hit = historyCache.get(m.conditionId);
  if (hit && Date.now() - hit.at < 2 * MIN) return hit.series;
  const end = ev.settledAt ? Math.min(Date.now(), (ev.start || Date.now()) + 12 * HOUR) : Date.now();
  let r = null;
  try {
    r = await priceRange(m.tokens[0], ev.start, end);
  } catch {
    r = null;
  }
  if (!r) return null;
  const series = r.series.map((p) => [p.t, Math.round(p.p * 1000) / 1000]);
  historyCache.set(m.conditionId, { at: Date.now(), series });
  if (historyCache.size > 300) historyCache.delete(historyCache.keys().next().value);
  const prices = col('prices');
  const tr = prices[m.conditionId];
  if (tr) {
    if (!tr.pre && Number.isFinite(r.pre)) tr.pre = [r.pre, 1 - r.pre];
    const lo = series.filter(([t]) => !ev.start || t >= ev.start - 6 * HOUR);
    if (lo.length) {
      const min0 = Math.min(...lo.map(([, p]) => p));
      const max0 = Math.max(...lo.map(([, p]) => p));
      tr.min = [Math.min(tr.min[0], min0), Math.min(tr.min[1], 1 - max0)];
      tr.max = [Math.max(tr.max[0], max0), Math.max(tr.max[1], 1 - min0)];
    }
    touch('prices');
  }
  return series;
}

async function recordTeamMatch(ev, m, win, source) {
  if (win === -1) return;
  const teams = col('teams');
  if (teams[m.conditionId]) return;
  const end = ev.closedAt || Date.now();
  const ranges = [];
  for (let i = 0; i < 2; i++) {
    let r = null;
    try {
      r = await priceRange(m.tokens[i], ev.start, end);
    } catch {
      r = null;
    }
    const tr = col('prices')[m.conditionId];
    ranges.push({
      pre: r?.pre ?? tr?.pre?.[i] ?? null,
      min: Math.min(r?.min ?? 1, tr?.min?.[i] ?? 1)
    });
  }
  teams[m.conditionId] = {
    eventId: ev.id,
    title: ev.title,
    league: ev.league,
    start: ev.start,
    source,
    teams: m.outcomes.map((name, i) => ({ name, pre: ranges[i].pre, min: ranges[i].min < 1 ? ranges[i].min : null, won: win === i }))
  };
  touch('teams');
}

// ---- backfill -----------------------------------------------------------------

/**
 * Finished tracked matches of the last `days`: their big underdog trades go
 * into the wallet records (already settled), and their price ranges into the
 * team table. Runs in the background; progress lives in meta.backfill.
 */
export async function backfill(days) {
  if (run.busy.backfill) return col('meta').backfill;
  run.busy.backfill = true;
  const meta = col('meta');
  const s = settings();
  const prog = (meta.backfill = { running: true, days, startedAt: Date.now(), scanned: 0, matches: 0, done: 0, trades: 0, flagged: 0, error: '' });
  touch('meta');
  try {
    await ensureRanks();
    const since = new Date(Date.now() - days * 86400e3).toISOString();
    const todo = [];
    let cursor = '';
    for (let page = 0; page < 400; page++) {
      const res = await pm.listEventsKeyset({ tag_id: CS2_TAG_ID, closed: true, end_date_min: since, limit: 100, ...(cursor ? { after_cursor: cursor } : {}) });
      const rows = res?.events;
      cursor = res?.next_cursor || '';
      if (!Array.isArray(rows) || !rows.length) break;
      for (const raw of rows) {
        prog.scanned++;
        const ev = normalizeEvent(raw);
        if (!ev) continue;
        const d = trackDecision(ev, s, ranks());
        if (!d.track) continue;
        if (ev.start && ev.start < Date.now() - days * 86400e3) continue;
        todo.push(raw);
      }
      touch('meta');
      if (rows.length < 100 || !cursor) break;
    }
    prog.matches = todo.length;
    // A few matches at a time; the request queue in polymarket.js still caps
    // how many calls are in flight.
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const raw = todo[next++];
        await backfillOne(raw, s, prog).catch((err) => logLine('warn', `backfill ${raw?.title}: ${err.message}`));
        prog.done++;
        touch('meta');
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    logLine('info', `Backfill ${days}d: ${prog.matches} matches, ${prog.flagged} flagged trades`);
  } catch (err) {
    prog.error = err.message;
    logLine('error', `backfill: ${err.message}`);
  } finally {
    prog.running = false;
    prog.finishedAt = Date.now();
    touch('meta');
    run.busy.backfill = false;
  }
  // The wallets the backfill surfaced most often get their profile read.
  const top = Object.values(col('wallets'))
    .filter((w) => !w.enrichedAt && w.entries.length >= 2)
    .sort((a, b) => b.entries.length - a.entries.length)
    .slice(0, 60);
  for (const w of top) await enrich(w).catch(() => {});
  return prog;
}

/** One finished match: team price range, then its big trades into the wallet records. */
async function backfillOne(raw, s, prog) {
  const ev = upsertEvent(raw);
  if (!ev) return;
  const m = ev.markets.find((x) => x.kind === 'match');
  const win = m ? winnerOf(m) : null;
  if (!m || win === null) return;
  if (!col('teams')[m.conditionId]) await recordTeamMatch(ev, m, win, 'backfill').catch(() => {});
  const rows = [];
  let cursor = '';
  for (let p = 0; p < 4; p++) {
    // The cursor alone loses the filter (empty or unrelated pages): send both.
    const body = await pm.listTrades({ condition: m.conditionId, filter_type: 'CASH', filter_amount: s.minCash, limit: 1000, ...(cursor ? { cursor } : {}) });
    rows.push(...(body?.data || []));
    cursor = body?.pagination?.next_cursor || '';
    if (!cursor) break;
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  for (const t of rows) {
    const key = tradeKey(t);
    if (run.seen.has(key)) continue;
    run.seen.add(key);
    prog.trades++;
    const f = await handleTrade(t, ev, m, 'backfill', win);
    if (f) prog.flagged++;
  }
  m.settled = true;
  ev.settledAt = ev.settledAt || Date.now();
  touch('events');
}

// ---- executor (the owner's PC) ------------------------------------------------

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function linkDevice(name) {
  const exec = col('executor');
  const token = crypto.randomBytes(32).toString('base64url');
  const device = { id: newId('d'), name: String(name || 'PC').slice(0, 40), tokenHash: hashToken(token), createdAt: Date.now(), lastSeen: 0, info: {} };
  exec.devices = (exec.devices || []).filter((d) => d.lastSeen || Date.now() - d.createdAt < 86400e3);
  exec.devices.push(device);
  touch('executor');
  return { device: publicDevice(device), token };
}

export function revokeDevice(id) {
  const exec = col('executor');
  exec.devices = (exec.devices || []).filter((d) => d.id !== id);
  if (!exec.devices.length) exec.armed = false;
  touch('executor');
}

export function deviceForToken(token) {
  if (!token) return null;
  const h = hashToken(token);
  return (col('executor').devices || []).find((d) => crypto.timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), Buffer.from(h, 'hex'))) || null;
}

export function publicDevice(d) {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, online: Date.now() - (d.lastSeen || 0) < DEVICE_ONLINE_MS, info: d.info || {} };
}

export function onlineDevice() {
  return (col('executor').devices || []).find((d) => Date.now() - (d.lastSeen || 0) < DEVICE_ONLINE_MS) || null;
}

/**
 * An order for the PC executor. type 'market' (FAK with a price cap) or
 * 'limit' (GTD, rests for ttlSec, then the executor cancels what is left).
 */
export function queueIntent(fields) {
  const ttl = fields.type === 'limit' ? (fields.ttlSec || 90) * 1000 + 15e3 : fields.side === 'SELL' ? INTENT_SELL_TTL : INTENT_BUY_TTL;
  const intent = { id: newId('i'), type: 'market', status: 'queued', createdAt: Date.now(), expiresAt: Date.now() + ttl, ...fields };
  col('intents').push(intent);
  touch('intents');
  return intent;
}

/** The executor asks for work. */
export function pollIntents(device) {
  device.lastSeen = Date.now();
  touch('executor');
  const exec = col('executor');
  const s = settings();
  const now = Date.now();
  const out = [];
  if (exec.armed && s.botsOn !== false) {
    for (const i of col('intents')) {
      if (i.status !== 'queued' || i.expiresAt < now) continue;
      i.status = 'sent';
      i.sentAt = now;
      i.deviceId = device.id;
      out.push({ id: i.id, type: i.type || 'market', side: i.side, tokenId: i.tokenId, amount: i.amount, maxPrice: i.maxPrice, shares: i.shares, minPrice: i.minPrice, price: i.price, size: i.size, ttlSec: i.ttlSec, expiresAt: i.expiresAt });
    }
    if (out.length) touch('intents');
  }
  return { armed: Boolean(exec.armed), intents: out };
}

/** The executor reports what one intent did. */
export function reportIntent(device, r) {
  device.lastSeen = Date.now();
  const intent = col('intents').find((i) => i.id === r?.id);
  if (!intent || intent.deviceId !== device.id) return false;
  intent.status = r.ok ? 'done' : 'failed';
  intent.result = { ok: Boolean(r.ok), orderId: String(r.orderId || ''), status: String(r.status || ''), spent: Number(r.spent) || 0, shares: Number(r.shares) || 0, error: String(r.error || '').slice(0, 300), at: Date.now() };
  const bet = col('bets').find((b) => b.id === intent.betId);
  if (bet) {
    if (intent.side === 'BUY') {
      if (r.ok && intent.result.shares > 0) {
        bet.status = 'open';
        bet.shares = intent.result.shares;
        bet.cost = intent.result.spent;
        bet.price = intent.result.spent / intent.result.shares;
        bet.mark = bet.price;
        bet.orderId = intent.result.orderId;
      } else {
        bet.status = 'failed';
        bet.error = intent.result.error || (r.ok ? `Order ${intent.result.status || 'not filled'}` : 'Rejected');
      }
    } else if (intent.side === 'SELL') {
      bet.exiting = null;
      if (r.ok && intent.result.shares > 0) {
        // For a SELL, `spent` carries what the sale returned.
        applyExit(bet, intent.result.shares, intent.result.spent);
        bet.exitReason = 'Whale sold';
      } else {
        bet.exitError = intent.result.error;
      }
    }
    touch('bets');
  }
  logLine(r.ok ? 'info' : 'error', `REAL ${intent.side} ${r.ok ? 'done' : 'failed'}: ${intent.result.status || intent.result.error}`);
  touch('intents');
  touch('executor');
  return true;
}

export function heartbeat(device, info) {
  device.lastSeen = Date.now();
  const i = info || {};
  device.info = {
    at: Date.now(),
    balance: Number.isFinite(Number(i.balance)) ? Number(i.balance) : null,
    wallet: String(i.wallet || '').slice(0, 64),
    signer: String(i.signer || '').slice(0, 64),
    geo: i.geo ? { blocked: Boolean(i.geo.blocked), country: String(i.geo.country || '').slice(0, 8) } : null,
    sdk: String(i.sdk || '').slice(0, 40),
    error: String(i.error || '').slice(0, 300)
  };
  touch('executor');
}

async function expireIntents() {
  const now = Date.now();
  let changed = false;
  for (const i of col('intents')) {
    // A sent intent gets longer: the executor may be mid-order when it would expire.
    const grace = i.status === 'sent' ? 120e3 : 5e3;
    if ((i.status === 'queued' || i.status === 'sent') && i.expiresAt + grace < now) {
      i.status = 'expired';
      changed = true;
      const bet = col('bets').find((b) => b.id === i.betId);
      if (bet && bet.status === 'pending') {
        bet.status = 'missed';
        bet.error = i.sentAt ? 'Executor did not report back' : 'Executor did not pick it up in time';
        touch('bets');
      }
      if (bet && i.side === 'SELL') bet.exiting = null;
    }
  }
  if (changed) touch('intents');
}

export function setArmed(on) {
  const exec = col('executor');
  exec.armed = Boolean(on);
  if (!on) {
    for (const i of col('intents')) {
      if (i.status === 'queued') i.status = 'expired';
    }
    touch('intents');
  }
  touch('executor');
  logLine('info', on ? 'Real trading ARMED' : 'Real trading disarmed');
}

// ---- settings -----------------------------------------------------------------

export function updateSettings(patch) {
  const prev = settings();
  const next = sanitizeSettings(patch, prev);
  // Switching all bots off always disarms real trading. Arming is its own deliberate step.
  if (prev.botsOn !== false && next.botsOn === false) setArmed(false);
  const store = col('settings');
  Object.assign(store, next);
  touch('settings');
  const listsChanged = ['teams', 'tournaments', 'excludeTeams', 'vrsBelow', 'vrsUnranked', 'useTeams', 'useVrs', 'useTournaments'].some((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
  if (listsChanged) {
    // Re-decide every stored open event under the new rules, then rediscover.
    for (const ev of Object.values(col('events'))) {
      if (ev.settledAt) continue;
      const d = trackDecision(ev, next, ranks());
      ev.track = d.track;
      ev.reasons = d.reasons;
    }
    touch('events');
    setTimeout(() => discover(), 10);
  }
  if (prev.botsOn !== next.botsOn) logLine('info', `Bots ${next.botsOn ? 'on' : 'off'}`);
  return store;
}

export function resetSim() {
  col('meta').simEpoch = Date.now();
  touch('meta');
  logLine('info', 'Paper wallet reset');
}

/** How many open events the given (draft) rules would track. */
export function previewRules(draft) {
  const s = sanitizeSettings(draft, settings());
  const events = Object.values(col('events')).filter((e) => !e.settledAt);
  let n = 0;
  for (const ev of events) if (trackDecision(ev, s, ranks()).track) n++;
  return { tracked: n, of: events.length };
}

// ---- status and lifecycle -----------------------------------------------------

export function engineStatus() {
  const events = Object.values(col('events'));
  return {
    running: run.started,
    tracking: settings().tracking,
    startedAt: run.startedAt,
    lastDiscover: run.lastDiscover,
    lastWatch: run.lastWatch,
    lastLive: run.lastLive,
    lastError: run.lastError,
    tracked: events.filter((e) => e.track && !e.settledAt).length,
    live: events.filter((e) => e.track && e.live && !e.settledAt).length,
    hot: hotEvents().length,
    openSeen: run.openEventsSeen,
    vrsTeams: run.ranks?.size || 0,
    requests: { ...pm.requestStats },
    backfill: col('meta').backfill || null
  };
}

function tick(fn, everyMs) {
  const loop = async () => {
    if (settings().tracking) {
      try {
        await fn();
      } catch (err) {
        run.lastError = err.message;
      }
    }
    const t = setTimeout(loop, typeof everyMs === 'function' ? everyMs() : everyMs);
    t.unref?.();
    run.timers.push(t);
    if (run.timers.length > 50) run.timers.splice(0, run.timers.length - 10);
  };
  const t = setTimeout(loop, 2000);
  t.unref?.();
  run.timers.push(t);
}

/** Start the loops. Safe to call twice. */
export function startEngine() {
  if (run.started) return;
  run.started = true;
  run.startedAt = Date.now();
  try {
    restoreModels();
  } catch (err) {
    logLine('warn', `models not restored: ${err.message}`);
  }
  feeds.startFeeds();
  setRecordFilter((eventId) => {
    const ev = col('events')[eventId];
    if (!ev || ev.settledAt) return false;
    return Boolean(feeds.scores.get(eventId)?.live ?? ev.live) || (ev.start && ev.start - Date.now() < 3 * HOUR && Date.now() - ev.start < 8 * HOUR);
  });
  if (settings().recordTicks) startRecorder();
  brain.startBrain();
  // A fresh install has no history: load the last N days of finished matches
  // (whale records, team stats, price paths), then train once on them.
  const fresh = !Object.keys(col('teams')).length;
  if (fresh) {
    const t = setTimeout(() => {
      logLine('info', 'First start: loading match history, then training');
      backfill(settings().backfillDays)
        .then(() => runTraining())
        .catch((err) => logLine('error', `first-start history: ${err.message}`));
    }, 60e3);
    t.unref?.();
  }
  scheduleTraining({ firstRun: !fresh });
  // Trades already stored are not processed again after a restart.
  for (const f of col('flags')) if (f.tx) run.seen.add(`${f.tx}|${f.wallet}|${f.tokenId}|${f.side}|${f.shares}`);
  tick(discover, 3 * MIN);
  tick(watch, () => (hotEvents().some((e) => e.live) ? 2000 : 15000));
  // A large print on the live book: fetch the wallet behind it now, not at the next poll.
  let soon = null;
  feeds.on('trade', (token, t) => {
    if (t.p * t.s < Math.min(10, settings().minCash) || soon) return;
    soon = setTimeout(() => {
      soon = null;
      watch().catch(() => {});
    }, 400);
  });
  tick(refreshLive, 15000);
  logLine('info', 'Engine started');
}

/** Run one discovery and one watch pass now (the Refresh button). */
export async function refreshNow() {
  await discover();
  await watch();
}

// The brain reaches back into the engine through these hooks (no import cycle at load).
brain.initBrain({ settings, simWallet, realWallet, queueIntent, applyExit, hotEvents, walletRecord: recordOf, onlineDevice });

export { discover as _discover, watch as _watch, settleClosed as _settleClosed, run as _run };
