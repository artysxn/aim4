// ---------------------------------------------------------------------------
// shared/sim/admission.js
// 7.0: a checkpoint becomes generation N, or the failure names the gate.
//
// The gates themselves are scored elsewhere (they need a graph, a library, a
// thousand matches). This file owns the part that must not be improvised: what
// a gate verdict IS, how the nine of 9.8 combine into one answer, and what
// gets written into the registry when the answer is yes.
//
// One rule drives the whole shape, and it is 9.24's:
//
//   A SKIPPED GATE IS NOT A PASSED GATE.
//
// The old eval reported `{pass: true, skipped: true}` for every gate needing a
// demo baseline this host does not have, then summed the passes and printed
// PASS. That is a green light produced by not looking. Here a skipped gate has
// its own status, an admission carrying skipped gates is `provisional` rather
// than `admitted`, and the manifest records exactly which gates were never
// scored so a later reader cannot mistake one for the other.
// ---------------------------------------------------------------------------

/** What one gate came back as. `skip` is never folded into `pass`. */
export const GATE_STATUS = Object.freeze({ PASS: 'pass', FAIL: 'fail', SKIP: 'skip' });

/** What the pipeline decided about the checkpoint as a whole. */
export const VERDICT = Object.freeze({
  ADMITTED: 'admitted',
  /** Every scored gate passed, but some could not be scored on this host. */
  PROVISIONAL: 'provisional',
  REJECTED: 'rejected'
});

/**
 * The nine gates of 9.8, in the order a failure should be reported in.
 *
 * Order is not cosmetic: it is cheapest-and-most-fundamental first, so the
 * reason a checkpoint was rejected is the most actionable one rather than
 * whichever gate happened to be evaluated last. Determinism before Elo because
 * a nondeterministic engine makes every other number meaningless.
 */
export const GATES = Object.freeze([
  Object.freeze({
    id: 'determinism',
    n: 5,
    title: 'Determinism smoke',
    what: 'same seed re-run bit-identical'
  }),
  Object.freeze({
    id: 'aim',
    n: 2,
    title: 'Aim envelope',
    what: '8.3 distributions inside the pro envelope',
    hard: true
  }),
  Object.freeze({
    id: 'elo',
    n: 1,
    title: 'Elo vs parent',
    what: 'at least +25 Elo over paired-seed matches'
  }),
  Object.freeze({
    id: 'humanLikeness',
    n: 3,
    title: 'Human likeness',
    what: 'KS vs demo baselines; carelessness within 1.5x pro',
    needsLibrary: true
  }),
  Object.freeze({
    id: 'diversity',
    n: 4,
    title: 'Strategy diversity',
    what: 'call entropy above floor; T and CT win rates both inside [35%, 65%]'
  }),
  Object.freeze({
    id: 'surprise',
    n: 6,
    title: 'Surprise band',
    what: 'texture inside the library band, two-sided',
    needsLibrary: true
  }),
  Object.freeze({
    id: 'teamPlay',
    n: 7,
    title: 'Team play',
    what: 'trade and untraded-death rates inside pro bands',
    needsLibrary: true
  }),
  Object.freeze({
    id: 'belief',
    n: 8,
    title: 'Belief quality',
    what: 'particle-filter KL beats the flow-prior baseline'
  }),
  Object.freeze({
    id: 'exploitability',
    n: 9,
    title: 'Exploitability',
    what: 'a fresh fixed-budget exploiter stays under the win-rate cap'
  })
]);

export const GATE_IDS = Object.freeze(GATES.map((g) => g.id));

/** The Elo margin 9.8 gate 1 demands over the previous generation. */
export const ELO_GATE = 25;
/** Matches 9.8 asks for. Paired, so this is pairs x 2 games. */
export const ELO_MATCHES = 400;

/**
 * Elo difference implied by a score rate, and its interval.
 *
 * Paired seeds (same seed, sides swapped) already remove most of the variance
 * that would otherwise need thousands of matches; what remains is binomial, so
 * the interval comes from a Wilson bound on the score rate and is mapped
 * through the same logistic. A rate of 1 or 0 has no finite Elo, so it is
 * pulled in by half a game -- the standard correction, and honest: 400 wins
 * from 400 games is evidence of a large difference, not an infinite one.
 *
 * @param {number} score  wins + 0.5 * draws
 * @param {number} n      games
 * @returns {{elo: number, lo: number, hi: number, rate: number, n: number}}
 */
export function eloFromScore(score, n) {
  if (!n) return { elo: 0, lo: -Infinity, hi: Infinity, rate: 0, n: 0 };
  const rate = score / n;
  const z = 1.96;
  const d = 1 + (z * z) / n;
  const centre = rate + (z * z) / (2 * n);
  const half = z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * n)) / n);
  const clamp = (p) => Math.min(1 - 0.5 / n, Math.max(0.5 / n, p));
  const toElo = (p) => -400 * Math.log10(1 / clamp(p) - 1);
  return {
    rate,
    n,
    elo: toElo(rate),
    lo: toElo((centre - half) / d),
    hi: toElo((centre + half) / d)
  };
}

/**
 * One gate's verdict, in the shape the report and the manifest both store.
 *
 * `reason` is mandatory and is written for a human reading a rejection at
 * midnight: it should say the number, the bar, and which way it went.
 */
export function gateResult(id, status, reason, detail = null) {
  if (!GATE_IDS.includes(id)) throw new Error(`admission: unknown gate ${id}`);
  if (!Object.values(GATE_STATUS).includes(status)) {
    throw new Error(`admission: bad status ${status} for gate ${id}`);
  }
  if (!reason) throw new Error(`admission: gate ${id} needs a reason`);
  return { id, status, reason, ...(detail ? { detail } : {}) };
}

/**
 * Fold the gate results into one answer.
 *
 * @param {object[]} results  one per gate, any order
 * @param {object} [opts]
 * @param {boolean} [opts.allowSkipped]  admit despite unscored gates. The flag
 *        exists because a host with no demo library physically cannot score
 *        four of the nine, and refusing to ever admit there would make the
 *        pipeline unusable on the only machine that runs it. It is recorded in
 *        the manifest, so a provisional generation always says so.
 * @returns {{verdict: string, failed: object|null, skipped: string[], scored: number, reason: string}}
 */
export function admit(results = [], { allowSkipped = false } = {}) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const missing = GATE_IDS.filter((id) => !byId.has(id));
  if (missing.length) {
    // A gate nobody reported is not a gate that passed. This is the same rule
    // as `skip`, applied to the case where the runner forgot entirely.
    return {
      verdict: VERDICT.REJECTED,
      failed: null,
      skipped: missing,
      scored: byId.size,
      reason: `gates never reported: ${missing.join(', ')}`
    };
  }

  // Reported in GATES order, so the named failure is the most fundamental one
  // rather than whichever ran last.
  for (const gate of GATES) {
    const r = byId.get(gate.id);
    if (r.status === GATE_STATUS.FAIL) {
      return {
        verdict: VERDICT.REJECTED,
        failed: r,
        skipped: results.filter((x) => x.status === GATE_STATUS.SKIP).map((x) => x.id),
        scored: results.filter((x) => x.status !== GATE_STATUS.SKIP).length,
        reason: `gate ${gate.n} (${gate.title}): ${r.reason}`
      };
    }
  }

  const skipped = GATES.filter((g) => byId.get(g.id).status === GATE_STATUS.SKIP).map((g) => g.id);
  const scored = GATE_IDS.length - skipped.length;
  if (!skipped.length) {
    return {
      verdict: VERDICT.ADMITTED,
      failed: null,
      skipped,
      scored,
      reason: `all ${GATE_IDS.length} gates passed`
    };
  }
  if (!allowSkipped) {
    return {
      verdict: VERDICT.REJECTED,
      failed: null,
      skipped,
      scored,
      reason:
        `${scored} of ${GATE_IDS.length} gates passed and ${skipped.length} could not be ` +
        `scored (${skipped.join(', ')}). Pass --allow-skipped to admit provisionally.`
    };
  }
  return {
    verdict: VERDICT.PROVISIONAL,
    failed: null,
    skipped,
    scored,
    reason: `${scored} of ${GATE_IDS.length} gates passed; ${skipped.join(', ')} unscored`
  };
}

/**
 * The registry manifest a passing checkpoint earns (9.9).
 *
 * The verdict travels WITH the model rather than only in the eval report,
 * because the registry is what the match seam reads: anything picking a brain
 * can see that a generation was admitted provisionally without going to find
 * a report directory.
 */
export function buildManifest({
  name,
  parent = null,
  gen,
  phase = 'C3',
  verdict,
  results = [],
  league = [],
  elo = null,
  evalId = null,
  createdAt
}) {
  return {
    gen,
    parent,
    phase,
    createdAt,
    admission: {
      verdict: verdict.verdict,
      reason: verdict.reason,
      scored: verdict.scored,
      of: GATE_IDS.length,
      skipped: verdict.skipped,
      evalId,
      gates: results.map((r) => ({ id: r.id, status: r.status, reason: r.reason }))
    },
    ...(elo ? { elo } : {}),
    individual: { weights: `${name}.json` },
    league
  };
}
