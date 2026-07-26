// ---------------------------------------------------------------------------
// Opening man-advantage for a focus team (library + analyzer filters).
//
// Window: 3 seconds after the first cross-team kill.
//   5v5 — no opening duel
//   5v4 / 5v3 — focus got the opening (and a second kill) and held the edge
//   4v5 / 3v5 — focus died first (and again) and stayed down
//   4v4 — advantage equalized (or flipped) inside the window
// ---------------------------------------------------------------------------

/**
 * @param {object} meta
 * @param {1|2} focusTeam  team index 1 or 2
 * @param {{ holdSeconds?: number }} [opts]
 * @returns {'5v5'|'5v4'|'5v3'|'4v5'|'3v5'|'4v4'|''}
 */
export function openingSituation(meta, focusTeam, { holdSeconds = 3 } = {}) {
  const idx = Number(focusTeam);
  if (idx !== 1 && idx !== 2) return '';
  const players = meta?.players || [];
  if (!players.length) return '';

  const teamOf = new Map(players.map((p) => [p.id, p.team]));
  const kills = [...(meta.events?.kills || [])].sort(
    (a, b) => (a.tick || 0) - (b.tick || 0)
  );

  let opening = null;
  for (const k of kills) {
    const at = teamOf.get(k.attacker);
    const vt = teamOf.get(k.victim);
    if (!at || !vt || at === vt) continue;
    opening = k;
    break;
  }
  if (!opening) return '5v5';

  const focusGotKill = teamOf.get(opening.attacker) === idx;
  const focusGotDeath = teamOf.get(opening.victim) === idx;
  if (!focusGotKill && !focusGotDeath) return '5v5';

  let focusAlive = players.filter((p) => p.team === idx).length || 5;
  let oppAlive = players.filter((p) => p.team && p.team !== idx).length || 5;
  if (focusGotKill) oppAlive = Math.max(0, oppAlive - 1);
  else focusAlive = Math.max(0, focusAlive - 1);

  const tickRate = meta.tickRate || 64;
  const windowEnd = opening.tick + holdSeconds * tickRate;

  for (const k of kills) {
    if (k.tick <= opening.tick) continue;
    if (k.tick > windowEnd) break;
    const vt = teamOf.get(k.victim);
    if (!vt) continue;
    if (vt === idx) focusAlive = Math.max(0, focusAlive - 1);
    else oppAlive = Math.max(0, oppAlive - 1);
    if (focusAlive === oppAlive) return '4v4';
  }

  if (focusAlive === 5 && oppAlive === 3) return '5v3';
  if (focusAlive === 5 && oppAlive === 4) return '5v4';
  if (focusAlive === 3 && oppAlive === 5) return '3v5';
  if (focusAlive === 4 && oppAlive === 5) return '4v5';
  if (focusAlive === oppAlive) return '4v4';
  if (focusAlive > oppAlive) {
    if (focusAlive - oppAlive >= 2) return '5v3';
    return '5v4';
  }
  if (oppAlive - focusAlive >= 2) return '3v5';
  return '4v5';
}

export const SITUATION_OPTIONS = [
  { key: '5v5', label: '5v5' },
  { key: '5v4', label: '5v4' },
  { key: '5v3', label: '5v3' },
  { key: '4v4', label: '4v4' },
  { key: '4v5', label: '4v5' },
  { key: '3v5', label: '3v5' }
];
