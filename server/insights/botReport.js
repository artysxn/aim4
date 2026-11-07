// ---------------------------------------------------------------------------
// server/insights/botReport.js
// One bot, one window: what it looked at, what it skipped and why, what it
// took, and how that went. Pure (inputs in, a plain object out), so the route
// stays thin and the numbers are testable.
//
// Three sources, each with a different completeness:
//   bets      every bet the bot placed (real money or its paper wallet)
//   funnel    every evaluation, one count per market and reason per UTC day
//   decisions every taken decision and a sample of skips (quiet skips are
//             kept at most every 10 minutes per market, near the edge only),
//             each later stamped with the result and the P&L of $1 held to it
// ---------------------------------------------------------------------------

import { betTotals } from './stats.js';

const DAY = 86400e3;
const TAKEN = new Set(['entered', 'queued', 'quoted', 'exited']);
const SKIPPED = new Set(['skipped', 'vetoed', 'review']);
const SETTLED = new Set(['won', 'lost', 'void', 'sold']);

/** "At 45%, not down to 20%" and "At 38%, not down to 20%" are one reason. */
export function reasonKey(reason) {
  return String(reason || 'No reason')
    .replace(/\$?-?\d+(?:[.,]\d+)?\s?(?:%|c|k|min|s|h)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

/** What kind of no a skip was: the bot's own rules, the wallet's limits, or the plumbing. */
export function skipCategory(reason) {
  const r = String(reason || '');
  if (/^Risk:|open-bets limit|daily loss stop|daily cap/i.test(r)) return 'risk';
  if (/switched off|not armed|executor offline|Wallet empty/i.test(r)) return 'blocked';
  if (/^Auto stake|Stake under minimum/i.test(r)) return 'stake';
  if (/Already (in|backed)|stake already in/i.test(r)) return 'duplicate';
  if (/No order book|not taking orders|^No asks|No start price|not filled|Price moved/i.test(r)) return 'market';
  if (/review|veto/i.test(r)) return 'review';
  return 'rules';
}

export const CATEGORY_LABELS = {
  rules: "The bot's own rules",
  risk: 'Wallet risk limits',
  stake: 'Stake sizing',
  blocked: 'Real money blocked',
  duplicate: 'Already in the match',
  market: 'Market or order book',
  review: 'AI review'
};

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const round2 = (v) => Math.round(v * 100) / 100;
const pnlOf = (b) => (b.payout || 0) - (b.cost || 0);

function bandOf(p) {
  if (!Number.isFinite(p)) return 'Unknown';
  if (p < 0.1) return 'Under 10%';
  if (p < 0.2) return '10-20%';
  if (p < 0.3) return '20-30%';
  if (p < 0.5) return '30-50%';
  return '50% and up';
}
const BAND_ORDER = ['Under 10%', '10-20%', '20-30%', '30-50%', '50% and up', 'Unknown'];

/** Settled bets grouped by a key: count, record, money in and out. */
function groupBets(bets, keyFn, order = null) {
  const m = new Map();
  for (const b of bets) {
    const k = keyFn(b);
    const g = m.get(k) || { label: k, n: 0, won: 0, lost: 0, staked: 0, pnl: 0 };
    g.n++;
    if (b.status === 'won' || (b.status === 'sold' && pnlOf(b) > 0)) g.won++;
    else if (b.status === 'lost' || b.status === 'sold') g.lost++;
    g.staked += b.cost || 0;
    g.pnl += pnlOf(b);
    m.set(k, g);
  }
  const rows = [...m.values()].map((g) => ({ ...g, staked: round2(g.staked), pnl: round2(g.pnl), roi: g.staked ? g.pnl / g.staked : null }));
  if (order) rows.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  else rows.sort((a, b) => b.n - a.n);
  return rows;
}

/** $1 on each decision, held to the result (no fees, no take-profit): the like-for-like line. */
function perDollar(rows) {
  let run = 0;
  return rows
    .filter((d) => Number.isFinite(d.pnl))
    .map((d) => {
      run += d.pnl;
      return { t: d.at, v: round2(run), d: round2(d.pnl), title: d.title || '', outcome: d.outcome || '', price: d.price, reason: d.reason || '', eventId: d.event_id || '' };
    });
}

function sideStats(rows) {
  const settled = rows.filter((d) => Number.isFinite(d.pnl));
  const moved = rows.filter((d) => Number.isFinite(d.m30) && Number.isFinite(d.price));
  return {
    n: rows.length,
    settled: settled.length,
    won: settled.filter((d) => d.result === 1).length,
    avgPnl: settled.length ? settled.reduce((s, d) => s + d.pnl, 0) / settled.length : null,
    move30: moved.length ? moved.reduce((s, d) => s + (d.m30 - d.price), 0) / moved.length : null,
    n30: moved.length
  };
}

/**
 * @param {object} a
 * @param {object} a.bot        the stored bot
 * @param {Array}  a.bets       this bot's bets (any mode)
 * @param {Array}  a.decisions  db.decisionRows for this bot, oldest first
 * @param {Array}  a.funnel     db.funnelRows for this bot
 * @param {{ equity?: number|null }} [a.wallet]  the real wallet, for real mode
 * @param {number} [a.days]     window in days; 0 = everything
 * @param {'sim'|'real'} [a.mode]
 */
export function botReport({ bot, bets, decisions, funnel, wallet = null, now = Date.now(), days = 7, mode }) {
  mode = mode === 'real' || mode === 'sim' ? mode : bot.mode === 'real' ? 'real' : 'sim';
  const since = days > 0 ? now - days * DAY : 0;
  const sinceDay = since ? dayOf(since) : '';

  // ---- bets ----
  const mine = bets.filter((b) => b.mode === mode && (mode !== 'sim' || b.placedAt >= (bot.paperEpoch || 0)));
  const placed = mine.filter((b) => b.placedAt >= since);
  const settled = mine.filter((b) => b.settledAt && b.settledAt >= since && SETTLED.has(b.status)).sort((a, b) => a.settledAt - b.settledAt);
  const all = betTotals(mine, now);
  const win = betTotals(placed, now);
  const settledCost = settled.reduce((s, b) => s + (b.cost || 0), 0);
  const realizedWin = settled.reduce((s, b) => s + pnlOf(b), 0);

  let run = 0;
  let peak = 0;
  let maxDd = 0;
  const curve = settled.map((b) => {
    const d = pnlOf(b);
    run += d;
    peak = Math.max(peak, run);
    maxDd = Math.max(maxDd, peak - run);
    return { t: b.settledAt, v: round2(run), d: round2(d), id: b.id, title: b.title || '', outcome: b.outcome || '', price: b.price ?? null, cost: round2(b.cost || 0), status: b.status, eventId: b.eventId || '' };
  });

  // Current streak, newest settlement back.
  let streak = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    const up = pnlOf(settled[i]) > 0;
    if (streak === 0) streak = up ? 1 : -1;
    else if ((streak > 0) === up) streak += up ? 1 : -1;
    else break;
  }
  const best = settled.reduce((m, b) => (!m || pnlOf(b) > pnlOf(m) ? b : m), null);
  const worst = settled.reduce((m, b) => (!m || pnlOf(b) < pnlOf(m) ? b : m), null);
  const brief = (b) => (b ? { title: b.title || '', outcome: b.outcome || '', pnl: round2(pnlOf(b)), eventId: b.eventId || '' } : null);
  const priced = placed.filter((b) => Number.isFinite(b.price) && b.price > 0);
  const counted = placed.filter((b) => !['failed', 'pending', 'missed'].includes(b.status));
  const equity = mode === 'sim' ? (bot.paperBankroll || 0) + all.realized + all.openMark - all.openCost : wallet?.equity ?? null;

  const kpis = {
    equity: equity === null ? null : round2(equity),
    realized: round2(realizedWin),
    realizedAll: round2(all.realized),
    roi: settledCost ? realizedWin / settledCost : null,
    settled: settled.length,
    won: settled.filter((b) => pnlOf(b) > 0).length,
    lost: settled.filter((b) => pnlOf(b) <= 0 && b.status !== 'void').length,
    voided: settled.filter((b) => b.status === 'void').length,
    open: all.open,
    openCost: round2(all.openCost),
    openMark: round2(all.openMark),
    placed: counted.length,
    failed: placed.filter((b) => b.status === 'failed' || b.status === 'missed').length,
    staked: round2(win.staked),
    avgStake: counted.length ? round2(win.staked / counted.length) : null,
    avgPrice: priced.length ? priced.reduce((s, b) => s + b.price, 0) / priced.length : null,
    maxDrawdown: round2(maxDd),
    streak,
    best: brief(best),
    worst: brief(worst)
  };

  // ---- decisions (the sample) ----
  const inWin = decisions.filter((d) => d.at >= since);
  const taken = inWin.filter((d) => TAKEN.has(d.action));
  const skipped = inWin.filter((d) => SKIPPED.has(d.action));

  // ---- funnel (complete counts) ----
  const fRows = funnel.filter((r) => !sinceDay || r.day >= sinceDay);
  const considered = fRows.filter((r) => r.reason === '__considered').reduce((s, r) => s + r.n, 0);
  const skipRows = fRows.filter((r) => r.reason !== '__considered');
  const byCategory = {};
  for (const r of skipRows) byCategory[r.category] = (byCategory[r.category] || 0) + r.n;

  const reasons = new Map();
  for (const r of skipRows) {
    const g = reasons.get(r.reason) || { key: r.reason, category: r.category, n: 0, lastAt: 0, sample: '' };
    g.n += r.n;
    if (r.last_at > g.lastAt) {
      g.lastAt = r.last_at;
      g.sample = r.sample || r.reason;
    }
    reasons.set(r.reason, g);
  }
  // Decisions recorded before the funnel existed still count, as samples.
  for (const d of skipped) {
    const k = reasonKey(d.reason);
    if (!reasons.has(k)) reasons.set(k, { key: k, category: skipCategory(d.reason), n: 0, lastAt: d.at, sample: d.reason || '' });
  }
  const reasonRows = [...reasons.values()]
    .map((g) => {
      const rows = skipped.filter((d) => reasonKey(d.reason) === g.key);
      const s = sideStats(rows);
      return { ...g, label: g.sample || g.key, recorded: rows.length, settled: s.settled, won: s.won, avgPnl: s.avgPnl, move30: s.move30 };
    })
    .sort((a, b) => b.n + b.recorded / 1000 - (a.n + a.recorded / 1000));

  // ---- day by day ----
  const dayMap = new Map();
  const dayRow = (k) => {
    if (!dayMap.has(k)) dayMap.set(k, { day: k, considered: 0, skipped: 0, taken: 0, pnl: 0, settled: 0 });
    return dayMap.get(k);
  };
  for (const r of fRows) {
    const row = dayRow(r.day);
    if (r.reason === '__considered') row.considered += r.n;
    else row.skipped += r.n;
  }
  for (const d of taken) dayRow(dayOf(d.at)).taken++;
  for (const b of settled) {
    const row = dayRow(dayOf(b.settledAt));
    row.pnl = round2(row.pnl + pnlOf(b));
    row.settled++;
  }
  // Days with no data at all still belong on the axis.
  if (dayMap.size) {
    const keys = [...dayMap.keys()].sort();
    const first = days > 0 ? sinceDay : keys[0];
    for (let t = Date.parse(`${first}T00:00:00Z`); t <= now; t += DAY) dayRow(dayOf(t));
  }
  const daily = [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1));

  return {
    bot: { id: bot.id, name: bot.name, type: bot.type, mode: bot.mode, enabled: bot.enabled, sizing: bot.sizing, minStake: bot.minStake, maxStake: bot.maxStake, paperBankroll: bot.paperBankroll },
    mode,
    days,
    since,
    now,
    kpis,
    curve,
    perDollar: { taken: perDollar(taken), skipped: perDollar(skipped) },
    compare: { taken: sideStats(taken), skipped: sideStats(skipped) },
    funnel: {
      considered,
      skipped: skipRows.reduce((s, r) => s + r.n, 0),
      taken: taken.length,
      byCategory,
      recordedSkips: skipped.length,
      since: funnel.length ? funnel[0].day : null
    },
    reasons: reasonRows.slice(0, 40),
    daily,
    breakdowns: {
      phase: groupBets(settled, (b) => (b.leg === 'pre' ? 'Before the start' : b.live ? 'Live' : 'Pre-match')),
      price: groupBets(settled, (b) => bandOf(b.price), BAND_ORDER),
      market: groupBets(settled, (b) => (b.market === 'map' ? b.marketLabel || 'Map' : 'Match winner')),
      exit: groupBets(settled, (b) => ({ won: 'Held, won', lost: 'Held, lost', sold: 'Sold early', void: 'Void' })[b.status] || b.status)
    }
  };
}
