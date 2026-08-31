// ---------------------------------------------------------------------------
// lib/aimRanks.js
// The rank ladder, and who is on which rung.
//
// Ranks are a POSITION, not a score. Nobody is Legend because they passed a
// number; they are Legend because nobody else on that board is above them.
// So the ladder is defined as a share of players per rank, the shares add to
// exactly 100, and a board is cut up by them.
//
// The shape is a bell with a long right tail: half of everyone sits between
// Silver 1 and Gold 2, the bottom falls away fast (Iron is 4% of players, all
// three divisions together), and the top thins to a point (Legend is one
// player in a thousand). The percentages are the design, not a fit to current
// data; they are what the ladder is FOR.
//
// Per category, per board. An ELO on Gridshot says nothing about an ELO on
// Tracking, so each board is cut on its own population.
// ---------------------------------------------------------------------------

/**
 * The ladder, worst first, with each rank's share of the population.
 *
 * `from` and `to` are cumulative percentiles FROM THE BOTTOM, filled in below
 * so the table above stays a list of shares that can be read against the
 * design. `top` is the same boundary read from the other end, which is how a
 * rank is usually quoted: Challenger is "top 5%".
 */
const LADDER = [
  ['iron1', 'Iron 1', 'iron', 0.5],
  ['iron2', 'Iron 2', 'iron', 1.0],
  ['iron3', 'Iron 3', 'iron', 2.5],
  ['bronze1', 'Bronze 1', 'bronze', 3.0],
  ['bronze2', 'Bronze 2', 'bronze', 4.0],
  ['bronze3', 'Bronze 3', 'bronze', 5.0],
  ['silver1', 'Silver 1', 'silver', 6.0],
  ['silver2', 'Silver 2', 'silver', 8.0],
  ['silver3', 'Silver 3', 'silver', 9.5],
  ['gold1', 'Gold 1', 'gold', 10.5],
  ['gold2', 'Gold 2', 'gold', 10.0],
  ['gold3', 'Gold 3', 'gold', 9.0],
  ['plat1', 'Platinum 1', 'platinum', 7.5],
  ['plat2', 'Platinum 2', 'platinum', 6.5],
  ['plat3', 'Platinum 3', 'platinum', 5.0],
  ['diamond1', 'Diamond 1', 'diamond', 3.0],
  ['diamond2', 'Diamond 2', 'diamond', 2.2],
  ['diamond3', 'Diamond 3', 'diamond', 1.8],
  ['challenger', 'Challenger', 'challenger', 2.6],
  ['master', 'Master', 'master', 1.7],
  ['champion', 'Champion', 'champion', 0.6],
  ['legend', 'Legend', 'legend', 0.1]
];

export const RANKS = Object.freeze(
  LADDER.map(([key, name, tier, share], i) => {
    const from = LADDER.slice(0, i).reduce((a, r) => a + r[3], 0);
    return Object.freeze({
      key,
      name,
      tier,
      index: i,
      /** Share of the population on this rank, in percent. */
      share,
      /** Percentile band from the bottom, [from, to). The top rank closes. */
      from: round2(from),
      to: round2(from + share),
      /** The same boundary quoted from the top: "top 5%". */
      top: round2(100 - from)
    });
  })
);

function round2(n) {
  return Math.round(n * 100) / 100;
}

export const RANK_COUNT = RANKS.length;
/** Worst and best rungs, and the one a lone player sits on. */
export const LOWEST = RANKS[0];
export const HIGHEST = RANKS[RANKS.length - 1];
export const MEDIAN = RANKS.find((r) => r.from <= 50 && 50 < r.to) || RANKS[10];

/** By key, for reading a stored rank back. */
export function rankByKey(key) {
  return RANKS.find((r) => r.key === key) || null;
}

/**
 * The rank at a percentile, counted FROM THE BOTTOM: 0 is the worst player on
 * the board, 1 is the best.
 *
 * Bands are half open, [from, to), so a player exactly on a boundary takes the
 * higher rank. 0.5 is Gold 2 and not Gold 1, which is the same rule that makes
 * the middle of three players Gold 2.
 */
export function rankAtPercentile(p) {
  const v = Number(p);
  if (!Number.isFinite(v)) return null;
  const pct = Math.max(0, Math.min(100, v * 100));
  if (pct >= HIGHEST.from) return HIGHEST;
  for (const r of RANKS) {
    if (pct < r.to) return r;
  }
  return HIGHEST;
}

/**
 * Rank every entry on one board.
 *
 * The array IS the population. Handing this the top ten of a board of ten
 * thousand would rank the tenth best player in the world as Iron 1, so a
 * caller with a page rather than a board must not use this on it.
 *
 * Position is spread across the FULL ladder rather than sampled from it, which
 * is what makes a small board still say something: with three players the
 * worst is Iron 1, the middle is Gold 2 and the best is Legend, because with
 * three players those are genuinely the bottom, the middle and the top. As the
 * board grows the same formula converges on the designed shares.
 *
 * Equal values share a rank, taken at the middle of their run, so a board
 * where everyone is tied is one rank rather than a ladder built out of the
 * order the rows happened to arrive in.
 *
 * @param {number[]} values one number per entry, in any order
 * @param {{higherIsBetter?: boolean}} [opts] false for boards where a lower
 *   number wins, such as reaction time
 * @returns {Array<object|null>} the rank per entry, aligned to `values`
 */
export function assignRanks(values, { higherIsBetter = true } = {}) {
  const list = Array.isArray(values) ? values : [];
  const scored = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    // Not `Number(raw)` alone: Number(null) is 0, and a row with no score
    // would be ranked bottom of the board as though it had scored zero.
    if (raw === null || raw === undefined || raw === '') continue;
    const v = Number(raw);
    if (Number.isFinite(v)) scored.push({ i, v });
  }
  const out = new Array(list.length).fill(null);
  if (!scored.length) return out;

  // Alone on a board you are at once the best player on it and the worst, and
  // neither is a fact about your aim. The middle rung claims nothing.
  if (scored.length === 1) {
    out[scored[0].i] = MEDIAN;
    return out;
  }

  scored.sort((a, b) => (higherIsBetter ? a.v - b.v : b.v - a.v));
  const last = scored.length - 1;
  for (let i = 0; i < scored.length; ) {
    let j = i;
    while (j + 1 < scored.length && scored[j + 1].v === scored[i].v) j++;
    // The middle of the tied run, so a tie is one rank and not a coin toss.
    const pos = (i + j) / 2;
    const rank = rankAtPercentile(pos / last);
    for (let k = i; k <= j; k++) out[scored[k].i] = rank;
    i = j + 1;
  }
  return out;
}
