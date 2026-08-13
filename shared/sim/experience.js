// ---------------------------------------------------------------------------
// shared/sim/experience.js
// The experience index (SIM-PLAN 18.3): one record per situation key, three
// scopes, library prior as Beta pseudo-counts, Wilson/Beta lower bound.
//
// Scopes: session (this match), opponent (this model id), career (the lineage).
// Reading is a lower confidence bound, not a mean: a 2-and-0 does not outrank
// a 40-and-25. Writing is LRU by recency*count, sharded under
// AIM4_REPLAY_DIR/sim/experience/ when a disk io is supplied.
//
// No Date.now: recency is a monotone seq the caller ticks, so enabling memory
// cannot change a determinism hash that does not read the index.
// ---------------------------------------------------------------------------

export const EXPERIENCE_VERSION = 1;
export const PRIOR_CAP = 20;
export const WILSON_Z = 1.96; // 95% lower bound: 2-and-0 must not beat 40-and-25

export function wilsonLower(wins, n, z = WILSON_Z) {
  if (!(n > 0)) return 0;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - spread) / denom));
}

function emptyRecord(key) {
  return {
    key,
    n: 0,
    w: 0,
    sumDprw: 0,
    gen: 0,
    lastSeq: 0,
    byCall: {},
    attrib: { call: 0, exec: 0 }
  };
}

function touchCall(rec, call) {
  if (!rec.byCall[call]) rec.byCall[call] = { n: 0, w: 0, sumDprw: 0 };
  return rec.byCall[call];
}

/**
 * Three scopes, one prior. In-memory by default; `io` is `{ dir, read, write }`
 * for the shard.
 */
export class ExperienceIndex {
  constructor({ prior = null, maxRows = 4000, io = null } = {}) {
    this.prior = prior || new Map();
    this.maxRows = maxRows;
    this.io = io;
    this.seq = 0;
    this.session = new Map();
    this.opponent = new Map();
    this.career = new Map();
  }

  _bag(scope) {
    if (scope === 'session') return this.session;
    if (scope === 'opponent') return this.opponent;
    return this.career;
  }

  /**
   * Library prior as Beta pseudo-counts, capped so a well-populated prior
   * does not become unmovable.
   */
  seedPrior(key, { n, w } = {}) {
    const nn = Math.min(PRIOR_CAP, Math.max(0, n || 0));
    const ww = Math.min(nn, Math.max(0, w || 0));
    this.prior.set(key, { n: nn, w: ww });
  }

  write({ key, call, won, dprw = 0, attrib = null, gen = 0, scopes = ['session', 'career'] } = {}) {
    if (!key) return;
    this.seq += 1;
    const hash = typeof key === 'string' ? key : key.hash;
    for (const scope of scopes) {
      const bag = this._bag(scope);
      let rec = bag.get(hash);
      if (!rec) {
        rec = emptyRecord(hash);
        bag.set(hash, rec);
      }
      rec.n += 1;
      rec.w += won ? 1 : 0;
      rec.sumDprw += dprw;
      rec.gen = gen;
      rec.lastSeq = this.seq;
      if (call) {
        const c = touchCall(rec, call);
        c.n += 1;
        c.w += won ? 1 : 0;
        c.sumDprw += dprw;
      }
      if (attrib === 'call' || attrib === 'exec') rec.attrib[attrib] += 1;
    }
    this._lru(this.career);
  }

  toJSON() {
    return {
      v: EXPERIENCE_VERSION,
      seq: this.seq,
      scopes: ['session', 'opponent', 'career'],
      rows: [...this.career.values()]
    };
  }

  _lru(bag) {
    if (bag.size <= this.maxRows) return;
    const ranked = [...bag.values()].sort((a, b) => a.lastSeq * a.n - b.lastSeq * b.n);
    const drop = ranked.slice(0, bag.size - this.maxRows);
    for (const r of drop) bag.delete(r.key);
  }

  /**
   * Lower bound for P(win | key, call), mixing session > opponent > career
   * > library prior by specificity (n).
   */
  read(key, call = null) {
    const hash = typeof key === 'string' ? key : key.hash;
    const layers = [
      { name: 'session', rec: this.session.get(hash), weight: 4 },
      { name: 'opponent', rec: this.opponent.get(hash), weight: 2 },
      { name: 'career', rec: this.career.get(hash), weight: 1 }
    ];
    let n = 0;
    let w = 0;
    let attrib = { call: 0, exec: 0 };
    for (const layer of layers) {
      if (!layer.rec) continue;
      const src = call ? layer.rec.byCall[call] : layer.rec;
      if (!src || !src.n) continue;
      n += src.n * layer.weight;
      w += src.w * layer.weight;
      attrib.call += layer.rec.attrib.call;
      attrib.exec += layer.rec.attrib.exec;
    }
    const prior = this.prior.get(hash);
    if (prior) {
      n += prior.n;
      w += prior.w;
    }
    return {
      key: hash,
      call,
      n,
      w,
      lower: wilsonLower(w, n),
      mean: n ? w / n : prior && prior.n ? prior.w / prior.n : 0.5,
      attrib,
      prior: prior || null
    };
  }
}
