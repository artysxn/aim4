// ---------------------------------------------------------------------------
// shared/sim/threat.js
// Threat is typed: where the AWP is, and where it is not.
//
// SIM-PLAN 19.3. Knowing that someone is on B is a fraction of the read.
// Knowing that the AWP is on B — and therefore that the two mid angles are
// rifle angles held at rifle depth — is the read. The joint particle already
// carries a weapon per slot (19.2), so the quantity everything else prices
// through is:
//
//   threat(spot, class) = Σ_particles w · 1[ some living slot of that class
//                                            has LOS to spot ]
//
// Three decisions in here are load-bearing, and each one is a bug avoided:
//
// ONE PASS, NOT A SCAN PER QUERY. This runs per bot per decision tick at 8 Hz
// over 256 particles, and the naive version — ask the belief for mass at every
// exposing anchor of every candidate spot — is a particle scan inside two
// loops. So `buildClassIndex` does what knowledge.js's `_buildMassIndex` does:
// one pass over particles builds every answer at once. It is the same
// argument that made the desire bot 18x slower before that index existed.
// A field is a TEAM object: build it once per belief per tick and hand it to
// every bot, not once per bot.
//
// A BITMAP PER (ANCHOR, CLASS), NOT A MASS PER (ANCHOR, CLASS). The plan asks
// for a bitmap test against the catalogue's cached exposure set, and the
// reason is correctness before speed. The formula is a per-PARTICLE indicator:
// a layout that puts two AWPs on two different anchors that both see the spot
// is one hypothesis, and it must contribute its weight once. Summing per-anchor
// mass (what `AngleCatalogue.threatAt` does, and it is honest about being a
// probability-like total rather than exact) double counts that layout. Here
// each (anchor, level, class) owns a Uint32Array over particle indices, a spot
// ORs the masks of the anchors that expose it, and the answer is a weighted
// popcount. Exact, and cheaper: eight words of OR per anchor instead of a scan.
//
// CLASS, NOT WEAPON ID. `JointBelief.massAt(anchor, level, weaponClass)` is
// keyed by the particle's weapon NAME despite the parameter's name, so asking
// it for 'sniper' silently returns zero. That is a trap rather than a bug —
// `massAt(a, l, 'awp')` is right and useful — but 19.3 reasons in classes, so
// this module maps weapon id to class through observe.js's `weaponClassOf`,
// the one canonical taxonomy, and never invents a second one.
//
// THE NEGATIVE READ IS THE VALUABLE ONE. A rifle can be anywhere; an AWP is
// only worth playing in a handful of spots per map. So the AWP marginal starts
// small and collapses fast, and `sniperMass` + `concentration` are the pair
// that makes "the AWP was not in the spots I swept, so it is concentrated in
// the rest" a number rather than a feeling. `concentration` conditions on the
// sweep EXACTLY — it deletes the particles a sweep contradicts, which is what
// `JointBelief.cleared` does — but it never touches the belief. It answers the
// hypothetical ("if I clear these three, what do I know?"), which is a
// question a bot must be able to ask before it commits to the sweep. Applying
// the update is the caller's job, through the belief's own methods.
//
// Nothing in here mutates a belief, calls Date.now, or draws from Math.random.
// The likelihood helper returns a FUNCTION; the caller passes it to
// `JointBelief.heard`. That is the same rule knowledge.js states about who owns
// a likelihood, for the same reason: how well a sound localizes is a property
// of the map, and this module does not know the map.
// ---------------------------------------------------------------------------

import { WEAPON_CLASSES, weaponClassOf } from './observe.js';
import { weaponInfo } from '../../src/replays/shared/weaponTable.js';
import { CLASS_CONFUSION, RANGE_BAND, shotReport } from './sound.js';

/**
 * Candidate spots priced per bot per step.
 *
 * This is the machine budget from 6.7, not a geometry constant. Foresight
 * prices a bot's top options through `predictDuel` and `expectedCtOverDuels`
 * every decision tick, the option set is what fits in that budget, and the
 * threat field is an input to that pricing rather than a survey of the map.
 * Widening it costs the same currency everything else is bought with, so the
 * cap is a parameter and the default is the plan's ~8.
 */
export const DEFAULT_SPOT_CAP = 8;

/** The class 19.3 is about. The one whose negative read is sharp. */
export const SNIPER_CLASS = 'sniper';

/**
 * How much a gunshot that does not match a hypothesis' weapon may punish it.
 * Never zero: the ear is wrong sometimes, and a hard zero deletes a hypothesis
 * that a later sighting cannot bring back. `[calibrate]`
 */
export const EAR_FLOOR = 0.05;

const CLASS_CACHE = new Map();

/** Weapon id to WEAPON_CLASSES member, memoized. The taxonomy is observe.js's. */
export function classOfWeapon(weapon) {
  if (!weapon) return 'other';
  let hit = CLASS_CACHE.get(weapon);
  if (hit === undefined) {
    hit = weaponClassOf(weaponInfo(weapon).category);
    CLASS_CACHE.set(weapon, hit);
  }
  return hit;
}

// ---- bitmaps over particles -------------------------------------------------

function orInto(dst, src) {
  for (let i = 0; i < dst.length; i += 1) dst[i] |= src[i];
}

function andNotInto(dst, src) {
  for (let i = 0; i < dst.length; i += 1) dst[i] &= ~src[i];
}

/** Σ of the weights of the particles whose bits are set. */
function maskMass(mask, weights) {
  let total = 0;
  for (let w = 0; w < mask.length; w += 1) {
    let bits = mask[w];
    while (bits) {
      // Lowest set bit, cleared each turn: the loop costs one iteration per
      // live particle rather than 32 per word.
      const lsb = bits & -bits;
      total += weights[(w << 5) + (31 - Math.clz32(lsb))];
      bits ^= lsb;
    }
  }
  return total;
}

/**
 * One pass over the particles, every typed question answered at once.
 *
 * @param {import('./knowledge.js').JointBelief} belief
 * @param {object} [opts]
 * @param {(weapon: string) => string} [opts.classOf]
 * @returns {object} the index consumed by everything below
 */
export function buildClassIndex(belief, { classOf = classOfWeapon } = {}) {
  const particles = belief.particles;
  const count = particles.length;
  const words = Math.max(1, (count + 31) >> 5);
  const weights = new Float64Array(count);

  /** class -> `anchor|level` -> Uint32Array of particle bits. */
  const byClass = new Map();
  /** `anchor|level` -> bits of layouts placing ANYBODY there, any class. */
  const anyByKey = new Map();
  /** `anchor|level` -> {anchor, level}, so nothing has to parse a key back. */
  const meta = new Map();
  /** class -> bits of layouts holding that class ALIVE anywhere. */
  const aliveByClass = new Map();

  const take = (map, key, w, bit) => {
    let mask = map.get(key);
    if (!mask) {
      mask = new Uint32Array(words);
      map.set(key, mask);
    }
    mask[w] |= bit;
    return mask;
  };

  for (let i = 0; i < count; i += 1) {
    const p = particles[i];
    weights[i] = p.weight;
    const w = i >> 5;
    const bit = 1 << (i & 31);
    for (const sl of p.slots) {
      if (!sl) continue;
      const cls = classOf(sl.weapon);
      const key = `${sl.anchor}|${sl.level}`;
      if (!meta.has(key)) meta.set(key, { anchor: sl.anchor, level: sl.level });

      let per = byClass.get(cls);
      if (!per) {
        per = new Map();
        byClass.set(cls, per);
      }
      // OR is idempotent, so two slots of one class on one anchor set the same
      // bit twice and the layout still counts once. That IS the plan's
      // indicator, for free.
      take(per, key, w, bit);
      take(anyByKey, key, w, bit);

      let alive = aliveByClass.get(cls);
      if (!alive) {
        alive = new Uint32Array(words);
        aliveByClass.set(cls, alive);
      }
      alive[w] |= bit;
    }
  }

  return {
    count,
    words,
    weights,
    /** Classes actually present in the belief, in first-seen order. */
    classes: [...byClass.keys()],
    meta,
    keysFor(cls) {
      return byClass.get(cls) || null;
    },
    maskAt(anchor, level, cls) {
      return byClass.get(cls)?.get(`${anchor}|${level}`) || null;
    },
    anyAt(anchor, level) {
      return anyByKey.get(`${anchor}|${level}`) || null;
    },
    /** Every key that names this anchor, at any level. */
    keysAtAnchor(anchor) {
      const out = [];
      for (const [key, m] of meta) if (m.anchor === anchor) out.push(key);
      return out;
    },
    anyByKey,
    aliveMask(cls) {
      return aliveByClass.get(cls) || null;
    },
    /** P(a living enemy of this class exists at all). The field's ceiling. */
    aliveMass(cls) {
      const mask = aliveByClass.get(cls);
      return mask ? maskMass(mask, weights) : 0;
    },
    mass(mask) {
      return mask ? maskMass(mask, weights) : 0;
    },
    blank() {
      return new Uint32Array(words);
    },
    /** All particles set, for conditioning. Trailing bits stay clear. */
    all() {
      const mask = new Uint32Array(words);
      for (let i = 0; i < count; i += 1) mask[i >> 5] |= 1 << (i & 31);
      return mask;
    }
  };
}

// ---- the field --------------------------------------------------------------

/**
 * Typed threat over a bot's candidate spots.
 *
 * A spot is `{x, y}` in world units, optionally with `level` and a label. When
 * it carries a `level`, exposing angles on other levels are dropped; when it
 * does not, the catalogue's own 2D exposure answer stands, which is what
 * `AngleCatalogue.exposedTo` gives and what the bake supports.
 *
 * @param {object} args
 * @param {import('./knowledge.js').JointBelief} [args.belief]  or pass `index`
 * @param {object} [args.index]      from buildClassIndex, shared across bots
 * @param {{exposedTo: Function}} args.catalogue   AngleCatalogue
 * @param {Array<{x:number, y:number, level?:string, anchor?:string}>} args.spots
 * @param {string[]} [args.classes]  default: every class the belief holds
 * @param {number} [args.cap]        6.7's machine budget, default 8
 * @returns {object} field
 */
export function threatField({
  belief = null,
  index = null,
  catalogue,
  spots,
  classes = null,
  cap = DEFAULT_SPOT_CAP,
  classOf = classOfWeapon
}) {
  const idx = index || buildClassIndex(belief, { classOf });
  const chosen = classes?.length ? classes : idx.classes;
  const used = cap > 0 ? spots.slice(0, cap) : spots.slice();

  // One accumulator per class, reused across spots: a decision tick allocates
  // these once, not once per candidate.
  const acc = new Map();
  for (const cls of chosen) acc.set(cls, idx.blank());
  const anyAcc = idx.blank();

  const rows = [];
  for (let s = 0; s < used.length; s += 1) {
    const spot = used[s];
    for (const mask of acc.values()) mask.fill(0);
    anyAcc.fill(0);

    const exposing = catalogue.exposedTo(spot.x, spot.y) || [];
    const seen = new Set();
    let anchors = 0;
    for (const e of exposing) {
      if (spot.level && e.level && e.level !== spot.level) continue;
      const key = `${e.anchor}|${e.level}`;
      // The catalogue enumerates an anchor once per yaw. A body standing there
      // sees the spot from at least one of them, so the anchor is worth one
      // visit, not four.
      if (seen.has(key)) continue;
      seen.add(key);
      anchors += 1;
      const any = idx.anyByKey.get(key);
      if (!any) continue;
      orInto(anyAcc, any);
      for (const cls of chosen) {
        const mask = idx.maskAt(e.anchor, e.level, cls);
        if (mask) orInto(acc.get(cls), mask);
      }
    }

    const byClass = {};
    for (const cls of chosen) byClass[cls] = idx.mass(acc.get(cls));
    rows.push({
      index: s,
      spot,
      anchor: spot.anchor ?? null,
      /** The plan's angleCount: how many catalogued angles overlook this spot. */
      anchors,
      byClass,
      /** Any tracked class, counted per layout rather than per anchor. */
      total: idx.mass(anyAcc)
    });
  }

  const bySpot = new Map();
  for (const row of rows) bySpot.set(row.spot, row);

  // Closures rather than methods: `const { at } = field` is exactly how a
  // pricing loop reads this, and a `this` in here would silently return zero.
  const rowOf = (spot) =>
    (typeof spot === 'number' ? rows[spot] : bySpot.get(spot)) || null;
  const valueAt = (spot, cls) => {
    const row = rowOf(spot);
    if (!row) return 0;
    return cls ? row.byClass[cls] ?? 0 : row.total;
  };

  return {
    classes: chosen,
    cap,
    spots: used,
    rows,
    index: idx,
    /** How much of the field is even possible: P(this class is alive). */
    aliveMass: (cls) => idx.aliveMass(cls),
    /** Row lookup by array index or by the spot object that was passed in. */
    row: rowOf,
    at: valueAt,
    /** Worst spot first, for a chooser that wants to reject rather than rank. */
    ranked: (cls = null) =>
      rows
        .map((r) => ({ row: r, value: cls ? r.byClass[cls] ?? 0 : r.total }))
        .sort((a, b) => b.value - a.value)
  };
}

/**
 * The AWP channel of the field. A spot with high `awpThreat` and a large
 * coverDist is a grave; the same spot against rifle-only threat is fine, and
 * that difference is the whole of 19.3's angle-choice claim.
 */
export function awpThreat(field, spot) {
  return field.at(spot, SNIPER_CLASS);
}

// ---- the negative read ------------------------------------------------------

/**
 * Where the sniper is believed to be, ranked, plus the mass that he exists.
 *
 * `catalogue.depthAt` orders the shortlist by longest sightline, which is the
 * cheap half of "where is an AWP worth playing" (6.8). The other half — which
 * of those a real AWPer on this map actually uses (library), and which ones
 * THIS one uses (mimicry, 10.3) — belongs to the prior that shaped the
 * particles, not here.
 *
 * @returns {{cls:string, total:number, ranked:Array, byAnchor:Map<string,number>}}
 */
export function sniperMass(
  belief,
  catalogue = null,
  { cls = SNIPER_CLASS, index = null, classOf = classOfWeapon, limit = 0 } = {}
) {
  const idx = index || buildClassIndex(belief, { classOf });
  const keys = idx.keysFor(cls);
  const total = idx.aliveMass(cls);

  const merged = new Map();
  if (keys) {
    for (const [key, mask] of keys) {
      const { anchor } = idx.meta.get(key);
      let acc = merged.get(anchor);
      if (!acc) {
        acc = idx.blank();
        merged.set(anchor, acc);
      }
      // Union across levels, so an anchor that exists on two floors is still
      // one place and one hypothesis.
      orInto(acc, mask);
    }
  }

  const byAnchor = new Map();
  const ranked = [];
  for (const [anchor, mask] of merged) {
    const mass = idx.mass(mask);
    byAnchor.set(anchor, mass);
    ranked.push({
      anchor,
      mass,
      share: total > 0 ? mass / total : 0,
      depth: catalogue?.depthAt ? catalogue.depthAt(anchor) : 0
    });
  }
  ranked.sort((a, b) => b.mass - a.mass);

  return {
    cls,
    total,
    byAnchor,
    ranked: limit > 0 ? ranked.slice(0, limit) : ranked,
    index: idx
  };
}

function entropyBits(values) {
  let sum = 0;
  for (const v of values) sum += v;
  if (!(sum > 0)) return 0;
  let h = 0;
  for (const v of values) {
    if (v <= 0) continue;
    const p = v / sum;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * The valuable one: what clearing a set of spots would do to the AWP read.
 *
 * "A bot that has swept mid knows the AWP is on B without having seen
 * anything." This computes that, without a raycast and without touching the
 * belief. The sweep is applied as `JointBelief.cleared` applies it — every
 * layout that placed a body in the swept set is deleted — so the answer is the
 * exact conditional over the surviving layouts rather than a rescaled
 * marginal, and `gain` says how much sharper the read got.
 *
 * `sweepClass` narrows what the sweep rules out. Null means the honest thing:
 * you looked and NOBODY was there. Passing a class means the weaker claim you
 * get from a sighting ("that was a rifler, so it is not the AWP").
 *
 * @param {object} args
 * @param {object} [args.index] from buildClassIndex; or pass `belief`
 * @param {string[]|Set<string>} args.cleared  anchor ids swept empty
 * @returns {object} before/after distributions, and what the sweep bought
 */
export function concentration({
  belief = null,
  index = null,
  cls = SNIPER_CLASS,
  cleared = [],
  sweepClass = null,
  catalogue = null,
  limit = 6,
  classOf = classOfWeapon
}) {
  const idx = index || buildClassIndex(belief, { classOf });
  const clearedSet = cleared instanceof Set ? cleared : new Set(cleared);

  const before = sniperMass(null, catalogue, { cls, index: idx, classOf });

  // Everything the sweep is inconsistent with, as one mask.
  const dead = idx.blank();
  for (const anchor of clearedSet) {
    for (const key of idx.keysAtAnchor(anchor)) {
      const { level } = idx.meta.get(key);
      const mask = sweepClass ? idx.maskAt(anchor, level, sweepClass) : idx.anyByKey.get(key);
      if (mask) orInto(dead, mask);
    }
  }
  const survive = idx.all();
  andNotInto(survive, dead);
  const surviving = idx.mass(survive);

  // A sweep that contradicts every layout means the belief was wrong rather
  // than the sweep — knowledge.js says so and rebuilds. A read cannot rebuild
  // anything, so it reports that it has nothing to say.
  if (!(surviving > 0)) {
    return {
      cls,
      contradicted: true,
      total: before.total,
      surviving: 0,
      after: [],
      before: before.ranked.slice(0, limit),
      top: null,
      gain: 1,
      bits: 0
    };
  }

  const scratch = idx.blank();
  const after = [];
  const keys = idx.keysFor(cls);
  const perAnchor = new Map();
  if (keys) {
    for (const [key, mask] of keys) {
      const { anchor } = idx.meta.get(key);
      if (clearedSet.has(anchor) && !sweepClass) continue;
      let acc = perAnchor.get(anchor);
      if (!acc) {
        acc = idx.blank();
        perAnchor.set(anchor, acc);
      }
      orInto(acc, mask);
    }
  }
  for (const [anchor, acc] of perAnchor) {
    scratch.set(acc);
    for (let i = 0; i < scratch.length; i += 1) scratch[i] &= survive[i];
    const mass = idx.mass(scratch);
    if (mass <= 0) continue;
    after.push({
      anchor,
      mass: mass / surviving,
      share: 0,
      depth: catalogue?.depthAt ? catalogue.depthAt(anchor) : 0
    });
  }

  // P(the class is alive somewhere | the sweep came back empty). The sweep can
  // RAISE this: ruling out empty ground concentrates the same body elsewhere.
  scratch.fill(0);
  const aliveMask = idx.aliveMask(cls);
  if (aliveMask) {
    scratch.set(aliveMask);
    for (let i = 0; i < scratch.length; i += 1) scratch[i] &= survive[i];
  }
  const total = idx.mass(scratch) / surviving;
  for (const row of after) row.share = total > 0 ? row.mass / total : 0;
  after.sort((a, b) => b.mass - a.mass);

  const top = after[0] || null;
  const wasShare = top ? before.byAnchor.get(top.anchor) ?? 0 : 0;
  const priorShare = before.total > 0 ? wasShare / before.total : 0;

  return {
    cls,
    contradicted: false,
    /** P(class alive) before and after the hypothetical sweep. */
    totalBefore: before.total,
    total,
    surviving,
    before: before.ranked.slice(0, limit),
    after: limit > 0 ? after.slice(0, limit) : after,
    top,
    /** How much sharper the leading hypothesis got. Six spots to three ~= 2. */
    gain: priorShare > 0 && top ? top.share / priorShare : top ? Infinity : 1,
    /** Bits of read the sweep buys, over the anchor distribution. */
    bits:
      entropyBits(before.ranked.map((r) => r.mass)) - entropyBits(after.map((r) => r.mass))
  };
}

// ---- the ear, as a belief reweight -----------------------------------------

/**
 * How well a heard shot matches a hypothesis holding `weapon`, in [0, 1].
 *
 * The percept carries a CLAIM (sound.js): a WEAPON_CLASSES member always, and
 * a weapon id when a player would name the gun. This inverts the same
 * confusion matrix that produced it — P(claim | weapon), scaled so the
 * best-explaining weapon in the pool scores 1 — which is what makes the AWP
 * read sharp in both directions. Hearing an AWP is nearly proof; hearing an AK
 * is nearly proof that it was NOT the AWP, and the second is the one that
 * moves a bot onto an angle it would otherwise never take.
 */
export function shotEvidence(percept, weapon, { weapons = null, floor = EAR_FLOOR } = {}) {
  const label = percept?.weaponHeard || percept?.weaponClass || null;
  if (!label || !weapon) return 1;
  const band = percept.band || RANGE_BAND.MID;

  const mine = shotReport(weapon, band)[label] || 0;

  // The scale is the BEST explanation of the claim, so the return value is a
  // relative likelihood in [0, 1] and `heard`'s own blend behaves. Given the
  // believed loadout pool that is exact; without one, fall back to the claim
  // explaining itself, which is what makes "I heard an AK" still say "not the
  // AWP" for a caller that never passed a pool.
  let best = mine;
  if (weapons?.length) {
    for (const w of weapons) {
      const p = shotReport(w, band)[label] || 0;
      if (p > best) best = p;
    }
  } else if (WEAPON_CLASSES.includes(label)) {
    best = Math.max(best, CLASS_CONFUSION[label]?.[label] ?? 0);
  } else {
    best = Math.max(best, shotReport(label, band)[label] || 0);
  }
  if (!(best > 0)) return 1;
  return floor + (1 - floor) * Math.min(1, mine / best);
}

/**
 * A gunshot percept as a likelihood, ready for `JointBelief.heard`.
 *
 * Returned rather than applied. threat.js does not own the belief and does not
 * own the map: `geometry(anchor, level)` is the caller's sector-and-band score
 * (desireBot.js already builds exactly that), and this multiplies the weapon
 * claim into it.
 *
 * ARITY, deliberately: `heard` calls `likelihood(anchor, level)` today, so the
 * third argument arrives undefined and the function degrades to pure geometry
 * — correct, just weaker, and never a crash. When the filter starts passing
 * the slot's weapon it sharpens for free with no change here. That seam is why
 * `shotEvidence` is exported separately: a caller that wants the weapon term
 * now can build its own reweight from it without this module reaching into
 * anybody's particles.
 *
 * @param {object} args
 * @param {object} args.percept   a gunshot percept from sound.js
 * @param {(anchor:string, level:string) => number} [args.geometry]  0..1
 * @param {string[]} [args.weapons]  the believed loadout pool (belief.weapons)
 * @returns {(anchor:string, level:string, weapon?:string) => number}
 */
export function gunshotLikelihood({
  percept,
  geometry = null,
  weapons = null,
  floor = EAR_FLOOR
} = {}) {
  const cache = new Map();
  const evidence = (weapon) => {
    let hit = cache.get(weapon);
    if (hit === undefined) {
      hit = shotEvidence(percept, weapon, { weapons, floor });
      cache.set(weapon, hit);
    }
    return hit;
  };

  return (anchor, level = 'default', weapon = undefined) => {
    let g = 1;
    if (geometry) {
      g = geometry(anchor, level);
      if (!(g > 0)) return 0;
      if (g > 1) g = 1;
    }
    if (weapon === undefined || weapon === null) return g;
    return g * evidence(weapon);
  };
}
