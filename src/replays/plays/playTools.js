// ---------------------------------------------------------------------------
// replays/plays/playTools.js
// What the round_plays tool returns, built in one place: the desktop server
// answers the eye with it (server/similar/plays.js) and the training tools
// write it into traces (tools/eye/plays), so the model is trained on exactly
// what it reads in the app.
//
// DOM-free.
// ---------------------------------------------------------------------------

import { DEFINITIONS, checkGuess, publicPlay, summarize } from './findPlays.js';

export const PLAYS_HOW_TO_READ =
  'Each play has an id (T1, CT2...) to name it in play_review. default: true marks the parts that were the side\'s default (no commitment, or a common setup); everything else is a play. usual: how often teams run that kind of play on this map in that economy. outcome: the side\'s round win chance at the start and end of the play (swing_pp), and the kills inside it. shape_unusual_pct: how far the default\'s shape was from the usual one (90 = more unusual than 90% of rounds).';

/**
 * @param {object} index
 * @param {object[]} plays  findPlays(index, baseline).plays
 * @param {{ guess?: object[]|null, usualFrom?: string }} [opts]
 */
export function playsReport(index, plays, { guess = null, usualFrom = '' } = {}) {
  const out = {
    round: index.file,
    map: index.map,
    usual_from: usualFrom,
    summary: summarize(index, plays),
    plays: plays.map(publicPlay),
    how_to_read: PLAYS_HOW_TO_READ
  };
  if (guess) {
    const check = checkGuess(guess, plays);
    // The definition of each kind it got wrong or missed: what to look for next time.
    const kinds = new Set([...check.missed.map((m) => m.kind), ...check.wrong.map((w) => w.guess.kind).filter((k) => DEFINITIONS[k])]);
    out.check = { ...check, definitions: [...kinds].map((k) => DEFINITIONS[k]) };
  }
  return out;
}

/** Lessons attached to one result, at most. */
const MAX_LESSONS = 4;

/**
 * The trained lessons that fit a result: this map's first, then the general
 * ones, heaviest first. A lesson is { map?, side?, kind?, text, weight? }
 * (tools/eye/plays/notes.mjs writes them).
 *
 * @param {{ lessons?: object[] }|null} notes
 * @param {{ map?: string, kinds?: string[] }} [where]
 * @returns {string[]}
 */
export function lessonsFor(notes, { map = '', kinds = [] } = {}) {
  const list = Array.isArray(notes?.lessons) ? notes.lessons : [];
  const fits = (l) => (!l.map || l.map === map) && (!l.kind || !kinds.length || kinds.includes(l.kind));
  return list
    .filter(fits)
    .sort((a, b) => (b.map === map) - (a.map === map) || (b.weight || 0) - (a.weight || 0))
    .slice(0, MAX_LESSONS)
    .map((l) => l.text);
}
