// ---------------------------------------------------------------------------
// replays/eye/roundRefs.js
// Round files are long ids: the round's own prefix, both line-ups, then the
// demo's hash, e.g.
//
//   CNh-Rrx-145-CCH-06_rBR-X74-VmM-RG9-q1S_EJe-S9F-ret-O7E-mef~6d10b24dd9ebd9fe
//
// A model copying one back now and then repeats a segment
// ("…-CCH-06_rBR-06_rBR-…") or drops a character of the hash. This file
// repairs those, and only those: the round prefix up to the first "_" must be
// one known round's exactly and the hash within two characters, or the edit as
// a whole must be small and clearly closer to one round than to any other. A
// neighbouring round of the same demo differs in its prefix, so it is never
// what a repair lands on.
//
// DOM-free.
// ---------------------------------------------------------------------------

/** Characters of the hash a repair may differ by. */
const HASH_SLACK = 2;
/** Whole-id edits a fallback repair may need, and how much closer than the next round it must be. */
const EDIT_SLACK = 3;
const EDIT_MARGIN = 3;

const prefixOf = (id) => String(id).split('_')[0];
const hashOf = (id) => /~([0-9a-z]+)$/i.exec(String(id))?.[1] || '';

/** Edit distance, for strings the length of a round id. */
export function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The known round a model meant.
 *
 * @param {string} given           what the model passed
 * @param {Iterable<string>} known round files this conversation has seen
 * @returns {{ round: string, repaired: boolean } | null}  null when no single round fits
 */
export function resolveRound(given, known) {
  const id = String(given || '').trim();
  const list = [...known];
  if (!id) return null;
  if (list.includes(id)) return { round: id, repaired: false };

  const hash = hashOf(id);
  const byPrefix = list.filter((k) => id.startsWith(`${prefixOf(k)}_`) && editDistance(hashOf(k), hash) <= HASH_SLACK);
  if (byPrefix.length === 1) return { round: byPrefix[0], repaired: true };

  const ranked = list.map((k) => [k, editDistance(k, id)]).sort((a, b) => a[1] - b[1]);
  const [best, next] = ranked;
  if (best && best[1] <= EDIT_SLACK && (!next || next[1] - best[1] >= EDIT_MARGIN)) return { round: best[0], repaired: true };
  return null;
}

/** Round files written anywhere in a text (a question, a tool result). */
export function roundIdsIn(text) {
  return String(text || '').match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+(?:_[A-Za-z0-9-]+)*~[0-9a-f]{6,}/gi) || [];
}

/** The note a tool result carries when it read a round under a repaired id. */
export const repairedNote = (round) => `The round id given was not exact; read it as ${round}. Use this id from now on.`;

// ---- what this conversation has seen ----------------------------------------

const seen = new Set();
const SEEN_MAX = 2000;

/** Remember round files the model has been shown (find_rounds results, the question). */
export function noteRounds(files) {
  for (const f of files || []) {
    if (!f) continue;
    seen.delete(f);
    seen.add(f);
  }
  while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
}

/** The round files remembered so far, newest last. */
export const seenRounds = () => [...seen];
