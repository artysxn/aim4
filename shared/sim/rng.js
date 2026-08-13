// ---------------------------------------------------------------------------
// shared/sim/rng.js
// The one source of randomness in the simulation.
//
// Every stochastic draw in the engine, the aim motor, the belief filter, and
// the policy sampler comes from here, seeded, so that a seed plus an intent
// stream reproduces a round bit for bit. That is not a convenience: it is the
// determinism gate (SIM-PLAN 9.8.5), it is what makes an eval fair, and it is
// what makes a bug reproducible instead of a story about something that
// happened once.
//
// mulberry32: 32 bits of state, four operations, passes gjrand and PractRand's
// smaller batteries, and is trivially serializable, which matters because a
// savestate (11.5) has to carry the generator with it or branching from it
// diverges immediately.
//
// Math.random is banned everywhere under shared/sim. A single call to it would
// make the determinism test fail intermittently, which is the worst way for a
// test to fail.
// ---------------------------------------------------------------------------

export class Rng {
  /** @param {number} seed  any 32-bit integer */
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /** Uniform in [lo, hi). */
  range(lo, hi) {
    return lo + this.next() * (hi - lo);
  }

  /** A uniform element, or undefined for an empty list. */
  pick(list) {
    return list.length ? list[this.int(list.length)] : undefined;
  }

  /**
   * Fisher-Yates, in place. Deterministic given the seed, which is why spawn
   * permutation and league pairing can both use it and still be reproducible.
   */
  shuffle(list) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  /**
   * Standard normal, Box-Muller. The aim motor's flick and tracking error are
   * normal by construction (8.1), so this is on the hot path and deliberately
   * does not cache the second variate: caching it makes the number of draws
   * depend on call parity, and that makes a savestate's generator position
   * depend on how the caller happened to be interleaved.
   */
  normal(mean = 0, sd = 1) {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Log-normal by median and a p90, which is how 5.7 and 8.1 state their latencies. */
  logNormalFromP90(median, p90) {
    // p90 / median = exp(1.2816 * sigma)
    const sigma = Math.log(p90 / median) / 1.2815515655446004;
    return median * Math.exp(sigma * this.normal());
  }

  /** A child generator, so a subsystem can draw without moving the parent. */
  fork() {
    return new Rng((this.next() * 4294967296) >>> 0);
  }

  /** Savestate support (11.5): the generator is one number. */
  save() {
    return this.state;
  }

  restore(state) {
    this.state = state >>> 0;
    return this;
  }
}

/** FNV-1a over a string, for state hashing and for seeding from a name. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
