// ---------------------------------------------------------------------------
// server/insights/matching.js
// Which Polymarket CS2 events Insights tracks, and how a Polymarket team name
// is matched against the owner's list, the tournament keywords and the VRS
// ladder. Pure: no I/O, so the rules are unit-tested (insights.test.js).
//
// Names are compared as word sequences, never substrings. The list holds short
// names ("NT", "pure", "maybe", "Leo") that are inside plenty of unrelated
// names; "NT" must match "NT" and "Team NT", not "Nemiga" or "ENTROPIQ".
// ---------------------------------------------------------------------------

/** Filler words that are not part of a team's identity on either side. */
const NOISE = new Set(['team', 'esports', 'esport', 'e', 'sports', 'gaming', 'gg', 'club', 'org', 'cs', 'cs2', 'csgo']);

/** Lowercase, accents off, punctuation to spaces. "KUUSAMO.gg" -> "kuusamo gg". */
export function normName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ]+/g, ' ')
    .trim();
}

/** Identity words of a name: normalized, with filler words removed (unless nothing else is left). */
export function nameTokens(name) {
  const all = normName(name).split(' ').filter(Boolean);
  const core = all.filter((t) => !NOISE.has(t));
  return core.length ? core : all;
}

/** A list entry: "ex-zero tenacity" also matches plain "zero tenacity". */
export function entryVariants(entry) {
  const toks = nameTokens(entry);
  if (!toks.length) return [];
  const out = [toks];
  if (toks[0] === 'ex' && toks.length > 1) out.push(toks.slice(1));
  return out;
}

/** Two words are the same word, allowing a language ending ("quintessence" / "quintessencia"). */
function sameWord(a, b) {
  if (a === b) return true;
  if (a.length < 6 || b.length < 6) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= Math.max(5, Math.min(a.length, b.length) - 2);
}

/** True when `needle` appears in `hay` as a contiguous run of words. */
function containsRun(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (!sameWord(hay[i + j], needle[j])) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * The first list entry that names this team, or ''.
 * @param {string} teamName  as Polymarket writes it
 * @param {string[]} entries  the owner's list
 */
export function matchEntry(teamName, entries) {
  const hay = nameTokens(teamName);
  if (!hay.length) return '';
  for (const entry of entries || []) {
    for (const v of entryVariants(entry)) {
      if (containsRun(hay, v)) return entry;
    }
  }
  return '';
}

/** First keyword found as whole words in any of the texts, or ''. */
export function matchKeyword(texts, keywords) {
  const hays = (texts || []).filter(Boolean).map((t) => normName(t).split(' ').filter(Boolean));
  for (const kw of keywords || []) {
    const needle = normName(kw).split(' ').filter(Boolean);
    if (!needle.length) continue;
    if (hays.some((h) => containsRun(h, needle))) return kw;
  }
  return '';
}

/**
 * Global VRS rank for a Polymarket team name, or 0 when unranked.
 * `ranks.byKey` is buildGlobalRanks() output, keyed by the lowercase VRS name.
 * Tries the exact name, then the name without filler words, then a
 * word-sequence match against every ranked name (once, cached per table).
 */
export function vrsRankOf(teamName, ranks) {
  if (!ranks?.byKey) return 0;
  const exact = ranks.byKey.get(String(teamName || '').trim().toLowerCase());
  if (exact) return exact.rank;
  const toks = nameTokens(teamName);
  const key = toks.join(' ');
  if (!key) return 0;
  if (!ranks._tokIndex) {
    ranks._tokIndex = new Map();
    for (const rec of ranks.list || []) {
      const k = nameTokens(rec.name).join(' ');
      if (k && !ranks._tokIndex.has(k)) ranks._tokIndex.set(k, rec.rank);
    }
  }
  return ranks._tokIndex.get(key) || 0;
}

/** "Counter-Strike: A vs B (BO3) - League Stage" -> parts. */
export function parseTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(counter-strike|cs2?|valorant|lol|league of legends|dota ?2)\s*:\s*(.+?)\s+vs\.?\s+(.+?)\s*(?:\((bo\d)\))?\s*(?:-\s*(.+))?$/i);
  if (!m) return null;
  const g = m[1].toLowerCase();
  return {
    game: /^(counter-strike|cs)/.test(g) ? 'cs2' : g.startsWith('valorant') ? 'valorant' : g.startsWith('dota') ? 'dota2' : 'lol',
    teamA: m[2].trim(),
    teamB: m[3].trim(),
    format: (m[4] || '').toUpperCase(),
    league: (m[5] || '').trim()
  };
}

function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  try {
    const out = JSON.parse(v || '[]');
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

/**
 * "4-9|1-0|Bo3" -> { rounds:[4,9], maps:[1,0], bestOf:3 }. Either half may be missing.
 */
export function parseScore(score) {
  const parts = String(score || '').split('|');
  const pair = (s) => {
    const m = String(s || '').match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const bo = String(parts[2] || '').match(/bo(\d)/i);
  return { rounds: pair(parts[0]), maps: pair(parts[1]), bestOf: bo ? Number(bo[1]) : 0 };
}

/**
 * Reduce a gamma event to what Insights keeps. Null when it is not a CS2 match
 * (futures like "Will FaZe win a Tier 1 event" have no two-team title).
 */
export function normalizeEvent(e) {
  const parsed = parseTitle(e?.title);
  if (!parsed) return null;
  const teams = Array.isArray(e.teams) && e.teams.length >= 2
    ? [e.teams[0].name, e.teams[1].name].map((s) => String(s || '').trim())
    : [parsed.teamA, parsed.teamB];
  const meta = e.eventMetadata || {};
  const markets = [];
  for (const m of e.markets || []) {
    const type = String(m.sportsMarketType || '');
    const kind = type === 'moneyline' ? 'match' : type === 'child_moneyline' ? 'map' : '';
    if (!kind) continue;
    const outcomes = parseJsonArray(m.outcomes).map(String);
    const tokens = parseJsonArray(m.clobTokenIds || m.positionIds).map(String);
    if (outcomes.length !== 2 || tokens.length !== 2 || !m.conditionId) continue;
    const prices = parseJsonArray(m.outcomePrices).map(Number);
    markets.push({
      id: String(m.id),
      conditionId: String(m.conditionId),
      kind,
      label: kind === 'match' ? 'Match' : String(m.groupItemTitle || m.question || 'Map').replace(/\s*winner\s*$/i, ''),
      outcomes,
      tokens,
      prices: prices.length === 2 && prices.every(Number.isFinite) ? prices : null,
      bestBid: Number.isFinite(Number(m.bestBid)) ? Number(m.bestBid) : null,
      bestAsk: Number.isFinite(Number(m.bestAsk)) ? Number(m.bestAsk) : null,
      closed: Boolean(m.closed),
      accepting: m.acceptingOrders !== false,
      version: String(m.version || 'v1'),
      tick: Number(m.orderPriceMinTickSize) || 0.01,
      minSize: Number(m.orderMinSize) || 5,
      feeRate: Number(m.feeSchedule?.rate) || 0,
      volume: Number(m.volumeNum ?? m.volume) || 0
    });
  }
  if (!markets.some((m) => m.kind === 'match')) return null;
  return {
    id: String(e.id),
    slug: String(e.slug || ''),
    title: String(e.title || ''),
    game: parsed.game,
    teams,
    format: parsed.format || (meta.serie ? '' : ''),
    league: String(meta.league || parsed.league || ''),
    stage: [meta.serie, meta.tournament].filter(Boolean).join(' '),
    tier: String(meta.leagueTier || ''),
    start: Date.parse(e.startTime || markets[0]?.gameStartTime || e.startDate || '') || 0,
    live: Boolean(e.live),
    ended: Boolean(e.ended),
    closed: Boolean(e.closed),
    score: String(e.score || ''),
    period: String(e.period || ''),
    volume: Number(e.volume) || 0,
    // The live score feed is keyed by this.
    gameId: String(e.gameId || ''),
    // Resolution rules (forfeit and tie handling), read by the AI reviewer.
    rules: String(e.description || '').slice(0, 1200),
    markets
  };
}

/**
 * Should this event be tracked, and why.
 * @returns {{ track: boolean, reasons: string[], ranks: number[], listed: string[] }}
 */
export function trackDecision(ev, settings, ranks) {
  // Other esports: no team lists or VRS, only low-tier leagues of the games switched on.
  if (ev.game && ev.game !== 'cs2') {
    const on = (settings.otherGames || []).includes(ev.game);
    const tier = Number(ev.tier) || 0;
    const low = tier === 0 || tier >= 3;
    return { track: on && low, reasons: on && low ? [`lowtier:${ev.game}${tier ? ` t${tier}` : ''}`] : [], ranks: [0, 0], listed: ['', ''] };
  }
  const reasons = [];
  const listed = ev.teams.map((t) => (settings.useTeams ? matchEntry(t, settings.teams) : ''));
  const excluded = ev.teams.some((t) => matchEntry(t, settings.excludeTeams));
  const vrs = ev.teams.map((t) => vrsRankOf(t, ranks));
  if (excluded) return { track: false, reasons: ['excluded'], ranks: vrs, listed };
  listed.forEach((hit, i) => {
    if (hit) reasons.push(`list:${ev.teams[i]}`);
  });
  if (settings.useVrs) {
    vrs.forEach((rank, i) => {
      if (rank > settings.vrsBelow) reasons.push(`vrs:${ev.teams[i]}#${rank}`);
      else if (!rank && settings.vrsUnranked) reasons.push(`unranked:${ev.teams[i]}`);
    });
  }
  if (settings.useTournaments) {
    const kw = matchKeyword([ev.title, ev.league], settings.tournaments);
    if (kw) reasons.push(`event:${kw}`);
  }
  return { track: reasons.length > 0, reasons, ranks: vrs, listed };
}
