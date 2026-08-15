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

export const EXPERIENCE_VERSION = 2;
export const PRIOR_CAP = 20;
export const WILSON_Z = 1.96; // 95% lower bound: 2-and-0 must not beat 40-and-25

/** Calibration is a memory too (18.6b.1), so it is gated, shrunk and capped. */
export const CAL_MIN_N = 4;
export const CAL_SHRINK = 8;
export const CAL_CAP = 0.15;

export function wilsonLower(wins, n, z = WILSON_Z) {
  if (!(n > 0)) return 0;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Math.min(1, (centre - spread) / denom));
}

/**
 * The bias a mean residual is allowed to become. A handful of rows is not a
 * lesson, so the mean is shrunk toward zero by count and capped: the same
 * shape as every other memory read here, for the same reason.
 */
export function calibrationBias({ n = 0, sum = 0 } = {}, { minN = CAL_MIN_N, shrink = CAL_SHRINK, cap = CAL_CAP } = {}) {
  if (!(n >= minN)) return 0;
  const shrunk = (sum / n) * (n / (n + shrink));
  return Math.max(-cap, Math.min(cap, shrunk));
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
    // `perc` is 18.6b's third bucket. It is counted beside call and exec and
    // deliberately does NOT feed the win counters below.
    attrib: { call: 0, exec: 0, perc: 0 }
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
    // situation hash -> { n, sum } of PRW residuals (18.6b.1).
    this.cal = new Map();
  }

  _bag(scope) {
    if (scope === 'session') return this.session;
    if (scope === 'opponent') return this.opponent;
    return this.career;
  }

  /**
   * A match ended; the next one starts fresh but not ignorant (18.8).
   *
   * The scopes already draw this line and this method is what makes it
   * usable across matches: SESSION is what is true about the match being
   * played — this opponent, tonight, on this economy — and it must not leak
   * into the next one, or a read built against one series is quoted at
   * another. CAREER and the calibration table are what was LEARNED, and
   * throwing those away between matches is how a trainee arrives at every
   * match as new as the first.
   *
   * The opponent scope survives on purpose: it is keyed by who is on the
   * other side, and in a drill ladder that is deliberately the same team all
   * the way through.
   */
  endSession() {
    this.session = new Map();
    return this;
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

  /**
   * One round's result against one situation.
   *
   * `attrib: 'perc'` is the exception and the whole point of 18.6b.2: the
   * believed ranking of options was right and only the price was wrong, so the
   * hivemind is told about it as CALIBRATION and is not punished for the call.
   * The bucket is counted; no win counter moves, at any scope, for any call.
   */
  write({ key, call, won, dprw = 0, attrib = null, gen = 0, scopes = ['session', 'career'] } = {}) {
    if (!key) return;
    this.seq += 1;
    const hash = typeof key === 'string' ? key : key.hash;
    const perceptual = attrib === 'perc';
    for (const scope of scopes) {
      const bag = this._bag(scope);
      let rec = bag.get(hash);
      if (!rec) {
        rec = emptyRecord(hash);
        bag.set(hash, rec);
      }
      rec.gen = gen;
      rec.lastSeq = this.seq;
      if (attrib === 'call' || attrib === 'exec' || perceptual) {
        rec.attrib[attrib] = (rec.attrib[attrib] || 0) + 1;
      }
      if (perceptual) continue;
      rec.n += 1;
      rec.w += won ? 1 : 0;
      rec.sumDprw += dprw;
      if (call) {
        const c = touchCall(rec, call);
        c.n += 1;
        c.w += won ? 1 : 0;
        c.sumDprw += dprw;
      }
    }
    this._lru(this.career);
  }

  /**
   * 18.6b.1: `calibrations[key] = mean residual`. Deliberately NOT split by
   * scope like the win records are: how this lineage reads a kind of picture
   * is a property of the lineage, not of the current match or the current
   * opponent, so there is one table and it survives both.
   */
  writeCalibration({ key, residual } = {}) {
    if (!key || !Number.isFinite(residual)) return;
    const hash = typeof key === 'string' ? key : key.hash;
    const cur = this.cal.get(hash) || { n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += residual;
    this.cal.set(hash, cur);
    if (this.cal.size > this.maxRows) {
      // Same LRU shape as the records: the least-seen keys go first.
      const ranked = [...this.cal.entries()].sort((a, b) => a[1].n - b[1].n);
      for (const [k] of ranked.slice(0, this.cal.size - this.maxRows)) this.cal.delete(k);
    }
  }

  /**
   * The gated bias to add to `pictureWinrate` for this situation. Zero until
   * the key has been seen enough times to be a lesson rather than a fluke.
   */
  calibrationFor(key) {
    if (!key) return 0;
    const hash = typeof key === 'string' ? key : key.hash;
    return calibrationBias(this.cal.get(hash));
  }

  /** Raw entry, for the inspector and the scorecard. */
  calibrationRow(key) {
    const hash = typeof key === 'string' ? key : key.hash;
    const cur = this.cal.get(hash);
    if (!cur) return null;
    return { key: hash, n: cur.n, mean: cur.sum / cur.n, bias: calibrationBias(cur) };
  }

  toJSON() {
    return {
      v: EXPERIENCE_VERSION,
      seq: this.seq,
      scopes: ['session', 'opponent', 'career'],
      rows: [...this.career.values()],
      calibrations: [...this.cal.entries()].map(([key, c]) => ({
        key,
        n: c.n,
        // `mean` is for a human reading the file. `sum` is what reloads:
        // calibrationBias needs the raw total, and rebuilding it from a
        // rounded mean loses the arithmetic the bias is made of.
        sum: c.sum,
        mean: c.sum / c.n,
        bias: calibrationBias(c)
      }))
    };
  }

  /**
   * Read an index back (18.8: experience inherits).
   *
   * CAREER and the calibration table only, which is the same line `endSession`
   * draws: what was learned survives, what was true about one series does not.
   * A file written by an older build is refused rather than half-read, because
   * a row shape that has drifted would still add up and would be quietly wrong.
   */
  static fromJSON(json, opts = {}) {
    const index = new ExperienceIndex(opts);
    if (!json) return index;
    if (json.v !== EXPERIENCE_VERSION) {
      throw new Error(`experience: v${json.v}, this build speaks v${EXPERIENCE_VERSION}`);
    }
    for (const row of json.rows || []) {
      if (!row?.key) continue;
      index.career.set(row.key, {
        ...emptyRecord(row.key),
        ...row,
        byCall: { ...(row.byCall || {}) },
        attrib: { call: 0, exec: 0, perc: 0, ...(row.attrib || {}) }
      });
    }
    for (const c of json.calibrations || []) {
      if (!c?.key || !c.n) continue;
      // Tolerate a file that predates `sum` by reconstructing it from the mean.
      const sum = Number.isFinite(c.sum) ? c.sum : (c.mean || 0) * c.n;
      index.cal.set(c.key, { n: c.n, sum });
    }
    index.seq = Number(json.seq) || 0;
    return index;
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
    let attrib = { call: 0, exec: 0, perc: 0 };
    for (const layer of layers) {
      if (!layer.rec) continue;
      // Buckets first: a situation whose only history is perceptual has no
      // win counters at all, and its `perc` count is still worth reading.
      attrib.call += layer.rec.attrib.call || 0;
      attrib.exec += layer.rec.attrib.exec || 0;
      attrib.perc += layer.rec.attrib.perc || 0;
      const src = call ? layer.rec.byCall[call] : layer.rec;
      if (!src || !src.n) continue;
      n += src.n * layer.weight;
      w += src.w * layer.weight;
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
      cal: this.calibrationFor(hash),
      prior: prior || null
    };
  }
}
