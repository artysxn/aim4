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

/**
 * Elo a pool opponent must clear before a match against it feeds CAREER (18.8).
 *
 * Relative to the pool's own anchor rather than absolute: this is the bar for
 * "strong enough that beating it is evidence", not a rating in a public table.
 */
export const ELO_FLOOR = Number(process.env.AIM4_EXPERIENCE_ELO_FLOOR || 0);

/**
 * Backoff ladder for retrieval (18.10's "small k-NN", as a prefix walk).
 *
 * The situation key is thirteen pipe-separated fields, most-general first:
 *
 *   v | map | side | phase | clock | men | econ | control | start | shape |
 *   read | util | roles
 *
 * Exact-match retrieval against all thirteen essentially never hits. Measured
 * on a real match: 2,999 reads, 11 of which found anything -- 0.37%. The key
 * space is combinatorial and the plan itself writes only 12 to 15 keys per
 * round, so no amount of grinding fills it. A memory that cannot be reached is
 * not a memory.
 *
 * So a miss walks back down the ladder. The levels are chosen where the
 * meaning survives the truncation:
 *
 *   9  through `shape`: the same fight, roughly the same formation
 *   7  through `econ`:  the same map, side, phase, clock, man count, economy
 *   6  through `men`:   the same map, side, phase, clock, man count
 *
 * Below six is (map, side, phase) and that is a platitude, not a situation.
 */
export const BACKOFF_LEVELS = Object.freeze([9, 7, 6]);

/**
 * How much a coarser hit counts against an exact one.
 *
 * A prefix match is real evidence about a broader class, so it is worth
 * something, and it is not worth as much: an exact key that has been seen four
 * times must outrank a six-field prefix seen four hundred. Applied to the
 * effective count, so it flows through the Wilson bound rather than around it.
 */
export const BACKOFF_WEIGHT = 0.35;

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

/**
 * The first `level` fields of a situation hash, or null when the key is
 * already shorter than that (an `open|...` bandit key, for instance, which is
 * not a situation and must never be aggregated as one).
 */
function prefixOf(hash, level) {
  let cut = -1;
  let seen = 0;
  for (let i = 0; i < hash.length; i += 1) {
    if (hash.charCodeAt(i) === 124) {
      seen += 1;
      if (seen === level) {
        cut = i;
        break;
      }
    }
  }
  return cut < 0 ? null : hash.slice(0, cut);
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
    /**
     * 18.8's guard, as its own bag: what was learned playing an EXPLOITER.
     *
     * An exploiter is built to be degenerate -- it finds one hole and rides
     * it -- so what beats it is not evidence about Counter-Strike. Kept
     * rather than dropped because it is exactly the right read to have when
     * the same exploiter comes back, and never mixed into career, which is
     * what the next generation inherits.
     */
    this.quarantine = new Map();
    /**
     * Prefix aggregates, `level:prefix` -> record, per scope bag.
     *
     * Maintained at WRITE time rather than scanned at read time. Scanning
     * would be O(rows) per lookup, and 18.10 budgets retrieval at "immaterial
     * next to the engine"; a career of a million rows scanned 3,000 times a
     * match is the opposite of that.
     */
    this.prefixes = { session: new Map(), opponent: new Map(), career: new Map(), quarantine: new Map() };
    // situation hash -> { n, sum } of PRW residuals (18.6b.1).
    this.cal = new Map();
    /**
     * 18.10's rule, enforced rather than trusted: the index is READ-ONLY for
     * the duration of a round and commits at round end. A write that lands
     * mid-round makes "same seed re-runs bit-identical" false immediately,
     * and the failure is invisible -- the run simply stops reproducing. So
     * the round latch throws instead.
     */
    this.inRound = false;
  }

  _bag(scope) {
    if (scope === 'session') return this.session;
    if (scope === 'opponent') return this.opponent;
    if (scope === 'quarantine') return this.quarantine;
    return this.career;
  }

  /** A round began: writes are refused until it ends (18.10). */
  beginRound() {
    this.inRound = true;
    return this;
  }

  /** The round is over; commits may land. */
  endRound() {
    this.inRound = false;
    return this;
  }

  _assertCommitTime(what) {
    if (this.inRound) {
      throw new Error(
        `experience: ${what} during a round. 18.10 requires commits at round end, ` +
          'outside the tick loop, or the same seed stops reproducing.'
      );
    }
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
   * Which scopes a match's results may be written to (18.8).
   *
   * The failure this exists to prevent: memory filled from self-play against
   * weak opponents teaches the team that bad calls work. The index would
   * faithfully record that a naive B rush wins 70% of the time, because
   * against our own generation-3 anchors it does, and the next generation
   * would inherit that as fact.
   *
   * So career -- the only scope a generation inherits -- ingests a match only
   * when the opponent was strong enough to be evidence. Everything else still
   * lands somewhere: session for the match being played, quarantine for
   * exploiters, so nothing is lost, only kept out of the inheritance.
   *
   * @param {object} args
   * @param {string} [args.opponentRole]  'main' | 'main-exploiter' | 'league-exploiter'
   * @param {number} [args.opponentElo]   null when unrated
   * @param {number} [args.eloFloor]
   * @returns {{scopes: string[], reason: string}}
   */
  static scopesFor({ opponentRole = 'main', opponentElo = null, eloFloor = ELO_FLOOR } = {}) {
    if (opponentRole && opponentRole !== 'main') {
      return { scopes: ['session', 'quarantine'], reason: `opponent is an ${opponentRole}` };
    }
    if (Number.isFinite(opponentElo) && opponentElo < eloFloor) {
      return {
        scopes: ['session'],
        reason: `opponent ${opponentElo.toFixed(0)} Elo is under the ${eloFloor} floor`
      };
    }
    // An unrated opponent is not assumed strong. The first matches of a pool
    // have no ratings at all, and letting those seed career is the same bug
    // the floor exists to stop, arriving through the gap.
    if (!Number.isFinite(opponentElo)) {
      return { scopes: ['session'], reason: 'opponent has no rating yet' };
    }
    return { scopes: ['session', 'career'], reason: `opponent ${opponentElo.toFixed(0)} Elo clears the floor` };
  }

  /**
   * A stable fingerprint of what this index holds.
   *
   * 12.3 puts it in the match config and the replay record so a reproduction
   * can prove it loaded the same memory the original had. Order-independent by
   * construction: a sum of per-row hashes, because two indexes holding the
   * same rows are the same memory whatever order they were written in.
   */
  hash() {
    let acc = 0;
    const mix = (str) => {
      let h = 2166136261;
      for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    };
    for (const rec of this.career.values()) {
      acc = (acc + mix(`${rec.key}:${rec.n}:${rec.w}`)) >>> 0;
    }
    for (const [key, c] of this.cal) {
      acc = (acc + mix(`${key}:${c.n}:${Math.round(c.sum * 1e6)}`)) >>> 0;
    }
    return `${EXPERIENCE_VERSION}-${this.career.size}-${acc.toString(16)}`;
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
    this._assertCommitTime('write');
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
      // The same evidence, rolled up the backoff ladder, so a read that finds
      // no exact key still has something to say about the class it is in.
      const pre = this.prefixes[scope];
      if (pre) {
        for (const level of BACKOFF_LEVELS) {
          const p = prefixOf(hash, level);
          if (!p) continue;
          const pkey = `${level}:${p}`;
          let prec = pre.get(pkey);
          if (!prec) {
            prec = emptyRecord(pkey);
            pre.set(pkey, prec);
          }
          prec.lastSeq = this.seq;
          prec.n += 1;
          prec.w += won ? 1 : 0;
          if (call) {
            const c = touchCall(prec, call);
            c.n += 1;
            c.w += won ? 1 : 0;
          }
        }
      }
    }
    this._lru(this.career);
    if (this.prefixes.career) this._lru(this.prefixes.career);
  }

  /**
   * 18.6b.1: `calibrations[key] = mean residual`. Deliberately NOT split by
   * scope like the win records are: how this lineage reads a kind of picture
   * is a property of the lineage, not of the current match or the current
   * opponent, so there is one table and it survives both.
   */
  writeCalibration({ key, residual } = {}) {
    if (!key || !Number.isFinite(residual)) return;
    this._assertCommitTime('writeCalibration');
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
    // The backoff ladder is derived, not stored: rebuilt here so a loaded
    // index retrieves exactly like the one that wrote it. Without this an
    // inherited memory answers only on exact keys and the whole ladder is
    // silently dead in every process that reads from disk, which is all of
    // them except the one that did the grinding.
    index.rebuildPrefixes();
    return index;
  }

  /**
   * Recompute every prefix aggregate from the scope bags.
   *
   * Cheap: one pass per row per ladder level, and it happens on load rather
   * than per read.
   */
  rebuildPrefixes() {
    for (const scope of ['session', 'opponent', 'career', 'quarantine']) {
      const bag = this._bag(scope);
      const pre = new Map();
      for (const rec of bag.values()) {
        for (const level of BACKOFF_LEVELS) {
          const p = prefixOf(rec.key, level);
          if (!p) continue;
          const pkey = `${level}:${p}`;
          let prec = pre.get(pkey);
          if (!prec) {
            prec = emptyRecord(pkey);
            pre.set(pkey, prec);
          }
          prec.n += rec.n;
          prec.w += rec.w;
          prec.lastSeq = Math.max(prec.lastSeq, rec.lastSeq || 0);
          for (const [call, c] of Object.entries(rec.byCall || {})) {
            const t = touchCall(prec, call);
            t.n += c.n;
            t.w += c.w;
          }
        }
      }
      this.prefixes[scope] = pre;
    }
    return this;
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
    // The backoff walk (18.10). Only when the exact key found nothing: a
    // situation the team has actually been in outranks the class it belongs
    // to, always, and mixing the two would let a broad prior drown a specific
    // memory the moment the specific one existed.
    let backoff = null;
    if (!n) {
      for (const level of BACKOFF_LEVELS) {
        const p = prefixOf(hash, level);
        if (!p) continue;
        const pkey = `${level}:${p}`;
        let pn = 0;
        let pw = 0;
        for (const layer of layers) {
          const rec = this.prefixes[layer.name]?.get(pkey);
          if (!rec) continue;
          const src = call ? rec.byCall[call] : rec;
          if (!src || !src.n) continue;
          pn += src.n * layer.weight;
          pw += src.w * layer.weight;
        }
        if (pn) {
          // Discounted into the effective count, so the Wilson bound does the
          // rest: coarse evidence widens its own interval instead of needing a
          // second confidence rule bolted on beside it.
          n = pn * BACKOFF_WEIGHT;
          w = pw * BACKOFF_WEIGHT;
          backoff = { level, prefix: p, rawN: pn };
          break;
        }
      }
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
      prior: prior || null,
      // Which rung answered, so the Memory tab can show "this is a read on the
      // class, not on this exact situation" rather than implying otherwise.
      backoff
    };
  }
}
