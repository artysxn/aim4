// ---------------------------------------------------------------------------
// server/insights/config.js
// Defaults and the settings sanitizer for Insights (the Polymarket CS2 whale
// tracker). Settings are one JSON object the owner edits on /insights/settings;
// everything that reaches the engine passes through sanitizeSettings, so a bad
// request can never leave a NaN stake or a negative cap behind.
// ---------------------------------------------------------------------------

/** The teams the owner asked to follow (2026-11-06). Matched by whole words, see matching.js. */
export const DEFAULT_TEAMS = [
  'private', 'betclic', 'unity', 'nexus', 'pure', 'brute', 'acend', 'quazar', 'color',
  'ex-zero tenacity', 'black phoenix', 'basement boys', 'lazer cats', 'forze reload', 'rbls',
  'aimclub', 'NT', 'ex-inox', 'omega', 'baks', 'bet-m', 'astral', 'ex-rustec', 'just players',
  'rune eaters', 'butterfly', 'the last resort', 'johnny speeds', 'sparta', 'illyrians',
  'pcific', 'Leo', 'Lavked', 'ex-6666', 'bushido wildcats', 'mellren', 'saint sinners',
  '6yuBoJlbl', 'misa', 'LFO 10', 'PAQT', 'phantom academy', 'Vexar', 'LPH', 'Quintessence',
  'megoshort', 'ex-RUBY', 'DONSTU', 'Noir Verse', 'PsychoFace', 'Ryvex', 'benched gods',
  'kolesie', 'banda chuya', 'maybe', 'walczaki', 'drama', 'titanflow', 'azuolas', 'gothic',
  'kuusamo', 'DNK', 'optibet', 'atreides', 'KAMUI', 'arcred', 'drip too hard', 'toobisie',
  'nexora', 'younglings', 'washed', 'berg'
];

/** Tournament keywords, matched by whole words against the event title and its league. */
export const DEFAULT_TOURNAMENTS = ['Exort', 'EPL', 'European Pro League', 'Fiesta', 'CCT', 'United21'];

/** Polymarket's CS2 sport tag (gamma /sports: sport "cs2", primaryTagId 100780). */
export const CS2_TAG_ID = 100780;

export const MODES = ['off', 'sim', 'real'];

export const DEFAULT_SETTINGS = Object.freeze({
  // Tracking: discovery + trade polling. Off stops every request to Polymarket.
  tracking: true,
  // Master switch for every bot (paper and real). Off: signals only.
  botsOn: true,
  // What happens to a qualifying signal. 'sim' is paper money; 'real' places
  // orders through the linked PC executor. Starts in sim, always.
  mode: 'sim',

  // ---- Which matches ------------------------------------------------------
  teams: DEFAULT_TEAMS,
  tournaments: DEFAULT_TOURNAMENTS,
  excludeTeams: [],
  // A team ranked worse than this on the global VRS ladder is tracked.
  vrsBelow: 160,
  // Unranked teams (not in the VRS tables at all) count as below the line.
  vrsUnranked: true,
  useTeams: true,
  useVrs: true,
  useTournaments: true,
  // Track map-winner markets as well as the match winner.
  mapMarkets: true,
  // How far ahead an upcoming match is polled for trades.
  prematchHours: 24,

  // ---- What is unusual ----------------------------------------------------
  minCash: 50, // USD
  maxPrice: 0.3, // the bought team's chance at the moment of the bet
  watchSells: true,

  // ---- Copying ------------------------------------------------------------
  minScore: 60,
  copyMaps: false, // copy map-winner signals too (match winner only by default)
  copyLive: true,
  copyPrematch: true,
  skipLosers: true, // skip wallets with a resolved record worse than their prices implied
  loserMinResolved: 5,
  stakePct: 2, // % of the wallet per match
  maxStake: 100, // USD per match
  minStake: 1, // USD
  maxSlippage: 0.05, // how far above the whale's price we still buy
  maxEntry: 0.4, // never buy above this price
  maxOpenPct: 25, // all open positions together, % of the wallet
  dailyLossPct: 10, // stop copying for the day after losing this much
  mirrorExits: true, // sell when the copied wallet sells

  // ---- Strategies and risk -------------------------------------------------
  swingStakePct: 1, // swing trades, % of the wallet before the edge multiplier
  matchCapPct: 4, // everything on one match, all its markets
  teamCapPct: 6, // everything on one team across matches
  worstCasePct: 5, // the most one match may cost if it all goes wrong
  maxSpread: 0.06, // no entries into a wider spread
  reviewer: true, // Claude reviews pre-match bets (needs an Anthropic key on the server)
  reviewMinStake: 10, // USD; smaller bets skip the review
  recordTicks: true, // keep every tick of tracked matches on disk
  autoPromote: true, // a challenger that beats the champion takes over paper trading
  autoPromoteReal: false, // ...and real money too; off means you approve it

  // ---- Paper wallet -------------------------------------------------------
  simBankroll: 1000,

  // ---- Real money ---------------------------------------------------------
  // Real orders stop after this much in one UTC day, whatever the % says.
  realDailyCap: 200,

  // ---- History ------------------------------------------------------------
  backfillDays: 30
});

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

/** Trimmed, de-duplicated (case-insensitive) list of short strings. */
export function cleanList(v, fallback, cap = 400) {
  if (!Array.isArray(v)) return fallback;
  const seen = new Set();
  const out = [];
  for (const raw of v) {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Merge a patch onto the current settings and clamp every field.
 * Unknown keys are dropped.
 */
export function sanitizeSettings(patch = {}, current = DEFAULT_SETTINGS) {
  const base = { ...DEFAULT_SETTINGS, ...(current || {}) };
  const p = patch && typeof patch === 'object' ? patch : {};
  const pick = (k) => (k in p ? p[k] : base[k]);
  return {
    tracking: bool(pick('tracking'), base.tracking),
    botsOn: bool(pick('botsOn'), base.botsOn),
    mode: MODES.includes(pick('mode')) ? pick('mode') : base.mode,
    teams: cleanList(pick('teams'), base.teams),
    tournaments: cleanList(pick('tournaments'), base.tournaments),
    excludeTeams: cleanList(pick('excludeTeams'), base.excludeTeams),
    vrsBelow: Math.round(num(pick('vrsBelow'), base.vrsBelow, 1, 2000)),
    vrsUnranked: bool(pick('vrsUnranked'), base.vrsUnranked),
    useTeams: bool(pick('useTeams'), base.useTeams),
    useVrs: bool(pick('useVrs'), base.useVrs),
    useTournaments: bool(pick('useTournaments'), base.useTournaments),
    mapMarkets: bool(pick('mapMarkets'), base.mapMarkets),
    prematchHours: num(pick('prematchHours'), base.prematchHours, 1, 168),
    minCash: num(pick('minCash'), base.minCash, 1, 1e6),
    maxPrice: num(pick('maxPrice'), base.maxPrice, 0.01, 0.6),
    watchSells: bool(pick('watchSells'), base.watchSells),
    minScore: Math.round(num(pick('minScore'), base.minScore, 0, 100)),
    copyMaps: bool(pick('copyMaps'), base.copyMaps),
    copyLive: bool(pick('copyLive'), base.copyLive),
    copyPrematch: bool(pick('copyPrematch'), base.copyPrematch),
    skipLosers: bool(pick('skipLosers'), base.skipLosers),
    loserMinResolved: Math.round(num(pick('loserMinResolved'), base.loserMinResolved, 1, 1000)),
    stakePct: num(pick('stakePct'), base.stakePct, 0.1, 50),
    maxStake: num(pick('maxStake'), base.maxStake, 1, 1e6),
    minStake: num(pick('minStake'), base.minStake, 1, 1e5),
    maxSlippage: num(pick('maxSlippage'), base.maxSlippage, 0, 0.5),
    maxEntry: num(pick('maxEntry'), base.maxEntry, 0.02, 0.95),
    maxOpenPct: num(pick('maxOpenPct'), base.maxOpenPct, 1, 100),
    dailyLossPct: num(pick('dailyLossPct'), base.dailyLossPct, 1, 100),
    mirrorExits: bool(pick('mirrorExits'), base.mirrorExits),
    swingStakePct: num(pick('swingStakePct'), base.swingStakePct, 0.1, 20),
    matchCapPct: num(pick('matchCapPct'), base.matchCapPct, 0.5, 100),
    teamCapPct: num(pick('teamCapPct'), base.teamCapPct, 0.5, 100),
    worstCasePct: num(pick('worstCasePct'), base.worstCasePct, 0.5, 100),
    maxSpread: num(pick('maxSpread'), base.maxSpread, 0.01, 0.5),
    reviewer: bool(pick('reviewer'), base.reviewer),
    reviewMinStake: num(pick('reviewMinStake'), base.reviewMinStake, 0, 1e6),
    recordTicks: bool(pick('recordTicks'), base.recordTicks),
    autoPromote: bool(pick('autoPromote'), base.autoPromote),
    autoPromoteReal: bool(pick('autoPromoteReal'), base.autoPromoteReal),
    simBankroll: num(pick('simBankroll'), base.simBankroll, 10, 1e8),
    realDailyCap: num(pick('realDailyCap'), base.realDailyCap, 1, 1e7),
    backfillDays: Math.round(num(pick('backfillDays'), base.backfillDays, 1, 365))
  };
}
