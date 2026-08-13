// ---------------------------------------------------------------------------
// shared/sim/skill.js
// Skill as a trait vector, and the pro envelope no profile may cross.
//
// SIM-PLAN 6.16 and 8.2: skill is not a slider. It is around a dozen traits,
// each wired to exactly one mechanism, so that two teams at the same nominal
// level can feel completely different and so that "worse" means specific things
// (checks angles late, keeps running at a dead plan, loses track of the lurker)
// rather than "aims badly".
//
// Only three traits touch the motor: `reaction`, `attackDelay`, and the aim
// sigmas. Those are clamped inside a pro envelope and the clamp is the
// structural anti-aimbot guarantee (8). The other traits cannot make a bot
// mechanically superhuman no matter how they are set, which is exactly why they
// can be exposed to a user without a second thought.
//
// The envelope is a ceiling on ABILITY, so the clamp direction differs per
// trait: a reaction time may not be faster than the envelope, a sigma may not
// be tighter, a turn rate may not be higher. Getting a direction wrong here
// would open the door the whole design closes, so each one is declared rather
// than inferred.
// ---------------------------------------------------------------------------

/**
 * The fastest, tightest, steadiest a bot may ever be. Fitted from top-tier
 * demos at implementation time (8.3); these are placeholders that keep the
 * shape honest. `[calibrate against aimMetrics.js]`
 */
export const PRO_ENVELOPE = Object.freeze({
  reactionMedian: 0.18, // seconds, floor
  reactionSigma: 0.25, // log-sigma, floor
  flickSigmaScale: 0.55, // floor
  trackSigmaScale: 0.55, // floor
  maxTurnRate: 700, // deg/s, ceiling
  triggerConfidence: 0.95, // ceiling
  sprayDiscipline: 1, // ceiling
  hsBias: 0.55 // ceiling
});

/** The weakest end of the ladder. Nothing is clamped here; it is a floor. */
export const AMATEUR_FLOOR = Object.freeze({
  reactionMedian: 0.42,
  reactionSigma: 0.55,
  flickSigmaScale: 2.4,
  trackSigmaScale: 2.2,
  maxTurnRate: 320,
  triggerConfidence: 0.55,
  sprayDiscipline: 0.35,
  hsBias: 0.15
});

/** Which way each motor trait is bounded by the envelope. */
const CLAMP = Object.freeze({
  reactionMedian: 'min', // may not be faster
  reactionSigma: 'min', // may not be more consistent
  flickSigmaScale: 'min', // may not be more accurate
  trackSigmaScale: 'min',
  maxTurnRate: 'max', // may not turn faster
  triggerConfidence: 'max',
  sprayDiscipline: 'max',
  hsBias: 'max'
});

/** Named stops on the ladder, as a position in [0, 1] from floor to envelope. */
export const SKILL_STOPS = Object.freeze({
  mix: 0,
  t3: 0.2,
  average: 0.4,
  t2: 0.6,
  t1: 0.8,
  pro: 1
});

/**
 * Decision-side traits (6.16). None of these touch the motor, so none are
 * clamped, and all of them are safe to expose. Values are in [0, 1] where 1 is
 * the strong end.
 */
export const DECISION_TRAITS = Object.freeze([
  'decisionSpeed',
  'concentration',
  'anticipation',
  'decisions',
  'composure',
  'positioning',
  'offBall',
  'teamwork',
  'aggression',
  'consistency',
  'discipline'
]);

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Build a profile at a point on the ladder.
 *
 * @param {number|keyof SKILL_STOPS} level  0..1, or a named stop
 * @param {object} [overrides]  per-trait overrides, still clamped
 */
export function skillProfile(level = 'average', overrides = {}) {
  const t = typeof level === 'number' ? level : (SKILL_STOPS[level] ?? SKILL_STOPS.average);
  const k = Math.max(0, Math.min(1, t));

  const profile = {};
  for (const key of Object.keys(PRO_ENVELOPE)) {
    profile[key] = lerp(AMATEUR_FLOOR[key], PRO_ENVELOPE[key], k);
  }
  for (const key of DECISION_TRAITS) profile[key] = k;
  // Not on the ladder: a logit offset on the PFW a bot decides with (8.2),
  // zero at every level. Filled by the mimic fit (confidence.js) or a knob.
  profile.confidenceBias = 0;
  // 20.9: the trait is the BASELINE of riskQuantile; state moves it.
  profile.riskQuantile = 0.5;

  Object.assign(profile, overrides);
  return clampToEnvelope(profile);
}

/**
 * Force a profile inside the envelope.
 *
 * Called on every profile, including ones assembled from a mimicked player's
 * fitted numbers and ones typed into the UI. A caller asking for `S = 2` gets
 * the envelope, not superhuman mechanics, and no code path exists that skips
 * this: `skillProfile` is the only constructor and it always ends here.
 */
export function clampToEnvelope(profile) {
  const out = { ...profile };
  for (const [key, dir] of Object.entries(CLAMP)) {
    if (out[key] == null) continue;
    out[key] =
      dir === 'min' ? Math.max(PRO_ENVELOPE[key], out[key]) : Math.min(PRO_ENVELOPE[key], out[key]);
  }
  return out;
}

/** Does this profile sit inside the envelope? The gate in 8.3 asserts it. */
export function withinEnvelope(profile) {
  for (const [key, dir] of Object.entries(CLAMP)) {
    if (profile[key] == null) continue;
    if (dir === 'min' && profile[key] < PRO_ENVELOPE[key] - 1e-9) return false;
    if (dir === 'max' && profile[key] > PRO_ENVELOPE[key] + 1e-9) return false;
  }
  return true;
}

/**
 * Five profiles for a side: a team level with optional per-slot overrides.
 * The "star AWPer on a t2 team" and "stand-in on a pro team" cases are both
 * first-class here rather than special (8.4).
 */
export function teamProfiles(teamLevel = 'average', perSlot = {}) {
  return [0, 1, 2, 3, 4].map((slot) =>
    skillProfile(perSlot[slot] ?? teamLevel, perSlot[`${slot}:overrides`] || {})
  );
}
