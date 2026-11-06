// ---------------------------------------------------------------------------
// server/insights/stats.js
// Track records and team tables. Pure functions over stored rows.
// ---------------------------------------------------------------------------

import { walletEdge } from './signals.js';

/**
 * A wallet's flagged underdog entries, settled.
 * Entry rows: { cash, price, shares, result: 'won'|'lost'|'void'|null, exitCash?, exitShares? }
 * A position sold before the end counts by what the sale returned.
 */
export function walletRecord(entries) {
  const r = { bets: 0, open: 0, resolved: 0, wins: 0, losses: 0, voids: 0, sold: 0, staked: 0, returned: 0, pnl: 0, avgPrice: 0, winRate: 0, edge: null, roi: 0, lastAt: 0 };
  let priceSum = 0;
  for (const e of entries || []) {
    r.bets++;
    r.staked += e.cash || 0;
    r.lastAt = Math.max(r.lastAt, e.at || 0);
    const held = Math.max(0, (e.shares || 0) - (e.exitShares || 0));
    if (e.exitShares) r.sold++;
    if (!e.result) {
      r.open++;
      continue;
    }
    if (e.result === 'void') {
      r.voids++;
      r.returned += (e.exitCash || 0) + held * 0.5;
      continue;
    }
    r.resolved++;
    priceSum += e.price || 0;
    if (e.result === 'won') r.wins++;
    else r.losses++;
    r.returned += (e.exitCash || 0) + (e.result === 'won' ? held : 0);
  }
  const settledStake = (entries || []).filter((e) => e.result).reduce((s, e) => s + (e.cash || 0), 0);
  r.pnl = r.returned - settledStake;
  r.avgPrice = r.resolved ? priceSum / r.resolved : 0;
  r.winRate = r.resolved ? r.wins / r.resolved : 0;
  r.edge = walletEdge(r);
  r.roi = settledStake ? r.pnl / settledStake : 0;
  return r;
}

/**
 * Per-team underdog table from finished match-winner markets.
 * Match rows: { teams: [{ name, pre, min, won }] } with prices as 0..1 and
 * `won` true/false (void matches are left out by the caller).
 */
export function teamTable(matches, line = 0.3) {
  const by = new Map();
  for (const m of matches || []) {
    for (const t of m.teams || []) {
      if (typeof t.won !== 'boolean') continue;
      const key = String(t.name || '').trim().toLowerCase();
      if (!key) continue;
      let row = by.get(key);
      if (!row) {
        row = { name: t.name, matches: 0, wins: 0, dips: 0, dipWins: 0, dogs: 0, dogWins: 0, preSum: 0, preN: 0, dogPreSum: 0, minSum: 0, lastAt: 0 };
        by.set(key, row);
      }
      row.matches++;
      if (t.won) row.wins++;
      if (Number.isFinite(t.pre)) {
        row.preSum += t.pre;
        row.preN++;
      }
      if (Number.isFinite(t.min) && t.min <= line) {
        row.dips++;
        row.minSum += t.min;
        if (t.won) row.dipWins++;
      }
      if (Number.isFinite(t.pre) && t.pre <= line) {
        row.dogs++;
        row.dogPreSum += t.pre;
        if (t.won) row.dogWins++;
      }
      row.lastAt = Math.max(row.lastAt, m.start || 0);
    }
  }
  return [...by.values()].map((r) => ({
    name: r.name,
    matches: r.matches,
    wins: r.wins,
    winRate: r.matches ? r.wins / r.matches : 0,
    avgPre: r.preN ? r.preSum / r.preN : null,
    // Went to `line` or below at any moment, before or during the match.
    dips: r.dips,
    dipWins: r.dipWins,
    dipWinRate: r.dips ? r.dipWins / r.dips : null,
    avgDipMin: r.dips ? r.minSum / r.dips : null,
    // Started the match priced at `line` or below.
    dogs: r.dogs,
    dogWins: r.dogWins,
    dogWinRate: r.dogs ? r.dogWins / r.dogs : null,
    dogImplied: r.dogs ? r.dogPreSum / r.dogs : null,
    lastAt: r.lastAt
  }));
}

/**
 * How often a team priced in each 10% bucket went on to win.
 * `field` is 'pre' (price at the start) or 'min' (lowest price it ever had).
 */
export function calibration(matches, field = 'pre') {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0, wins: 0, priceSum: 0 }));
  for (const m of matches || []) {
    for (const t of m.teams || []) {
      if (typeof t.won !== 'boolean') continue;
      const p = t[field];
      if (!Number.isFinite(p)) continue;
      const b = buckets[Math.min(9, Math.max(0, Math.floor(p * 10)))];
      b.n++;
      b.priceSum += p;
      if (t.won) b.wins++;
    }
  }
  return buckets.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, wins: b.wins, rate: b.n ? b.wins / b.n : null, implied: b.n ? b.priceSum / b.n : null }));
}

/** Our own bets: totals for the KPI row. */
export function betTotals(bets, now = Date.now()) {
  const dayStart = Math.floor(now / 86400e3) * 86400e3;
  const t = { count: 0, open: 0, won: 0, lost: 0, voided: 0, sold: 0, staked: 0, openCost: 0, openMark: 0, realized: 0, today: 0, todayStaked: 0 };
  for (const b of bets || []) {
    if (b.status === 'failed' || b.status === 'pending' || b.status === 'missed') continue;
    t.count++;
    t.staked += b.cost || 0;
    if (b.placedAt >= dayStart) t.todayStaked += b.cost || 0;
    if (b.status === 'open') {
      t.open++;
      t.openCost += b.cost || 0;
      // A partly sold bet carries what the sale returned until it settles.
      t.openMark += (b.shares || 0) * (Number.isFinite(b.mark) ? b.mark : b.price || 0) + (b.exitProceeds || 0);
      continue;
    }
    const pnl = (b.payout || 0) - (b.cost || 0);
    t.realized += pnl;
    if ((b.settledAt || 0) >= dayStart) t.today += pnl;
    if (b.status === 'won') t.won++;
    else if (b.status === 'lost') t.lost++;
    else if (b.status === 'void') t.voided++;
    else if (b.status === 'sold') t.sold++;
  }
  return t;
}
