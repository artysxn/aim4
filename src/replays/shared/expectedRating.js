// ---------------------------------------------------------------------------
// Expected rating, overperformance, and true rating.
//
// These are derived from Rating 3.0 and a team's round winrate. Nothing in
// the stats index is rewritten: the Database already has both inputs.
//
// Team identity is the 75%+ majority of a player's most recent matches,
// starting at the last 10 and walking further back if no side has a unique
// majority. The winrate on that team is round winrate, not map winrate.
// ---------------------------------------------------------------------------

/** Y = 0.45 + 1.26 × W, W as a 0–1 fraction. `winratePct` is 0–100. */
export function expectedRatingFromWinrate(winratePct) {
  if (winratePct == null || winratePct === '') return null;
  const pct = Number(winratePct);
  if (!Number.isFinite(pct)) return null;
  return 0.45 + 1.26 * (pct / 100);
}

/** X / Y as a percent. 1.14 → 114. */
export function expectedRatingOverperformance(rating, expected) {
  const x = Number(rating);
  const y = Number(expected);
  if (!Number.isFinite(x) || expected == null || !Number.isFinite(y) || y === 0) return null;
  return (x / y) * 100;
}

/**
 * X + 0.35 × (X − Y) × e^(0.35 × max(0, (X − 1.02) / 0.13))
 */
export function trueRatingOf(rating, expected) {
  const x = Number(rating);
  const y = Number(expected);
  if (!Number.isFinite(x) || expected == null || !Number.isFinite(y)) return null;
  const lift = Math.max(0, (x - 1.02) / 0.13);
  return x + 0.35 * (x - y) * Math.exp(0.35 * lift);
}

/**
 * The team a player is on: unique 75%+ majority of the last N games, N
 * starting at 10 (or the whole history if shorter) and growing on a tie or
 * a split.
 *
 * @param {Array<{ at?: number, key?: string, name?: string }>} games
 * @returns {{ key: string, name: string } | null}
 */
export function primaryTeamFromGames(games) {
  const list = (games || [])
    .filter((g) => g && g.key)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0) || String(a.key).localeCompare(String(b.key)));
  if (!list.length) return null;
  let n = Math.min(10, list.length);
  while (n <= list.length) {
    const slice = list.slice(0, n);
    const counts = new Map();
    const names = new Map();
    for (const g of slice) {
      counts.set(g.key, (counts.get(g.key) || 0) + 1);
      if (!names.has(g.key) && g.name) names.set(g.key, g.name);
    }
    let bestKey = '';
    let bestN = 0;
    let ties = 0;
    for (const [k, c] of counts) {
      if (c > bestN) {
        bestN = c;
        bestKey = k;
        ties = 1;
      } else if (c === bestN) {
        ties += 1;
      }
    }
    if (ties === 1 && bestN / n >= 0.75) {
      return { key: bestKey, name: names.get(bestKey) || bestKey };
    }
    n += 1;
  }
  return null;
}

/**
 * Stamp expected rating / overperformance / true rating onto player rows.
 * Drops `clubGames` afterwards so the API payload stays small.
 *
 * @param {object[]} players
 * @param {object[]} teams
 */
export function attachExpectedRatings(players, teams) {
  const wr = new Map();
  for (const t of teams || []) {
    if (t?.key) wr.set(t.key, t.roundWinrate);
  }
  for (const p of players || []) {
    if (p.absent) {
      p.clubKey = '';
      p.clubName = '';
      p.clubWinrate = null;
      p.expectedRating = null;
      p.expectedRatingOp = null;
      p.trueRating = null;
      delete p.clubGames;
      continue;
    }
    const club = primaryTeamFromGames(p.clubGames);
    const winrate = club ? wr.get(club.key) : null;
    const y = expectedRatingFromWinrate(winrate);
    p.clubKey = club?.key || '';
    p.clubName = club?.name || '';
    p.clubWinrate = Number.isFinite(winrate) ? winrate : null;
    p.expectedRating = y;
    p.expectedRatingOp = expectedRatingOverperformance(p.rating, y);
    p.trueRating = trueRatingOf(p.rating, y);
    delete p.clubGames;
  }
  return players;
}
