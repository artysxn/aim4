// ---------------------------------------------------------------------------
// server/insights/botbacktest.js
// Backtest any bot with its own settings and stake rule, then replay the bets
// through a wallet: what it would have made, month by month, how deep it fell,
// and how often a year like this goes bust (Monte Carlo).
//
// Data per bot type:
//   comeback  the history pack (a year of esports price paths, history.js)
//   whale     stored whale entries with their results (the tracked history)
//   fade      stored underdog buys and match results
//   value     stored start prices and match results
// Swing and market making keep their own backtests (5-minute history, ticks).
// ---------------------------------------------------------------------------

import { col } from './store.js';
import { loadPack } from './history.js';
import { autoStake, comebackRules } from './bots.js';

const DAY = 86400;
const fee = (p) => 0.03 * Math.min(p, 1 - p);
// What one dollar returns: held to the end (1/cost or 0), or sold on the way up (mult set by the signal).
const multOf = (b) => (Number.isFinite(b.mult) ? b.mult : b.won ? 1 / (b.q + fee(b.q)) : 0);
const ret = (b) => multOf(b) - 1;
const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

// ---- signals per bot type (times in unix seconds) -------------------------------

function comebackBets(p, sinceS, extraSlip) {
  const games = p.games?.length ? p.games : ['cs2', 'valorant', 'lol', 'dota2'];
  const bets = [];
  for (const r of loadPack()) {
    if (r.s < sinceS || !games.includes(r.g)) continue;
    if (p.lowTierOnly && !r.low) continue;
    let best = null;
    for (let x = 0; x < 2; x++) {
      const rules = comebackRules(p, { game: r.g, team: r.n[x], opponent: r.n[1 - x] });
      if (rules.skip) continue;
      const preX = x === 0 ? r.pre : 1 - r.pre;
      // Leg 1: back a listed team before the start, held to the end.
      if (rules.listed && p.backListed && preX + 0.01 + extraSlip <= (p.backMaxPrice ?? 0.85)) {
        const q = Math.min(0.99, preX + 0.01 + extraSlip);
        bets.push({ at: r.s - 600, end: r.e, q, won: r.w === x, mult: r.w === x ? 1 / (q + fee(q)) : 0, sold: false, leg: 'pre', game: r.g, title: `${r.n[0]} vs ${r.n[1]}`, team: `${r.n[x]} (before the start)` });
      }
      if (rules.formats?.length && r.f && !rules.formats.includes(r.f)) continue;
      if (preX < rules.preMin) continue;
      const px = (i) => (x === 0 ? r.p[i + 1] / 1000 : 1 - r.p[i + 1] / 1000);
      for (let i = 0; i + 4 < r.p.length; i += 2) {
        if (px(i) > rules.collapseAt) continue;
        const p3 = median([px(i), px(i + 2), px(i + 4)]);
        if (p3 > rules.collapseAt + 0.03) continue;
        const q = Math.min(0.99, p3 + 0.01 + extraSlip);
        if (q > rules.collapseAt + p.maxSlippage + extraSlip) break;
        if (rules.maxMinutes && r.p[i] / 60 > rules.maxMinutes) break;
        // Sudden collapses only: the highest price in the 10 minutes before, minus the price now.
        if (rules.minDrop) {
          let hi = px(i);
          for (let j = i; j >= 0 && r.p[i] - r.p[j] <= 600; j -= 2) hi = Math.max(hi, px(j));
          if (hi - px(i) < rules.minDrop) continue;
        }
        const at = r.s + r.p[i];
        const won = r.w === x;
        let mult = won ? 1 / (q + fee(q)) : 0, end = r.e, sold = false;
        // Take profit: the first later trade at or above sellAt sells it all, 1c under (the bid), taker fee.
        if (rules.sellAt) {
          for (let k = i + 6; k < r.p.length; k += 2) {
            if (px(k) < rules.sellAt) continue;
            const sp = rules.sellAt - 0.01;
            mult = (sp - fee(sp)) / (q + fee(q));
            end = r.s + r.p[k];
            sold = true;
            break;
          }
        }
        if (!best || at < best.at) best = { at, end, q, won, mult, sold, leg: 'comeback', game: r.g, title: `${r.n[0]} vs ${r.n[1]}`, team: r.n[x] + (rules.listed ? ' (listed, held)' : '') };
        break;
      }
    }
    if (best) bets.push(best);
  }
  return bets;
}

function whaleBets(p, sinceS, extraSlip) {
  const flags = new Map(col('flags').map((f) => [f.id, f]));
  const seen = new Set();
  const out = [];
  const entries = [];
  for (const w of Object.values(col('wallets'))) {
    const done = (w.entries || []).filter((e) => e.result === 'won' || e.result === 'lost').sort((a, b) => a.at - b.at);
    done.forEach((e, i) => {
      const prior = done.slice(0, i);
      const priorRoi = prior.length ? prior.reduce((s, x) => s + (x.result === 'won' ? 1 / x.price - 1 : -1), 0) / prior.length : 0;
      entries.push({ e, f: flags.get(e.flagId), priorN: prior.length, priorRoi });
    });
  }
  entries.sort((a, b) => a.e.at - b.e.at);
  for (const { e, f, priorN, priorRoi } of entries) {
    if (e.at / 1000 < sinceS) continue;
    if (e.market !== 'match' && !p.copyMaps) continue;
    const reasons = f ? f.reasons.map((r) => r.key) : [];
    if ((f?.score ?? e.score ?? 0) < (p.minScore || 0)) continue;
    if ((p.needs || []).length && !reasons.some((r) => p.needs.includes(r))) continue;
    if (reasons.some((r) => (p.excludes || []).includes(r))) continue;
    if (e.price > p.maxWhalePrice || e.price < (p.minWhalePrice || 0) || e.cash < (p.minWhaleCash || 0) || (p.maxWhaleCash && e.cash > p.maxWhaleCash)) continue;
    if (p.skipLosers && priorN >= (p.loserMinResolved || 5) && priorRoi < 0) continue;
    if (!p.copyLive && e.live) continue;
    if (!p.copyPrematch && !e.live) continue;
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    const at = Math.round(e.at / 1000);
    out.push({ at, end: at + 3 * 3600, q: Math.min(e.price + p.maxSlippage / 2 + extraSlip, p.maxEntry), won: e.result === 'won', title: f?.outcome ? `${f.outcome}` : '', team: e.outcome || f?.outcome || '' });
  }
  return out;
}

function fadeBets(p, sinceS, extraSlip) {
  const teams = col('teams');
  const events = col('events');
  const rows = [];
  for (const f of col('flags')) {
    if (f.kind !== 'entry' || f.market !== 'match') continue;
    const t = teams[f.conditionId]?.teams.find((x) => x.name === f.outcome);
    if (!t || typeof t.won !== 'boolean') continue;
    const ev = events[f.eventId] || {};
    rows.push({ f, won: t.won, ev, live: f.at > (ev.start || Infinity) });
  }
  rows.sort((a, b) => a.f.at - b.f.at);
  const count = new Map();
  const seen = new Set();
  const out = [];
  for (const { f, won, ev, live } of rows) {
    const k = `${f.eventId}|${f.outcomeIndex}`;
    count.set(k, (count.get(k) || 0) + 1);
    if (f.at / 1000 < sinceS || seen.has(f.eventId)) continue;
    if (count.get(k) < p.minBuys || f.price > p.maxWhalePrice) continue;
    if (p.formats?.length && ev.format && !p.formats.includes(ev.format)) continue;
    if (p.prematchOnly && live) continue;
    seen.add(f.eventId);
    const at = Math.round(f.at / 1000);
    out.push({ at, end: at + 3 * 3600, q: Math.min(p.maxEntry, 1 - f.price + p.maxSlippage / 2 + extraSlip), won: !won, title: ev.title || '', team: `against ${f.outcome}` });
  }
  return out;
}

function valueBets(p, sinceS, extraSlip) {
  const events = col('events');
  const out = [];
  for (const m of Object.values(col('teams'))) {
    if ((m.start || 0) / 1000 < sinceS) continue;
    const ev = events[m.eventId] || {};
    if (p.formats?.length && ev.format && !p.formats.includes(ev.format)) continue;
    const t = (m.teams || []).find((x) => typeof x.won === 'boolean' && Number.isFinite(x.pre) && x.pre >= p.priceMin && x.pre <= p.priceMax);
    if (!t) continue;
    const at = Math.round(m.start / 1000);
    out.push({ at, end: at + 3 * 3600, q: t.pre + 0.01 + extraSlip, won: t.won, title: m.title || '', team: t.name });
  }
  return out;
}

// ---- wallet replay with the bot's stake rule ------------------------------------

function stakeOf(bot, equity, drawdown) {
  if (bot.sizing.kind === 'auto') return autoStake({ bankroll: equity, fillCost: 0.01, drawdown, maxStake: bot.maxStake, minStake: bot.minStake }).stake;
  const raw = bot.sizing.kind === 'fixed' ? bot.sizing.value : (equity * bot.sizing.value) / 100;
  return Math.min(bot.maxStake, Math.max(bot.minStake, raw));
}

function replay(bets, bot, start) {
  let cash = start, peak = start, maxDd = 0, placed = 0, broke = false;
  const open = [], months = new Map(), dayPnl = new Map(), placedBets = [];
  const equity = () => cash + open.reduce((s, x) => s + x.stake, 0);
  const settle = (until) => {
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].end > until) continue;
      const o = open.splice(i, 1)[0];
      cash += o.pay;
      dayPnl.set(o.day, (dayPnl.get(o.day) || 0) + o.pay - o.stake);
      const mo = months.get(o.month);
      mo.profit += o.pay - o.stake;
      if (o.pay > o.stake) mo.won++;
    }
  };
  for (const b of bets) {
    settle(b.at);
    const eq = equity();
    peak = Math.max(peak, eq);
    const dd = peak > 0 ? 1 - eq / peak : 0;
    maxDd = Math.max(maxDd, dd);
    const d = new Date(b.at * 1000).toISOString();
    const month = d.slice(0, 7), day = d.slice(0, 10);
    if (!months.has(month)) months.set(month, { month, start: eq, bets: 0, won: 0, profit: 0 });
    if (eq < bot.minStake) { broke = true; continue; }
    if ((dayPnl.get(day) || 0) <= -eq * (bot.dailyLossPct / 100)) continue;
    const stake = Math.floor(stakeOf(bot, eq, dd) * 100) / 100;
    if (!stake || stake > cash || open.reduce((s, x) => s + x.stake, 0) + stake > Math.max(eq * (bot.maxOpenPct / 100), bot.minStake)) continue;
    cash -= stake;
    placed++;
    months.get(month).bets++;
    open.push({ end: b.end, stake, month, day, pay: stake * multOf(b) });
    placedBets.push({ ...b, stake });
  }
  settle(Infinity);
  const list = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  list.forEach((m, i) => (m.end = i + 1 < list.length ? list[i + 1].start : cash));
  return { start, end: cash, peak: Math.max(peak, cash), maxDrawdown: maxDd, broke: broke && cash < bot.minStake, placed, months: list, placedBets };
}

/** A year of random bets from this pool at its own rate, many times: bust and spread. */
function monteCarlo(bets, bot, start, spanDays, runs = 1000) {
  if (bets.length < 20 || spanDays < 7) return null;
  const perDay = bets.length / spanDays;
  let bust = 0, half = 0, mUp = 0, mN = 0;
  const ends = [];
  for (let r = 0; r < runs; r++) {
    let w = start, peak = start, min = start, dead = false;
    for (let mo = 0; mo < 12 && !dead; mo++) {
      const before = w;
      for (let i = 0, n = Math.round(perDay * 30); i < n; i++) {
        peak = Math.max(peak, w);
        const st = stakeOf(bot, w, 1 - w / peak);
        if (!st || w < Math.max(st, bot.minStake)) { dead = true; break; }
        w += st * ret(bets[Math.floor(Math.random() * bets.length)]);
        min = Math.min(min, w);
      }
      mN++;
      if (w > before) mUp++;
    }
    if (dead) bust++;
    if (min < start / 2) half++;
    ends.push(dead ? 0 : w);
  }
  ends.sort((a, b) => a - b);
  return { runs, bust: bust / runs, everHalf: half / runs, monthsUp: mUp / mN, worst5: ends[Math.floor(runs * 0.05)], median: ends[runs >> 1], best5: ends[Math.floor(runs * 0.95)] };
}

const summary = (bets) => {
  const n = bets.length;
  if (!n) return { bets: 0 };
  return { bets: n, winRate: bets.filter((b) => multOf(b) > 1).length / n, sold: bets.filter((b) => b.sold).length / n, avgPrice: bets.reduce((s, b) => s + b.q, 0) / n, returnPerBet: bets.reduce((s, b) => s + ret(b), 0) / n };
};

/**
 * @param {object} bot      a bot as stored
 * @param {{ days?:number, start?:number, extraSlip?:number }} o
 *   extraSlip: cents (as a fraction) added to every fill, to test thinner books
 */
export function botBacktest(bot, { days = 365, start = 500, extraSlip = 0 } = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const sinceS = nowS - days * DAY;
  let bets, source;
  if (bot.type === 'comeback') {
    bets = comebackBets(bot.params, sinceS, extraSlip);
    const pack = loadPack();
    source = `History pack: ${pack.length.toLocaleString('en-US')} settled esports matches with full price paths`;
  } else if (bot.type === 'whale') {
    bets = whaleBets(bot.params, sinceS, extraSlip);
    source = 'Stored whale entries with results (tracked history only)';
  } else if (bot.type === 'fade') {
    bets = fadeBets(bot.params, sinceS, extraSlip);
    source = 'Stored underdog buys and match results (tracked history only)';
  } else if (bot.type === 'value') {
    bets = valueBets(bot.params, sinceS, extraSlip);
    source = 'Stored start prices and results (tracked history only)';
  } else {
    const e = new Error('Swing and market-making bots use the 5-minute history and recorded-tick backtests on the Brain page.');
    e.status = 400;
    throw e;
  }
  bets.sort((a, b) => a.at - b.at);
  const from = bets[0]?.at || sinceS, to = bets[bets.length - 1]?.at || nowS;
  const spanDays = Math.max(1, (to - from) / DAY);
  const half = Math.floor(bets.length / 2);
  const w = replay(bets, bot, start);
  const byGame = {};
  for (const b of bets) if (b.game) (byGame[b.game] ||= []).push(b);
  return {
    bot: { id: bot.id, name: bot.name, type: bot.type, sizing: bot.sizing },
    source,
    days,
    from,
    to,
    perDay: bets.length / spanDays,
    extraSlip,
    all: summary(bets),
    firstHalf: summary(bets.slice(0, half)),
    secondHalf: summary(bets.slice(half)),
    last90: summary(bets.filter((b) => b.at >= nowS - 90 * DAY)),
    games: Object.fromEntries(Object.entries(byGame).map(([g, bs]) => [g, summary(bs)])),
    wallet: { start: w.start, end: w.end, peak: w.peak, maxDrawdown: w.maxDrawdown, broke: w.broke, placed: w.placed },
    months: w.months.map((m) => ({ month: m.month, bets: m.bets, won: m.won, start: m.start, end: m.end, profit: m.end - m.start })),
    monteCarlo: monteCarlo(bets, bot, start, spanDays),
    worstRun30: (() => { const rs = bets.map(ret); let w = 0; for (let i = 0; i + 30 <= rs.length; i++) { let t = 0; for (let k = i; k < i + 30; k++) t += rs[k]; w = Math.min(w, t); } return w; })(),
    recent: w.placedBets.slice(-25).reverse().map((b) => ({ at: b.at, title: b.title, team: b.team, game: b.game || '', price: b.q, stake: b.stake, won: b.won, sold: Boolean(b.sold), profit: b.stake * (multOf(b) - 1) }))
  };
}
