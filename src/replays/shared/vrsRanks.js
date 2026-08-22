// ---------------------------------------------------------------------------
// replays/shared/vrsRanks.js
// Global VRS ranking (three regional tables pooled by points) and the Rank
// filter: "50" = top 50, "20-50" = that band, empty = all.
// ---------------------------------------------------------------------------

/** Must match statsMath.teamNameKey for named orgs (placeholders stay unranked). */
export function rankNameKey(name) {
  const norm = String(name || '')
    .trim()
    .toLowerCase();
  if (!norm || norm === 'team 1' || norm === 'team 2') return '';
  return norm;
}

/**
 * One global ladder from the three regional standings. Duplicate names keep
 * the highest points. Rank 1 is the most points worldwide.
 *
 * @param {Array<{ name?: string, points?: number, standing?: number, region?: string }>} teams
 * @returns {{ size: number, byKey: Map<string, { name: string, rank: number, points: number, region: string }>, list: Array<{ name: string, rank: number, points: number, region: string }> }}
 */
export function buildGlobalRanks(teams) {
  /** @type {Map<string, { name: string, points: number, standing: number, region: string }>} */
  const best = new Map();
  for (const team of teams || []) {
    const key = rankNameKey(team?.name);
    if (!key) continue;
    const points = Number(team.points) || 0;
    const standing = Number(team.standing) || 9999;
    const prev = best.get(key);
    if (
      !prev ||
      points > prev.points ||
      (points === prev.points && standing < prev.standing)
    ) {
      best.set(key, {
        name: String(team.name || '').trim(),
        points,
        standing,
        region: String(team.region || '')
      });
    }
  }
  const list = [...best.values()].sort(
    (a, b) =>
      b.points - a.points || a.standing - b.standing || a.name.localeCompare(b.name)
  );
  /** @type {Map<string, { name: string, rank: number, points: number, region: string }>} */
  const byKey = new Map();
  const ranked = list.map((row, i) => {
    const rec = { name: row.name, rank: i + 1, points: row.points, region: row.region };
    byKey.set(rankNameKey(row.name), rec);
    return rec;
  });
  return { size: ranked.length, byKey, list: ranked };
}

/**
 * @param {string} raw
 * @returns {{ min: number, max: number } | null}
 */
export function parseRankSpec(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(s);
  if (range) {
    let min = Math.floor(Number(range[1]));
    let max = Math.floor(Number(range[2]));
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (min > max) {
      const t = min;
      min = max;
      max = t;
    }
    return { min: Math.max(1, min), max: Math.max(1, max) };
  }
  if (!/^\d+$/.test(s)) return null;
  const n = Math.max(1, Math.floor(Number(s)));
  return { min: 1, max: n };
}

export function hasRankFilter(filter = {}) {
  return Boolean(parseRankSpec(filter.rankOwn) || parseRankSpec(filter.rankOpp));
}

/** Off the VRS ladder. `50-9999` includes these; `50` (top 50) does not. */
export const UNRANKED_RANK = 9999;

/** Rank for a display name. Unknown orgs sit at UNRANKED_RANK so open-ended ranges include them. */
export function rankOfName(name, table) {
  if (!table?.byKey) return UNRANKED_RANK;
  const key = rankNameKey(name);
  if (!key) return UNRANKED_RANK;
  return table.byKey.get(key)?.rank || UNRANKED_RANK;
}

export function rankInSpec(rank, spec) {
  if (!spec) return true;
  const n = Number(rank);
  if (!Number.isFinite(n)) return false;
  return n >= spec.min && n <= spec.max;
}

function tableOf(filter) {
  return filter?.vrsRanks || installedRanks;
}

/**
 * Subject seating: ownName is the focused side, oppName is the other.
 * Empty specs pass. Missing table with an active spec fails closed.
 */
export function sidesPassRank(ownName, oppName, rankOwn, rankOpp, table) {
  const ownSpec = parseRankSpec(rankOwn);
  const oppSpec = parseRankSpec(rankOpp);
  if (!ownSpec && !oppSpec) return true;
  if (!table) return false;
  if (ownSpec && !rankInSpec(rankOfName(ownName, table), ownSpec)) return false;
  if (oppSpec && !rankInSpec(rankOfName(oppName, table), oppSpec)) return false;
  return true;
}

/**
 * No focused side: a single spec keeps games that involve that band; two specs
 * keep games whose sides match the two bands (either orientation).
 */
export function sidesPassRankEither(name1, name2, rankOwn, rankOpp, table) {
  const ownSpec = parseRankSpec(rankOwn);
  const oppSpec = parseRankSpec(rankOpp);
  if (!ownSpec && !oppSpec) return true;
  if (!table) return false;
  const r1 = rankOfName(name1, table);
  const r2 = rankOfName(name2, table);
  if (ownSpec && !oppSpec) return rankInSpec(r1, ownSpec) || rankInSpec(r2, ownSpec);
  if (!ownSpec && oppSpec) return rankInSpec(r1, oppSpec) || rankInSpec(r2, oppSpec);
  return (
    (rankInSpec(r1, ownSpec) && rankInSpec(r2, oppSpec)) ||
    (rankInSpec(r2, ownSpec) && rankInSpec(r1, oppSpec))
  );
}

/**
 * @param {{ name1?: string, name2?: string, team1?: { name?: string, id?: string }, team2?: { name?: string, id?: string }, t1?: string, t2?: string }} demo
 * @param {string} rankOwn
 * @param {string} rankOpp
 * @param {string} [subjectKey]  teamNameKey of the focused team, if any
 */
export function demoPassesRank(demo, rankOwn, rankOpp, subjectKey = '', table) {
  const ownSpec = parseRankSpec(rankOwn);
  const oppSpec = parseRankSpec(rankOpp);
  if (!ownSpec && !oppSpec) return true;
  const n1 = demo?.name1 || demo?.team1?.name;
  const n2 = demo?.name2 || demo?.team2?.name;
  const ranks = table || installedRanks;
  if (subjectKey) {
    const k1 = rankNameKey(n1) || String(demo?.t1 || demo?.team1?.id || '');
    const k2 = rankNameKey(n2) || String(demo?.t2 || demo?.team2?.id || '');
    if (k1 === subjectKey) return sidesPassRank(n1, n2, rankOwn, rankOpp, ranks);
    if (k2 === subjectKey) return sidesPassRank(n2, n1, rankOwn, rankOpp, ranks);
    return false;
  }
  return sidesPassRankEither(n1, n2, rankOwn, rankOpp, ranks);
}

export function rankSummaryLabel(own, opp) {
  const a = String(own || '').trim();
  const b = String(opp || '').trim();
  if (!a && !b) return 'Rank';
  const ownBit = !a ? '' : parseRankSpec(a)?.min === 1 && !a.includes('-') ? `Top ${a}` : a;
  if (!b) return ownBit || 'Rank';
  const oppBit = parseRankSpec(b)?.min === 1 && !b.includes('-') ? `Top ${b}` : b;
  if (!a) return `vs ${oppBit}`;
  return `${ownBit} vs ${oppBit}`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Dropdown with two text fields (Own / Enemy). `scope` prefixes data-rank so
 * Charts can host one per axis.
 *
 * @param {{ own?: string, opp?: string, scope?: string, summaryClass?: string, extraClass?: string }} [opts]
 */
export function rankFilterHtml(opts = {}) {
  const own = String(opts.own || '');
  const opp = String(opts.opp || '');
  const scope = opts.scope ? `${opts.scope}|` : '';
  const summaryClass = opts.summaryClass || 'site-select st-rank-summary';
  const extraClass = opts.extraClass || '';
  const label = rankSummaryLabel(own, opp);
  return `<details class="st-rank-dd${extraClass ? ` ${extraClass}` : ''}">
    <summary class="${summaryClass}" aria-label="Rank">${escapeHtml(label)}</summary>
    <div class="st-rank-menu" role="group" aria-label="Rank">
      <input class="site-input st-rank-input" type="text" inputmode="numeric" autocomplete="off"
        spellcheck="false" data-rank="${scope}rankOwn" placeholder="Own" aria-label="Own rank"
        value="${escapeHtml(own)}" />
      <input class="site-input st-rank-input" type="text" inputmode="numeric" autocomplete="off"
        spellcheck="false" data-rank="${scope}rankOpp" placeholder="Enemy" aria-label="Enemy rank"
        value="${escapeHtml(opp)}" />
    </div>
  </details>`;
}

export function placeRankMenu(details) {
  const menu = details?.querySelector?.('.st-rank-menu');
  const summary = details?.querySelector?.('summary');
  if (!menu || !summary) return;
  const r = summary.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.minWidth = `${Math.round(Math.max(r.width, 160))}px`;
}

export function syncRankSummary(details, own, opp) {
  const summary = details?.querySelector?.('summary');
  if (summary) summary.textContent = rankSummaryLabel(own, opp);
}

/** @type {ReturnType<typeof buildGlobalRanks> | null} */
let installedRanks = null;

export function getVrsRankTable() {
  return installedRanks;
}

export function setVrsRankTable(table) {
  installedRanks = table || null;
}

export function ranksFromApiPayload(body) {
  const list = Array.isArray(body?.teams) ? body.teams : [];
  const byKey = new Map();
  for (const row of list) {
    const key = rankNameKey(row?.name);
    if (!key) continue;
    byKey.set(key, {
      name: String(row.name || '').trim(),
      rank: Number(row.rank) || 0,
      points: Number(row.points) || 0,
      region: String(row.region || '')
    });
  }
  const size = Number(body?.size) || byKey.size;
  return { size, byKey, list, asOf: body?.asOf || null };
}

/** Filter helper for rowPasses / hot aggregate (subject seating). */
export function filterSeatPassesRank(ownName, oppName, filter) {
  if (!hasRankFilter(filter)) return true;
  return sidesPassRank(ownName, oppName, filter.rankOwn, filter.rankOpp, tableOf(filter));
}
