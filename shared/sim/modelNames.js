// ---------------------------------------------------------------------------
// shared/sim/modelNames.js
// What the brains are called.
//
// `bc0`, `gen1`, `demo-g0` described how a file was produced — which stopped
// being useful the moment there was more than one way to produce one, and was
// actively misleading by the end: `gen1` was an RL smoke test that never saw
// data, and `demo-g0` was 91 million samples on a GPU. Two names that looked
// like a progression, in the wrong order.
//
// So names now describe WHICH BRAIN, and the number describes how far along
// that brain is. There are two brains (6.2, 6.3):
//
//   INDIVIDUAL — the bot: what one player does at 8 Hz.
//   HIVEMIND   — the caller: what the team does at freeze and at each recall.
//
// They share ONE tier vocabulary, ascending: navaja, paracord, bayonet, talon,
// butterfly, karambit. A tier is a statement about how good and how evolved a
// brain is, and the pair that plays together should be at the same level — so
// Paracord Lite's caller and Paracord Lite's bots carry the same name because
// they ARE the same generation of the same project, trained on the same
// corpus, meant to be run together.
//
// They are still two separate weight files with two separate trainers, so the
// hivemind carries an `igl-` prefix on its id and "(IGL)" in its display. The
// bot keeps the bare name, because it is the one every existing file, match
// record, and job default already refers to.
//
//   paracord-lite-1        Paracord Lite 1          the five bots
//   igl-paracord-lite-1    Paracord Lite 1 (IGL)    the caller they answer to
//
// A NEW TIER NAME is a big change: a different architecture, a different
// dataset, a different training regime. A NEW NUMBER is a real but smaller
// change to the same brain (Paracord 1 -> Paracord 2). A MINOR is a touch-up
// that leaves the brain recognizably itself (Paracord 1 -> Paracord 1.2).
//
// Variants hang off a tier rather than consuming one. `lite` is the reduced
// run — fewer maps, smaller budget — and it is deliberately NOT a lower tier,
// because Paracord Lite and Paracord 1 are the same brain trained twice, not
// two brains.
//
// Ids are filename-safe and lowercase, because they are filenames:
//
//   navaja-1            Navaja 1
//   paracord-lite-1     Paracord Lite 1
//   paracord-1-2        Paracord 1.2
//   alpha-1             Alpha 1
//
// The minor is dropped from the id when it is zero, so the common case is the
// short spelling and `paracord-1` and `paracord-1-0` are the same model.
// ---------------------------------------------------------------------------

/** Which brain a model drives. */
export const LINEAGE = Object.freeze({
  INDIVIDUAL: 'individual',
  HIVEMIND: 'hivemind'
});

/**
 * The tier vocabulary, ascending, shared by both brains. Position in this
 * array IS the tier order, so entries are appended and never reordered: a
 * model file on disk outlives any opinion about where its tier belongs.
 */
export const KNIFE_TIERS = Object.freeze([
  'navaja',
  'paracord',
  'bayonet',
  'talon',
  'butterfly',
  'karambit'
]);

/** The id prefix that marks a caller rather than a bot. */
export const HIVEMIND_PREFIX = 'igl';

/**
 * The test harness's name. A Nomad wanders OUTSIDE the tier ladder — the
 * clue is in the name — so it parses, displays and sorts (first, below
 * Navaja) but is never a generation, never has a successor, and never
 * competes for a rung. It replaced the standalone `desire` brain: the bare
 * arbiter, driven by a knobs file, for testing one aspect at a time.
 */
export const TEST_TIER = 'nomad';

/**
 * Variants of a tier, not tiers of their own.
 *
 * `lite` is the reduced run: one map, a smaller sample budget, a shorter
 * schedule. It exists so a laptop can produce a real, comparable model
 * instead of a toy — and so that comparing it against the full run is
 * comparing two trainings of one brain rather than two brains.
 */
export const VARIANTS = Object.freeze(['lite']);

/** Tier order. One vocabulary, so one index; the Nomad sorts below it all. */
function tierIndexOf(tier) {
  return tier === TEST_TIER ? -1 : KNIFE_TIERS.indexOf(tier);
}

/**
 * Names the registry still answers to, pointing at what they became.
 *
 * Kept rather than deleted because these strings are baked into shipped match
 * records, scorecard frozen references, and job defaults. A rename that
 * orphans the `match.json` records under `sim/matches` would make old results
 * unattributable, which is the one thing 9.9 asks the registry to prevent.
 */
export const LEGACY_ALIASES = Object.freeze({
  // Distilled from the SCRIPTED desire bot on Inferno (teacher `desire-p3d`,
  // 40 seeds x 6 rounds, val 62.1%). It learned to imitate the script, which
  // is why it only ever really held or searched.
  bc0: 'navaja-1',
  // An RL smoke test: teacher `ppo`, dataset `rl-smoke.jsonl`, no recorded
  // val accuracy. It proved the RL path could write a file the loader
  // accepts. It never trained on anything.
  gen1: 'navaja-2',
  // The first real one: 91.6 M samples, 8 epochs on cuda, 897 k parameters,
  // six heads, trained from actual demos rather than from us.
  'demo-g0': 'navaja-3'
});

/**
 * Parse a model id into its parts.
 *
 * @param {string} id
 * @returns {null|{
 *   id: string, lineage: string, tier: string, tierIndex: number,
 *   variant: string|null, major: number, minor: number, display: string
 * }}
 */
export function parseModelId(id) {
  const raw = String(id || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;

  const parts = raw.split('-');

  // The caller wears a prefix; the bot does not. Asymmetric on purpose: every
  // existing file, match record, and job default names a bot, and prefixing
  // those too would have been a second rename for no gain.
  let lineage = LINEAGE.INDIVIDUAL;
  if (parts[0] === HIVEMIND_PREFIX) {
    parts.shift();
    lineage = LINEAGE.HIVEMIND;
  }

  const tier = parts.shift();
  if (!KNIFE_TIERS.includes(tier) && tier !== TEST_TIER) return null;

  let variant = null;
  if (parts.length && VARIANTS.includes(parts[0])) variant = parts.shift();

  // A tier with no number is that tier's first model, not an error: `navaja`
  // and `navaja-1` name the same thing, and only one of them is what somebody
  // types.
  const major = parts.length ? Number(parts.shift()) : 1;
  const minor = parts.length ? Number(parts.shift()) : 0;
  if (parts.length) return null; // trailing junk is a different name, not this one
  if (!Number.isInteger(major) || major < 1) return null;
  if (!Number.isInteger(minor) || minor < 0) return null;

  return {
    id: formatModelId({ tier, variant, major, minor, lineage }),
    lineage,
    tier,
    tierIndex: tierIndexOf(tier),
    variant,
    major,
    minor,
    display: displayName({ tier, variant, major, minor, lineage })
  };
}

/**
 * Build the canonical id. Minor zero is omitted, so `paracord-1` rather than
 * `paracord-1-0`.
 *
 * @param {{tier: string, variant?: string|null, major?: number, minor?: number}} parts
 * @returns {string}
 */
export function formatModelId({
  tier,
  variant = null,
  major = 1,
  minor = 0,
  lineage = LINEAGE.INDIVIDUAL
}) {
  const bits = [];
  if (lineage === LINEAGE.HIVEMIND) bits.push(HIVEMIND_PREFIX);
  bits.push(String(tier).toLowerCase());
  if (variant) bits.push(String(variant).toLowerCase());
  bits.push(String(major));
  if (minor) bits.push(String(minor));
  return bits.join('-');
}

/**
 * The human spelling: "Paracord Lite 1.2".
 *
 * @param {{tier: string, variant?: string|null, major?: number, minor?: number}} parts
 * @returns {string}
 */
export function displayName({
  tier,
  variant = null,
  major = 1,
  minor = 0,
  lineage = LINEAGE.INDIVIDUAL
}) {
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  const head = variant ? `${cap(tier)} ${cap(variant)}` : cap(tier);
  const version = minor ? `${major}.${minor}` : major;
  // The pair reads as one generation with two halves, which is the point: the
  // caller and the bots it calls for carry the same name.
  return lineage === LINEAGE.HIVEMIND
    ? `${head} ${version} (IGL)`
    : `${head} ${version}`;
}

/**
 * Resolve any name the system might be handed — a current id, a legacy id, or
 * a bare tier — to the canonical id. Unknown names come back untouched, so a
 * caller can still load a one-off file that predates all of this.
 *
 * @param {string} name
 * @returns {string}
 */
export function resolveModelName(name) {
  const raw = String(name || '').trim();
  const alias = LEGACY_ALIASES[raw] || LEGACY_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  const parsed = parseModelId(raw);
  return parsed ? parsed.id : raw;
}

/**
 * Sort order for a registry listing: lineage, then tier, then version, then
 * the full run ahead of its lite variant.
 *
 * Anything unparseable sorts last, alphabetically, rather than being dropped:
 * a file nobody can name is exactly the file somebody needs to find.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareModelNames(a, b) {
  const pa = parseModelId(a);
  const pb = parseModelId(b);
  if (!pa && !pb) return String(a).localeCompare(String(b));
  if (!pa) return 1;
  if (!pb) return -1;
  // Tier first, so a generation's two halves sit together: Paracord Lite 1
  // and Paracord Lite 1 (IGL) are one row apart, which is how they are run.
  if (pa.tierIndex !== pb.tierIndex) return pa.tierIndex - pb.tierIndex;
  // Variant outranks version, so a listing reads as "every Paracord, then
  // every Paracord Lite" rather than interleaving two different trainings by
  // their version numbers, which are not comparable across variants anyway.
  if (Boolean(pa.variant) !== Boolean(pb.variant)) return pa.variant ? 1 : -1;
  if (pa.variant !== pb.variant) {
    return String(pa.variant || '').localeCompare(String(pb.variant || ''));
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  // Bots before the caller within one generation, arbitrarily but stably.
  if (pa.lineage !== pb.lineage) return pa.lineage === LINEAGE.INDIVIDUAL ? -1 : 1;
  return 0;
}

/**
 * The next name up, for a trainer that has just improved on something.
 *
 * @param {string} id
 * @param {'tier'|'major'|'minor'} step
 * @returns {string|null} null when a tier step runs off the end of a lineage
 */
export function nextModelName(id, step = 'major') {
  const p = parseModelId(id);
  if (!p) return null;
  if (step === 'minor') {
    return formatModelId({ ...p, minor: p.minor + 1 });
  }
  if (step === 'major') {
    return formatModelId({ ...p, major: p.major + 1, minor: 0 });
  }
  // A Nomad has no next tier: the harness wanders beside the ladder, it does
  // not climb it. (tierIndex -1 would otherwise "ascend" into Navaja.)
  if (p.tier === TEST_TIER) return null;
  const next = KNIFE_TIERS[p.tierIndex + 1];
  if (!next) return null;
  return formatModelId({
    tier: next,
    variant: p.variant,
    major: 1,
    minor: 0,
    lineage: p.lineage
  });
}
