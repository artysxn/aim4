// ---------------------------------------------------------------------------
// server/insights/routes.js - /api/insights/*
//
// Owner only. Everyone else, signed in or not, gets the same 404 an unknown
// path gets, so the feature is not discoverable from outside.
//
//   GET    /api/insights/access              200 for the owner
//   GET    /api/insights/overview            mode, wallets, live and next matches, latest signals
//   GET    /api/insights/matches?scope=      tracked matches (live|upcoming|finished|all)
//   GET    /api/insights/matches/:id         one match: markets, price track, signals, our bets
//   GET    /api/insights/whales?sort=        wallets with flagged bets and their records
//   GET    /api/insights/whales/:addr        one wallet
//   PATCH  /api/insights/whales/:addr        { follow?, ignore?, note? }
//   GET    /api/insights/signals             flagged trades
//   GET    /api/insights/bets?mode=          our paper or real bets
//   GET    /api/insights/stats?line=&min=    team underdog table, calibration, score check
//   GET    /api/insights/settings            settings, VRS snapshot, executor devices
//   PUT    /api/insights/settings            patch settings
//   POST   /api/insights/preview             how many open matches draft rules would track
//   POST   /api/insights/refresh             run discovery + watch now
//   POST   /api/insights/backfill            { days }
//   GET    /api/insights/backtest-bot        history pack size and the bots
//   POST   /api/insights/backtest-bot        { bot, days, start, extraSlip } -> replay with the bot's stake rule
//   POST   /api/insights/sim/reset           start a fresh paper wallet
//   POST   /api/insights/real/arm            { confirm: 'REAL' }
//   POST   /api/insights/real/disarm
//   POST   /api/insights/executor/link       { name } -> one-time device token
//   DELETE /api/insights/executor/devices/:id
//
// The PC executor authenticates with its device token instead of a session:
//   POST   /api/insights/executor/poll       -> { armed, mode, intents }
//   POST   /api/insights/executor/report     { id, ok, orderId, status, spent, shares, error }
//   POST   /api/insights/executor/heartbeat  { balance, wallet, signer, geo, sdk, error }
// ---------------------------------------------------------------------------

import { whoami } from '../replays/identity.js';
import { localMode, OWNER_ID } from '../local/mode.js';
import { col, touch } from './store.js';
import * as engine from './engine.js';
import { betTotals, calibration, teamTable, walletRecord } from './stats.js';
import * as brain from './brain.js';
import * as db from './db.js';
import * as learn from './learn.js';
import * as backtest from './backtest.js';
import * as feeds from './feeds.js';
import { recStatus, diskUsage } from './recorder.js';
import { reviewStatus, reviewerConfigured } from './review.js';
import { getWeights } from './analysts.js';
import { tables as reactionTables, MOVE_LABELS } from './reaction.js';
import { learnedPoints } from './signals.js';
import * as botsMod from './bots.js';
import { botBacktest } from './botbacktest.js';
import { packInfo } from './history.js';

/** One bot with its results: paper wallet, real share, decisions against later prices. */
function botRow(bot, clv) {
  const bets = col('bets').filter((b) => b.botId === bot.id);
  const paperBets = bets.filter((b) => b.mode === 'sim' && b.placedAt >= (bot.paperEpoch || 0));
  const realBets = bets.filter((b) => b.mode === 'real');
  const settledCost = (list) => list.filter((b) => b.settledAt && ['won', 'lost', 'sold', 'void'].includes(b.status)).reduce((sum, b) => sum + (b.cost || 0), 0);
  const pt = betTotals(paperBets);
  const rt = betTotals(realBets);
  const w = brain.walletFor(bot);
  const c = clv.get(bot.id);
  return {
    ...bot,
    wallet: { mode: w.mode, bankroll: w.bankroll, blocker: w.blocker },
    paper: { ...pt, equity: bot.paperBankroll + pt.realized + pt.openMark - pt.openCost, roi: settledCost(paperBets) ? pt.realized / settledCost(paperBets) : null },
    real: { ...rt, roi: settledCost(realBets) ? rt.realized / settledCost(realBets) : null },
    clv: c?.clv ?? null,
    nClose: c?.nClose || 0,
    move30: c?.move30 ?? null,
    n30: c?.n30 || 0,
    lastAt: bets.reduce((mx, b) => Math.max(mx, b.placedAt || 0), 0)
  };
}

function botsView() {
  const clv = new Map(db.variantStats().map((r) => [r.variant, r]));
  const s = engine.settings();
  const rep = learn.learnStatus.lastReport?.bots || null;
  return {
    schema: botsMod.botSchema(),
    bots: botsMod.allBots().map((b) => botRow(b, clv)),
    botsOn: s.botsOn !== false,
    real: { ...engine.realWallet(), armed: Boolean(col('executor').armed), blocker: brain.realBlocker(), dailyCap: s.realDailyCap, executor: engine.onlineDevice() ? engine.publicDevice(engine.onlineDevice()) : null },
    report: rep ? { suggestions: rep.suggestions, stopped: rep.stopped, benchmark: rep.benchmark, at: learn.learnStatus.lastReport.at } : null
  };
}

/**
 * Matches where big money came in the way inside information would: large,
 * from wallets with almost no history or brand new, and in-game after the
 * team had fallen well below its start price. One score per match (0-100).
 */
/** Never suspicious: a VRS top-20 team, or both teams in the top 30 (0 = unranked). */
export function isTopVrsMatch(ev) {
  const r = (ev.vrs || []).filter((x) => x > 0);
  return r.some((x) => x <= 20) || ((ev.vrs || []).length === 2 && r.length === 2 && r.every((x) => x <= 30));
}

function suspiciousView(minScore = 35, minCash = 200) {
  minCash = Math.max(200, minCash || 200);
  const events = col('events');
  const wallets = col('wallets');
  const prices = col('prices');
  const teams = col('teams');
  const byEvent = new Map();
  for (const f of col('flags')) {
    if (f.kind !== 'entry' || f.market !== 'match') continue;
    const ev = events[f.eventId];
    if (!ev || isTopVrsMatch(ev)) continue;
    const cash = Math.max(f.cash || 0, f.stackCash || 0);
    const w = wallets[f.wallet] || {};
    const ageDays = w.joinedAt ? (f.at - w.joinedAt) / 86400e3 : null;
    const pre = prices[f.conditionId]?.pre?.[f.outcomeIndex] ?? teams[f.conditionId]?.teams?.[f.outcomeIndex]?.pre ?? null;
    const reasons = [];
    let pts = Math.max(0, Math.min(40, Math.log10(cash / 50) * 18));
    reasons.push(`$${Math.round(cash)} at ${Math.round(f.price * 100)}%`);
    if ((ageDays !== null && ageDays <= 7) || (Number.isFinite(w.markets) && w.markets <= 3)) {
      pts += 35;
      reasons.push(ageDays !== null && ageDays <= 7 ? `wallet ${Math.max(0, Math.round(ageDays))}d old` : `${w.markets} markets ever`);
    } else if ((ageDays !== null && ageDays <= 30) || (Number.isFinite(w.markets) && w.markets <= 10)) {
      pts += 20;
      reasons.push(ageDays !== null && ageDays <= 30 ? `wallet ${Math.round(ageDays)}d old` : `${w.markets} markets ever`);
    }
    const inGame = ev.start && f.at >= ev.start;
    if (inGame && Number.isFinite(pre) && pre - f.price >= 0.15) {
      pts += pre - f.price >= 0.25 ? 30 : 22;
      reasons.push(`in-game, fell ${Math.round(pre * 100)}% → ${Math.round(f.price * 100)}%`);
    }
    const score = Math.min(100, Math.round(pts));
    let row = byEvent.get(ev.id);
    if (!row) byEvent.set(ev.id, (row = { id: ev.id, title: ev.title, teams: ev.teams, league: ev.league, start: ev.start, live: ev.live && !ev.settledAt, settled: Boolean(ev.settledAt), winner: engine.winnerOf(ev.markets.find((m) => m.kind === 'match') || {}), score: 0, total: 0, bets: [] }));
    if (score >= minScore && cash >= minCash) {
      row.bets.push({ at: f.at, wallet: f.wallet, name: w.name || w.pseudonym || '', outcome: f.outcome, outcomeIndex: f.outcomeIndex, price: f.price, cash, score, reasons });
      row.total += cash;
    }
  }
  const out = [];
  for (const row of byEvent.values()) {
    if (!row.bets.length) continue;
    row.bets.sort((a, b) => b.score - a.score);
    row.score = Math.min(100, row.bets[0].score + 5 * (row.bets.length - 1));
    const side = row.bets[0].outcomeIndex;
    row.suspectSide = row.teams?.[side] || row.bets[0].outcome;
    row.suspectWon = row.winner === null || row.winner === undefined || row.winner === -1 ? null : row.winner === side;
    row.bets = row.bets.slice(0, 6);
    out.push(row);
  }
  return out.sort((a, b) => b.score - a.score || b.start - a.start).slice(0, 300);
}

/** The learning state and the live plumbing. */
async function brainView() {
  const t = reactionTables();
  return {
    bots: botsView().bots.map((b) => ({ id: b.id, name: b.name, type: b.type, mode: b.mode, enabled: b.enabled, paper: b.paper, real: b.real, clv: b.clv, nClose: b.nClose, move30: b.move30, n30: b.n30, params: b.params })),
    learn: { ...learn.learnStatus, lastReport: learn.learnStatus.lastReport ? { ...learn.learnStatus.lastReport, reasons: undefined } : null },
    weights: getWeights(),
    reasonPoints: learnedPoints(),
    reaction: { fittedAt: t.fittedAt, cells: Object.keys(t.reaction || {}).length, scoreReaction: t.scoreReaction, labels: MOVE_LABELS, table: t.reaction, volatility: t.volatility },
    models: db.modelHistory(12).map((m) => ({ id: m.id, at: m.at, kind: m.kind, adopted: m.adopted, reason: m.reason || '', test: m.test || m.walkForward || null })),
    feeds: { ...feeds.status, books: feeds.books.size, scores: feeds.scores.size },
    recorder: { ...recStatus, disk: diskUsage() },
    review: { ...reviewStatus, configured: reviewerConfigured() },
    brain: brain.brainStatus(),
    decisions: db.counts()
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('Request body too large.');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('Invalid JSON body.');
    err.status = 400;
    throw err;
  }
}

/**
 * The one account Insights belongs to.
 *
 * AIM4_INSIGHTS_USER_IDS (comma-separated auth ids) pins it by id. Without it,
 * the account must be a site admin AND be named artysan: a username alone is
 * claimable, an admin row is not, and usernames are unique, so the pair names
 * exactly one person. Locally the single owner account is it.
 */
export function isInsightsOwner(me) {
  if (!me?.signedIn || me.impersonating) return false;
  if (localMode()) return me.id === OWNER_ID;
  const ids = String(process.env.AIM4_INSIGHTS_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length) return ids.includes(me.id);
  return me.admin === true && String(me.username || '').toLowerCase() === 'artysan';
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// ---- views ------------------------------------------------------------------

function matchMarket(ev) {
  return ev.markets.find((m) => m.kind === 'match') || ev.markets[0];
}

function eventRow(ev, flagsByEvent, betsByEvent) {
  const m = matchMarket(ev);
  const tr = col('prices')[m?.conditionId] || null;
  const flags = flagsByEvent.get(ev.id) || [];
  const entries = flags.filter((f) => f.kind === 'entry');
  return {
    id: ev.id,
    slug: ev.slug,
    title: ev.title,
    teams: ev.teams,
    vrs: ev.vrs || [0, 0],
    listed: ev.listed || ['', ''],
    reasons: ev.reasons || [],
    league: ev.league,
    stage: ev.stage,
    format: ev.format,
    tier: ev.tier,
    start: ev.start,
    live: ev.live && !ev.settledAt,
    ended: ev.ended,
    settledAt: ev.settledAt || 0,
    score: ev.score,
    period: ev.period,
    volume: ev.volume,
    prices: tr?.last || m?.prices || null,
    min: tr?.min || null,
    pre: tr?.pre || null,
    winner: m ? engine.winnerOf(m) : null,
    signals: entries.length,
    topScore: entries.reduce((mx, f) => Math.max(mx, f.score), 0),
    bigCash: entries.reduce((mx, f) => Math.max(mx, f.cash), 0),
    exits: flags.filter((f) => f.kind !== 'entry').length,
    bets: (betsByEvent.get(ev.id) || []).length
  };
}

function indexBy(list, key) {
  const map = new Map();
  for (const x of list) {
    const k = x[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return map;
}

function flagView(f, wallets) {
  const w = wallets[f.wallet];
  return { ...f, walletName: w?.name || w?.pseudonym || '', walletFollow: Boolean(w?.follow), walletIgnore: Boolean(w?.ignore) };
}

function matchesView(scope) {
  const events = Object.values(col('events')).filter((e) => e.track || e.settledAt);
  const flagsByEvent = indexBy(col('flags'), 'eventId');
  const betsByEvent = indexBy(col('bets'), 'eventId');
  const now = Date.now();
  let list = events.map((e) => eventRow(e, flagsByEvent, betsByEvent));
  if (scope === 'live') list = list.filter((e) => e.live);
  else if (scope === 'upcoming') list = list.filter((e) => !e.live && !e.settledAt && e.start > now - 3600e3);
  else if (scope === 'finished') list = list.filter((e) => e.settledAt);
  list.sort((a, b) => (scope === 'finished' ? b.start - a.start : a.live !== b.live ? (a.live ? -1 : 1) : a.start - b.start));
  return list.slice(0, 500);
}

function whaleRow(w) {
  const rec = walletRecord(w.entries);
  const scores = w.entries.map((e) => e.score || 0);
  return {
    addr: w.addr,
    name: w.name || w.pseudonym || '',
    pseudonym: w.pseudonym,
    follow: Boolean(w.follow),
    ignore: Boolean(w.ignore),
    note: w.note || '',
    joinedAt: w.joinedAt || 0,
    markets: w.markets,
    value: w.value,
    cs2Share: w.cs2Share,
    allTimePnl: w.allTimePnl ?? null,
    lastAt: rec.lastAt,
    avgScore: scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : 0,
    ...rec
  };
}

function whalesView(sort = 'edge', minBets = 1) {
  const rows = Object.values(col('wallets'))
    .filter((w) => w.entries.length >= minBets)
    .map(whaleRow);
  const key = {
    edge: (r) => (r.edge ?? -1) * Math.min(1, r.resolved / 5) + (r.follow ? 10 : 0),
    pnl: (r) => r.pnl,
    staked: (r) => r.staked,
    recent: (r) => r.lastAt,
    bets: (r) => r.bets,
    score: (r) => r.avgScore
  }[sort] || ((r) => r.edge ?? -1);
  rows.sort((a, b) => key(b) - key(a));
  return rows.slice(0, 1000);
}

function betsView(mode, botId = '') {
  const epochs = new Map(botsMod.allBots().map((b) => [b.id, b.paperEpoch || 0]));
  const bets = col('bets')
    .filter((b) => b.mode === mode && (mode !== 'sim' || b.placedAt >= (epochs.get(b.botId) || 0)) && (!botId || b.botId === botId))
    .slice()
    .sort((a, b) => b.placedAt - a.placedAt);
  // Running realized P&L, oldest settlement first.
  const settled = bets.filter((b) => b.settledAt && ['won', 'lost', 'void', 'sold'].includes(b.status)).sort((a, b) => a.settledAt - b.settledAt);
  let run = 0;
  const curve = settled.map((b) => {
    run += (b.payout || 0) - (b.cost || 0);
    return [b.settledAt, Math.round(run * 100) / 100];
  });
  return { bets: bets.slice(0, 1000), totals: betTotals(bets), curve };
}

/** Did the score predict anything? Flat $1 on every settled entry above each threshold. */
function scoreCheck() {
  const entries = [];
  for (const w of Object.values(col('wallets'))) {
    for (const e of w.entries) if (e.result === 'won' || e.result === 'lost') entries.push(e);
  }
  const thresholds = [0, 20, 40, 50, 60, 70, 80];
  const rows = thresholds.map((t) => {
    const set = entries.filter((e) => (e.score || 0) >= t);
    const wins = set.filter((e) => e.result === 'won');
    const ret = wins.reduce((s, e) => s + 1 / Math.max(0.01, e.price), 0);
    return {
      min: t,
      n: set.length,
      wins: wins.length,
      rate: set.length ? wins.length / set.length : null,
      implied: set.length ? set.reduce((s, e) => s + e.price, 0) / set.length : null,
      roi: set.length ? ret / set.length - 1 : null
    };
  });
  const flags = col('flags').filter((f) => f.kind === 'entry');
  const result = new Map();
  for (const w of Object.values(col('wallets'))) for (const e of w.entries) if (e.result) result.set(e.flagId, e.result);
  const byReason = new Map();
  for (const f of flags) {
    const r = result.get(f.id);
    if (r !== 'won' && r !== 'lost') continue;
    for (const reason of f.reasons || []) {
      const row = byReason.get(reason.key) || { key: reason.key, n: 0, wins: 0, priceSum: 0 };
      row.n++;
      row.priceSum += f.price;
      if (r === 'won') row.wins++;
      byReason.set(reason.key, row);
    }
  }
  const reasons = [...byReason.values()].map((r) => ({ key: r.key, n: r.n, wins: r.wins, rate: r.n ? r.wins / r.n : null, implied: r.n ? r.priceSum / r.n : null })).sort((a, b) => b.n - a.n);
  return { thresholds: rows, reasons, settled: entries.length };
}

function statsView(line = 0.3, minMatches = 1) {
  const matches = Object.values(col('teams'));
  const teams = teamTable(matches, line).filter((t) => t.matches >= minMatches).sort((a, b) => b.dips - a.dips || b.matches - a.matches);
  const flat = matches.flatMap((m) => m.teams.filter((t) => typeof t.won === 'boolean'));
  const dipped = flat.filter((t) => Number.isFinite(t.min) && t.min <= line);
  const dogs = flat.filter((t) => Number.isFinite(t.pre) && t.pre <= line);
  return {
    line,
    matches: matches.length,
    summary: {
      dips: dipped.length,
      dipWins: dipped.filter((t) => t.won).length,
      dogs: dogs.length,
      dogWins: dogs.filter((t) => t.won).length,
      dogImplied: dogs.length ? dogs.reduce((s, t) => s + t.pre, 0) / dogs.length : null
    },
    teams,
    calibrationPre: calibration(matches, 'pre'),
    calibrationMin: calibration(matches, 'min'),
    score: scoreCheck()
  };
}

function executorView() {
  const exec = col('executor');
  return { armed: Boolean(exec.armed), devices: (exec.devices || []).map(engine.publicDevice), online: engine.onlineDevice() ? engine.publicDevice(engine.onlineDevice()) : null };
}

function overviewView() {
  const s = engine.settings();
  const wallets = col('wallets');
  const now = Date.now();
  const matches = matchesView('all').filter((e) => !e.settledAt);
  const live = matches.filter((e) => e.live);
  const next = matches.filter((e) => !e.live && e.start >= now - 3600e3).slice(0, 12);
  const flags = col('flags');
  const events = col('events');
  const latest = [];
  for (let i = flags.length - 1; i >= 0 && latest.length < 20; i--) {
    const f = flags[i];
    if (f.source !== 'live') continue;
    const ev = events[f.eventId];
    latest.push({ ...flagView(f, wallets), title: ev?.title || '', teams: ev?.teams || null });
  }
  const dayStart = Math.floor(now / 86400e3) * 86400e3;
  const today = flags.filter((f) => f.source === 'live' && f.at >= dayStart);
  const topWallets = whalesView('edge', 1).filter((w) => w.resolved >= 3).slice(0, 6);
  const all = botsMod.allBots();
  const paperOn = all.filter((b) => b.enabled && b.mode === 'paper').length;
  const realOn = all.filter((b) => b.enabled && b.mode === 'real').length;
  const botsOn = s.botsOn !== false;
  return {
    // The banner: red while any real-money bot is on, blue for paper only, grey when stopped.
    mode: !botsOn || paperOn + realOn === 0 ? 'off' : realOn ? 'real' : 'sim',
    bots: { on: botsOn, paper: paperOn, real: realOn, blocker: brain.realBlocker() },
    tracking: s.tracking,
    status: engine.engineStatus(),
    sim: engine.simWallet(),
    real: engine.realWallet(),
    executor: executorView(),
    live,
    next,
    latest,
    today: { signals: today.filter((f) => f.kind === 'entry').length, copied: today.filter((f) => f.action === 'copied' || f.action === 'queued').length, exits: today.filter((f) => f.kind !== 'entry').length },
    topWallets,
    limits: { stakePct: s.stakePct, maxStake: s.maxStake, minScore: s.minScore, realDailyCap: s.realDailyCap }
  };
}

async function vrsInfo() {
  try {
    const m = await import('../replays/teamStandingsDb.js');
    const ranks = m.loadGlobalRanks();
    return { teams: ranks.size, snapshot: m.loadedStandingSnapshot?.() || null };
  } catch {
    return { teams: 0, snapshot: null };
  }
}

// ---- dispatcher ---------------------------------------------------------------

/** @returns {Promise<boolean>} true when the request was an Insights route */
export async function handleInsightsRequest(req, res, url) {
  const p = url.pathname;
  if (!p.startsWith('/api/insights/')) return false;
  try {
    // The PC executor: device token, no session.
    if (p.startsWith('/api/insights/executor/') && ['poll', 'report', 'heartbeat'].includes(p.slice('/api/insights/executor/'.length))) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' }), true;
      const device = engine.deviceForToken(bearer(req));
      if (!device) return json(res, 401, { error: 'Unknown device. Link this PC again from Insights settings.' }), true;
      const body = await readJson(req, 16 * 1024);
      const which = p.slice('/api/insights/executor/'.length);
      if (which === 'poll') return json(res, 200, engine.pollIntents(device)), true;
      if (which === 'report') return json(res, engine.reportIntent(device, body) ? 200 : 404, { ok: true }), true;
      engine.heartbeat(device, body);
      return json(res, 200, { ok: true, armed: Boolean(col('executor').armed), mode: engine.settings().mode }), true;
    }

    const me = await whoami(req);
    if (!isInsightsOwner(me)) return json(res, 404, { error: 'Not found' }), true;

    const m = req.method;
    if (m === 'GET' && p === '/api/insights/access') return json(res, 200, { ok: true }), true;
    if (m === 'GET' && p === '/api/insights/overview') return json(res, 200, overviewView()), true;
    if (m === 'GET' && p === '/api/insights/matches') return json(res, 200, { matches: matchesView(url.searchParams.get('scope') || 'all') }), true;

    let hit = p.match(/^\/api\/insights\/matches\/([^/]+)$/);
    if (m === 'GET' && hit) {
      const ev = col('events')[decodeURIComponent(hit[1])];
      if (!ev) return json(res, 404, { error: 'No such match.' }), true;
      const wallets = col('wallets');
      const history = await engine.matchHistory(ev).catch(() => null);
      const prices = col('prices');
      const flagsByEvent = indexBy(col('flags'), 'eventId');
      const betsByEvent = indexBy(col('bets'), 'eventId');
      const order = (mk) => (mk.kind === 'match' ? '' : mk.label);
      const markets = ev.markets
        .slice()
        .sort((a, b) => order(a).localeCompare(order(b), undefined, { numeric: true }))
        .map((mk) => {
          let track = prices[mk.conditionId] || null;
          if (mk.kind === 'match' && history?.length) {
            // History up to where live sampling began, live samples after.
            const live = track?.series || [];
            const from = live.length ? live[0][0] : Infinity;
            track = { ...(track || {}), series: [...history.filter(([t]) => t < from), ...live] };
          }
          return { ...mk, track, winner: engine.winnerOf(mk) };
        });
      return (
        json(res, 200, {
          match: eventRow(ev, flagsByEvent, betsByEvent),
          markets,
          flags: (flagsByEvent.get(ev.id) || []).slice().sort((a, b) => b.at - a.at).map((f) => flagView(f, wallets)),
          bets: (betsByEvent.get(ev.id) || []).slice().sort((a, b) => b.placedAt - a.placedAt)
        }),
        true
      );
    }

    if (m === 'GET' && p === '/api/insights/suspicious') {
      return json(res, 200, { matches: suspiciousView(Number(url.searchParams.get('min')) || 35, Number(url.searchParams.get('cash')) || 200) }), true;
    }
    if (m === 'GET' && p === '/api/insights/whales') {
      return json(res, 200, { whales: whalesView(url.searchParams.get('sort') || 'edge', Number(url.searchParams.get('min')) || 1) }), true;
    }
    hit = p.match(/^\/api\/insights\/whales\/(0x[0-9a-fA-F]{40})$/);
    if (hit) {
      const addr = hit[1].toLowerCase();
      const w = col('wallets')[addr];
      if (!w) return json(res, 404, { error: 'No such wallet.' }), true;
      if (m === 'PATCH') {
        const body = await readJson(req, 4096);
        if (typeof body.follow === 'boolean') {
          w.follow = body.follow;
          if (body.follow) w.ignore = false;
        }
        if (typeof body.ignore === 'boolean') {
          w.ignore = body.ignore;
          if (body.ignore) w.follow = false;
        }
        if (typeof body.note === 'string') w.note = body.note.slice(0, 300);
        touch('wallets');
        return json(res, 200, { whale: whaleRow(w) }), true;
      }
      if (m === 'GET') {
        const events = col('events');
        const flags = col('flags').filter((f) => f.wallet === addr).slice(-400).reverse();
        const entries = w.entries.slice().reverse().map((e) => ({ ...e, title: events[e.eventId]?.title || '', teams: events[e.eventId]?.teams || null, start: events[e.eventId]?.start || 0 }));
        return json(res, 200, { whale: whaleRow(w), entries, flags }), true;
      }
    }

    if (m === 'GET' && p === '/api/insights/signals') {
      const q = url.searchParams;
      const kind = q.get('kind') || '';
      const minScore = Number(q.get('min')) || 0;
      const source = q.get('source') || 'live';
      const action = q.get('action') || '';
      const wallets = col('wallets');
      const events = col('events');
      const out = [];
      const flags = col('flags');
      for (let i = flags.length - 1; i >= 0 && out.length < 600; i--) {
        const f = flags[i];
        if (source !== 'all' && f.source !== source) continue;
        if (kind && f.kind !== kind) continue;
        if (f.score < minScore) continue;
        if (action && f.action !== action) continue;
        const ev = events[f.eventId];
        out.push({ ...flagView(f, wallets), title: ev?.title || '', teams: ev?.teams || null, league: ev?.league || '' });
      }
      return json(res, 200, { signals: out }), true;
    }

    if (m === 'GET' && p === '/api/insights/bets') {
      const q = url.searchParams;
      const mode = q.get('mode') === 'real' ? 'real' : 'sim';
      const botId = q.get('bot') || '';
      const view = betsView(mode, botId);
      const names = Object.fromEntries(botsMod.allBots().map((b) => [b.id, b.name]));
      view.bets = view.bets.map((b) => ({ ...b, botName: names[b.botId] || b.botId || '' }));
      const s = engine.settings();
      const bot = botId ? botsMod.botById(botId) : null;
      const wallet = mode === 'real' ? engine.realWallet() : bot ? (() => { const w = brain.walletFor({ ...bot, mode: 'paper' }); return { cash: null, equity: w.bankroll, realized: view.totals.realized, openCost: view.totals.openCost, today: view.totals.today }; })() : engine.simWallet();
      void s;
      return json(res, 200, { mode, ...view, wallet }), true;
    }

    if (m === 'GET' && p === '/api/insights/stats') {
      const line = Math.min(0.6, Math.max(0.05, Number(url.searchParams.get('line')) || 0.3));
      const min = Math.max(1, Number(url.searchParams.get('min')) || 1);
      return json(res, 200, statsView(line, min)), true;
    }

    if (p === '/api/insights/settings') {
      if (m === 'PUT') {
        const body = await readJson(req);
        const next = engine.updateSettings(body);
        return json(res, 200, { settings: next }), true;
      }
      if (m === 'GET') {
        return json(res, 200, { settings: engine.settings(), vrs: await vrsInfo(), preview: engine.previewRules({}), executor: executorView(), status: engine.engineStatus(), log: (col('meta').log || []).slice(-80).reverse() }), true;
      }
    }

    if (m === 'POST' && p === '/api/insights/preview') {
      const body = await readJson(req);
      return json(res, 200, engine.previewRules(body)), true;
    }
    if (m === 'POST' && p === '/api/insights/refresh') {
      await engine.refreshNow();
      return json(res, 200, { ok: true, status: engine.engineStatus() }), true;
    }
    if (m === 'POST' && p === '/api/insights/backfill') {
      const body = await readJson(req, 1024);
      const days = Math.round(Math.min(365, Math.max(1, Number(body.days) || engine.settings().backfillDays)));
      engine.backfill(days).catch(() => {});
      return json(res, 202, { started: true, days }), true;
    }
    if (m === 'POST' && p === '/api/insights/sim/reset') {
      engine.resetSim();
      return json(res, 200, { ok: true }), true;
    }
    if (m === 'POST' && p === '/api/insights/real/arm') {
      const body = await readJson(req, 1024);
      if (body.confirm !== 'REAL') return json(res, 400, { error: 'Type REAL to arm real trading.' }), true;
      if (!botsMod.allBots().some((b) => b.enabled && b.mode === 'real')) return json(res, 409, { error: 'No bot is set to real money. Set one to Real on the Bots page first.' }), true;
      if (engine.settings().botsOn === false) return json(res, 409, { error: 'Bots are switched off.' }), true;
      const dev = engine.onlineDevice();
      if (!dev) return json(res, 409, { error: 'No PC executor online. Open the aim4 app on your PC with Insights linked.' }), true;
      if (dev.info?.geo?.blocked) return json(res, 409, { error: `Polymarket blocks trading from the executor's location (${dev.info.geo.country}).` }), true;
      engine.setArmed(true);
      return json(res, 200, executorView()), true;
    }
    if (m === 'POST' && p === '/api/insights/real/disarm') {
      engine.setArmed(false);
      return json(res, 200, executorView()), true;
    }
    if (m === 'POST' && p === '/api/insights/executor/link') {
      const body = await readJson(req, 1024);
      return json(res, 200, engine.linkDevice(body.name)), true;
    }
    hit = p.match(/^\/api\/insights\/executor\/devices\/([\w-]+)$/);
    if (m === 'DELETE' && hit) {
      engine.revokeDevice(hit[1]);
      return json(res, 200, executorView()), true;
    }

    // ---- bots, training, backtests, decisions ----
    if (m === 'GET' && p === '/api/insights/brain') return json(res, 200, await brainView()), true;
    if (p === '/api/insights/bots') {
      if (m === 'GET') return json(res, 200, botsView()), true;
      if (m === 'POST') {
        const body = await readJson(req, 16 * 1024);
        if (!botsMod.BOT_TYPES[body.type]) return json(res, 400, { error: 'Pick a bot type.' }), true;
        const bot = botsMod.createBot(body);
        return json(res, 200, { bot, ...botsView() }), true;
      }
    }
    hit = p.match(/^\/api\/insights\/bots\/([\w-]+)(?:\/(duplicate|reset))?$/);
    if (hit) {
      const [, id, action] = hit;
      const bot = botsMod.botById(id);
      if (!bot) return json(res, 404, { error: 'No such bot.' }), true;
      if (m === 'PUT' && !action) {
        const body = await readJson(req, 16 * 1024);
        if (body.mode === 'real' && bot.mode !== 'real') {
          if (botsMod.BOT_TYPES[bot.type].paperOnly) return json(res, 400, { error: 'Market making runs on paper only for now.' }), true;
          if (body.confirm !== 'REAL') return json(res, 400, { error: 'Type REAL to let this bot use real money.' }), true;
        }
        const next = botsMod.updateBot(id, body);
        return json(res, 200, { bot: next, ...botsView() }), true;
      }
      if (m === 'DELETE' && !action) {
        botsMod.deleteBot(id);
        return json(res, 200, botsView()), true;
      }
      if (m === 'POST' && action === 'duplicate') return json(res, 200, { bot: botsMod.duplicateBot(id), ...botsView() }), true;
      if (m === 'POST' && action === 'reset') {
        botsMod.resetPaper(id);
        return json(res, 200, botsView()), true;
      }
    }
    if (m === 'POST' && p === '/api/insights/train') {
      learn.runTraining().catch(() => {});
      return json(res, 202, { started: true }), true;
    }
    if (m === 'GET' && p === '/api/insights/backtest-bot') {
      return json(res, 200, { pack: packInfo(), bots: botsMod.allBots().map((b) => ({ id: b.id, name: b.name, type: b.type, enabled: b.enabled, mode: b.mode })) }), true;
    }
    if (m === 'POST' && p === '/api/insights/backtest-bot') {
      const body = await readJson(req, 4096);
      const bot = botsMod.botById(body.bot);
      if (!bot) return json(res, 400, { error: 'Pick a bot to test.' }), true;
      const days = Math.min(730, Math.max(7, Number(body.days) || 365));
      const start = Math.min(1e7, Math.max(10, Number(body.start) || 500));
      const extraSlip = Math.min(0.1, Math.max(0, Number(body.extraSlip) || 0));
      return json(res, 200, botBacktest(bot, { days, start, extraSlip })), true;
    }
    if (m === 'POST' && p === '/api/insights/backtest') {
      const body = await readJson(req, 2048);
      const days = Math.min(365, Math.max(1, Number(body.days) || 30));
      const bot = botsMod.botById(body.bot);
      if (!bot) return json(res, 400, { error: 'Pick a bot to test.' }), true;
      if (body.kind === 'ticks') {
        const size = bot.sizing.kind === 'fixed' ? bot.sizing.value : 15;
        const out = await backtest.tickBacktest(bot.type, bot.params, { days, tables: reactionTables(), size, name: bot.name });
        return json(res, 200, out), true;
      }
      if (bot.type !== 'swing') return json(res, 400, { error: '5-minute history backtests run swing bots; use recorded ticks for market making.' }), true;
      // Cached histories only: training fetches new ones; a backtest should answer fast.
      const { matches } = await learn.loadHistories({ fetchLimit: 0 });
      return json(res, 200, backtest.historyBacktest(matches, bot.params, { name: bot.name })), true;
    }
    if (m === 'GET' && p === '/api/insights/decisions') {
      const q = url.searchParams;
      return (
        json(res, 200, {
          decisions: db.listDecisions({ strategy: q.get('strategy') || '', variant: q.get('bot') || q.get('variant') || '', action: q.get('action') || '', eventId: q.get('event') || '', limit: Number(q.get('limit')) || 150, before: Number(q.get('before')) || 0 }),
          counts: db.counts()
        }),
        true
      );
    }
    hit = p.match(/^\/api\/insights\/decisions\/([\w-]+)$/);
    if (m === 'GET' && hit) {
      const d = db.getDecision(hit[1]);
      return json(res, d ? 200 : 404, d || { error: 'No such decision.' }), true;
    }

    return json(res, 404, { error: 'Not found' }), true;
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[insights]', err);
    json(res, status, { error: err.message || 'Server error' });
    return true;
  }
}
