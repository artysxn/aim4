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
// Strategies run as bots (bots.js): each with its own settings, stake rule,
// paper wallet or the real one. Every enabled bot sees every signal, so bots
// with different settings can be compared on the same matches.
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
import { activeBots, botById, stakeFor, autoStake, comebackRules } from './bots.js';

const newId = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const MIN = 60e3;

let api = null; // engine hooks, set by initBrain
const state = {
  started: false,
  timers: [],
  lastEval: new Map(), // token|bot -> t
  lastRecorded: new Map(), // token|bot -> t (skips)
  lastExitCheck: new Map(),
  paperOrders: new Map(), // id -> order
  scoreChangedAt: new Map(), // eventId -> t
  teamRows: null,
  teamRowsAt: 0,
  stats: { decisions: 0, entered: 0, exits: 0, quotes: 0, fills: 0, reviews: 0, vetoes: 0 }
};
export const brainStatus = () => ({ ...state.stats, paperOrders: state.paperOrders.size, started: state.started });

const botsOn = () => api.settings().botsOn !== false;
const openOf = (bets) => bets.filter((b) => b.status === 'open' || b.status === 'pending');

/** Why a real-money bot cannot trade right now, or '' when it can. */
export function realBlocker() {
  if (!botsOn()) return 'Bots are switched off';
  if (!col('executor').armed) return 'Real trading not armed';
  if (!api.onlineDevice()) return 'PC executor offline';
  return '';
}

/**
 * The wallet a bot trades: its own paper wallet, or the shared real one.
 * `open` is what risk checks run against (the whole real wallet for a real
 * bot); `mine` is the bot's own share of it.
 */
export function walletFor(bot) {
  const all = col('bets');
  if (bot.mode === 'real') {
    const w = api.realWallet();
    const real = all.filter((b) => b.mode === 'real');
    const mine = real.filter((b) => b.botId === bot.id);
    const t = betTotals(mine);
    return { mode: 'real', bankroll: w.equity ?? 0, today: t.today, open: openOf(real), mine: openOf(mine), mineCost: t.openCost, blocker: realBlocker() };
  }
  const mine = all.filter((b) => b.mode === 'sim' && b.botId === bot.id && b.placedAt >= (bot.paperEpoch || 0));
  const t = betTotals(mine);
  return { mode: 'sim', bankroll: bot.paperBankroll + t.realized + t.openMark - t.openCost, today: t.today, open: openOf(mine), mine: openOf(mine), mineCost: t.openCost, blocker: '' };
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
export async function consider({ bot, ev, m, idx, flag = null, whale = null, leg = '' }) {
  const s = api.settings();
  const strategy = bot.type;
  const variantId = bot.id;
  const params = bot.params;
  const horizon = strategy === 'swing' ? params.horizon : 30;
  const wallet = walletFor(bot);
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
    // Comeback bots trade two legs per match: 'pre' (backing a listed team before the start) and 'comeback'.
    leg: strategy === 'comeback' ? leg || 'comeback' : '',
    action: 'skipped',
    reason: ''
  };
  const finish = (action, reason) => {
    decision.action = action;
    decision.reason = reason;
    return record(decision);
  };

  if (mid === null || ask === null) return finish('skipped', 'No order book');
  const cb = strategy === 'comeback' ? comebackRules(params, { game: ev.game, team: m.outcomes[idx], opponent: m.outcomes[1 - idx] }) : null;
  const sameLeg = (x) => strategy !== 'comeback' || (x.leg || 'comeback') === decision.leg;
  const { analysts, vol } = runAnalysts(ctx);
  const comb = combine(mid, analysts, vol, horizon);
  decision.analysts = analysts;
  decision.combined = { expected: comb.expected, shift: comb.shift, sd: comb.sd, horizon };
  decision.pMarket = mid;
  decision.pFinal = comb.expected;

  if (wallet.blocker) return finish('skipped', wallet.blocker);

  // Size before the edge check: the edge depends on how deep we walk the book.
  let target;
  if (bot.sizing.kind === 'auto') {
    const a = autoStake({ bankroll: wallet.bankroll, maxStake: bot.maxStake, minStake: bot.minStake, ...autoInputs(bot, wallet) });
    decision.sizing = a;
    if (!a.stake) return finish('skipped', `Auto stake: ${a.reason}`);
    target = a.stake;
  } else target = stakeFor(bot, wallet.bankroll);
  if (strategy === 'whale' || strategy === 'fade' || strategy === 'comeback') {
    // The whale stake is per match: what this bot already put on it counts.
    const already = wallet.mine.filter((x) => x.eventId === ev.id && sameLeg(x)).reduce((sum, x) => sum + (x.cost || x.amount || 0), 0);
    target -= already;
    if (target < bot.minStake) {
      decision.analysts = [];
      return finish('skipped', already > 0 ? 'Match stake already in' : 'Stake under minimum');
    }
  }
  target = Math.floor(target * 100) / 100;

  let maxPrice;
  if (strategy === 'whale') maxPrice = Math.min(params.maxEntry, flag.price + params.maxSlippage);
  else if (strategy === 'fade') maxPrice = Math.min(params.maxEntry, 1 - flag.price + params.maxSlippage);
  else if (strategy === 'comeback') maxPrice = decision.leg === 'pre' ? Math.min(params.backMaxPrice ?? 0.85, mid + params.maxSlippage) : (cb.collapseAt ?? params.collapseAt) + params.maxSlippage;
  else if (strategy === 'value') maxPrice = params.priceMax;
  else maxPrice = Math.min(0.97, comb.expected - params.minEdge);
  const fill = pm.walkAsks(book, target, maxPrice);
  const maker = (strategy === 'swing' || strategy === 'value') && params.maker && ask - (bid ?? 0) >= 0.02;
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

  // The bot's own rules.
  if (strategy === 'whale') {
    if (!flag) return finish('skipped', 'No flag');
    if (whale?.ignore) return finish('skipped', 'Wallet ignored');
    const followed = Boolean(whale?.follow);
    if (params.followedOnly && !followed) return finish('skipped', 'Not a followed wallet');
    if (!followed && flag.score < params.minScore) return finish('skipped', `Score ${flag.score} under ${params.minScore}`);
    if (params.needs?.length && !flag.reasons.some((r) => params.needs.includes(r.key))) return finish('skipped', `Needs ${params.needs.join(' or ')}`);
    const banned = flag.reasons.find((r) => (params.excludes || []).includes(r.key));
    if (banned) return finish('skipped', `Excluded: ${banned.key}`);
    if ((flag.stackCash || flag.cash) < params.minWhaleCash) return finish('skipped', `Whale bet under $${params.minWhaleCash}`);
    if (flag.price > params.maxWhalePrice) return finish('skipped', `Whale paid over ${Math.round(params.maxWhalePrice * 100)}%`);
    if (flag.price < (params.minWhalePrice || 0)) return finish('skipped', `Whale paid under ${Math.round(params.minWhalePrice * 100)}%`);
    if (params.maxWhaleCash && (flag.stackCash || flag.cash) > params.maxWhaleCash) return finish('skipped', `Whale total over $${params.maxWhaleCash}`);
    if (params.requireEdge && e.edge < params.minEdge) return finish('skipped', `Edge ${(e.edge * 100).toFixed(1)}c under ${(params.minEdge * 100).toFixed(1)}c`);
    if (m.kind === 'map' && !params.copyMaps) return finish('skipped', 'Map markets not copied');
    if (ctx.live && !params.copyLive) return finish('skipped', 'Live bets not copied');
    if (!ctx.live && !params.copyPrematch) return finish('skipped', 'Pre-match bets not copied');
    if (params.skipLosers && !followed && whale) {
      const rec = api.walletRecord(whale);
      if (rec.resolved >= params.loserMinResolved && rec.edge !== null && rec.edge < 0) return finish('skipped', `Losing record ${rec.wins}/${rec.resolved}`);
    }
  } else if (strategy === 'fade') {
    if (!flag) return finish('skipped', 'No flag');
    if (m.kind !== 'match') return finish('skipped', 'Match winner only');
    if (flag.price > params.maxWhalePrice) return finish('skipped', `Underdog priced over ${Math.round(params.maxWhalePrice * 100)}%`);
    if (params.formats?.length && ev.format && !params.formats.includes(ev.format)) return finish('skipped', `${ev.format} not traded`);
    if (params.prematchOnly && (ctx.live || !(ev.start > Date.now()))) return finish('skipped', 'Match already started');
    const buys = flag.underdogBuys || 0;
    if (buys < params.minBuys) return finish('skipped', `${buys} of ${params.minBuys} underdog buys so far`);
    if (wallet.mine.some((x) => x.eventId === ev.id)) return finish('skipped', 'Already in this match');
  } else if (strategy === 'comeback' && decision.leg === 'pre') {
    if (cb.skip) return finish('skipped', cb.skip);
    if (!cb.listed || !params.backListed) return finish('skipped', 'Not a listed team');
    const mins = (ev.start - Date.now()) / MIN;
    if (ctx.live || mins < 0 || mins > (params.backWindowMax || 30)) return finish('skipped', 'Outside the window before the start');
    if (mid > (params.backMaxPrice ?? 0.85)) return finish('skipped', `At ${Math.round(mid * 100)}%, over ${Math.round((params.backMaxPrice ?? 0.85) * 100)}%`);
    if (wallet.mine.some((x) => x.eventId === ev.id && sameLeg(x))) return finish('skipped', 'Already backed this match');
  } else if (strategy === 'comeback') {
    if (cb.skip) return finish('skipped', cb.skip);
    if (!ctx.live) return finish('skipped', 'Not live');
    if (m.kind === 'map' && !params.maps) return finish('skipped', 'Map markets off');
    const game = ev.game || 'cs2';
    if (params.games?.length && !params.games.includes(game)) return finish('skipped', `${game} not traded`);
    const minsIn = (Date.now() - ev.start) / MIN;
    if (cb.maxMinutes && minsIn > cb.maxMinutes) return finish('skipped', `${Math.round(minsIn)} min in, over ${cb.maxMinutes}`);
    if (cb.formats?.length && ev.format && !cb.formats.includes(ev.format)) return finish('skipped', `${ev.format} not traded`);
    if (params.lowTierOnly && game === 'cs2' && !(ev.vrs || []).every((r) => !r || r > 30)) return finish('skipped', 'A VRS top-30 team plays');
    if (params.lowTierOnly && game !== 'cs2' && Number(ev.tier) >= 1 && Number(ev.tier) <= 2) return finish('skipped', `League tier ${ev.tier}`);
    const pre = col('prices')[m.conditionId]?.pre?.[idx];
    if (!Number.isFinite(pre)) return finish('skipped', 'No start price');
    if (pre < cb.preMin) return finish('skipped', `Started at ${Math.round(pre * 100)}%, under ${Math.round(cb.preMin * 100)}%`);
    if (mid > cb.collapseAt) return finish('skipped', `At ${Math.round(mid * 100)}%, not down to ${Math.round(cb.collapseAt * 100)}%`);
    if (cb.minDrop) {
      const drop = recentDrop(m, idx, mid);
      decision.drop = drop;
      if (drop < cb.minDrop) return finish('skipped', `Fell ${Math.round(drop * 100)} pts in 10 min, under ${Math.round(cb.minDrop * 100)}`);
    }
    if (wallet.mine.some((x) => x.eventId === ev.id && sameLeg(x))) return finish('skipped', 'Already in this match');
  } else if (strategy === 'value') {
    const mins = (ev.start - Date.now()) / MIN;
    if (ctx.live || mins > params.windowMax || mins < params.windowMin) return finish('skipped', 'Outside the start window');
    if (mid < params.priceMin || mid > params.priceMax) return finish('skipped', 'Price outside the band');
    if (params.formats?.length && ev.format && !params.formats.includes(ev.format)) return finish('skipped', `${ev.format} not traded`);
    if (wallet.mine.some((x) => x.eventId === ev.id)) return finish('skipped', 'Already in this match');
  } else if (strategy === 'swing') {
    if (mid < params.priceMin || mid > params.priceMax) return finish('skipped', 'Price outside the band');
    if (ctx.live && !params.live) return finish('skipped', 'Live trading off');
    if (!ctx.live && !params.prematch) return finish('skipped', 'Pre-match trading off');
    if (params.afterScore && !(analysts.find((a) => a.key === 'overreaction')?.conf > 0)) return finish('skipped', 'No recent score change');
    if (e.edge < params.minEdge) return finish('skipped', `Edge ${(e.edge * 100).toFixed(1)}c under ${(params.minEdge * 100).toFixed(1)}c`);
    if (comb.sd > 0 && e.edge / comb.sd < 0.25) return finish('skipped', `Edge small against the uncertainty (${(comb.sd * 100).toFixed(1)}c)`);
  }
  if (m.closed || !m.accepting) return finish('skipped', 'Market not taking orders');
  if (!maker && fill.shares <= 0) return finish('skipped', `No asks under ${(maxPrice * 100).toFixed(0)}%`);

  // The bot's own exposure, then the risk gate against the whole wallet.
  if (strategy === 'swing') target = Math.min(target * clamp(e.edge / params.minEdge, 0.5, 2), bot.maxStake);
  const ownRoom = wallet.bankroll * (bot.maxOpenPct / 100) - wallet.mineCost;
  if (ownRoom < bot.minStake) return finish('skipped', `Bot open-bets limit (${bot.maxOpenPct}% of wallet)`);
  target = Math.min(target, ownRoom);
  if (wallet.mode === 'real' && wallet.today <= -wallet.bankroll * (bot.dailyLossPct / 100)) return finish('skipped', 'Bot daily loss stop');
  const limits = wallet.mode === 'real' ? { ...s, minStake: bot.minStake } : { ...s, minStake: bot.minStake, maxOpenPct: bot.maxOpenPct, dailyLossPct: bot.dailyLossPct };
  const risk = riskGate({
    cand: { eventId: ev.id, conditionId: m.conditionId, tokenId: token, outcome: m.outcomes[idx], side: 'BUY', stake: target, price: e.px, needsExit: strategy === 'swing', start: ev.start, live: ctx.live },
    open: wallet.open,
    bankroll: wallet.bankroll,
    todayPnl: wallet.today,
    limits,
    exitDepth: ctx.depth,
    spread: ask - (bid ?? ask),
    rules: ev.rules
  });
  decision.risk = risk;
  decision.stake = risk.stake;
  if (!risk.ok) return finish('skipped', `Risk: ${risk.checks.filter((c) => !c.ok).map((c) => c.key).join(', ')}`);
  if (wallet.mode === 'real' && risk.stake + (api.realWallet().todayStaked || 0) > s.realDailyCap) return finish('skipped', `Real daily cap $${s.realDailyCap} reached`);

  // Exit plan, sized to how much this market usually moves.
  const sdH = (vol.sd5 || 0.03) * Math.sqrt(horizon / 5);
  decision.plan =
    strategy === 'whale' || strategy === 'value' || strategy === 'fade' || strategy === 'comeback'
      ? { hold: true, mirror: Boolean(params.mirrorExits), sellAt: strategy === 'comeback' ? (decision.leg === 'pre' ? 0 : cb.sellAt || 0) : params.sellAt || 0 }
      : { target: Math.min(0.99, e.px + Math.max(params.minEdge, params.targetK * sdH)), stop: Math.max(0.01, e.px - Math.max(0.03, params.stopK * sdH)), timeStop: Date.now() + horizon * params.timeMult * MIN, edgeExit: params.edgeExit };

  // A pre-match bet of real size gets a second opinion first.
  const wantsReview = s.reviewer && bot.review && !ctx.live && ev.start - Date.now() > 10 * MIN && risk.stake >= s.reviewMinStake && reviewerConfigured();
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
      await execute(decision, { ev, m, idx, book: fresh, maxPrice, maker, makerPx, flag, wallet, bot });
    });
    return decision;
  }
  await execute(decision, { ev, m, idx, book, maxPrice, maker, makerPx, flag, wallet, bot });
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

/**
 * What the automatic stake reads from the bot's own record: how far over the
 * mid its last 30 fills ran (null under 10 fills), and how far its wallet is
 * below its best point.
 */
export function autoInputs(bot, wallet) {
  const mine = col('bets')
    .filter((b) => b.botId === bot.id && b.mode === (bot.mode === 'real' ? 'real' : 'sim') && (bot.mode === 'real' || b.placedAt >= (bot.paperEpoch || 0)))
    .sort((a, b) => a.placedAt - b.placedAt);
  const fills = mine.filter((b) => Number.isFinite(b.price) && Number.isFinite(b.midAt)).slice(-30);
  const fillCost = fills.length >= 10 ? fills.reduce((s, b) => s + (b.price - b.midAt), 0) / fills.length : null;
  let run = 0, peak = 0;
  for (const b of mine.filter((x) => x.status === 'won' || x.status === 'lost' || x.status === 'sold' || x.status === 'void').sort((a, c) => (a.settledAt || 0) - (c.settledAt || 0))) {
    run += (Number(b.payout) || 0) - (Number(b.cost) || 0);
    peak = Math.max(peak, run);
  }
  const base = wallet.bankroll - run;
  const drawdown = base + peak > 0 ? Math.max(0, (peak - run) / (base + peak)) : 0;
  return { fillCost, drawdown };
}

function newBet(decision, fields) {
  return {
    id: newId('b'),
    mode: decision.mode,
    botId: decision.variant,
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
    leg: decision.leg || '',
    // The mid when the bot decided: fill price minus this is what the automatic stake measures.
    midAt: Number.isFinite(decision.pMarket) ? decision.pMarket : null,
    live: decision.live,
    plan: decision.plan,
    ...fields
  };
}

async function execute(decision, { m, idx, book, maxPrice, maker, makerPx, bot }) {
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
    decision.reason = `Real ${maker ? 'limit' : 'market'} order $${stake.toFixed(2)} up to ${(maxPrice * 100).toFixed(1)}%`;
    logLine('info', `REAL ${bot?.name || decision.variant}: ${decision.title} ${decision.outcome} ${decision.reason}`);
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
    decision.reason = `Paper $${bet.cost.toFixed(2)} at ${(fill.avg * 100).toFixed(1)}%`;
    state.stats.entered++;
  }
  record(decision);
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
    let bet = bets.find((b) => b.strategy === 'mm' && b.botId === o.variant && b.tokenId === o.token && b.status === 'open' && b.mode === o.mode);
    if (!bet) {
      bet = { id: newId('b'), mode: o.mode, botId: o.variant, strategy: 'mm', variant: o.variant, status: 'open', eventId: o.eventId, title: o.title, conditionId: o.conditionId, market: o.market, marketLabel: o.marketLabel, tokenId: o.token, outcome: o.outcome, outcomeIndex: o.outcomeIndex, placedAt: Date.now(), shares: 0, cost: 0, price: o.price, mark: o.price, fee: 0, plan: { mm: true } };
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
  if (bet.mode === 'real') logLine('info', `REAL exit ${bet.title} ${bet.outcome}: ${reason}`);
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
    if (bet.tokenId !== token || bet.status !== 'open' || !bet.plan || bet.plan.mm || bet.exiting) continue;
    bet.mark = feeds.midOf(token) ?? bet.mark;
    const p = bet.plan;
    if (p.hold) {
      if (p.sellAt && bid >= p.sellAt) await exitBet(bet, `Take profit at ${Math.round(p.sellAt * 100)}%`);
      continue;
    }
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

/** The copied whale sold: every whale bot that follows exits and holds a copy sells too. */
export async function mirrorWhaleExit(flag, whale) {
  const entry = whale.entries.filter((e) => e.tokenId === flag.tokenId);
  const shares = entry.reduce((sum, e) => sum + (e.shares || 0), 0);
  const sold = entry.reduce((sum, e) => sum + (e.exitShares || 0), 0);
  if (!shares || sold / shares < 0.5) return 0;
  const mine = col('bets').filter((b) => b.status === 'open' && b.strategy === 'whale' && b.sourceWallet === whale.addr && b.tokenId === flag.tokenId && !b.exiting && (botById(b.botId)?.params.mirrorExits ?? b.plan?.mirror ?? true));
  for (const bet of mine) await exitBet(bet, 'Whale sold');
  if (mine.length) Object.assign(flag, { action: 'mirrored', actionReason: `Exit mirrored on ${mine.length} bet${mine.length > 1 ? 's' : ''}` });
  return mine.length;
}

/**
 * A live whale entry: every whale bot that is on considers it. The flag ends
 * up saying what happened: a real order beats a paper copy beats a skip.
 */
export async function onWhaleEntry(flag, ev, m, whale) {
  const bots = activeBots('whale', botsOn());
  // Fade bots take the other side of the underdog money, so they count every
  // big underdog buy on this team in this match, this one included.
  const fades = m.kind === 'match' && m.outcomes.length === 2 ? activeBots('fade', botsOn()) : [];
  if (fades.length) {
    flag.underdogBuys = col('flags').filter((f) => f.eventId === ev.id && f.market === 'match' && f.kind === 'entry' && f.outcomeIndex === flag.outcomeIndex).length + 1;
    const fadeCopies = [];
    for (const bot of fades) {
      const d = await consider({ bot, ev, m, idx: 1 - flag.outcomeIndex, flag, whale }).catch((err) => {
        logLine('error', `fade bot ${bot.name}: ${err.message}`);
        return null;
      });
      if (d) fadeCopies.push({ botId: bot.id, name: bot.name, mode: d.mode, action: d.action, reason: d.reason, betId: d.betId || null });
    }
    flag.fades = fadeCopies;
  }
  if (!bots.length) {
    Object.assign(flag, { action: 'skip', actionReason: botsOn() ? 'No whale bot is on' : 'Bots are switched off' });
    return;
  }
  const copies = [];
  for (const bot of bots) {
    const d = await consider({ bot, ev, m, idx: flag.outcomeIndex, flag, whale }).catch((err) => {
      logLine('error', `whale bot ${bot.name}: ${err.message}`);
      return null;
    });
    if (d) copies.push({ botId: bot.id, name: bot.name, mode: d.mode, action: d.action, reason: d.reason, betId: d.betId || null });
  }
  flag.copies = copies;
  const real = copies.find((c) => c.action === 'queued');
  const paper = copies.filter((c) => c.action === 'entered');
  if (real) Object.assign(flag, { action: 'queued', actionReason: `${real.name}: ${real.reason}`, betId: real.betId });
  else if (paper.length) Object.assign(flag, { action: 'copied', actionReason: paper.length === 1 ? `${paper[0].name}: ${paper[0].reason}` : `Copied by ${paper.length} paper bots`, betId: paper[0].betId });
  else if (copies[0]) Object.assign(flag, { action: 'skip', actionReason: copies.length === 1 ? copies[0].reason : `No bot copied (${copies[0].name}: ${copies[0].reason})` });
}

/** Swing bots look at one token. Throttled per token and bot. */
async function evaluateSwing(ev, m, idx, force = false) {
  const token = m.tokens[idx];
  for (const bot of activeBots('swing', botsOn())) {
    if (m.kind === 'map' && !bot.params.maps) continue;
    const k = `${token}|${bot.id}`;
    if (!force && Date.now() - (state.lastEval.get(k) || 0) < 10e3) continue;
    state.lastEval.set(k, Date.now());
    // Already holding this token: its exit plan runs instead.
    if (walletFor(bot).mine.some((b) => b.tokenId === token)) continue;
    await consider({ bot, ev, m, idx }).catch((err) => logLine('error', `swing bot ${bot.name}: ${err.message}`));
  }
}

/** Market-making bots keep two bids around the analysts' price, and asks on inventory. Paper only. */
async function quoteMarket(ev, m) {
  const bots = activeBots('mm', botsOn()).filter((b) => b.mode === 'paper' && (m.kind === 'match' || b.params.maps));
  if (!bots.length) return;
  const t0 = m.tokens[0];
  const b0 = feeds.books.get(t0);
  if (!b0 || b0.bestBid === null || b0.bestAsk === null) return;
  const spread = b0.bestAsk - b0.bestBid;
  const { ctx, mid } = await contextFor(ev, m, 0, 5);
  if (mid === null) return;
  const { analysts, vol } = runAnalysts(ctx);
  const ref = combine(mid, analysts, vol, 5).expected;
  const tick = b0.tick || 0.01;
  const sinceScore = Date.now() - (state.scoreChangedAt.get(ev.id) || 0);
  for (const bot of bots) {
    const p = bot.params;
    if (spread < p.minSpread - 1e-9 || mid < p.priceMin || mid > p.priceMax || sinceScore < p.pauseSec * 1000) continue;
    const wallet = walletFor(bot);
    const size = stakeFor(bot, wallet.bankroll);
    if (size < bot.minStake) continue;
    const half = Math.max(tick, p.spreadK * (vol.sd5 || 0.02) * 0.5);
    const inv = [0, 1].map((i) => wallet.mine.filter((b) => b.tokenId === m.tokens[i]).reduce((sum, b) => sum + (b.cost || 0), 0));
    const skew = ((inv[0] - inv[1]) / Math.max(1, p.maxInv)) * tick * 2;
    const refs = [ref, 1 - ref];
    for (const i of [0, 1]) {
      const token = m.tokens[i];
      const bk = feeds.books.get(token);
      if (!bk || bk.bestAsk === null) continue;
      let px = Math.floor((refs[i] - half - (i === 0 ? skew : -skew)) / tick) * tick;
      px = Math.min(px, bk.bestAsk - tick);
      px = Math.round(px * 1000) / 1000;
      const key = `mm|${bot.id}|${token}`;
      const existing = state.paperOrders.get(key);
      const room = Math.min(p.maxInv - inv[i], wallet.bankroll * (bot.maxOpenPct / 100) - wallet.mineCost);
      if (room < bot.minStake || px <= 0.01) {
        if (existing) state.paperOrders.delete(key);
      } else if (!existing || Math.abs(existing.price - px) >= tick - 1e-9 || existing.expiresAt < Date.now()) {
        state.paperOrders.set(key, { id: key, kind: 'mm-bid', mode: 'sim', variant: bot.id, token, side: 'BUY', price: px, usd: Math.min(size, room), filledShares: 0, cost: 0, expiresAt: Date.now() + 60e3, ref: refs[i], eventId: ev.id, title: `${ev.teams[0]} vs ${ev.teams[1]}`, conditionId: m.conditionId, market: m.kind, marketLabel: m.kind === 'match' ? 'Match' : m.label, outcome: m.outcomes[i], outcomeIndex: i, live: ctx.live, start: ev.start });
        state.stats.quotes++;
      }
      // Offer held inventory back at the reference plus the half spread.
      for (const bet of wallet.mine.filter((b) => b.tokenId === token && b.status === 'open' && b.shares > 0.5)) {
        const askKey = `mmask|${bet.id}`;
        const apx = Math.max(Math.round(Math.ceil((refs[i] + half) / tick) * tick * 1000) / 1000, bk.bestBid !== null ? bk.bestBid + tick : 0);
        const cur = state.paperOrders.get(askKey);
        if (!cur || Math.abs(cur.price - apx) >= tick - 1e-9) {
          state.paperOrders.set(askKey, { id: askKey, kind: 'mm-ask', mode: 'sim', variant: bot.id, token, side: 'SELL', price: apx, shares: bet.shares, filledShares: 0, cost: 0, betId: bet.id, expiresAt: Date.now() + 60e3, ref: refs[i], eventId: ev.id, title: bet.title, conditionId: m.conditionId, market: bet.market, marketLabel: bet.marketLabel, outcome: bet.outcome, outcomeIndex: i, live: ctx.live, start: ev.start });
        }
      }
    }
  }
}

/** A score changed: pull market-making quotes and look for overreactions. */
function onScore(eventId, prev, next) {
  state.scoreChangedAt.set(eventId, Date.now());
  for (const o of [...state.paperOrders.values()]) if (o.eventId === eventId && o.kind.startsWith('mm')) state.paperOrders.delete(o.id);
  const ev = col('events')[eventId];
  if (!ev) return;
  ev.score = next.score;
  ev.live = next.live;
  touch('events');
  // Give the market 45 s to react, then let the swing bots judge the jump.
  setTimeout(() => {
    for (const m of ev.markets) {
      if (m.closed) continue;
      for (const i of [0, 1]) evaluateSwing(ev, m, i, true).catch(() => {});
    }
  }, 45e3).unref?.();
}

function onBook(token) {
  checkExits(token).catch(() => {});
}

/**
 * Comeback bots: a live team that started at preMin or more and has fallen to
 * collapseAt. Cheap checks first; the full decision runs only on a collapse.
 */
/** Mids seen in the last 15 minutes per token (sampled every sweep), for "how fast did it fall". */
const midHist = new Map();
function noteMid(token, mid, now = Date.now()) {
  if (mid === null || !Number.isFinite(mid)) return;
  const h = midHist.get(token) || [];
  h.push([now, mid]);
  while (h.length && now - h[0][0] > 15 * MIN) h.shift();
  midHist.set(token, h);
}
/**
 * How far this outcome fell in the last 10 minutes: the highest price seen
 * since then minus now. Reads both the sweep's mids and the trade-price series.
 */
export function recentDrop(m, idx, mid, now = Date.now()) {
  let hi = mid;
  for (const [t, p] of midHist.get(m.tokens[idx]) || []) if (now - t <= 10 * MIN) hi = Math.max(hi, p);
  for (const [t, p0] of col('prices')[m.conditionId]?.series || []) if (now - t <= 10 * MIN) hi = Math.max(hi, idx === 0 ? p0 : 1 - p0);
  return Math.max(0, hi - mid);
}

async function evaluateComeback(ev, m, idx) {
  const bots = activeBots('comeback', botsOn());
  if (!bots.length) return;
  const token = m.tokens[idx];
  const mid = feeds.midOf(token);
  noteMid(token, mid);
  const pre = col('prices')[m.conditionId]?.pre?.[idx];
  if (mid === null || !Number.isFinite(pre)) return;
  for (const bot of bots) {
    const p = bot.params;
    if (m.kind === 'map' && !p.maps) continue;
    const game = ev.game || 'cs2';
    if (p.games?.length && !p.games.includes(game)) continue;
    const r = comebackRules(p, { game, team: m.outcomes[idx], opponent: m.outcomes[1 - idx] });
    if (r.skip || pre < r.preMin || mid > r.collapseAt) continue;
    if (r.maxMinutes && (Date.now() - ev.start) / MIN > r.maxMinutes) continue;
    if (r.minDrop && recentDrop(m, idx, mid) < r.minDrop) continue;
    const k = `${token}|${bot.id}`;
    if (Date.now() - (state.lastEval.get(k) || 0) < 5e3) continue;
    state.lastEval.set(k, Date.now());
    if (walletFor(bot).mine.some((b) => b.eventId === ev.id && (b.leg || 'comeback') === 'comeback')) continue;
    await consider({ bot, ev, m, idx, leg: 'comeback' }).catch((err) => logLine('error', `comeback bot ${bot.name}: ${err.message}`));
  }
}

/** Comeback bots that back their listed teams: once a minute inside the window before the start. */
async function evaluatePrematchBack(ev, m, idx) {
  if (m.kind !== 'match' || (ev.game || 'cs2') !== 'cs2') return;
  for (const bot of activeBots('comeback', botsOn())) {
    const p = bot.params;
    if (!p.backListed || !(p.holdTeams || []).length) continue;
    const r = comebackRules(p, { game: 'cs2', team: m.outcomes[idx], opponent: m.outcomes[1 - idx] });
    if (!r.listed) continue;
    const mins = (ev.start - Date.now()) / MIN;
    if (mins < 0 || mins > (p.backWindowMax || 30)) continue;
    const k = `pre|${m.tokens[idx]}|${bot.id}`;
    if (Date.now() - (state.lastEval.get(k) || 0) < 60e3) continue;
    state.lastEval.set(k, Date.now());
    if (walletFor(bot).mine.some((b) => b.eventId === ev.id && b.leg === 'pre')) continue;
    await consider({ bot, ev, m, idx, leg: 'pre' }).catch((err) => logLine('error', `comeback bot ${bot.name} (pre): ${err.message}`));
  }
}

/** Start-price bots: once a minute per token inside their window before the start. */
async function evaluateValue(ev, m, idx) {
  const token = m.tokens[idx];
  for (const bot of activeBots('value', botsOn())) {
    if (m.kind === 'map' && !bot.params.maps) continue;
    const mins = (ev.start - Date.now()) / MIN;
    if (mins > bot.params.windowMax || mins < bot.params.windowMin) continue;
    const k = `${token}|${bot.id}`;
    if (Date.now() - (state.lastEval.get(k) || 0) < 60e3) continue;
    state.lastEval.set(k, Date.now());
    if (walletFor(bot).mine.some((b) => b.eventId === ev.id)) continue;
    await consider({ bot, ev, m, idx }).catch((err) => logLine('error', `value bot ${bot.name}: ${err.message}`));
  }
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
      // (bots decide for themselves whether map markets are theirs)
      for (const i of [0, 1]) await evaluateSwing(ev, m, i);
      if (live) for (const i of [0, 1]) await evaluateComeback(ev, m, i);
      if (!live) for (const i of [0, 1]) await evaluateValue(ev, m, i);
      if (!live) for (const i of [0, 1]) await evaluatePrematchBack(ev, m, i);
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
