// ---------------------------------------------------------------------------
// replays/eye/eyePlays.js
// The play tools' side of the page: round_moves, round_plays and play_review.
//
// The work happens in the desktop app's own server (server/similar/plays.js),
// beside Similar Rounds, which the reviews read. The page adds two things:
//
//   lessons   what training taught the eye to watch for on this map
//             (/eye/play-notes.json, written by tools/eye/plays/self-train.mjs),
//             attached to the result so the model reads them where it needs them
//   rules     when a review has too few similar rounds, the autocoach's flags
//             for the play's window, computed here where the round is priced
// ---------------------------------------------------------------------------

import { readRoundPlays, reviewRoundPlay } from '../api.js';
import { elapsedOf } from '../plays/findPlays.js';
import { lessonsFor } from '../plays/playTools.js';
import { coachFlagsFor } from './eyeValue.js';
import { repairedNote, resolveRound, seenRounds } from './roundRefs.js';

let notes = null;
/** The trained lessons, fetched once. Missing (never trained) is no lessons. */
function playNotes() {
  notes ||= fetch('/eye/play-notes.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return notes;
}

function roundOf(args) {
  const given = String(args.round || '').trim();
  if (!given) throw new Error('Give match and number (or a round file from find_rounds).');
  const hit = resolveRound(given, seenRounds());
  return hit ? { file: hit.round, repaired: hit.repaired } : { file: given, repaired: false };
}

const progressOf = (onProgress, what) => (event) => {
  if (event.type === 'phase' && event.phase === 'baseline') onProgress?.('Learning what is usual on this map…');
  else if (event.type === 'start' && event.purpose) onProgress?.(`${event.purpose[0].toUpperCase()}${event.purpose.slice(1)}…`);
  else if (event.type === 'progress' && event.total) onProgress?.(`${what}: ${event.done} of ${event.total} rounds…`);
};

/** The round with no labels: what the eye reads before it guesses the plays. */
export async function roundMovesTool(args, { onProgress, signal } = {}) {
  const { file, repaired } = roundOf(args);
  const r = await readRoundPlays({ file, moves: true }, { signal, onEvent: progressOf(onProgress, 'Reading rounds') });
  const out = repaired ? { round_used: repairedNote(file), ...r.moves } : r.moves;
  return { file, out, display: `Watched round ${r.moves.round} on ${r.map}` };
}

/** The plays of a round, with the eye's guess checked. */
export async function roundPlaysTool(args, { onProgress, signal } = {}) {
  const { file, repaired } = roundOf(args);
  const guess = Array.isArray(args.guess) ? args.guess : null;
  const r = await readRoundPlays({ file, guess }, { signal, onEvent: progressOf(onProgress, 'Learning the map') });
  const { type: _type, ...rest } = r;
  const lessons = lessonsFor(await playNotes(), { map: r.map, kinds: [...new Set(r.plays.map((p) => p.kind))] });
  const out = { ...(repaired ? { round_used: repairedNote(file) } : {}), ...rest, ...(lessons.length ? { lessons } : {}) };
  const checked = r.check ? `, guess ${r.check.score}%` : '';
  return { file, out, display: `Read ${r.plays.length} plays${checked}` };
}

/** One play judged against the rounds most like it. */
export async function playReviewTool(args, { onProgress, signal } = {}) {
  const { file, repaired } = roundOf(args);
  const guess = args.guess && typeof args.guess === 'object' ? args.guess : args.verdict ? { verdict: args.verdict } : null;
  const r = await reviewRoundPlay({ file, play: String(args.play || ''), guess }, { signal, onEvent: progressOf(onProgress, 'Reading similar rounds') });
  const { type: _type, ...rest } = r;
  if (rest.guidelines) {
    // The play's window in seconds since the round went live, as the flags count it.
    const start = elapsedOf(rest.play?.from) ?? -Infinity;
    const end = elapsedOf(rest.play?.to) ?? Infinity;
    const flags = (await coachFlagsFor(file)).filter((f) => (!f.side || f.side === rest.play?.side) && f.e >= start - 5 && f.e <= end + 2);
    rest.guidelines.flags = flags.slice(0, 5).map((f) => ({ player: f.player, rule: f.rule, text: f.text, ...(f.cost_pp != null ? { cost_pp: f.cost_pp } : {}) }));
  }
  const lessons = lessonsFor(await playNotes(), { map: rest.map, kinds: rest.play?.kind ? [rest.play.kind] : [] });
  const out = { ...(repaired ? { round_used: repairedNote(file) } : {}), ...rest, ...(lessons.length ? { lessons } : {}) };
  return { file, out, display: `Reviewed ${rest.play?.label || 'the play'}: ${rest.verdict}` };
}
