// ---------------------------------------------------------------------------
// multiplayer/elo.js — shared Elo math (client + server)
// ---------------------------------------------------------------------------

export const DEFAULT_ELO = 1000;
export const K_FACTOR = 32;

export function clampElo(n) {
  return Math.max(100, Math.min(4000, Math.round(Number(n) || DEFAULT_ELO)));
}

/** Expected score for player A vs opponent B (0–1). */
export function expectedScore(eloA, eloB) {
  return 1 / (1 + 10 ** ((eloB - eloA) / 400));
}

/** Signed Elo change for one player after a match. */
export function eloDelta(yourElo, oppElo, won) {
  const actual = won ? 1 : 0;
  const expected = expectedScore(yourElo, oppElo);
  return Math.round(K_FACTOR * (actual - expected));
}

/** New rating + delta for one player. */
export function applyElo(yourElo, oppElo, won) {
  const delta = eloDelta(yourElo, oppElo, won);
  return { newElo: clampElo(yourElo + delta), delta };
}

/** Per-player Elo results for a finished 1v1 (not aborted). */
export function eloResultsForMatch(players, winnerId, ratings) {
  const out = {};
  for (const p of players) {
    const opp = players.find((x) => x.id !== p.id);
    if (!opp) continue;
    const yours = clampElo(ratings[p.id] ?? DEFAULT_ELO);
    const theirs = clampElo(ratings[opp.id] ?? DEFAULT_ELO);
    const won = p.id === winnerId;
    const { newElo, delta } = applyElo(yours, theirs, won);
    out[p.id] = { oldElo: yours, newElo, delta, opponentElo: theirs };
  }
  return out;
}
