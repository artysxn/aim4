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
import { autoStake, comebackRules, leaderView, teamKey } from './bots.js';

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
  // Oracle V3.2: its crash bets, plus the leader on every other match's crash (one bet per match).
  if (p.bet === 'both') {
    const crash = comebackBets({ ...p, bet: 'crashed' }, sinceS, extraSlip);
    const taken = new Set(crash.map((b) => b.cid)); // live: the leader leg skips any match the bot already holds, pre-match leg included
    const lead = comebackBets(leaderView(p), sinceS, extraSlip)
      .filter((b) => b.leg === 'comeback' && !taken.has(b.cid))
      .map((b) => ({ ...b, kellyPct: p.leaderKellyPct ?? 19.1 }));
    return [...crash, ...lead].sort((a, b) => a.at - b.at);
  }
  const games = p.games?.length ? p.games : ['cs2', 'valorant', 'lol', 'dota2'];
  const bets = [];
  for (const r of loadPack()) {
    if (r.s < sinceS || !games.includes(r.g)) continue;
    if (p.lowTierOnly && !r.low) continue;
    let best = null;
    const again = [null, null];
    for (let x = 0; x < 2; x++) {
      const rules = comebackRules(p, { game: r.g, team: r.n[x], opponent: r.n[1 - x] });
      if (rules.skip) continue;
      const preX = x === 0 ? r.pre : 1 - r.pre;
      // Leg 1: back a listed team before the start, held to the end.
      if (rules.listed && p.backListed && preX + 0.01 + extraSlip <= (p.backMaxPrice ?? 0.85)) {
        const q = Math.min(0.99, preX + 0.01 + extraSlip);
        bets.push({ at: r.s - 600, end: r.e, cid: r.cid, q, won: r.w === x, mult: r.w === x ? 1 / (q + fee(q)) : 0, sold: false, leg: 'pre', game: r.g, title: `${r.n[0]} vs ${r.n[1]}`, team: `${r.n[x]} (before the start)` });
      }
      if (rules.formats?.length && r.f && !rules.formats.includes(r.f)) continue;
      if (preX < rules.preMin) continue;
      const px = (i) => (x === 0 ? r.p[i + 1] / 1000 : 1 - r.p[i + 1] / 1000);
      // Top-tier LoL/Valorant comebacks are overpriced (2026-11-08): the leader leg may fire earlier there.
      const ca = p.bet === 'leader' && !r.low && p.leaderTopCollapseAt > 0 && (p.leaderTopGames || []).includes(r.g) ? Math.max(rules.collapseAt, p.leaderTopCollapseAt) : rules.collapseAt;
      for (let i = 0; i + 4 < r.p.length; i += 2) {
        if (px(i) > ca) continue;
        const p3 = median([px(i), px(i + 2), px(i + 4)]);
        if (p3 > ca + 0.03) continue;
        const q = Math.min(0.99, p3 + 0.01 + extraSlip);
        if (q > ca + p.maxSlippage + extraSlip) break;
        if (rules.maxMinutes && r.p[i] / 60 > rules.maxMinutes) break;
        let hi = px(i);
        for (let j = i; j >= 0 && r.p[i] - r.p[j] <= 600; j -= 2) hi = Math.max(hi, px(j));
        // In-game trades a minute so far: the path's points before now (as brain.tradesPerMin counts live).
        const tpm = i / 2 / Math.max(1, r.p[i] / 60);
        if (p.bet === 'leader') {
          // Buy the other side when the comeback is overpriced: not a crash the
          // crashed-team bots take, and higher tier, busy or BO1.
          if (p.notAgainst?.some((t) => teamKey(t) === teamKey(r.n[x]))) break;
          // The leader pays only when it is not too dear (2026-11-08: 78-85% +4.3%/+4.9% a bet, above 85% none).
          if (1 - p3 + 0.01 + extraSlip > (p.leaderMaxPrice ?? 0.97) + 1e-9) continue;
          const crashBotsTake = r.low && ['BO3', 'BO5'].includes(r.f) && hi - px(i) >= 0.2 && !(r.g === 'cs2' && r.p[i] / 60 > 90);
          if (crashBotsTake) break;
          if (r.low && tpm < (p.busyAt ?? 4) && r.f !== 'BO1') continue;
          // A crash with a big single-trade shock tends to come back: no leader bet (2026-11-08: 20+ pt shock -9.8%/-6.1% a bet).
          if (p.leaderMaxShock > 0) {
            let step = 0;
            for (let j = i; j >= 2 && r.p[i] - r.p[j] <= 600; j -= 2) step = Math.max(step, px(j - 2) - px(j));
            if (step >= p.leaderMaxShock) continue;
          }
          const oq = Math.min(0.99, 1 - p3 + 0.01 + extraSlip);
          const lw = r.w === 1 - x;
          const at = r.s + r.p[i];
          if (!best || at < best.at) best = { at, end: r.e, cid: r.cid, q: oq, won: lw, mult: lw ? 1 / (oq + fee(oq)) : 0, sold: false, leg: 'comeback', game: r.g, title: `${r.n[0]} vs ${r.n[1]}`, team: `${r.n[1 - x]} (leader)` };
          break;
        }
        // Sudden collapses only: the highest price in the 10 minutes before, minus the price now.
        if (rules.minDrop && hi - px(i) < rules.minDrop) continue;
        // Busy markets price a crash right: skip them.
        if (p.maxTradesPerMin > 0 && tpm >= p.maxTradesPerMin) continue;
        // A shock: the biggest single-trade fall in the 10 minutes before (as brain.shockStep reads it live).
        if (p.minShock > 0) {
          let step = 0;
          for (let j = i; j >= 2 && r.p[i] - r.p[j] <= 600; j -= 2) step = Math.max(step, px(j - 2) - px(j));
          if (step < p.minShock) continue;
        }
        const at = r.s + r.p[i];
        const won = r.w === x;
        const exit = (from, qq) => {
          // Take profit: the first later trade at or above sellAt sells it all, 1c under (the bid), taker fee.
          if (rules.sellAt) for (let k = from + 6; k < r.p.length; k += 2) if (px(k) >= rules.sellAt) { const sp = rules.sellAt - 0.01; return { mult: (sp - fee(sp)) / (qq + fee(qq)), end: r.s + r.p[k], sold: true, k }; }
          return { mult: won ? 1 / (qq + fee(qq)) : 0, end: r.e, sold: false, k: r.p.length };
        };
        const e1 = exit(i, q);
        if (!best || at < best.at) best = { x, at, end: e1.end, cid: r.cid, q, won, mult: e1.mult, sold: e1.sold, leg: 'comeback', game: r.g, title: `${r.n[0]} vs ${r.n[1]}`, team: r.n[x] + (rules.listed ? ' (listed, held)' : '') };
        // Sold on the way up and it crashes again: the same rules buy it again (the live bot does: it only checks open bets).
        if (e1.sold && p.reenter !== false) {
          for (let i2 = e1.k + 2; i2 + 4 < r.p.length; i2 += 2) {
            if (px(i2) > rules.collapseAt) continue;
            const p32 = median([px(i2), px(i2 + 2), px(i2 + 4)]);
            if (p32 > rules.collapseAt + 0.03) continue;
            const q2 = Math.min(0.99, p32 + 0.01 + extraSlip);
            if (q2 > rules.collapseAt + p.maxSlippage + extraSlip) break;
            if (rules.maxMinutes && r.p[i2] / 60 > rules.maxMinutes) break;
            let hi2 = px(i2), step2 = 0;
            for (let j = i2; j >= 2 && r.p[i2] - r.p[j] <= 600; j -= 2) { hi2 = Math.max(hi2, px(j)); step2 = Math.max(step2, px(j - 2) - px(j)); }
            if (rules.minDrop && hi2 - px(i2) < rules.minDrop) continue;
            if (p.maxTradesPerMin > 0 && i2 / 2 / Math.max(1, r.p[i2] / 60) >= p.maxTradesPerMin) continue;
            if (p.minShock > 0 && step2 < p.minShock) continue;
            const e2 = exit(i2, q2);
            again[x] = { at: r.s + r.p[i2], end: e2.end, cid: r.cid, q: q2, won, mult: e2.mult, sold: e2.sold, leg: 'comeback', game: r.g, title: `${r.n[0]} vs ${r.n[1]}`, team: `${r.n[x]} (again)` };
            break;
          }
        }
        break;
      }
    }
    if (best) {
      bets.push(best);
      if (best.x !== undefined && again[best.x]) bets.push(again[best.x]);
    }
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

function stakeOf(bot, equity, drawdown, kellyPct = bot.kellyPct) {
  if (bot.sizing.kind === 'auto') return autoStake({ bankroll: equity, fillCost: 0.01, drawdown, maxStake: bot.maxStake, minStake: bot.minStake, kellyPct, kellyFrom: bot.kellyFrom }).stake;
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
        const pick = bets[Math.floor(Math.random() * bets.length)];
        const st = stakeOf(bot, w, 1 - w / peak, pick.kellyPct ?? bot.kellyPct);
        if (!st || w < Math.max(st, bot.minStake)) { dead = true; break; }
        w += st * ret(pick);
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

/** Every signal this bot would have acted on since a time (unix seconds), oldest first. */
function signalsFor(bot, sinceS, extraSlip) {
  let bets, source, dataFrom = null;
  if (bot.type === 'comeback') {
    bets = comebackBets(bot.params, sinceS, extraSlip);
    const pack = loadPack();
    for (const r of pack) if (dataFrom === null || r.s < dataFrom) dataFrom = r.s;
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
  if (dataFrom === null) dataFrom = bets[0]?.at ?? null;
  return { bets, source, dataFrom };
}

/**
 * The wallet bet by bet, the way the live bot would size it: the automatic stake
 * halves until 10 fills are measured, stops for good once fills run over 2.5c
 * above the mid (fillCost), and stops under $10. Every settlement is a point.
 * Times in the result are milliseconds.
 */
function replayCurve(bets, bot, start, { fillCost = 0.01, startS = null } = {}) {
  let cash = start, peak = start, low = start, maxDd = 0, placed = 0, won = 0, fills = 0;
  let stopped = null;
  const open = [], curve = [], months = new Map(), dayPnl = new Map();
  const skips = { daily: 0, open: 0, stake: 0 };
  const equity = () => cash + open.reduce((s, x) => s + x.stake, 0);
  const monthOf = (t) => {
    const k = new Date(t * 1000).toISOString().slice(0, 7);
    if (!months.has(k)) months.set(k, { month: k, start: equity(), bets: 0, won: 0, profit: 0 });
    return months.get(k);
  };
  const settle = (until) => {
    const due = open.filter((o) => o.end <= until).sort((a, b) => a.end - b.end);
    for (const o of due) {
      open.splice(open.indexOf(o), 1);
      cash += o.pay;
      const pnl = o.pay - o.stake;
      dayPnl.set(o.day, (dayPnl.get(o.day) || 0) + pnl);
      const mo = monthOf(o.end);
      mo.profit += pnl;
      if (pnl > 0) {
        mo.won++;
        won++;
      }
      const eq = equity();
      peak = Math.max(peak, eq);
      low = Math.min(low, eq);
      maxDd = Math.max(maxDd, peak > 0 ? 1 - eq / peak : 0);
      curve.push({ t: o.end * 1000, v: Math.round(eq * 100) / 100, d: Math.round(pnl * 100) / 100, title: o.b.title, team: o.b.team, price: o.b.q, stake: o.stake, won: pnl > 0, sold: Boolean(o.b.sold), game: o.b.game || '' });
    }
  };
  for (const b of bets) {
    settle(b.at);
    if (stopped) continue;
    const eq = equity();
    const dd = peak > 0 ? 1 - eq / peak : 0;
    const mo = monthOf(b.at);
    const day = new Date(b.at * 1000).toISOString().slice(0, 10);
    if ((dayPnl.get(day) || 0) <= -eq * ((bot.dailyLossPct ?? 10) / 100)) {
      skips.daily++;
      continue;
    }
    let stake;
    if (bot.sizing.kind === 'auto') {
      const a = autoStake({ bankroll: eq, fillCost: fills >= 10 ? fillCost : null, drawdown: dd, maxStake: bot.maxStake, minStake: bot.minStake, kellyPct: b.kellyPct ?? bot.kellyPct, kellyFrom: bot.kellyFrom });
      stake = a.stake;
      if (!stake) {
        // Under $10 with nothing left to settle, or fills too dear: the live bot is done.
        if (!open.length || fillCost > 0.025) stopped = { t: b.at * 1000, reason: a.reason };
        skips.stake++;
        continue;
      }
    } else stake = Math.floor(stakeOf(bot, eq, dd) * 100) / 100;
    // A bet may carry its own multiplier (a boosted signal); the live 4% match cap when the bot sets one.
    if (b.stakeMult > 0) stake = Math.floor(Math.min(bot.maxStake, stake * b.stakeMult) * 100) / 100;
    if (bot.matchCapPct > 0) stake = Math.floor(Math.min(stake, Math.max(bot.minStake, (eq * bot.matchCapPct) / 100)) * 100) / 100;
    if (stake > cash) {
      skips.stake++;
      if (!open.length && cash < bot.minStake) stopped = { t: b.at * 1000, reason: 'Wallet under the minimum stake' };
      continue;
    }
    if (open.reduce((s, x) => s + x.stake, 0) + stake > Math.max(eq * ((bot.maxOpenPct ?? 25) / 100), bot.minStake)) {
      skips.open++;
      continue;
    }
    cash -= stake;
    placed++;
    fills++;
    mo.bets++;
    open.push({ end: b.end, stake, day, pay: stake * multOf(b), b });
  }
  settle(Infinity);
  const list = [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  list.forEach((m, i) => (m.end = i + 1 < list.length ? list[i + 1].start : cash));
  const firstT = startS ? startS * 1000 : bets[0] ? bets[0].at * 1000 : null;
  const lastT = curve.length ? curve[curve.length - 1].t : firstT;
  return {
    start,
    end: Math.round(cash * 100) / 100,
    peak: Math.round(Math.max(peak, cash) * 100) / 100,
    low: Math.round(Math.min(low, cash) * 100) / 100,
    maxDrawdown: maxDd,
    placed,
    won,
    perDay: firstT && lastT > firstT ? placed / ((lastT - firstT) / 86400e3) : null,
    skips,
    stopped,
    months: list.map((m) => ({ month: m.month, bets: m.bets, won: m.won, start: Math.round(m.start * 100) / 100, end: Math.round(m.end * 100) / 100, profit: Math.round((m.end - m.start) * 100) / 100 })),
    curve
  };
}

/**
 * The same bot started on several dates with the same wallet, each run forward
 * to the end of the data. For the bot page's chart.
 * @param {object} bot
 * @param {{ starts: number[], start?: number, extraSlip?: number, to?: number|null }} o  starts and to in ms
 */
export function botBacktestRuns(bot, { starts, start = 21, extraSlip = 0, to = null } = {}) {
  const firstS = Math.floor(Math.min(...starts) / 1000);
  const { bets, source, dataFrom } = signalsFor(bot, firstS, extraSlip);
  const toS = to ? Math.floor(to / 1000) : Infinity;
  const runs = starts
    .slice()
    .sort((a, b) => a - b)
    .map((t) => {
      const s = Math.floor(t / 1000);
      const r = replayCurve(
        bets.filter((b) => b.at >= s && b.at <= toS),
        bot,
        start,
        { fillCost: 0.01 + extraSlip, startS: s }
      );
      return { from: t, beforeData: dataFrom !== null && s < dataFrom, ...r };
    });
  return { bot: { id: bot.id, name: bot.name, type: bot.type, sizing: bot.sizing }, source, dataFrom: dataFrom === null ? null : dataFrom * 1000, dataTo: bets.length ? bets[bets.length - 1].at * 1000 : null, start, extraSlip, runs };
}

/**
 * @param {object} bot      a bot as stored
 * @param {{ days?:number, start?:number, extraSlip?:number }} o
 *   extraSlip: cents (as a fraction) added to every fill, to test thinner books
 */
export function botBacktest(bot, { days = 365, start = 500, extraSlip = 0 } = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const sinceS = nowS - days * DAY;
  const { bets, source } = signalsFor(bot, sinceS, extraSlip);
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
export { comebackBets as _comebackBets, replayCurve as _replayCurve };
