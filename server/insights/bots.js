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
  if (f.kind === 'bool') return typeof v === 'boolean' ? v : prev ?? f.def;
  if (f.kind === 'choice') return f.options.includes(Number(v)) ? Number(v) : prev ?? f.def;
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
      kind: p.sizing?.kind === 'fixed' || p.sizing?.kind === 'pct' ? p.sizing.kind : prev?.sizing?.kind || 'pct',
      value: 0
    },
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
    paperEpoch: prev?.paperEpoch || 0,
    params: {}
  };
  const rawValue = p.sizing?.value ?? prev?.sizing?.value;
  out.sizing.value = out.sizing.kind === 'pct' ? clamp(Number(rawValue) || 2, 0.1, 100) : clamp(Number(rawValue) || 10, 1, 1e6);
  for (const f of COMMON_FIELDS) out[f.key] = cleanField(f, f.key in p ? p[f.key] : undefined, prev?.[f.key]);
  for (const f of def.fields) out.params[f.key] = cleanField(f, p.params && f.key in p.params ? p.params[f.key] : undefined, prev?.params?.[f.key]);
  if (out.params.priceMin !== undefined && out.params.priceMin > out.params.priceMax) [out.params.priceMin, out.params.priceMax] = [out.params.priceMax, out.params.priceMin];
  return out;
}

function newBotId() {
  return `bot_${crypto.randomBytes(5).toString('hex')}`;
}

/** The stake one decision may use: the bot's rule, inside its own min and max. */
export function stakeFor(bot, bankroll) {
  const raw = bot.sizing.kind === 'fixed' ? bot.sizing.value : (bankroll * bot.sizing.value) / 100;
  return Math.floor(Math.min(raw, bot.maxStake) * 100) / 100;
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
