// ---------------------------------------------------------------------------
// server/insights/bots.js
// Bots: the owner's own trading algorithms, any number of them.
//
// A bot is a strategy type (whale copy, swing, market making) plus every one
// of its settings, a switch, a mode (paper or real money) and a stake rule
// (a % of its wallet, or a fixed amount). Paper bots each have their own paper
// wallet, so several can run side by side on the same signals and be compared.
// Real bots share the real Polymarket wallet and still need real trading to
// be armed and the PC executor online.
//
// FIELDS below is the single description of every setting: the server
// sanitizes with it and the page builds its editor from it.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { col, touch, logLine } from './store.js';

const REASONS = ['fresh', 'specialist', 'record', 'stacking', 'impact', 'cluster', 'live-down', 'prematch', 'all-in', 'longshot'];

/** Settings every bot has. scale: shown value = stored x scale. */
export const COMMON_FIELDS = [
  { key: 'maxStake', label: 'Largest stake', kind: 'num', unit: '$', min: 1, max: 1e6, step: 1, def: 100 },
  { key: 'minStake', label: 'Smallest stake', kind: 'num', unit: '$', min: 1, max: 1e5, step: 1, def: 1 },
  { key: 'paperBankroll', label: 'Paper wallet', kind: 'num', unit: '$', min: 10, max: 1e8, step: 10, def: 1000 },
  { key: 'maxOpenPct', label: 'Open bets at most', kind: 'num', unit: '% of wallet', min: 1, max: 100, step: 1, def: 25 },
  { key: 'dailyLossPct', label: 'Stop for the day after losing', kind: 'num', unit: '% of wallet', min: 1, max: 100, step: 1, def: 10 },
  { key: 'autoStop', label: 'Back to paper if it keeps losing (real money)', kind: 'bool', def: true },
  { key: 'review', label: 'AI review before pre-match bets', kind: 'bool', def: false }
];

export const BOT_TYPES = {
  whale: {
    label: 'Whale copy',
    sizingLabel: 'Stake per match',
    fields: [
      { key: 'minScore', label: 'Copy from score', kind: 'num', min: 0, max: 100, step: 1, def: 60 },
      { key: 'needs', label: 'Only when the signal has one of', kind: 'multi', options: REASONS, def: [] },
      { key: 'excludes', label: 'Never when the signal has', kind: 'multi', options: REASONS, def: [] },
      { key: 'requireEdge', label: 'Analysts must agree', kind: 'bool', def: false },
      { key: 'minEdge', label: 'Analyst edge at least', kind: 'num', unit: 'c', scale: 100, min: -0.2, max: 0.2, step: 0.5, def: 0 },
      { key: 'followedOnly', label: 'Followed wallets only', kind: 'bool', def: false },
      { key: 'minWhaleCash', label: 'Whale bet of at least', kind: 'num', unit: '$', min: 0, max: 1e6, step: 10, def: 0 },
      { key: 'minWhalePrice', label: 'Whale price at least', kind: 'num', unit: '%', scale: 100, min: 0, max: 0.6, step: 1, def: 0 },
      { key: 'maxWhalePrice', label: 'Whale price at most', kind: 'num', unit: '%', scale: 100, min: 0.01, max: 0.6, step: 1, def: 0.3 },
      { key: 'maxWhaleCash', label: 'Whale total at most (0 = any)', kind: 'num', unit: '$', min: 0, max: 1e6, step: 10, def: 0 },
      { key: 'copyLive', label: 'Copy live bets', kind: 'bool', def: true },
      { key: 'copyPrematch', label: 'Copy pre-match bets', kind: 'bool', def: true },
      { key: 'copyMaps', label: 'Copy map-winner bets', kind: 'bool', def: false },
      { key: 'skipLosers', label: 'Skip wallets with a losing record', kind: 'bool', def: true },
      { key: 'loserMinResolved', label: 'Losing record counts after', kind: 'num', unit: 'settled', min: 1, max: 1000, step: 1, def: 5 },
      { key: 'maxSlippage', label: 'Pay up to whale price plus', kind: 'num', unit: 'c', scale: 100, min: 0, max: 0.5, step: 0.5, def: 0.05 },
      { key: 'maxEntry', label: 'Never buy above', kind: 'num', unit: '%', scale: 100, min: 0.02, max: 0.95, step: 1, def: 0.4 },
      { key: 'mirrorExits', label: 'Sell when the whale sells', kind: 'bool', def: true },
      { key: 'sellAt', label: 'Take profit at (0 = hold)', kind: 'num', unit: '%', scale: 100, min: 0, max: 0.99, step: 1, def: 0 }
    ]
  },
  swing: {
    label: 'Swing',
    sizingLabel: 'Stake per trade',
    fields: [
      { key: 'minEdge', label: 'Edge after all costs at least', kind: 'num', unit: 'c', scale: 100, min: 0, max: 0.3, step: 0.5, def: 0.03 },
      { key: 'horizon', label: 'Looks ahead', kind: 'choice', unit: 'min', options: [5, 15, 30], def: 30 },
      { key: 'maker', label: 'Limit orders (wait at the bid)', kind: 'bool', def: true },
      { key: 'afterScore', label: 'Only after a score change', kind: 'bool', def: false },
      { key: 'live', label: 'Trade live', kind: 'bool', def: true },
      { key: 'prematch', label: 'Trade the 3 hours before start', kind: 'bool', def: true },
      { key: 'maps', label: 'Map-winner markets too', kind: 'bool', def: false },
      { key: 'priceMin', label: 'Price at least', kind: 'num', unit: '%', scale: 100, min: 0.01, max: 0.99, step: 1, def: 0.05 },
      { key: 'priceMax', label: 'Price at most', kind: 'num', unit: '%', scale: 100, min: 0.01, max: 0.99, step: 1, def: 0.95 },
      { key: 'targetK', label: 'Profit target', kind: 'num', unit: 'x usual move', min: 0.1, max: 5, step: 0.1, def: 0.8 },
      { key: 'stopK', label: 'Stop loss', kind: 'num', unit: 'x usual move', min: 0.1, max: 5, step: 0.1, def: 1.2 },
      { key: 'timeMult', label: 'Time limit', kind: 'num', unit: 'x look-ahead', min: 0.5, max: 10, step: 0.5, def: 2 },
      { key: 'edgeExit', label: 'Sell when the edge is gone', kind: 'bool', def: true }
    ]
  },
  value: {
    label: 'Start-price value',
    sizingLabel: 'Stake per match',
    fields: [
      { key: 'priceMin', label: 'Team priced at least', kind: 'num', unit: '%', scale: 100, min: 0.01, max: 0.99, step: 1, def: 0.3 },
      { key: 'priceMax', label: 'Team priced at most', kind: 'num', unit: '%', scale: 100, min: 0.01, max: 0.99, step: 1, def: 0.5 },
      { key: 'formats', label: 'Series lengths', kind: 'multi', options: ['BO1', 'BO3', 'BO5'], def: ['BO1', 'BO3', 'BO5'] },
      { key: 'windowMax', label: 'Buy from this long before start', kind: 'num', unit: 'min', min: 1, max: 600, step: 1, def: 30 },
      { key: 'windowMin', label: 'Until this long before start', kind: 'num', unit: 'min', min: 0, max: 600, step: 1, def: 5 },
      { key: 'maker', label: 'Limit orders (no fee)', kind: 'bool', def: true },
      { key: 'maps', label: 'Map-winner markets too', kind: 'bool', def: false }
    ]
  },
  // Big underdog buys before the start are overpriced: over a year of CS2 on
  // Polymarket, underdogs whales bought at 25-30% won 21%. This bot buys the
  // other team once the underdog money has piled up.
  fade: {
    label: 'Fade underdog money',
    sizingLabel: 'Stake per match',
    fields: [
      { key: 'minBuys', label: 'After this many big underdog buys', kind: 'num', unit: 'buys', min: 1, max: 50, step: 1, def: 3 },
      { key: 'formats', label: 'Series lengths', kind: 'multi', options: ['BO1', 'BO3', 'BO5'], def: ['BO3'] },
      { key: 'prematchOnly', label: 'Before the start only', kind: 'bool', def: true },
      { key: 'maxWhalePrice', label: 'Underdog priced at most', kind: 'num', unit: '%', scale: 100, min: 0.01, max: 0.5, step: 1, def: 0.3 },
      { key: 'maxSlippage', label: 'Pay up to 100% minus underdog price plus', kind: 'num', unit: 'c', scale: 100, min: 0, max: 0.2, step: 0.5, def: 0.03 },
      { key: 'maxEntry', label: 'Never buy above', kind: 'num', unit: '%', scale: 100, min: 0.5, max: 0.97, step: 1, def: 0.92 }
    ]
  },
  // Low-tier CS2 (both teams outside the VRS top 30): a team that started as a
  // contender and collapses in-game comes back more often than its price says.
  // Year of Polymarket data, both halves: collapsed to 25% after starting at 40%+,
  // won 24.9% while priced 22.3%.
  comeback: {
    label: 'Low-tier comeback',
    sizingLabel: 'Stake per match',
    fields: [
      { key: 'preMin', label: 'Team priced at the start at least', kind: 'num', unit: '%', scale: 100, min: 0.1, max: 0.9, step: 1, def: 0.5 },
      { key: 'collapseAt', label: 'Buy once it falls to', kind: 'num', unit: '%', scale: 100, min: 0.03, max: 0.4, step: 1, def: 0.2 },
      { key: 'maxSlippage', label: 'Pay at most that plus', kind: 'num', unit: 'c', scale: 100, min: 0, max: 0.1, step: 0.5, def: 0.02 },
      { key: 'maxOverMid', label: 'And never more than the mid plus (0 = off)', kind: 'num', unit: 'c', scale: 100, min: 0, max: 0.1, step: 0.5, def: 0.015 },
      { key: 'minDrop', label: 'Only after a sudden fall of at least (10 min)', kind: 'num', unit: 'pts', scale: 100, min: 0, max: 0.6, step: 1, def: 0 },
      // 2026-11-07 crash study (a year, found on Nov-Jul, checked on Jul-Nov): busy
      // markets price a crash right; thin ones overreact. V2.2 +17.8% -> +25.1% per bet out of sample.
      { key: 'maxTradesPerMin', label: 'Skip busy markets: this many trades a minute since the start or more (0 = off)', kind: 'num', unit: '/min', min: 0, max: 60, step: 0.5, def: 0 },
      // Leader: on a crash the crashed-team bots skip (higher tier, busy or BO1), buy the team that leads.
      // The comeback is overpriced there: the leader won 87.7% while priced 84.6% (+3.3% per bet, every month).
      { key: 'bet', label: 'Bet on', kind: 'choice', options: ['crashed', 'leader'], def: 'crashed' },
      { key: 'busyAt', label: 'Leader: a market counts as busy from (trades a minute)', kind: 'num', unit: '/min', min: 0.5, max: 60, step: 0.5, def: 4 },
      { key: 'sellAt', label: 'Take profit at (0 = hold)', kind: 'num', unit: '%', scale: 100, min: 0, max: 0.95, step: 1, def: 0 },
      { key: 'games', label: 'Games', kind: 'multi', options: ['cs2', 'valorant', 'lol', 'dota2'], def: ['cs2', 'valorant', 'lol', 'dota2'] },
      { key: 'holdTeams', label: 'CS2 comeback teams (looser entry, hold to the end)', kind: 'list', def: [] },
      { key: 'listPreMin', label: 'Comeback teams: priced at the start at least', kind: 'num', unit: '%', scale: 100, min: 0.1, max: 0.9, step: 1, def: 0.4 },
      { key: 'listCollapseAt', label: 'Comeback teams: buy once they fall to', kind: 'num', unit: '%', scale: 100, min: 0.03, max: 0.45, step: 1, def: 0.25 },
      { key: 'skipAgainst', label: 'CS2: never buy a team playing against', kind: 'list', def: [] },
      { key: 'neverTeams', label: 'CS2: never bet on a match with', kind: 'list', def: [] },
      { key: 'backListed', label: 'Back the comeback teams before the start', kind: 'bool', def: false },
      { key: 'backWindowMax', label: 'Back them from this long before the start', kind: 'num', unit: 'min', min: 1, max: 600, step: 1, def: 30 },
      { key: 'backMaxPrice', label: 'Back them at most at', kind: 'num', unit: '%', scale: 100, min: 0.05, max: 0.95, step: 1, def: 0.85 },
      { key: 'maxMinutes', label: 'CS2: only this long after the start', kind: 'num', unit: 'min', min: 10, max: 600, step: 5, def: 90 },
      { key: 'formats', label: 'Series lengths', kind: 'multi', options: ['BO1', 'BO3', 'BO5'], def: ['BO3', 'BO5'] },
      { key: 'lowTierOnly', label: 'Low tier only (CS2: both outside VRS top 30; others: league tier 3-5)', kind: 'bool', def: true },
      { key: 'maps', label: 'Map-winner markets too', kind: 'bool', def: false }
    ]
  },
  mm: {
    label: 'Market making',
    sizingLabel: 'Quote size',
    paperOnly: true,
    fields: [
      { key: 'spreadK', label: 'Quote distance', kind: 'num', unit: 'x usual move', min: 0.2, max: 6, step: 0.1, def: 2 },
      { key: 'maxInv', label: 'Inventory per side at most', kind: 'num', unit: '$', min: 1, max: 1e6, step: 5, def: 60 },
      { key: 'minSpread', label: 'Only when the spread is at least', kind: 'num', unit: 'c', scale: 100, min: 0.01, max: 0.3, step: 0.5, def: 0.02 },
      { key: 'pauseSec', label: 'Pause after a score change', kind: 'num', unit: 's', min: 0, max: 600, step: 5, def: 20 },
      { key: 'priceMin', label: 'Price at least', kind: 'num', unit: '%', scale: 100, min: 0.01, max: 0.99, step: 1, def: 0.05 },
      { key: 'priceMax', label: 'Price at most', kind: 'num', unit: '%', scale: 100, min: 0.01, max: 0.99, step: 1, def: 0.95 },
      { key: 'maps', label: 'Map-winner markets too', kind: 'bool', def: false }
    ]
  }
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function cleanField(f, v, prev) {
  if (f.kind === 'list') {
    const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : null;
    if (!raw) return prev ?? f.def;
    const seen = new Set();
    return raw.map((x) => String(x).trim().slice(0, 40)).filter((x) => x && !seen.has(teamKey(x)) && seen.add(teamKey(x))).slice(0, 100);
  }
  if (f.kind === 'bool') return typeof v === 'boolean' ? v : prev ?? f.def;
  if (f.kind === 'choice') {
    const c = typeof f.options[0] === 'number' ? Number(v) : String(v);
    return f.options.includes(c) ? c : prev ?? f.def;
  }
  if (f.kind === 'multi') return Array.isArray(v) ? [...new Set(v.map(String).filter((x) => f.options.includes(x)))] : prev ?? f.def;
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, f.min, f.max) : prev ?? f.def;
}

/** A full, valid bot from a patch on top of an existing bot (or the type defaults). */
export function sanitizeBot(patch = {}, prev = null) {
  const type = BOT_TYPES[prev?.type] ? prev.type : BOT_TYPES[patch.type] ? patch.type : 'whale';
  const def = BOT_TYPES[type];
  const p = patch || {};
  const out = {
    id: prev?.id || newBotId(),
    type,
    name: String(p.name ?? prev?.name ?? def.label).replace(/\s+/g, ' ').trim().slice(0, 50) || def.label,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : prev?.enabled ?? false,
    mode: def.paperOnly ? 'paper' : p.mode === 'real' || p.mode === 'paper' ? p.mode : prev?.mode || 'paper',
    sizing: {
      kind: ['fixed', 'pct', 'auto'].includes(p.sizing?.kind) ? p.sizing.kind : prev?.sizing?.kind || 'pct',
      value: 0
    },
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
    paperEpoch: prev?.paperEpoch || 0,
    params: {}
  };
  const rawValue = p.sizing?.value ?? prev?.sizing?.value;
  out.sizing.value = out.sizing.kind === 'auto' ? 1 : out.sizing.kind === 'pct' ? clamp(Number(rawValue) || 2, 0.1, 100) : clamp(Number(rawValue) || 10, 1, 1e6);
  for (const f of COMMON_FIELDS) out[f.key] = cleanField(f, f.key in p ? p[f.key] : undefined, prev?.[f.key]);
  for (const f of def.fields) out.params[f.key] = cleanField(f, p.params && f.key in p.params ? p.params[f.key] : undefined, prev?.params?.[f.key]);
  if (out.params.priceMin !== undefined && out.params.priceMin > out.params.priceMax) [out.params.priceMin, out.params.priceMax] = [out.params.priceMax, out.params.priceMin];
  return out;
}

function newBotId() {
  return `bot_${crypto.randomBytes(5).toString('hex')}`;
}

/** The stake one decision may use: the bot's rule, inside its own min and max. */
/** Team names compared without case, accents, spaces or punctuation: "LFO 10" = "lfo10". */
export function teamKey(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The rules a comeback bot applies to one team in one match. The team lists
 * (CS2 only) override the defaults: a listed team gets the looser entry and is
 * held to the end; a team playing a skip-listed team is never bought.
 * Shared by the live bot and the backtest so the two never drift.
 * @returns {{ skip:string, listed:boolean, preMin:number, collapseAt:number, minDrop:number, maxMinutes:number, formats:string[], sellAt:number }}
 */
export function comebackRules(p, { game, team, opponent }) {
  const cs2 = (game || 'cs2') === 'cs2';
  const has = (list, name) => (list || []).some((x) => teamKey(x) === teamKey(name));
  // Never-bet list: any match with one of these teams, on either side, is left alone.
  const never = [team, opponent].find((n) => cs2 && has(p.neverTeams, n));
  if (never) return { skip: `Match with ${never} (never-bet list)`, listed: false };
  if (cs2 && has(p.skipAgainst, opponent)) return { skip: `Plays ${opponent} (skip list)`, listed: false };
  if (cs2 && has(p.holdTeams, team)) return { skip: '', listed: true, preMin: p.listPreMin ?? 0.4, collapseAt: p.listCollapseAt ?? 0.25, minDrop: 0, maxMinutes: 0, formats: [], sellAt: 0 };
  return { skip: '', listed: false, preMin: p.preMin, collapseAt: p.collapseAt, minDrop: p.minDrop || 0, maxMinutes: cs2 ? p.maxMinutes || 0 : 0, formats: p.formats || [], sellAt: p.sellAt || 0 };
}

export function stakeFor(bot, bankroll, auto = null) {
  if (bot.sizing.kind === 'auto') return autoStake({ bankroll, maxStake: bot.maxStake, minStake: bot.minStake, ...(auto || {}) }).stake;
  const raw = bot.sizing.kind === 'fixed' ? bot.sizing.value : (bankroll * bot.sizing.value) / 100;
  return Math.floor(Math.min(raw, bot.maxStake) * 100) / 100;
}

/**
 * Automatic, risk-adjusted stake. From the 2026-11-07 wallet x stake grid
 * (a year of low-tier esports comebacks, Monte Carlo on June-November):
 *  - 1% of the wallet is the base: 0% yearly bust from $200 up, ~1.8% chance
 *    of ever halving at $500; 2%+ adds drawdown for little gain under the cap.
 *  - The edge depends on fill cost: +19.9%/bet as measured, +12% at 1c worse,
 *    +5% at 2c worse, gone beyond that. So until 10 fills are measured, or
 *    while they run 1.5-2.5c over the mid, the stake halves; past 2.5c it stops.
 *  - A drawdown of 25% from the peak halves it again, 50% quarters it.
 *  - Polymarket's $1 minimum is the floor; under $10 the bot stops.
 *  - maxStake is the depth cap: $25 fits within 2c of the ask ~85% of the time.
 * @param {{ bankroll:number, fillCost?:number|null, drawdown?:number, maxStake?:number, minStake?:number }} a
 * @returns {{ stake:number, pct:number, reason:string }}
 */
export function autoStake({ bankroll, fillCost = null, drawdown = 0, maxStake = 25, minStake = 1 }) {
  if (!(bankroll >= 10)) return { stake: 0, pct: 0, reason: 'Wallet under $10' };
  if (fillCost !== null && fillCost > 0.025) return { stake: 0, pct: 0, reason: `Fills ${(fillCost * 100).toFixed(1)}c over the mid: no edge left` };
  let pct = 0.01;
  const notes = [];
  if (fillCost === null) { pct /= 2; notes.push('fills not measured yet'); }
  else if (fillCost > 0.015) { pct /= 2; notes.push(`fills ${(fillCost * 100).toFixed(1)}c over the mid`); }
  if (drawdown >= 0.5) { pct /= 4; notes.push(`down ${Math.round(drawdown * 100)}% from the peak`); }
  else if (drawdown >= 0.25) { pct /= 2; notes.push(`down ${Math.round(drawdown * 100)}% from the peak`); }
  const stake = Math.floor(Math.min(maxStake, Math.max(minStake, bankroll * pct)) * 100) / 100;
  return { stake, pct, reason: `${(pct * 100).toFixed(2).replace(/\.?0+$/, '')}% of $${Math.round(bankroll)}${notes.length ? ` (${notes.join(', ')})` : ''}` };
}

// ---- storage --------------------------------------------------------------------

export function allBots() {
  const b = col('bots');
  if (!Array.isArray(b.list)) {
    b.list = seedBots();
    touch('bots');
  }
  // 2026-11-06 data review: the two edges become bots; the losing styles go off.
  if (!b.v2) {
    b.v2 = true;
    for (const x of b.list) if (['w-score', 'w-edge', 's-maker3', 's-taker5', 's-score'].includes(x.id)) x.enabled = false;
    if (!b.list.some((x) => x.id === 'split-buys')) b.list.push({ ...sanitizeBot({ type: 'whale', name: 'Split buys 25-30%, small', enabled: true, sizing: { kind: 'pct', value: 2 }, maxStake: 50, params: { minScore: 0, needs: ['stacking'], minWhalePrice: 0.25, maxWhalePrice: 0.31, maxWhaleCash: 150, skipLosers: false, maxSlippage: 0.03, maxEntry: 0.34, copyMaps: false } }), id: 'split-buys' });
    if (!b.list.some((x) => x.id === 'value-dogs')) b.list.push({ ...sanitizeBot({ type: 'value', name: 'Slight underdogs at start', enabled: true, sizing: { kind: 'pct', value: 2 }, maxStake: 50 }), id: 'value-dogs' });
    touch('bots');
  }
  // 2026-11-06 second review: uncrowded split buys and BO3 30-40% start prices.
  if (!b.v3) {
    b.v3 = true;
    const sb = b.list.find((x) => x.id === 'split-buys');
    if (sb) sb.params.maxSlippage = 0.02;
    const vd = b.list.find((x) => x.id === 'value-dogs');
    if (vd) Object.assign(vd.params, { priceMax: 0.4, formats: ['BO3'] });
    if (vd) vd.name = 'Underdogs 30-40% at start, BO3';
    if (!b.list.some((x) => x.id === 'split-uncrowded')) b.list.push({ ...sanitizeBot({ type: 'whale', name: 'Split buys, uncrowded', enabled: true, sizing: { kind: 'pct', value: 2 }, maxStake: 50, params: { minScore: 0, needs: ['stacking'], excludes: ['cluster'], maxWhalePrice: 0.31, skipLosers: false, maxSlippage: 0.02, maxEntry: 0.34 } }), id: 'split-uncrowded' });
    touch('bots');
  }
  // 2026-11-07 year review: the underdog bots lose over 12 months; fading the
  // pre-match underdog money is the edge that held (paper until the owner arms it).
  if (!b.v4) {
    b.v4 = true;
    if (!b.list.some((x) => x.id === 'fade-prematch')) b.list.push({ ...sanitizeBot({ type: 'fade', name: 'Fade underdog money, BO3 pre-match', enabled: false, mode: 'paper', sizing: { kind: 'pct', value: 6 }, maxStake: 50 }), id: 'fade-prematch' });
    if (!b.list.some((x) => x.id === 'comeback-low')) b.list.push({ ...sanitizeBot({ type: 'comeback', name: 'Low-tier comeback, BO3', enabled: true, mode: 'paper', sizing: { kind: 'pct', value: 4 }, maxStake: 25 }), id: 'comeback-low' });
    touch('bots');
  }
  // 2026-11-07 full-year replay: the 40%/25% rule went flat from June; the
  // stricter rule (started 50%+, down to 20%, first 90 minutes) still paid
  // +13.7% a bet from June to November. Sized for a $500 wallet at 1%.
  if (!b.v5) {
    b.v5 = true;
    const cb = b.list.find((x) => x.id === 'comeback-low');
    if (cb) {
      Object.assign(cb.params, { preMin: 0.5, collapseAt: 0.2, maxSlippage: 0.02, maxMinutes: 90 });
      Object.assign(cb, { name: 'Low-tier comeback, BO3 strict', sizing: { kind: 'pct', value: 1 }, maxStake: 25, paperBankroll: Math.max(cb.paperBankroll || 0, 500) });
    }
    touch('bots');
  }
  // 2026-11-07 all-esports test: the same low-tier comeback held in Valorant,
  // LoL and Dota 2 (both halves of the year and June-November); R6 did not.
  if (!b.v6) {
    b.v6 = true;
    const cb = b.list.find((x) => x.id === 'comeback-low');
    if (cb) {
      Object.assign(cb.params, { games: ['cs2', 'valorant', 'lol', 'dota2'], formats: ['BO3', 'BO5'] });
      cb.name = 'Low-tier comeback, all esports';
    }
    touch('bots');
  }
  // 2026-11-07: Oracle V2 joins the lineup: the all-esports low-tier comeback
  // with automatic, risk-adjusted sizing. The older comeback bot goes off so
  // the two never double up on the same match.
  if (!b.v7) {
    b.v7 = true;
    if (!b.list.some((x) => x.id === 'oracle-v2')) {
      b.list.push({
        ...sanitizeBot({
          type: 'comeback',
          name: 'Oracle V2',
          enabled: true,
          mode: 'paper',
          sizing: { kind: 'auto', value: 1 },
          maxStake: 25,
          paperBankroll: 500,
          params: { preMin: 0.5, collapseAt: 0.2, maxSlippage: 0.02, maxMinutes: 90, games: ['cs2', 'valorant', 'lol', 'dota2'], formats: ['BO3', 'BO5'], lowTierOnly: true, maps: false }
        }),
        id: 'oracle-v2'
      });
    }
    const old = b.list.find((x) => x.id === 'comeback-low');
    if (old) old.enabled = false;
    touch('bots');
  }
  // 2026-11-07: Oracle V2.1, the same comeback with two rules from the year test:
  // only sudden collapses (20+ points in the 10 minutes before) and take profit
  // at 60%. Year: +35.8%/bet vs +22.9%, 39% of bets profitable vs 20%, worst
  // 30-bet run -16 stakes vs -25. Paper; Oracle V2 keeps its mode.
  if (!b.v8) {
    b.v8 = true;
    if (!b.list.some((x) => x.id === 'oracle-v2-1')) {
      b.list.push({
        ...sanitizeBot({
          type: 'comeback',
          name: 'Oracle V2.1',
          enabled: true,
          mode: 'paper',
          sizing: { kind: 'auto', value: 1 },
          maxStake: 25,
          paperBankroll: 500,
          params: { preMin: 0.5, collapseAt: 0.2, maxSlippage: 0.02, minDrop: 0.2, sellAt: 0.6, maxMinutes: 90, games: ['cs2', 'valorant', 'lol', 'dota2'], formats: ['BO3', 'BO5'], lowTierOnly: true, maps: false }
        }),
        id: 'oracle-v2-1'
      });
    }
    touch('bots');
  }
  // 2026-11-07: Oracle V2.2 = V2.1 (take profit moved to 65%) + the owner's
  // CS2 team lists: listed teams that collapse are bought on the looser entry
  // and held; their collapsed opponents are skipped; listed teams are also
  // backed in the last 30 minutes before the start (year: 62% won, +22%/bet).
  if (!b.v9) {
    b.v9 = true;
    const teams = ['megoshort', 'QUAZAR', 'Entropy', 'LFO 10', 'LFO', 'Quintessence', 'TitanFlow'];
    if (!b.list.some((x) => x.id === 'oracle-v2-2')) {
      b.list.push({
        ...sanitizeBot({
          type: 'comeback',
          name: 'Oracle V2.2',
          enabled: true,
          mode: 'paper',
          sizing: { kind: 'auto', value: 1 },
          maxStake: 25,
          paperBankroll: 500,
          params: { preMin: 0.5, collapseAt: 0.2, maxSlippage: 0.02, minDrop: 0.2, sellAt: 0.65, maxMinutes: 90, games: ['cs2', 'valorant', 'lol', 'dota2'], formats: ['BO3', 'BO5'], lowTierOnly: true, maps: false, holdTeams: teams, listPreMin: 0.4, listCollapseAt: 0.25, skipAgainst: teams, backListed: true, backWindowMax: 30, backMaxPrice: 0.85 }
        }),
        id: 'oracle-v2-2'
      });
    }
    touch('bots');
  }
  // 2026-11-07 owner rule: Oracle V2.2 never bets on a CS2 match with The Golden Horde.
  if (!b.v10) {
    b.v10 = true;
    const v22 = b.list.find((x) => x.id === 'oracle-v2-2');
    if (v22) v22.params.neverTeams = [...new Set([...(v22.params.neverTeams || []), 'The Golden Horde', 'Golden Horde'])];
    touch('bots');
  }
  return b.list;
}

export const botById = (id) => allBots().find((x) => x.id === id) || null;

/** Enabled bots of one type, while bots are switched on at all. */
export function activeBots(type, botsOn = true) {
  if (!botsOn) return [];
  return allBots().filter((x) => x.enabled && x.type === type);
}

export function createBot(patch) {
  const bot = sanitizeBot({ ...patch, enabled: patch.enabled ?? false, mode: 'paper' });
  allBots().push(bot);
  touch('bots');
  logLine('info', `Bot created: ${bot.name} (${BOT_TYPES[bot.type].label})`);
  return bot;
}

export function updateBot(id, patch) {
  const list = allBots();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const prev = list[i];
  const next = sanitizeBot(patch, prev);
  list[i] = next;
  touch('bots');
  if (prev.mode !== next.mode) logLine('info', `Bot ${next.name}: ${prev.mode.toUpperCase()} -> ${next.mode.toUpperCase()}`);
  if (prev.enabled !== next.enabled) logLine('info', `Bot ${next.name} ${next.enabled ? 'on' : 'off'}`);
  return next;
}

export function duplicateBot(id) {
  const src = botById(id);
  if (!src) return null;
  return createBot({ ...structuredClone(src), name: `${src.name} copy`.slice(0, 50), enabled: false });
}

export function deleteBot(id) {
  const b = col('bots');
  const before = allBots().length;
  b.list = allBots().filter((x) => x.id !== id);
  touch('bots');
  return b.list.length < before;
}

export function resetPaper(id) {
  const bot = botById(id);
  if (!bot) return null;
  bot.paperEpoch = Date.now();
  touch('bots');
  return bot;
}

/**
 * First start of the bot system: the strategy variants that ran before become
 * bots with the same ids (so their paper history stays theirs), all on paper.
 */
function seedBots() {
  const s = col('settings');
  const st = col('strategies') || {};
  const whaleBase = {
    sizing: { kind: 'pct', value: s.stakePct ?? 2 },
    maxStake: s.maxStake ?? 100,
    minStake: s.minStake ?? 1,
    paperBankroll: s.simBankroll ?? 1000,
    maxOpenPct: s.maxOpenPct ?? 25,
    dailyLossPct: s.dailyLossPct ?? 10
  };
  const whaleParams = {
    minScore: s.minScore ?? 60,
    copyLive: s.copyLive ?? true,
    copyPrematch: s.copyPrematch ?? true,
    copyMaps: s.copyMaps ?? false,
    skipLosers: s.skipLosers ?? true,
    loserMinResolved: s.loserMinResolved ?? 5,
    maxSlippage: s.maxSlippage ?? 0.05,
    maxEntry: s.maxEntry ?? 0.4,
    mirrorExits: s.mirrorExits ?? true
  };
  const swingBase = { ...whaleBase, sizing: { kind: 'pct', value: s.swingStakePct ?? 1 } };
  const mmBase = { ...whaleBase, sizing: { kind: 'fixed', value: 15 } };
  const on = (key) => st[key]?.enabled !== false;
  const seeds = [
    { id: 'w-score', type: 'whale', name: 'Whale: score over the line', ...whaleBase, review: true, params: whaleParams, enabled: on('whale') },
    { id: 'w-edge', type: 'whale', name: 'Whale: analysts agree', ...whaleBase, params: { ...whaleParams, minScore: 40, requireEdge: true, minEdge: 0 }, enabled: on('whale') },
    { id: 'w-proven', type: 'whale', name: 'Whale: specialists and split buys', ...whaleBase, params: { ...whaleParams, minScore: 25, needs: ['specialist', 'stacking'] }, enabled: on('whale') },
    { id: 's-maker3', type: 'swing', name: 'Swing: 3c edge, limit orders', ...swingBase, params: { minEdge: 0.03, horizon: 30, maker: true }, enabled: on('swing') },
    { id: 's-taker5', type: 'swing', name: 'Swing: 5c edge, market orders', ...swingBase, params: { minEdge: 0.05, horizon: 30, maker: false }, enabled: on('swing') },
    { id: 's-score', type: 'swing', name: 'Swing: fade score jumps', ...swingBase, params: { minEdge: 0.025, horizon: 15, maker: false, afterScore: true, prematch: false }, enabled: on('swing') },
    { id: 'm-tight', type: 'mm', name: 'Market making: tight', ...mmBase, params: { spreadK: 1, maxInv: 60 }, enabled: on('mm') },
    { id: 'm-wide', type: 'mm', name: 'Market making: wide', ...mmBase, params: { spreadK: 2, maxInv: 60 }, enabled: on('mm') }
  ];
  const list = seeds.map((x) => ({ ...sanitizeBot(x), id: x.id }));
  // Bets made before bots existed belong to the variant that made them.
  for (const b of col('bets')) {
    if (b.botId) continue;
    b.botId = b.variant || 'w-score';
    if (b.mode === 'shadow') b.mode = 'sim';
  }
  touch('bets');
  logLine('info', `Bots set up: ${list.length} paper bots from the earlier strategy variants`);
  return list;
}

/** The field descriptions the page renders the editor from. */
export function botSchema() {
  return {
    common: COMMON_FIELDS,
    types: Object.fromEntries(Object.entries(BOT_TYPES).map(([k, t]) => [k, { label: t.label, sizingLabel: t.sizingLabel, paperOnly: Boolean(t.paperOnly), fields: t.fields }]))
  };
}
