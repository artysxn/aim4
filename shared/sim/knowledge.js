// ---------------------------------------------------------------------------
// shared/sim/knowledge.js
// What a team believes, as a distribution over where the enemy actually is.
//
// This is the joint belief from SIM-PLAN 19.2, and the word joint is the whole
// design. The first four passes ran one particle filter per enemy slot, which
// is a product of marginals, and a product of marginals cannot represent the
// read a team actually makes:
//
//   it cannot say how many are on a site, because independent slots give the
//     wrong variance and put mass on layouts that never occur
//   it cannot say that clearing banana makes A thicker, because nothing
//     couples the slots
//   it cannot express doctrine, which is entirely about relationships: CTs do
//     not double up at the same depth, Ts move in cores, a 2-2-1 is a real
//     thing and a 5-0-0 is not
//
// So a particle here is a WHOLE-MAP LAYOUT, and the claim the design makes is
// falsifiable: a weak read is the product of the marginals, a strong read is
// the joint, and the attention budget is what moves a bot between them.
//
// Two rules that must not be broken:
//
//   Nothing in this file may read engine truth. It consumes percepts. The test
//   for that is that every update method takes an observation, never a body.
//
//   Negative information is a COMM, not a fact (SIM-PLAN 20.7). Clearing an
//   angle deletes mass from the clearing bot's own view immediately and from
//   the team blackboard only when he says so. If it were free, the most
//   valuable call in the game would be worth nothing.
// ---------------------------------------------------------------------------

import { TICK_RATE } from './constants.js';

/** Particles per team. 256 layouts is plenty for five discrete slots. */
export const PARTICLE_COUNT = 256;
/** Belief steps at 8 Hz, like decisions. */
export const UPDATE_EVERY_TICKS = 8;

/**
 * One hypothesis about where the whole enemy team is.
 * @typedef {object} Layout
 * @property {Array<{anchor: string, level: string, weapon: string}|null>} slots
 * @property {number} weight
 */

export class JointBelief {
  /**
   * @param {object} cfg
   * @param {string[]} cfg.anchors        anchor ids the enemy could be at
   * @param {import('./rng.js').Rng} cfg.rng
   * @param {number} [cfg.count]
   * @param {(anchor: string) => number} [cfg.prior]  flow prior weight
   * @param {string[]} [cfg.weapons]      believed loadout pool
   */
  constructor(cfg) {
    this.anchors = cfg.anchors;
    this.rng = cfg.rng;
    this.count = cfg.count || PARTICLE_COUNT;
    this.prior = cfg.prior || (() => 1);
    this.weapons = cfg.weapons || ['ak47'];

    /** Slots known to be dead. Bodies are conserved and the feed is public. */
    this.dead = new Set();
    /** @type {Layout[]} */
    this.particles = [];
    /**
     * Lazy mass-by-anchor index. massAt is asked hundreds of times per
     * decision tick (the space field alone asks twice per anchor), and a
     * full particle scan per question is what made the desire bot 18x
     * slower than the scripted one. One scan builds every answer at once;
     * any update throws the index away.
     */
    this._mass = null;
    this._massByWeapon = null;
    this.reset();
  }

  _invalidateMass() {
    this._mass = null;
    this._massByWeapon = null;
  }

  reset() {
    this._invalidateMass();
    this.particles = [];
    for (let i = 0; i < this.count; i += 1) {
      this.particles.push({
        slots: [0, 1, 2, 3, 4].map((s) => (this.dead.has(s) ? null : this.sampleSlot())),
        weight: 1 / this.count
      });
    }
  }

  sampleSlot() {
    // Prior-weighted draw, so an unseen enemy drifts toward where that side
    // actually stands rather than into a uniform cloud.
    let total = 0;
    for (const a of this.anchors) total += this.prior(a);
    let r = this.rng.next() * total;
    for (const a of this.anchors) {
      r -= this.prior(a);
      if (r <= 0) {
        return { anchor: a, level: 'default', weapon: this.rng.pick(this.weapons) };
      }
    }
    return { anchor: this.anchors[0], level: 'default', weapon: this.weapons[0] };
  }

  // ---- updates, all percept-driven -----------------------------------------

  /**
   * Propagate: unseen enemies drift along the flow prior.
   *
   * `neighbours(anchor)` supplies where a body at an anchor could plausibly be
   * a moment later. Without it particles never move and the belief becomes a
   * memory of the last contact rather than a projection.
   */
  propagate(neighbours, rate = 0.25) {
    this._invalidateMass();
    for (const p of this.particles) {
      for (let s = 0; s < 5; s += 1) {
        const cur = p.slots[s];
        if (!cur) continue;
        if (this.rng.next() > rate) continue;
        const near = neighbours(cur.anchor);
        if (!near?.length) continue;
        cur.anchor = this.rng.pick(near);
      }
    }
  }

  /** Positive contact: a slot was seen, so every layout agrees about it. */
  sighting(slot, anchor, { level = 'default', weapon = null } = {}) {
    this._invalidateMass();
    this.dead.delete(slot);
    for (const p of this.particles) {
      p.slots[slot] = {
        anchor,
        level,
        weapon: weapon || p.slots[slot]?.weapon || this.weapons[0]
      };
    }
  }

  /**
   * Negative information: this set of anchors was swept and was empty.
   *
   * Kills every LAYOUT that placed anybody there, which re-normalizes mass onto
   * the rest of the map. That is the part marginals cannot do: "banana is
   * empty" makes "four on A" more likely for all five slots at once, which is
   * how a human's read actually updates.
   */
  cleared(anchorSet) {
    this._invalidateMass();
    const empty = anchorSet instanceof Set ? anchorSet : new Set(anchorSet);
    let survivors = 0;
    for (const p of this.particles) {
      const bad = p.slots.some((sl) => sl && empty.has(sl.anchor));
      if (bad) p.weight = 0;
      else survivors += 1;
    }
    // If a sweep contradicts everything we believed, the belief was wrong
    // rather than the sweep. Rebuild rather than dividing by zero, and say so.
    if (survivors === 0) {
      this.reset();
      for (const p of this.particles) {
        for (const sl of p.slots) if (sl && empty.has(sl.anchor)) sl.anchor = this.sampleSlot().anchor;
      }
      return false;
    }
    this.normalize();
    return true;
  }

  /** A death removes a body. Bodies are conserved; the kill feed is public. */
  killed(slot) {
    this._invalidateMass();
    this.dead.add(slot);
    for (const p of this.particles) p.slots[slot] = null;
  }

  /**
   * A sound percept: reweight rather than collapse.
   *
   * A gunshot is narrow and a footstep is wide, which is why the percept
   * carries a band and a sector rather than a position (sound.js). `likelihood`
   * scores an anchor against the percept and the caller owns it, because how
   * well a sound localizes is a property of the map's geometry.
   */
  heard(likelihood) {
    this._invalidateMass();
    for (const p of this.particles) {
      let best = 0;
      for (const sl of p.slots) {
        if (!sl) continue;
        const l = likelihood(sl.anchor, sl.level);
        if (l > best) best = l;
      }
      // The best explanation, not the product: one footstep is evidence that
      // SOMEBODY is there, not that everybody is.
      p.weight *= 0.15 + 0.85 * best;
    }
    this.normalize();
  }

  /**
   * The corpse constraint (SIM-PLAN 19.9).
   *
   * A teammate died at a cell to a known weapon class, so the killer had line
   * of sight to that cell with that weapon at that tick. This is a hard
   * likelihood rather than a soft nudge, and it typically collapses the belief
   * onto a handful of spots, which is how a human knows where a killer is
   * without having seen him.
   */
  deathRecord({ canSeeFrom, weapon = null }) {
    this._invalidateMass();
    for (const p of this.particles) {
      let ok = false;
      for (const sl of p.slots) {
        if (!sl) continue;
        if (weapon && sl.weapon !== weapon) continue;
        if (canSeeFrom(sl.anchor, sl.level)) {
          ok = true;
          break;
        }
      }
      if (!ok) p.weight = 0;
    }
    if (!this.normalize()) this.reset();
  }

  /** Weapon evidence: the feed names the killer's gun, so that slot holds it. */
  sawWeapon(slot, weapon) {
    this._invalidateMass();
    for (const p of this.particles) if (p.slots[slot]) p.slots[slot].weapon = weapon;
  }

  normalize() {
    this._invalidateMass();
    let total = 0;
    for (const p of this.particles) total += p.weight;
    if (!(total > 0)) return false;
    for (const p of this.particles) p.weight /= total;
    return true;
  }

  /**
   * Effective sample size. When it collapses the filter has become a handful of
   * duplicated layouts and is confidently wrong, which is worse than being
   * wide, so the caller resamples.
   */
  ess() {
    let sum = 0;
    for (const p of this.particles) sum += p.weight * p.weight;
    return sum > 0 ? 1 / sum : 0;
  }

  /**
   * Resample with a move step. Plain resampling in five dimensions collapses to
   * a few identical layouts within seconds; the jitter is what keeps diversity
   * alive without inventing evidence.
   */
  resample(neighbours) {
    this._invalidateMass();
    const cdf = [];
    let acc = 0;
    for (const p of this.particles) {
      acc += p.weight;
      cdf.push(acc);
    }
    const next = [];
    const step = 1 / this.count;
    let u = this.rng.next() * step;
    let i = 0;
    for (let n = 0; n < this.count; n += 1) {
      while (i < cdf.length - 1 && cdf[i] < u) i += 1;
      const src = this.particles[i];
      const copy = {
        slots: src.slots.map((sl) => (sl ? { ...sl } : null)),
        weight: step
      };
      // Move step: nudge one slot, so copies diverge again.
      if (neighbours) {
        const s = this.rng.int(5);
        const sl = copy.slots[s];
        if (sl) {
          const near = neighbours(sl.anchor);
          if (near?.length && this.rng.next() < 0.5) sl.anchor = this.rng.pick(near);
        }
      }
      next.push(copy);
      u += step;
    }
    this.particles = next;
  }

  // ---- the reads a policy actually consumes --------------------------------

  /** Probability distribution over how many enemies are in a zone, 0..5. */
  countDist(inZone) {
    const dist = [0, 0, 0, 0, 0, 0];
    for (const p of this.particles) {
      let n = 0;
      for (const sl of p.slots) if (sl && inZone(sl.anchor, sl.level)) n += 1;
      dist[n] += p.weight;
    }
    return dist;
  }

  /** P(nobody there). The number a fast hit is bet on. */
  pEmpty(inZone) {
    return this.countDist(inZone)[0];
  }

  pAtMost(inZone, k) {
    const d = this.countDist(inZone);
    let sum = 0;
    for (let i = 0; i <= k; i += 1) sum += d[i];
    return sum;
  }

  /** Expected number of enemies in a zone. */
  expected(inZone) {
    const d = this.countDist(inZone);
    let sum = 0;
    for (let i = 0; i < d.length; i += 1) sum += i * d[i];
    return sum;
  }

  /**
   * Entropy over the zone-count vector: the "we do not know the split" scalar.
   * This is what decides commit versus gather (19.4), and it has no equivalent
   * in a marginal filter.
   */
  splitEntropy(zones) {
    const counts = new Map();
    for (const p of this.particles) {
      const sig = zones
        .map((z) => {
          let n = 0;
          for (const sl of p.slots) if (sl && z.test(sl.anchor, sl.level)) n += 1;
          return n;
        })
        .join('-');
      counts.set(sig, (counts.get(sig) || 0) + p.weight);
    }
    let h = 0;
    for (const w of counts.values()) if (w > 0) h -= w * Math.log2(w);
    return h;
  }

  /** The top whole-map layouts, which is what a caller says out loud. */
  layoutModes(zones, limit = 3) {
    const counts = new Map();
    for (const p of this.particles) {
      const sig = zones
        .map((z) => {
          let n = 0;
          for (const sl of p.slots) if (sl && z.test(sl.anchor, sl.level)) n += 1;
          return `${z.name}:${n}`;
        })
        .join(' ');
      counts.set(sig, (counts.get(sig) || 0) + p.weight);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([signature, mass]) => ({ signature, mass }));
  }

  /**
   * One pass over the particles answers every massAt question at once. A
   * particle contributes its weight once per key it occupies, matching the
   * scan's break-on-first-match: two slots on the same anchor still count
   * as one layout saying "somebody is there".
   */
  _buildMassIndex() {
    const mass = new Map();
    const seen = new Set();
    for (const p of this.particles) {
      seen.clear();
      for (const sl of p.slots) {
        if (!sl) continue;
        const key = `${sl.anchor}|${sl.level}`;
        if (!seen.has(key)) {
          seen.add(key);
          mass.set(key, (mass.get(key) || 0) + p.weight);
        }
      }
    }
    this._mass = mass;
  }

  /** The weapon-keyed index pays for itself only when somebody asks (19.3). */
  _buildWeaponMassIndex() {
    const byWeapon = new Map();
    const seen = new Set();
    for (const p of this.particles) {
      seen.clear();
      for (const sl of p.slots) {
        if (!sl) continue;
        const wkey = `${sl.anchor}|${sl.level}|${sl.weapon}`;
        if (!seen.has(wkey)) {
          seen.add(wkey);
          byWeapon.set(wkey, (byWeapon.get(wkey) || 0) + p.weight);
        }
      }
    }
    this._massByWeapon = byWeapon;
  }

  /** Belief mass that an enemy of a weapon class is at an anchor (19.3). */
  massAt(anchor, level = 'default', weaponClass = null) {
    if (weaponClass) {
      if (!this._massByWeapon) this._buildWeaponMassIndex();
      return this._massByWeapon.get(`${anchor}|${level}|${weaponClass}`) || 0;
    }
    if (!this._mass) this._buildMassIndex();
    return this._mass.get(`${anchor}|${level}`) || 0;
  }

  /** How many enemies are believed alive at all. */
  aliveCount() {
    return 5 - this.dead.size;
  }
}

/**
 * A bot's personal view of the team belief, degraded by attention.
 *
 * This is where the design's central claim becomes mechanical. A bot tracking
 * `k` slots keeps the joint structure over those and MARGINALIZES the rest, so
 * a low-attention bot's belief literally is the product of the marginals and a
 * high-attention one's is the joint. Skill is a budget, not a different model.
 */
export function personalView(belief, attendedSlots) {
  const attended = new Set(attendedSlots);
  const marginal = new Map();
  for (const p of belief.particles) {
    for (let s = 0; s < 5; s += 1) {
      if (attended.has(s)) continue;
      const sl = p.slots[s];
      if (!sl) continue;
      const key = `${s}|${sl.anchor}|${sl.level}`;
      marginal.set(key, (marginal.get(key) || 0) + p.weight);
    }
  }
  return {
    joint: belief,
    attended,
    /** Marginal mass for an unattended slot, with the couplings thrown away. */
    marginalAt(slot, anchor, level = 'default') {
      return marginal.get(`${slot}|${anchor}|${level}`) || 0;
    }
  };
}

/** Ticks between belief updates, exported so the engine can schedule it. */
export const UPDATE_INTERVAL = UPDATE_EVERY_TICKS;
export const SECONDS_PER_UPDATE = UPDATE_EVERY_TICKS / TICK_RATE;
