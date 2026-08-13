// ---------------------------------------------------------------------------
// shared/sim/zstat.js
// The strategy statistic z the policy conditions on.
//
// SIM-PLAN 9.11: AlphaStar kept strategic variety alive under self-play by
// conditioning the policy on a statistic z extracted from a human replay,
// sampling z from that human set at train time, and letting the policy
// specialize. Diversity stops being something you pray for and becomes an
// input. Ours is a natural fit because the round library already *is* the
// statistic:
//
//   z = (call, utility signature, first-commit timing bucket, spawn shape,
//        lurk presence)
//
// This file only MAKES THE KEY. Concatenating z onto the observation the way
// the player-mimic embedding is concatenated is the trainer's job (9.3 / 9.4);
// putting a one-hot in here would pick a width the trainer then has to agree
// with, and the two would drift. encodeZ returns a vocab index; sampleZ
// draws a key from a library list with an injected rng so a seed reproduces.
//
// SIM-PLAN 9.12's league still needs z: the call-entropy gate (9.8.4) is
// measured with z sampled from the library's own distribution, which is why
// a policy that ignores z scores badly on the adherence term for every z
// but one.
//
// Tiny on purpose. Thresholds that no demo has been mined for yet carry
// `[calibrate]`.
// ---------------------------------------------------------------------------

/** Utility signature from a side's nade count. `[calibrate]` */
export function utilSig(grenadeCounts) {
  let n = 0;
  if (Array.isArray(grenadeCounts)) {
    for (const v of grenadeCounts) n += Number(v) || 0;
  } else if (grenadeCounts && typeof grenadeCounts === 'object') {
    for (const v of Object.values(grenadeCounts)) n += Number(v) || 0;
  } else {
    n = Number(grenadeCounts) || 0;
  }
  if (n >= 5) return 'full';
  if (n >= 2) return 'half';
  return 'eco';
}

/** First-commit timing bucket. Cuts at 25 s and 55 s. `[calibrate]` */
export function commitBucket(secondsElapsed) {
  if (secondsElapsed < 25) return 'early';
  if (secondsElapsed < 55) return 'mid';
  return 'late';
}

/**
 * Canonical z string, e.g. `a-execute|full|early|stack|lurk`.
 * `lurk` is the token when a lurker is present, `nolurk` otherwise.
 */
export function zKey({ call, utilSig: util, commitBucket: commit, spawnShape, lurk }) {
  const lurkPart = lurk === true || lurk === 'lurk' ? 'lurk' : lurk || 'nolurk';
  return `${call}|${util}|${commit}|${spawnShape}|${lurkPart}`;
}

/** Vocab index of a z key (or of a z-bag run through zKey). −1 if unseen. */
export function encodeZ(z, vocab) {
  const key = typeof z === 'string' ? z : zKey(z);
  return vocab.indexOf(key);
}

/**
 * Draw one z string from a library list. `rng` is injected (shared/sim/rng
 * or any `{int(n)}` / `{next()}`) so a seed reproduces the sample.
 */
export function sampleZ(rng, libraryRows) {
  if (!libraryRows || !libraryRows.length) return null;
  const n = libraryRows.length;
  const i =
    typeof rng.int === 'function' ? rng.int(n) : Math.floor((rng.next() * n) % n);
  const row = libraryRows[i];
  return typeof row === 'string' ? row : zKey(row);
}
