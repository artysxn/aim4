// ---------------------------------------------------------------------------
// server/insights/backtest.js
// What a strategy variant would have made, before it trades a cent.
//
//   history   swing variants on Polymarket's 5-minute price paths of every
//             finished tracked match. Walk-forward: the reaction table is
//             fitted on the earlier matches only and traded on the later ones,
//             paying a spread estimate and the taker fee both ways.
//   ticks     the recorder's ticks replayed: books rebuilt level by level,
//             trades on the tape, scores. Market-making quotes fill only when
//             the tape trades through them; swing entries pay the ask and
//             exit into the bid. Settled at the real result where known.
// ---------------------------------------------------------------------------

import { fitTables, samplesOf, predict, priceAt, volOf } from './reaction.js';
import { listRecordings, readRecording } from './recorder.js';
import { col } from './store.js';
import { STRATEGY_DEFS } from './brain.js';

const MIN = 60e3;
const fee = (rate, p) => rate * Math.min(p, 1 - p);

/** Rebuild one token's mid path ([[t, mid]]) from recorded book lines. */
export function replayMids(lines, token, every = 5000) {
  const bids = new Map();
  const asks = new Map();
  const out = [];
  let lastAt = -Infinity;
  let lastTrade = null;
  for (const l of lines) {
    if (l.a !== token) continue;
    if (l.k === 'b' || l.k === 'q') {
      bids.clear();
      asks.clear();
      for (const [p, s] of l.b) bids.set(p, s);
      for (const [p, s] of l.s) asks.set(p, s);
    } else if (l.k === 'p') {
      const side = l.d === 'b' ? bids : asks;
      if (l.z > 0) side.set(l.p, l.z);
      else side.delete(l.p);
    } else if (l.k === 'x') lastTrade = l.p;
    if (l.t - lastAt < every) continue;
    let bb = null;
    let ba = null;
    for (const [p, s] of bids) if (s > 0 && (bb === null || p > bb)) bb = p;
    for (const [p, s] of asks) if (s > 0 && (ba === null || p < ba)) ba = p;
    const mid = bb !== null && ba !== null && ba - bb <= 0.1 ? (bb + ba) / 2 : lastTrade;
    if (mid !== null) {
      out.push([l.t, mid]);
      lastAt = l.t;
    }
  }
  return out;
}

/** Swing on 5-minute history, walk-forward. */
export function historyBacktest(matches, variantId, { split = 0.7, spread = 0.02, feeRate = 0.03 } = {}) {
  const p = STRATEGY_DEFS.swing.variants[variantId];
  if (!p) throw new Error(`Unknown swing variant ${variantId}`);
  const sorted = matches.filter((m) => m.path?.length > 3).sort((a, b) => a.start - b.start);
  const cut = Math.floor(sorted.length * split);
  const fit = fitTables(sorted.slice(0, cut).flatMap((m) => samplesOf(m)));
  const h = p.horizon === 15 ? 1 : 2;
  const trades = [];
  for (const m of sorted.slice(cut)) {
    for (const s of samplesOf(m, 5 * MIN)) {
      if (s.fut[h] === null) continue;
      if (p.afterScore) continue; // needs recorded score changes; see the tick backtest
      const pred = predict(fit, s.phase, s.p, s.move)[h].shrunk;
      const ask = s.p + spread / 2;
      const cost = ask - s.p + fee(feeRate, ask);
      const edge = s.p + pred - ask - fee(feeRate, ask);
      if (edge < p.minEdge) continue;
      const exitBid = s.p + s.fut[h] - spread / 2;
      const ret = (exitBid - fee(feeRate, exitBid) - ask - fee(feeRate, ask)) / ask;
      trades.push({ t: s.t, p: s.p, pred, edge, ret, cost });
    }
  }
  return summarize(trades, { kind: 'history', variant: variantId, trainMatches: cut, testMatches: sorted.length - cut });
}

function summarize(trades, meta) {
  const n = trades.length;
  const wins = trades.filter((t) => t.ret > 0).length;
  const total = trades.reduce((s, t) => s + t.ret, 0);
  const sorted = trades.map((t) => t.ret).sort((a, b) => a - b);
  let peak = 0;
  let run = 0;
  let dd = 0;
  for (const t of trades.sort((a, b) => a.t - b.t)) {
    run += t.ret;
    peak = Math.max(peak, run);
    dd = Math.min(dd, run - peak);
  }
  return { ...meta, trades: n, winRate: n ? wins / n : null, avgReturn: n ? total / n : null, totalPerDollar: total, median: n ? sorted[Math.floor(n / 2)] : null, maxDrawdown: dd };
}

/** Replay recorded ticks for a market-making or swing variant. */
export async function tickBacktest(strategy, variantId, { days = 30, feeRate = 0.03, tables = null } = {}) {
  const def = STRATEGY_DEFS[strategy];
  const p = def?.variants[variantId];
  if (!p || strategy === 'whale') throw new Error('Tick backtests run market-making and swing variants');
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
  const recs = listRecordings().filter((r) => r.day >= since);
  const events = col('events');
  const trades = [];
  let quotesFilled = 0;
  for (const rec of recs) {
    const ev = events[rec.eventId];
    const m = ev?.markets.find((x) => x.kind === 'match');
    if (!m) continue;
    const lines = await readRecording(rec.file).catch(() => []);
    if (lines.length < 50) continue;
    const win = m.closed && m.prices ? (m.prices[0] >= 0.99 ? 0 : m.prices[1] >= 0.99 ? 1 : null) : null;
    const books = m.tokens.map(() => ({ bids: new Map(), asks: new Map() }));
    const best = (bk) => {
      let bb = null;
      let ba = null;
      for (const [px, s] of bk.bids) if (s > 0 && (bb === null || px > bb)) bb = px;
      for (const [px, s] of bk.asks) if (s > 0 && (ba === null || px < ba)) ba = px;
      return { bb, ba };
    };
    const mids = m.tokens.map(() => []);
    const scoreTimes = [];
    const pos = m.tokens.map(() => ({ shares: 0, cost: 0 }));
    const quotes = m.tokens.map(() => null);
    let open = null; // swing position
    let lastEval = 0;
    for (const l of lines) {
      if (l.k === 's') {
        scoreTimes.push(l.t);
        quotes[0] = quotes[1] = null; // pulled on score changes
        continue;
      }
      const i = m.tokens.indexOf(l.a);
      if (i < 0) continue;
      const bk = books[i];
      if (l.k === 'b' || l.k === 'q') {
        bk.bids = new Map(l.b);
        bk.asks = new Map(l.s);
      } else if (l.k === 'p') {
        const side = l.d === 'b' ? bk.bids : bk.asks;
        if (l.z > 0) side.set(l.p, l.z);
        else side.delete(l.p);
      } else if (l.k === 'x' && strategy === 'mm') {
        // A taker sell through our bid fills it; at our exact price, half the print.
        const q = quotes[i];
        if (q && l.d === 's' && l.p <= q.px + 1e-9) {
          const take = Math.min(q.usd / q.px - q.filled, l.z * (l.p < q.px - 1e-9 ? 1 : 0.5));
          if (take > 0) {
            q.filled += take;
            pos[i].shares += take;
            pos[i].cost += take * q.px;
            quotesFilled++;
          }
        }
      }
      const { bb, ba } = best(bk);
      if (bb === null || ba === null) continue;
      const mid = (bb + ba) / 2;
      const mp = mids[i];
      if (!mp.length || l.t - mp[mp.length - 1][0] >= 5000) mp.push([l.t, mid]);
      if (l.t - lastEval < 15e3 || i !== 0) continue;
      lastEval = l.t;
      const live = Boolean(ev.start && l.t >= ev.start);
      const phase = live ? 'live' : 'pre';
      if (strategy === 'mm') {
        const vol = volOf(tables || { volatility: {} }, phase, mid);
        const half = Math.max(0.01, p.spreadK * (vol.sd5 || 0.02) * 0.5);
        if (ba - bb < 0.02) continue;
        for (const j of [0, 1]) {
          const ref = j === 0 ? mid : 1 - mid;
          const inv = pos[j].cost;
          const px = Math.round(Math.floor((ref - half) * 100) / 100 * 1000) / 1000;
          quotes[j] = inv < p.maxInv && px > 0.01 ? { px, usd: p.size, filled: 0 } : null;
        }
      } else {
        const m5 = priceAt(mp, l.t - 5 * MIN);
        if (m5 === null) continue;
        if (open) {
          const target = open.target;
          if (bb >= target || bb <= open.stop || l.t >= open.timeStop) {
            const ret = (bb - fee(feeRate, bb) - open.px - fee(feeRate, open.px)) / open.px;
            trades.push({ t: l.t, ret, event: rec.eventId });
            open = null;
          }
          continue;
        }
        const h = p.horizon === 15 ? 1 : 2;
        const pred = predict(tables || { reaction: {} }, phase, mid, mid - m5)[h].shrunk;
        if (p.afterScore && !scoreTimes.some((t) => l.t - t <= 3 * MIN && l.t - t >= 45e3)) continue;
        const edge = mid + pred - ba - fee(feeRate, ba);
        if (edge >= p.minEdge) {
          const vol = volOf(tables || { volatility: {} }, phase, mid);
          const sdH = (vol.sd5 || 0.03) * Math.sqrt(p.horizon / 5);
          open = { px: ba, target: Math.min(0.99, ba + Math.max(p.minEdge, 0.8 * sdH)), stop: Math.max(0.01, ba - Math.max(0.03, 1.2 * sdH)), timeStop: l.t + p.horizon * 2 * MIN };
        }
      }
    }
    // Close out: market-making inventory at the result (or the last mid), swing at the last bid.
    if (strategy === 'mm') {
      for (const j of [0, 1]) {
        if (!pos[j].shares) continue;
        const last = mids[j][mids[j].length - 1]?.[1] ?? 0.5;
        const value = win === null ? last : win === j ? 1 : 0;
        trades.push({ t: lines[lines.length - 1].t, ret: (pos[j].shares * value - pos[j].cost) / pos[j].cost, event: rec.eventId, usd: pos[j].cost });
      }
    } else if (open) {
      const last = mids[0][mids[0].length - 1]?.[1] ?? open.px;
      trades.push({ t: lines[lines.length - 1].t, ret: (last - open.px) / open.px, event: rec.eventId });
    }
  }
  return summarize(trades, { kind: 'ticks', strategy, variant: variantId, recordings: recs.length, quotesFilled });
}
