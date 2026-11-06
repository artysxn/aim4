// ---------------------------------------------------------------------------
// server/insights/brain.js
// Every trade goes through the same pipeline, whatever started it:
//
//   trigger    a whale entry, a price state the swing strategy likes, a
//              market-making quote cycle
//   analysts   analysts.js: where the price should be in N minutes, and why
//   edge       expected price minus what we would pay, after fees and the
//              cost of walking the book
//   risk       risk.js against the wallet the trade would land in
//   review     Claude, for pre-match bets of a real size (review.js)
//   execute    paper fill on the live book, a paper limit order that fills
//              when the tape trades through it, or an order intent for the
//              PC executor (real money)
//   record     a decision record in SQLite, taken or not, then follow-up
//              prices at +5 min, +30 min and the start, and the result
//
// Strategies run as variants. One variant per strategy is the champion and
// trades the main wallet (paper in Simulation, real when armed and allowed);
// the others are challengers trading their own shadow paper wallets on the
// same signals, so learn.js can compare them on equal terms.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import * as feeds from './feeds.js';
import * as pm from './polymarket.js';
import * as db from './db.js';
import { col, touch, logLine } from './store.js';
import { runAnalysts, combine, edgeOf } from './analysts.js';
import { riskGate } from './risk.js';
import { reviewDecision, reviewerConfigured } from './review.js';
import { tables, volOf, priceAt } from './reaction.js';
import { betTotals, teamTable } from './stats.js';
import { normName } from './matching.js';

const newId = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const MIN = 60e3;

/** Strategy variants. Parameters are fixed per variant; challengers differ on purpose. */
export const STRATEGY_DEFS = {
  whale: {
    label: 'Whale copy',
    variants: {
      'w-score': { label: 'Score over the line', minScore: null },
      'w-edge': { label: 'Score 40+ and analysts agree', minScore: 40, minEdge: 0 },
      'w-proven': { label: 'Specialists and split buys', minScore: 25, needs: ['specialist', 'stacking'] }
    },
    champion: 'w-score'
  },
  swing: {
    label: 'Swing',
    variants: {
      's-maker3': { label: '3c edge, limit orders', minEdge: 0.03, horizon: 30, maker: true },
      's-taker5': { label: '5c edge, market orders', minEdge: 0.05, horizon: 30, maker: false },
      's-score': { label: 'Fade score overreactions', minEdge: 0.025, horizon: 15, maker: false, afterScore: true }
    },
    champion: 's-maker3'
  },
  mm: {
    label: 'Market making',
    variants: {
      'm-tight': { label: 'Tight quotes', spreadK: 1.0, size: 15, maxInv: 60 },
      'm-wide': { label: 'Wide quotes', spreadK: 2.0, size: 15, maxInv: 60 }
    },
    champion: 'm-wide'
  }
};

let api = null; // engine hooks, set by initBrain
const state = {
  started: false,
  timers: [],
  lastEval: new Map(), // token|variant -> t
  lastRecorded: new Map(), // token|variant -> t (skips)
  lastExitCheck: new Map(),
  paperOrders: new Map(), // id -> order
  quotePause: new Map(), // eventId -> until
  teamRows: null,
  teamRowsAt: 0,
  stats: { decisions: 0, entered: 0, exits: 0, quotes: 0, fills: 0, reviews: 0, vetoes: 0 }
};
export const brainStatus = () => ({ ...state.stats, paperOrders: state.paperOrders.size, started: state.started });

// ---- strategy state -------------------------------------------------------------

export function strategies() {
  const s = col('strategies');
  let changed = false;
  for (const [key, def] of Object.entries(STRATEGY_DEFS)) {
    if (!s[key]) {
      // Market making starts on (paper only; its real path is blocked until promoted
      // and allowed). Only the whale strategy may use real money out of the box.
      s[key] = { enabled: true, realAllowed: key === 'whale', champion: def.champion, allocation: 1 / Object.keys(STRATEGY_DEFS).length, pendingPromotion: null, history: [] };
      changed = true;
    }
    if (!def.variants[s[key].champion]) s[key].champion = def.champion;
  }
  if (changed) touch('strategies');
  return s;
}

function variantParams(strategy, variantId) {
  const p = { ...STRATEGY_DEFS[strategy].variants[variantId] };
  // The whale champion follows the Settings page's score line.
  if (strategy === 'whale' && p.minScore === null) p.minScore = api.settings().minScore;
  return p;
}

/** Which wallet a variant's trade lands in, and how big that wallet is. */
function walletFor(strategy, variantId) {
  const s = api.settings();
  const st = strategies()[strategy];
  const champion = st.champion === variantId;
  const exec = col('executor');
  // Real mode never falls back to the paper wallet: a champion that may not
  // trade real money right now trades its shadow wallet, and the flag says why.
  let mode = 'shadow';
  if (champion && s.mode === 'real' && exec.armed && st.realAllowed && api.onlineDevice()) mode = 'real';
  else if (champion && s.mode === 'sim') mode = 'sim';
  const all = col('bets');
  let bets;
  let bankroll;
  let today;
  if (mode === 'shadow') {
    bets = all.filter((b) => b.mode === 'shadow' && b.variant === variantId);
    const t = betTotals(bets);
    bankroll = s.simBankroll + t.realized + t.openMark - t.openCost;
    today = t.today;
  } else if (mode === 'sim') {
    const w = api.simWallet();
    bets = all.filter((b) => b.mode === 'sim' && b.placedAt >= (col('meta').simEpoch || 0));
    bankroll = w.equity;
    today = w.today;
  } else {
    const w = api.realWallet();
    bets = all.filter((b) => b.mode === 'real');
    bankroll = w.equity ?? 0;
    today = w.today;
  }
  const open = bets.filter((b) => b.status === 'open' || b.status === 'pending');
  // Allocation shares are normalized over the strategies that are switched on,
  // so an even split means a multiplier of 1 whatever the number of strategies.
  const enabled = Object.values(strategies()).filter((x) => x.enabled);
  const n = enabled.length || 1;
  const total = enabled.reduce((sum, x) => sum + (x.allocation || 1 / n), 0) || 1;
  const allocMult = mode === 'shadow' ? 1 : clamp(((st.allocation || 1 / n) / total) * n, 0.25, 2);
  return { mode, champion, bankroll, today, open, allocMult };
}

// ---- context for the analysts ------------------------------------------------------

function teamRow(name) {
  if (!state.teamRows || Date.now() - state.teamRowsAt > 10 * MIN) {
    state.teamRows = new Map(teamTable(Object.values(col('teams')), api.settings().maxPrice).map((r) => [normName(r.name), r]));
    state.teamRowsAt = Date.now();
  }
  return state.teamRows.get(normName(name)) || null;
}

async function bookFor(token) {
  const live = feeds.bookSnapshot(token);
  if (live && Date.now() - live.at < 60e3) return live;
  try {
    return await pm.orderBook(token);
  } catch {
    return live;
  }
}

function bestOf(book) {
  let bid = null;
  let ask = null;
  for (const l of book?.bids || []) if (Number(l.size) > 0 && (bid === null || Number(l.price) > bid)) bid = Number(l.price);
  for (const l of book?.asks || []) if (Number(l.size) > 0 && (ask === null || Number(l.price) < ask)) ask = Number(l.price);
  return { bid, ask };
}

function depthOf(book, cents = 0.05) {
  const { bid, ask } = bestOf(book);
  let bidUsd = 0;
  let askUsd = 0;
  for (const l of book?.bids || []) if (bid !== null && bid - Number(l.price) <= cents + 1e-9) bidUsd += Number(l.size) * Number(l.price);
  for (const l of book?.asks || []) if (ask !== null && Number(l.price) - ask <= cents + 1e-9) askUsd += Number(l.size) * Number(l.price);
  return { bidUsd, askUsd };
}

/** Everything the analysts need about one outcome token right now. */
async function contextFor(ev, m, idx, horizon) {
  const token = m.tokens[idx];
  const book = await bookFor(token);
  const { bid, ask } = bestOf(book);
  const mid = feeds.midOf(token) ?? (bid !== null && ask !== null ? (bid + ask) / 2 : m.prices?.[idx] ?? null);
  const flags = col('flags');
  const recent = [];
  for (let i = flags.length - 1; i >= 0 && recent.length < 60; i--) {
    const f = flags[i];
    if (Date.now() - f.at > 30 * MIN) break;
    if (f.conditionId === m.conditionId && f.source === 'live') recent.push(f);
  }
  const sc = feeds.scores.get(ev.id);
  return {
    token,
    book,
    bid,
    ask,
    mid,
    ctx: {
      token,
      mid,
      bid,
      ask,
      mids: feeds.books.get(token)?.mids || [],
      now: Date.now(),
      live: Boolean(sc?.live ?? ev.live),
      start: ev.start,
      scoreTimes: sc?.history || [],
      flags: recent,
      depth: depthOf(book),
      flow: feeds.flowOf(token),
      team: teamRow(m.outcomes[idx]),
      line: api.settings().maxPrice,
      horizon
    }
  };
}

// ---- the pipeline -------------------------------------------------------------------

/**
 * One candidate trade through every stage. Returns the decision.
 * @param {object} a
 * @param {'whale'|'swing'} a.strategy
 * @param {string} a.variantId
 * @param {object} a.ev
 * @param {object} a.m        market
 * @param {number} a.idx      outcome index to buy
 * @param {object} [a.flag]   the whale flag that triggered it
 * @param {object} [a.whale]  the whale wallet
 */
export async function consider({ strategy, variantId, ev, m, idx, flag = null, whale = null }) {
  const s = api.settings();
  const params = variantParams(strategy, variantId);
  const horizon = params.horizon || 30;
  const wallet = walletFor(strategy, variantId);
  const { token, book, bid, ask, mid, ctx } = await contextFor(ev, m, idx, horizon);
  const decision = {
    id: newId('d'),
    at: Date.now(),
    strategy,
    variant: variantId,
    mode: wallet.mode,
    eventId: ev.id,
    conditionId: m.conditionId,
    token,
    outcome: m.outcomes[idx],
    side: 'BUY',
    title: `${ev.teams[0]} vs ${ev.teams[1]}`,
    market: m.kind === 'match' ? 'Match' : m.label,
    live: ctx.live,
    start: ev.start,
    trigger: flag ? { kind: 'whale', flagId: flag.id, wallet: flag.wallet, cash: flag.stackCash || flag.cash, price: flag.price, score: flag.score } : { kind: strategy },
    action: 'skipped',
    reason: ''
  };
  const finish = (action, reason) => {
    decision.action = action;
    decision.reason = reason;
    return record(decision);
  };

  if (mid === null || ask === null) return finish('skipped', 'No order book');
  const { analysts, vol } = runAnalysts(ctx);
  const comb = combine(mid, analysts, vol, horizon);
  decision.analysts = analysts;
  decision.combined = { expected: comb.expected, shift: comb.shift, sd: comb.sd, horizon };
  decision.pMarket = mid;
  decision.pFinal = comb.expected;

  // Size before the edge check: the edge depends on how deep we walk the book.
  let target;
  if (strategy === 'whale') {
    // "Stake per match" on the Settings page: whatever the whale strategy already
    // put on this match counts against it.
    const already = wallet.open.filter((b) => b.eventId === ev.id && (b.strategy || 'whale') === 'whale').reduce((sum, b) => sum + (b.cost || b.amount || 0), 0);
    target = Math.min(wallet.bankroll * (s.stakePct / 100) * wallet.allocMult, s.maxStake) - already;
    if (target < s.minStake) {
      decision.analysts = [];
      return finish('skipped', already > 0 ? 'Match stake already in' : 'Stake under minimum');
    }
  } else target = Math.min(wallet.bankroll * (s.swingStakePct / 100) * wallet.allocMult, s.maxStake);
  target = Math.floor(target * 100) / 100;

  let maxPrice;
  if (strategy === 'whale') maxPrice = Math.min(s.maxEntry, flag.price + s.maxSlippage);
  else maxPrice = Math.min(0.97, comb.expected - params.minEdge);
  const fill = pm.walkAsks(book, target, maxPrice);
  const maker = strategy === 'swing' && params.maker && ask - (bid ?? 0) >= 0.02;
  const makerPx = maker ? Math.min(maxPrice, Math.round(((bid ?? 0) + 0.01) * 100) / 100) : null;
  const e = edgeOf({ side: 'BUY', expected: comb.expected, ask, bid, fill: maker ? { avg: makerPx } : fill, feeRate: m.feeRate, maker });
  if (strategy === 'swing') {
    // A swing trade has to get out again: the exit sells into the bid and pays
    // the taker fee. Buying at the bid of a wide spread is not an edge by itself.
    const exitHalf = bid !== null ? Math.max(0, mid - bid) : 0;
    e.edge -= exitHalf + (m.feeRate || 0) * Math.min(comb.expected, 1 - comb.expected);
  }
  decision.price = e.px;
  decision.edge = e.edge;

  // Strategy gates.
  if (strategy === 'whale') {
    if (!flag) return finish('skipped', 'No flag');
    if (whale?.ignore) return finish('skipped', 'Wallet ignored');
    const followed = Boolean(whale?.follow);
    if (!followed && flag.score < params.minScore) return finish('skipped', `Score ${flag.score} under ${params.minScore}`);
    if (params.needs && !flag.reasons.some((r) => params.needs.includes(r.key))) return finish('skipped', `Needs ${params.needs.join(' or ')}`);
    if (params.minEdge !== undefined && e.edge < params.minEdge) return finish('skipped', `Edge ${(e.edge * 100).toFixed(1)}c under ${(params.minEdge * 100).toFixed(1)}c`);
    if (m.kind === 'map' && !s.copyMaps) return finish('skipped', 'Map markets not copied');
    if (ctx.live && !s.copyLive) return finish('skipped', 'Live bets not copied');
    if (!ctx.live && !s.copyPrematch) return finish('skipped', 'Pre-match bets not copied');
    if (s.skipLosers && !followed && whale) {
      const rec = api.walletRecord(whale);
      if (rec.resolved >= s.loserMinResolved && rec.edge !== null && rec.edge < 0) return finish('skipped', `Losing record ${rec.wins}/${rec.resolved}`);
    }
  } else if (strategy === 'swing') {
    if (params.afterScore && !(analysts.find((a) => a.key === 'overreaction')?.conf > 0)) return finish('skipped', 'No recent score change');
    if (e.edge < params.minEdge) return finish('skipped', `Edge ${(e.edge * 100).toFixed(1)}c under ${(params.minEdge * 100).toFixed(1)}c`);
    if (comb.sd > 0 && e.edge / comb.sd < 0.25) return finish('skipped', `Edge small against the uncertainty (${(comb.sd * 100).toFixed(1)}c)`);
  }
  if (m.closed || !m.accepting) return finish('skipped', 'Market not taking orders');
  if (!maker && fill.shares <= 0) return finish('skipped', `No asks under ${(maxPrice * 100).toFixed(0)}%`);

  // Risk against the whole wallet.
  if (strategy === 'swing') target = Math.min(target * clamp(e.edge / params.minEdge, 0.5, 2), s.maxStake);
  const risk = riskGate({
    cand: { eventId: ev.id, conditionId: m.conditionId, tokenId: token, outcome: m.outcomes[idx], side: 'BUY', stake: target, price: e.px, needsExit: strategy === 'swing', start: ev.start, live: ctx.live },
    open: wallet.open,
    bankroll: wallet.bankroll,
    todayPnl: wallet.today,
    limits: s,
    exitDepth: ctx.depth,
    spread: ask - (bid ?? ask),
    rules: ev.rules
  });
  decision.risk = risk;
  decision.stake = risk.stake;
  if (!risk.ok) return finish('skipped', `Risk: ${risk.checks.filter((c) => !c.ok).map((c) => c.key).join(', ')}`);

  // Exit plan, sized to how much this market usually moves.
  const sdH = (vol.sd5 || 0.03) * Math.sqrt(horizon / 5);
  decision.plan =
    strategy === 'whale'
      ? { hold: true, mirror: true }
      : { target: Math.min(0.99, e.px + Math.max(params.minEdge, 0.8 * sdH)), stop: Math.max(0.01, e.px - Math.max(0.03, 1.2 * sdH)), timeStop: Date.now() + horizon * 2 * MIN, edgeExit: true };

  // A pre-match bet of real size gets a second opinion first.
  const wantsReview = s.reviewer && wallet.mode !== 'shadow' && !ctx.live && ev.start - Date.now() > 10 * MIN && risk.stake >= s.reviewMinStake && reviewerConfigured();
  if (wantsReview) {
    decision.action = 'review';
    decision.reason = 'Waiting for the AI review';
    record(decision);
    state.stats.reviews++;
    reviewDecision(decision, ev).then(async (rv) => {
      db.patchDecisionJson(decision.id, { review: rv });
      if (rv.verdict === 'veto') {
        state.stats.vetoes++;
        db.updateDecision(decision.id, { action: 'vetoed', reason: rv.flags[0] || 'Vetoed by review' });
        logLine('info', `Review vetoed ${decision.title} ${decision.outcome}: ${rv.rationale.slice(0, 120)}`);
        return;
      }
      // Prices move while Claude reads: execute only if it still pays.
      const fresh = await bookFor(token);
      const { ask: a2 } = bestOf(fresh);
      if (a2 === null || a2 > maxPrice + 1e-9) {
        db.updateDecision(decision.id, { action: 'skipped', reason: 'Price moved during review' });
        return;
      }
      decision.review = rv;
      await execute(decision, { ev, m, idx, book: fresh, maxPrice, maker, makerPx, flag, wallet });
    });
    return decision;
  }
  await execute(decision, { ev, m, idx, book, maxPrice, maker, makerPx, flag, wallet });
  return decision;
}

/** Save a decision, skipping repeat no-trade records of the same token and variant. */
function record(d) {
  state.stats.decisions++;
  const k = `${d.token}|${d.variant}`;
  const quiet = d.action === 'skipped' && d.strategy !== 'whale';
  if (quiet) {
    const last = state.lastRecorded.get(k) || 0;
    if (Date.now() - last < 10 * MIN) return d;
    // A skip far from the line teaches nothing.
    if (!(d.edge > -0.01)) return d;
  }
  state.lastRecorded.set(k, Date.now());
  try {
    db.saveDecision(d);
  } catch (err) {
    logLine('error', `decision save: ${err.message}`);
  }
  return d;
}

// ---- execution ---------------------------------------------------------------------

function newBet(decision, fields) {
  return {
    id: newId('b'),
    mode: decision.mode,
    strategy: decision.strategy,
    variant: decision.variant,
    decisionId: decision.id,
    status: 'open',
    eventId: decision.eventId,
    title: decision.title,
    conditionId: decision.conditionId,
    market: decision.market === 'Match' ? 'match' : 'map',
    marketLabel: decision.market,
    tokenId: decision.token,
    outcome: decision.outcome,
    placedAt: Date.now(),
    score: decision.trigger?.score,
    sourceWallet: decision.trigger?.wallet || '',
    sourceFlagId: decision.trigger?.flagId || '',
    whalePrice: decision.trigger?.price ?? null,
    live: decision.live,
    plan: decision.plan,
    ...fields
  };
}

async function execute(decision, { ev, m, idx, book, maxPrice, maker, makerPx, flag }) {
  const stake = decision.stake;
  const outcomeIndex = idx;
  if (decision.mode === 'real') {
    const intent = maker
      ? api.queueIntent({ type: 'limit', side: 'BUY', tokenId: decision.token, conditionId: m.conditionId, price: makerPx, size: Math.floor((stake / makerPx) * 100) / 100, ttlSec: 90 })
      : api.queueIntent({ type: 'market', side: 'BUY', tokenId: decision.token, conditionId: m.conditionId, amount: stake, maxPrice });
    const bet = newBet(decision, { status: 'pending', amount: stake, maxPrice, outcomeIndex, intentId: intent.id });
    col('bets').push(bet);
    touch('bets');
    decision.betId = bet.id;
    decision.action = 'queued';
    decision.reason = `${maker ? 'Limit' : 'Market'} order $${stake.toFixed(2)} up to ${(maxPrice * 100).toFixed(1)}%`;
    if (flag) Object.assign(flag, { action: 'queued', actionReason: decision.reason, betId: bet.id });
  } else if (maker) {
    // A paper limit order: fills only if the tape trades through our price.
    const order = { id: newId('o'), kind: 'entry', decisionId: decision.id, token: decision.token, side: 'BUY', price: makerPx, usd: stake, filledShares: 0, cost: 0, expiresAt: Date.now() + 90e3, decision, outcomeIndex, feeRate: 0 };
    state.paperOrders.set(order.id, order);
    decision.action = 'entered';
    decision.reason = `Paper limit $${stake.toFixed(2)} at ${(makerPx * 100).toFixed(1)}%`;
  } else {
    const fill = pm.walkAsks(book, stake, maxPrice);
    const fee = pm.takerFee(m.feeRate, fill.avg, fill.shares);
    const bet = newBet(decision, { shares: fill.shares, price: fill.avg, fee, cost: fill.cost + fee, mark: fill.avg, outcomeIndex, amount: stake });
    col('bets').push(bet);
    touch('bets');
    decision.betId = bet.id;
    decision.price = fill.avg;
    decision.action = 'entered';
    decision.reason = `${decision.mode === 'shadow' ? 'Shadow' : 'Paper'} $${bet.cost.toFixed(2)} at ${(fill.avg * 100).toFixed(1)}%`;
    if (flag && decision.mode !== 'shadow') Object.assign(flag, { action: 'copied', actionReason: decision.reason, betId: bet.id });
    state.stats.entered++;
  }
  if (flag && decision.mode !== 'shadow' && flag.action === 'none') Object.assign(flag, { action: 'skip', actionReason: decision.reason });
  if (decision.mode !== 'shadow') logLine('info', `${decision.mode.toUpperCase()} ${decision.strategy}/${decision.variant} ${decision.title}: ${decision.outcome} ${decision.reason}`);
  record(decision);
  touch('flags');
}

// ---- paper limit orders and market-making fills --------------------------------------

/** A trade printed on the tape: fill paper limit orders it traded through. */
function onTrade(token, t) {
  for (const o of state.paperOrders.values()) {
    if (o.token !== token) continue;
    // A taker SELL at or below our bid fills our BUY; a taker BUY at or above our ask fills our SELL.
    const hit = o.side === 'BUY' ? t.side === 'SELL' && t.p <= o.price + 1e-9 : t.side === 'BUY' && t.p >= o.price - 1e-9;
    if (!hit) continue;
    // At our exact price we assume half the print reached us (queue position).
    const through = o.side === 'BUY' ? t.p < o.price - 1e-9 : t.p > o.price + 1e-9;
    const avail = t.s * (through ? 1 : 0.5);
    const wantShares = o.side === 'BUY' ? (o.usd - o.cost) / o.price : o.shares - o.filledShares;
    const take = Math.min(avail, wantShares);
    if (take <= 0.01) continue;
    o.filledShares += take;
    o.cost += take * o.price;
    state.stats.fills++;
    paperFill(o, take);
    const done = o.side === 'BUY' ? o.cost >= o.usd - 0.01 : o.filledShares >= o.shares - 0.01;
    if (done) state.paperOrders.delete(o.id);
  }
}

function paperFill(o, shares) {
  const bets = col('bets');
  if (o.kind === 'entry') {
    let bet = bets.find((b) => b.decisionId === o.decisionId && b.status === 'open');
    if (!bet) {
      bet = newBet(o.decision, { shares: 0, price: o.price, fee: 0, cost: 0, mark: o.price, outcomeIndex: o.outcomeIndex, amount: o.usd, maker: true });
      bets.push(bet);
      db.updateDecision(o.decisionId, { action: 'entered' });
      state.stats.entered++;
    }
    bet.shares += shares;
    bet.cost += shares * o.price;
    bet.price = bet.cost / bet.shares;
  } else if (o.kind === 'mm-bid') {
    let bet = bets.find((b) => b.strategy === 'mm' && b.variant === o.variant && b.tokenId === o.token && b.status === 'open' && b.mode === o.mode);
    if (!bet) {
      bet = { id: newId('b'), mode: o.mode, strategy: 'mm', variant: o.variant, status: 'open', eventId: o.eventId, title: o.title, conditionId: o.conditionId, market: o.market, marketLabel: o.marketLabel, tokenId: o.token, outcome: o.outcome, outcomeIndex: o.outcomeIndex, placedAt: Date.now(), shares: 0, cost: 0, price: o.price, mark: o.price, fee: 0, plan: { mm: true } };
      bets.push(bet);
    }
    bet.shares += shares;
    bet.cost += shares * o.price;
    bet.price = bet.cost / bet.shares;
    logFill(o, shares);
  } else if (o.kind === 'mm-ask' || o.kind === 'exit') {
    const bet = bets.find((b) => b.id === o.betId);
    if (bet) api.applyExit(bet, shares, shares * o.price);
    if (o.kind === 'mm-ask') logFill(o, shares);
  }
  touch('bets');
}

function logFill(o, shares) {
  if (o.mode === 'shadow') return;
  try {
    db.saveDecision({ id: newId('d'), at: Date.now(), strategy: 'mm', variant: o.variant, mode: o.mode, eventId: o.eventId, conditionId: o.conditionId, token: o.token, outcome: o.outcome, side: o.side, price: o.price, pMarket: feeds.midOf(o.token), pFinal: o.ref, edge: o.side === 'BUY' ? o.ref - o.price : o.price - o.ref, stake: shares * o.price, action: 'entered', reason: `Quote filled: ${o.side === 'BUY' ? 'bought' : 'sold'} ${shares.toFixed(1)} at ${(o.price * 100).toFixed(1)}%`, live: o.live, start: o.start, title: o.title, market: o.marketLabel });
  } catch {
    /* recording is best effort */
  }
}

function expirePaperOrders() {
  const now = Date.now();
  for (const o of state.paperOrders.values()) {
    if (o.expiresAt > now) continue;
    state.paperOrders.delete(o.id);
    if (o.kind === 'entry' && o.filledShares <= 0) db.updateDecision(o.decisionId, { action: 'skipped', reason: 'Limit order not filled in 90 s' });
  }
}

// ---- exits ---------------------------------------------------------------------------

/** Sell an open bet: paper on the live book, real through the executor. */
export async function exitBet(bet, reason, minPrice = 0.01) {
  if (bet.status !== 'open' || bet.exiting) return;
  if (bet.mode === 'real') {
    const s = api.settings();
    const book = await bookFor(bet.tokenId);
    const { bid } = bestOf(book);
    const intent = api.queueIntent({ type: 'market', side: 'SELL', tokenId: bet.tokenId, conditionId: bet.conditionId, shares: bet.shares, minPrice: Math.max(minPrice, (bid ?? 0.02) - s.maxSlippage) });
    bet.exiting = intent.id;
    bet.exitReason = reason;
  } else {
    const book = await bookFor(bet.tokenId);
    const out = pm.walkBids(book, bet.shares, minPrice);
    if (!out.sold) return;
    const ev = col('events')[bet.eventId];
    const m = ev?.markets.find((x) => x.conditionId === bet.conditionId);
    const fee = pm.takerFee(m?.feeRate || 0, out.avg, out.sold);
    api.applyExit(bet, out.sold, out.proceeds - fee);
    bet.exitReason = reason;
  }
  state.stats.exits++;
  touch('bets');
  if (bet.mode !== 'shadow') logLine('info', `${bet.mode.toUpperCase()} exit ${bet.title} ${bet.outcome}: ${reason}`);
}

/** Every open position with a plan, checked against the live price. */
async function checkExits(token) {
  const now = Date.now();
  if (now - (state.lastExitCheck.get(token) || 0) < 2000) return;
  state.lastExitCheck.set(token, now);
  const b = feeds.books.get(token);
  if (!b || b.bestBid === null) return;
  const bid = b.bestBid;
  for (const bet of col('bets')) {
    if (bet.tokenId !== token || bet.status !== 'open' || !bet.plan || bet.plan.hold || bet.plan.mm || bet.exiting) continue;
    bet.mark = feeds.midOf(token) ?? bet.mark;
    const p = bet.plan;
    if (bid >= p.target) await exitBet(bet, `Target ${(p.target * 100).toFixed(1)}% reached`);
    else if (bid <= p.stop) await exitBet(bet, `Stop ${(p.stop * 100).toFixed(1)}% hit`);
    else if (now >= p.timeStop) await exitBet(bet, 'Time limit');
    else if (p.edgeExit && now - (bet.lastEdgeCheck || 0) > 15e3) {
      // The reason to hold is gone: the analysts now see it at or below the bid.
      bet.lastEdgeCheck = now;
      const ev = col('events')[bet.eventId];
      const m = ev?.markets.find((x) => x.conditionId === bet.conditionId);
      if (!ev || !m) continue;
      const { ctx, mid } = await contextFor(ev, m, bet.outcomeIndex, 15);
      if (mid === null) continue;
      const { analysts, vol } = runAnalysts(ctx);
      const comb = combine(mid, analysts, vol, 15);
      if (comb.expected <= bid - 0.005 && bid > bet.price) await exitBet(bet, `Expected ${(comb.expected * 100).toFixed(1)}% no better than the bid`);
    }
  }
}

/** The copied whale sold: every whale-strategy bet following it sells too. */
export async function mirrorWhaleExit(flag, whale) {
  if (!api.settings().mirrorExits) return 0;
  const entry = whale.entries.filter((e) => e.tokenId === flag.tokenId);
  const shares = entry.reduce((s, e) => s + (e.shares || 0), 0);
  const sold = entry.reduce((s, e) => s + (e.exitShares || 0), 0);
  if (!shares || sold / shares < 0.5) return 0;
  const mine = col('bets').filter((b) => b.status === 'open' && b.strategy === 'whale' && b.sourceWallet === whale.addr && b.tokenId === flag.tokenId && !b.exiting);
  for (const bet of mine) await exitBet(bet, 'Whale sold');
  if (mine.length) Object.assign(flag, { action: 'mirrored', actionReason: `Exit mirrored on ${mine.length} bet${mine.length > 1 ? 's' : ''}` });
  return mine.length;
}

// ---- triggers ------------------------------------------------------------------------

/** A live whale entry: every enabled whale variant considers it. */
export async function onWhaleEntry(flag, ev, m, whale) {
  const st = strategies().whale;
  if (!st.enabled) {
    Object.assign(flag, { action: 'skip', actionReason: 'Whale strategy off' });
    return;
  }
  // Champion first, so the flag shows what the main wallet did.
  const order = [st.champion, ...Object.keys(STRATEGY_DEFS.whale.variants).filter((v) => v !== st.champion)];
  for (const variantId of order) {
    const d = await consider({ strategy: 'whale', variantId, ev, m, idx: flag.outcomeIndex, flag, whale }).catch((err) => {
      logLine('error', `whale ${variantId}: ${err.message}`);
      return null;
    });
    if (variantId === st.champion && d && flag.action === 'none') Object.assign(flag, { action: 'skip', actionReason: d.reason });
  }
}

/** The swing strategy looks at one token. Throttled per token and variant. */
async function evaluateSwing(ev, m, idx, force = false) {
  const st = strategies().swing;
  if (!st.enabled) return;
  const token = m.tokens[idx];
  for (const variantId of Object.keys(STRATEGY_DEFS.swing.variants)) {
    const k = `${token}|${variantId}`;
    if (!force && Date.now() - (state.lastEval.get(k) || 0) < 10e3) continue;
    state.lastEval.set(k, Date.now());
    // Already holding this token in this variant's wallet: let the exit plan run.
    const wallet = walletFor('swing', variantId);
    if (wallet.open.some((b) => b.tokenId === token && b.strategy === 'swing')) continue;
    await consider({ strategy: 'swing', variantId, ev, m, idx }).catch((err) => logLine('error', `swing ${variantId}: ${err.message}`));
  }
}

/** Market making: keep two paper (or real) bids around the analysts' price, and asks on inventory. */
async function quoteMarket(ev, m) {
  const st = strategies().mm;
  if (!st.enabled) return;
  if ((state.quotePause.get(ev.id) || 0) > Date.now()) return;
  const t0 = m.tokens[0];
  const b0 = feeds.books.get(t0);
  if (!b0 || b0.bestBid === null || b0.bestAsk === null) return;
  const spread = b0.bestAsk - b0.bestBid;
  if (spread < 0.02) return; // nothing to earn inside a one-tick spread
  const { ctx, mid } = await contextFor(ev, m, 0, 5);
  if (mid === null || mid < 0.05 || mid > 0.95) return;
  const { analysts, vol } = runAnalysts(ctx);
  const ref = combine(mid, analysts, vol, 5).expected;
  const tick = b0.tick || 0.01;
  for (const variantId of Object.keys(STRATEGY_DEFS.mm.variants)) {
    const p = STRATEGY_DEFS.mm.variants[variantId];
    const wallet = walletFor('mm', variantId);
    if (wallet.mode === 'real') continue; // real market making waits for a promoted, explicitly allowed champion
    const half = Math.max(tick, p.spreadK * (vol.sd5 || 0.02) * 0.5);
    const inv = [0, 1].map((i) => wallet.open.filter((b) => b.strategy === 'mm' && b.tokenId === m.tokens[i]).reduce((s, b) => s + (b.cost || 0), 0));
    const skew = ((inv[0] - inv[1]) / Math.max(1, p.maxInv)) * tick * 2;
    const refs = [ref, 1 - ref];
    for (const i of [0, 1]) {
      const token = m.tokens[i];
      const bk = feeds.books.get(token);
      if (!bk || bk.bestAsk === null) continue;
      let px = Math.floor((refs[i] - half - (i === 0 ? skew : -skew)) / tick) * tick;
      px = Math.min(px, bk.bestAsk - tick);
      px = Math.round(px * 1000) / 1000;
      const key = `mm|${variantId}|${token}`;
      const existing = state.paperOrders.get(key);
      if (inv[i] >= p.maxInv || px <= 0.01) {
        if (existing) state.paperOrders.delete(key);
      } else if (!existing || Math.abs(existing.price - px) >= tick - 1e-9 || existing.expiresAt < Date.now()) {
        state.paperOrders.set(key, { id: key, kind: 'mm-bid', mode: wallet.mode, variant: variantId, token, side: 'BUY', price: px, usd: p.size, filledShares: 0, cost: 0, expiresAt: Date.now() + 60e3, ref: refs[i], eventId: ev.id, title: `${ev.teams[0]} vs ${ev.teams[1]}`, conditionId: m.conditionId, market: m.kind, marketLabel: m.kind === 'match' ? 'Match' : m.label, outcome: m.outcomes[i], outcomeIndex: i, live: ctx.live, start: ev.start });
        state.stats.quotes++;
      }
      // Offer held inventory back at the reference plus the half spread.
      for (const bet of wallet.open.filter((b) => b.strategy === 'mm' && b.tokenId === token && b.status === 'open' && b.shares > 0.5)) {
        const askKey = `mmask|${bet.id}`;
        const apx = Math.max(Math.round((Math.ceil((refs[i] + half) / tick) * tick) * 1000) / 1000, bk.bestBid !== null ? bk.bestBid + tick : 0);
        const cur = state.paperOrders.get(askKey);
        if (!cur || Math.abs(cur.price - apx) >= tick - 1e-9) {
          state.paperOrders.set(askKey, { id: askKey, kind: 'mm-ask', mode: wallet.mode, variant: variantId, token, side: 'SELL', price: apx, shares: bet.shares, filledShares: 0, cost: 0, betId: bet.id, expiresAt: Date.now() + 60e3, ref: refs[i], eventId: ev.id, title: bet.title, conditionId: m.conditionId, market: bet.market, marketLabel: bet.marketLabel, outcome: bet.outcome, outcomeIndex: i, live: ctx.live, start: ev.start });
        }
      }
    }
  }
}

/** A score changed: pull market-making quotes for 20 s and look for overreactions. */
function onScore(eventId, prev, next) {
  state.quotePause.set(eventId, Date.now() + 20e3);
  for (const o of [...state.paperOrders.values()]) if (o.eventId === eventId && o.kind.startsWith('mm')) state.paperOrders.delete(o.id);
  const ev = col('events')[eventId];
  if (!ev) return;
  ev.score = next.score;
  ev.live = next.live;
  touch('events');
  // Give the market 45 s to react, then let the swing strategy judge the jump.
  setTimeout(() => {
    for (const m of ev.markets) {
      if (m.closed || (m.kind === 'map' && !api.settings().mapMarkets)) continue;
      for (const i of [0, 1]) evaluateSwing(ev, m, i, true).catch(() => {});
    }
  }, 45e3).unref?.();
}

function onBook(token) {
  checkExits(token).catch(() => {});
}

/** The periodic sweep over hot markets: swing evaluations and quotes. */
async function sweep() {
  const events = api.hotEvents();
  for (const ev of events) {
    const live = feeds.scores.get(ev.id)?.live ?? ev.live;
    const soon = ev.start && ev.start - Date.now() < 3 * 3600e3;
    if (!live && !soon) continue;
    for (const m of ev.markets) {
      if (m.closed || !m.accepting || (m.kind === 'map' && !api.settings().mapMarkets)) continue;
      for (const i of [0, 1]) await evaluateSwing(ev, m, i);
      await quoteMarket(ev, m).catch((err) => logLine('error', `mm: ${err.message}`));
    }
  }
  expirePaperOrders();
  markBets();
}

function markBets() {
  for (const b of col('bets')) {
    if (b.status !== 'open') continue;
    const mid = feeds.midOf(b.tokenId);
    if (mid !== null) b.mark = mid;
  }
}

// ---- follow-ups (the fast learning signal) ---------------------------------------------

async function priceAtTime(token, t) {
  const mids = feeds.books.get(token)?.mids;
  if (mids?.length && mids[0][0] <= t) {
    const p = priceAt(mids, t);
    if (p !== null) return p;
  }
  try {
    const body = await pm.priceHistory({ token_id: token, as_of: Math.floor(t / 1000) });
    const pt = (body?.data || []).pop();
    return pt ? Number(pt.price) : null;
  } catch {
    return null;
  }
}

async function followups() {
  const now = Date.now();
  let budget = 40;
  for (const d of db.pendingFollowups(now)) {
    if (budget-- <= 0) break;
    const fields = {};
    if (d.m5 === null && d.at <= now - 5 * MIN) fields.m5 = await priceAtTime(d.token, d.at + 5 * MIN);
    if (d.m30 === null && d.at <= now - 30 * MIN) fields.m30 = await priceAtTime(d.token, d.at + 30 * MIN);
    if (d.close === null && !d.live && d.start && d.start <= now) fields.close = await priceAtTime(d.token, d.start);
    for (const k of Object.keys(fields)) if (fields[k] === null) delete fields[k];
    if (Object.keys(fields).length) db.updateDecision(d.id, fields);
  }
}

/** A market resolved: every decision on it gets its result and $1 P&L. */
export function onSettle(conditionId, tokens, win) {
  for (const d of db.decisionsForCondition(conditionId)) {
    const idx = tokens.indexOf(d.token);
    const result = win === -1 ? 0.5 : win === idx ? 1 : 0;
    const pnl = d.price > 0 ? (d.side === 'BUY' ? result / d.price - 1 : 1 - result / d.price) : null;
    db.updateDecision(d.id, { result, pnl });
  }
}

// ---- lifecycle -------------------------------------------------------------------------

let listening = false;
/** Engine hooks, and the feed listeners (passive: they only act on what the feeds deliver). */
export function initBrain(hooks) {
  api = hooks;
  if (listening) return;
  listening = true;
  feeds.on('trade', onTrade);
  feeds.on('score', onScore);
  feeds.on('book', onBook);
}

export function startBrain() {
  if (state.started) return;
  state.started = true;
  strategies();
  const every = (fn, ms) => {
    const loop = async () => {
      if (api.settings().tracking) {
        try {
          await fn();
        } catch (err) {
          logLine('error', `brain: ${err.message}`);
        }
      }
      const t = setTimeout(loop, ms);
      t.unref?.();
    };
    const t = setTimeout(loop, 8000);
    t.unref?.();
  };
  every(sweep, 5000);
  every(followups, 30e3);
}

export const _state = state;
