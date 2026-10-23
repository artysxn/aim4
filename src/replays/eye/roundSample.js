// ---------------------------------------------------------------------------
// replays/eye/roundSample.js
// How a round went in players alive: the man advantage of one side after
// every kill, read from a round's meta (its players and kill list). Pure, so
// it is tested without the library.
//
// Why: "pistol rounds the Ts win clean" is a question about the advantage
// through the round (never down two, up two at some point), which no round
// tag or buy filter can answer. The model must never count it from pictures.
// ---------------------------------------------------------------------------

/** "T" or "CT" for a meta's team 1 or 2. */
export function sideOfTeam(meta, team) {
  const one = String(meta?.team1Side || '').toUpperCase() === 'CT' ? 'CT' : 'T';
  return Number(team) === 1 ? one : one === 'CT' ? 'T' : 'CT';
}

/** The side that won a round, from its meta. */
export const winnerSide = (meta) => sideOfTeam(meta, meta?.winner === 1 ? 1 : 2);

/**
 * The man advantage of `side` (its players alive minus the other side's) at
 * the start and after every kill, until one side has nobody left.
 *
 * A count held for `grace` seconds or less (a man down and traded at once) is left out of min and
 * max; rawMin and rawMax keep it.
 *
 * @param {object} meta  round meta: players [{ id, team }], team1Side, tickRate, events.kills [{ tick, victim }]
 * @param {'T'|'CT'} side
 * @param {number} [grace]  seconds
 * @returns {{ min: number, max: number, rawMin: number, rawMax: number, grace: number, steps: string[] }}  steps: "5v5", "5v4", ...
 */
export function aliveGaps(meta, side = 'T', grace = 0) {
  const sideOf = new Map((meta?.players || []).map((p) => [p.id, sideOfTeam(meta, p.team)]));
  const alive = { T: 0, CT: 0 };
  for (const s of sideOf.values()) alive[s]++;
  // A round read before its players were known: assume the usual five a side.
  if (!alive.T) alive.T = 5;
  if (!alive.CT) alive.CT = 5;
  const other = side === 'T' ? 'CT' : 'T';
  const gap = () => alive[side] - alive[other];
  let min = gap();
  let max = gap();
  const steps = [`${alive[side]}v${alive[other]}`];
  const kills = [...(meta?.events?.kills || [])].sort((a, b) => Number(a.tick) - Number(b.tick));
  // Kills after the round was decided (a saving player hunted down) are not part of how it went.
  const end = Number(meta?.endTick);
  const live = kills.filter((k) => !(Number.isFinite(end) && end > 0 && Number(k.tick) > end));
  const graceTicks = Math.max(0, Number(grace) || 0) * (Number(meta?.tickRate) || 64);
  let rawMin = min;
  let rawMax = max;
  for (const [i, k] of live.entries()) {
    const s = sideOf.get(k.victim);
    if (!s || alive[s] <= 0) continue;
    alive[s]--;
    steps.push(`${alive[side]}v${alive[other]}`);
    // The kill that ends it (2v1 to 2v0) is not an advantage anyone played with: every win would
    // otherwise be "up 2" at the end.
    if (!alive.T || !alive.CT) break;
    rawMin = Math.min(rawMin, gap());
    rawMax = Math.max(rawMax, gap());
    // How long this count held: to the next kill, else to the end of the round.
    const until = i + 1 < live.length ? Number(live[i + 1].tick) : Number.isFinite(end) && end > 0 ? end : Infinity;
    if (until - Number(k.tick) <= graceTicks) continue;
    min = Math.min(min, gap());
    max = Math.max(max, gap());
  }
  return { min, max, rawMin, rawMax, grace: Math.max(0, Number(grace) || 0), steps };
}

/**
 * Does a round's advantage fit: never below `never_below`, and at least
 * `reaches` at some point. Either may be left out.
 */
export function gapFits(gaps, { never_below: floor, reaches } = {}) {
  if (Number.isFinite(floor) && gaps.min < floor) return false;
  if (Number.isFinite(reaches) && gaps.max < reaches) return false;
  return true;
}

/** "never behind, up to +3 (5v2)" for a model to quote. */
export function gapWords(gaps) {
  const sign = (n) => (n > 0 ? `+${n}` : String(n));
  const best = gaps.steps.find((s) => {
    const [a, b] = s.split('v').map(Number);
    return a - b === gaps.max;
  });
  // A count left out for being brief is still said, so "never behind" is not read as "never 4v5".
  const brief = gaps.rawMin < gaps.min ? ` (down to ${sign(gaps.rawMin)} for ${gaps.grace}s or less)` : '';
  return `${gaps.min >= 0 ? 'never behind' : `down to ${sign(gaps.min)} at worst`}${brief}, up to ${sign(gaps.max)}${best ? ` (${best})` : ''}; ${gaps.steps.join(' → ')}`;
}
