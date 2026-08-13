// ---------------------------------------------------------------------------
// shared/sim/opponentModel.js
// Tendency tracker plus EXP3 over calls (SIM-PLAN 6.10).
//
// Round 24 has to play differently from round 1. Two layers, both built from
// OUR knowledge stream, never from engine truth:
//
//   A decayed frequency model of the shapes we actually saw: site, first
//   contact clock, lurk, utility, buy, save. Runs from round 1 at low
//   confidence.
//
//   EXP3 over the legal call vocabulary, keyed by (side, economy bucket,
//   score situation), as multiplicative weights on the Playstyle logits.
//   Adversarial because the opponent adapts. About thirty lines, no training
//   run, and the inspector can print "b-rush weight fell after two losses".
//
// The antistrat scan (aggTells / aggCtSpread / aggResponses) overwrites the
// tracker when its shipped thresholds fire (>= 5 rounds, >= 80% share). The
// scan is structured and slow; the tracker is crude and immediate. Neither
// replaces the other. Evidence counts travel with both so a 2-round hunch
// does not outrank a 6-round tell.
//
// Pure given an injected rng. No Date.now, no Math.random.
// ---------------------------------------------------------------------------

import { libraryLabel } from './layers.js';

/** Same numbers as antistratScan.js. Copied, not imported: that module is huge. */
export const TELL_MIN_ROUNDS = 5;
export const TELL_MIN_SHARE = 80;

export const EXP3_GAMMA = 0.15;
export const TENDENCY_DECAY = 0.85;

const ECON = Object.freeze(['eco', 'force', 'half', 'full']);

export function econBucket(value) {
  const v = Number(value) || 0;
  if (v < 2000) return 'eco';
  if (v < 3500) return 'force';
  if (v < 4500) return 'half';
  return 'full';
}

/**
 * Score situation as a coarse key: leading / even / trailing, plus pistol.
 * @param {{us:number, them:number, pistol?:boolean}} s
 */
export function scoreSituation({ us = 0, them = 0, pistol = false } = {}) {
  const d = (Number(us) || 0) - (Number(them) || 0);
  const gap = d > 2 ? 'up' : d < -2 ? 'down' : 'even';
  return pistol ? `pistol-${gap}` : gap;
}

export function banditKey({ side = 'T', econ = 'full', score = 'even' } = {}) {
  return `${side}|${econ}|${score}`;
}

function shareIsTell(share) {
  const s = Number(share) || 0;
  return s >= TELL_MIN_SHARE || s >= TELL_MIN_SHARE / 100;
}

/**
 * Decayed counts over observed round shapes. Observe ONLY what this side
 * saw: a believed site, a contact clock, a lurk we noticed.
 */
export class TendencyTracker {
  constructor({ decay = TENDENCY_DECAY } = {}) {
    this.decay = decay;
    this.n = 0;
    this.sites = { a: 0, b: 0, other: 0 };
    this.firstContact = { early: 0, mid: 0, late: 0 };
    this.lurk = { yes: 0, no: 0 };
    this.util = { heavy: 0, light: 0, none: 0 };
    this.buy = { eco: 0, force: 0, half: 0, full: 0 };
    this.save = { yes: 0, no: 0 };
    /** Scan overwrites, with the evidence that justified them. */
    this.scan = { tells: [], evidence: 0 };
  }

  observe({
    site = null,
    firstContactSeconds = null,
    lurkSeen = false,
    utilSignature = 'none',
    buy = 'full',
    saved = false
  } = {}) {
    this.n += 1;
    const decay = (bag) => {
      for (const k of Object.keys(bag)) bag[k] *= this.decay;
    };
    decay(this.sites);
    decay(this.firstContact);
    decay(this.lurk);
    decay(this.util);
    decay(this.buy);
    decay(this.save);

    const s = String(site || '').toLowerCase();
    if (s === 'a' || s.startsWith('a')) this.sites.a += 1;
    else if (s === 'b' || s.startsWith('b')) this.sites.b += 1;
    else this.sites.other += 1;

    const t = Number(firstContactSeconds);
    if (Number.isFinite(t)) {
      if (t < 25) this.firstContact.early += 1;
      else if (t < 70) this.firstContact.mid += 1;
      else this.firstContact.late += 1;
    }

    this.lurk[lurkSeen ? 'yes' : 'no'] += 1;
    const u = String(utilSignature || 'none');
    this.util[this.util[u] != null ? u : 'none'] += 1;
    const b = ECON.includes(buy) ? buy : econBucket(buy);
    this.buy[b] += 1;
    this.save[saved ? 'yes' : 'no'] += 1;
  }

  /**
   * Scan detections overwrite the matching tracker cells when they clear the
   * shipped thresholds. The tracker keeps running underneath for everything
   * the scan has not named yet.
   */
  applyScan(scan = null) {
    if (!scan) return;
    const tells = [];
    const sides = scan.sides || scan.tells?.sides || {};
    for (const side of Object.keys(sides)) {
      const bag = sides[side];
      for (const t of bag.tells || []) {
        if ((t.rounds || 0) < TELL_MIN_ROUNDS) continue;
        if (!shareIsTell(t.share)) continue;
        tells.push({ ...t, side, evidence: t.rounds });
      }
    }
    this.scan = { tells, evidence: tells.reduce((s, t) => s + (t.evidence || 0), 0) };
    for (const t of tells) {
      const label = String(t.label || t.name || '').toLowerCase();
      if (/(^|[-_ ])b\b/.test(label) || label.includes('banana')) {
        this.sites.b = Math.max(this.sites.b, t.rounds || TELL_MIN_ROUNDS);
      }
      if (/(^|[-_ ])a\b/.test(label) && !label.includes('banana')) {
        this.sites.a = Math.max(this.sites.a, t.rounds || TELL_MIN_ROUNDS);
      }
    }
  }

  summary() {
    const siteTotal = this.sites.a + this.sites.b + this.sites.other || 1;
    return {
      n: this.n,
      pSite: {
        a: this.sites.a / siteTotal,
        b: this.sites.b / siteTotal
      },
      firstContact: { ...this.firstContact },
      lurkRate: this.lurk.yes / (this.lurk.yes + this.lurk.no || 1),
      buy: { ...this.buy },
      saveRate: this.save.yes / (this.save.yes + this.save.no || 1),
      scanTells: this.scan.tells.length,
      scanEvidence: this.scan.evidence,
      evidence: this.n
    };
  }
}

/**
 * EXP3 over a named action set. Weights persist across rounds; the legal
 * set can change (a pistol has a shorter vocabulary) and missing arms keep
 * their weight.
 */
export class Exp3Bandit {
  constructor({ gamma = EXP3_GAMMA } = {}) {
    this.gamma = gamma;
    /** key -> { id: weight } */
    this.tables = new Map();
  }

  _table(key) {
    if (!this.tables.has(key)) this.tables.set(key, new Map());
    return this.tables.get(key);
  }

  probabilities(key, ids) {
    const list = (ids || []).filter(Boolean);
    const k = list.length;
    if (!k) return [];
    const table = this._table(key);
    for (const id of list) if (!table.has(id)) table.set(id, 1);
    let sum = 0;
    for (const id of list) sum += table.get(id);
    const g = this.gamma;
    return list.map((id) => (1 - g) * (table.get(id) / sum) + g / k);
  }

  /**
   * Sample an id. `rng` is required so a seeded match reproduces.
   * @param {import('./rng.js').Rng} rng
   */
  sample(key, ids, rng) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return null;
    const p = this.probabilities(key, list);
    let r = rng.next();
    for (let i = 0; i < list.length; i += 1) {
      r -= p[i];
      if (r <= 0) return { id: list[i], p: p[i], index: i };
    }
    return { id: list[list.length - 1], p: p[p.length - 1], index: list.length - 1 };
  }

  /**
   * Reward in [0, 1] for the arm that was played.
   */
  reward(key, id, r) {
    if (!id) return;
    const table = this._table(key);
    if (!table.has(id)) table.set(id, 1);
    const ids = [...table.keys()];
    const p = this.probabilities(key, ids);
    const i = ids.indexOf(id);
    const pi = Math.max(1e-9, p[i] ?? 1 / ids.length);
    const g = this.gamma;
    const k = ids.length;
    const est = Math.max(0, Math.min(1, r)) / pi;
    table.set(id, table.get(id) * Math.exp((g * est) / k));
  }

  weight(key, id) {
    return this._table(key).get(id) ?? 1;
  }
}

/**
 * Turn a heuristic pick into a peaked distribution, multiply by EXP3
 * probabilities, sample. The policy stays the prior; the bandit is the
 * adaptation. Returns the chosen candidate.
 *
 * @param {Array<object>} candidates
 * @param {object} args
 * @param {object} args.policyPick
 * @param {Exp3Bandit} args.bandit
 * @param {string} args.key
 * @param {import('./rng.js').Rng} args.rng
 * @param {(c: object) => string} [args.idOf]
 */
export function mixPolicyExp3(
  candidates,
  { policyPick, bandit, key, rng, idOf = libraryLabel } = {}
) {
  if (!candidates?.length) return null;
  const ids = candidates.map((c) => idOf(c));
  const exp3 = bandit.probabilities(key, ids);
  const policyIdx = Math.max(
    0,
    candidates.findIndex((c) => c === policyPick)
  );
  // Heuristic as a peaked distribution: 0.6 on the policy pick, rest split.
  const rest = (1 - 0.6) / Math.max(1, candidates.length - 1);
  const mixed = exp3.map((p, i) => p * (i === policyIdx ? 0.6 : rest || 0.6));
  let sum = mixed.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return policyPick || candidates[0];
  let r = rng.next() * sum;
  for (let i = 0; i < mixed.length; i += 1) {
    r -= mixed[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/**
 * 24-round bandit exam against a fixed exploitable habit: they always go B.
 * Stacking B wins; stacking A loses. Second-half win rate must beat first
 * half, and B's weight must rise.
 *
 * This is the P5b acceptance, as a seeded simulation of the bandit rather
 * than a full engine match, because the property being certified is the
 * bandit, not the translator.
 */
export function playExploitableMatch(rng, { rounds = 24, calls = ['a-default', 'b-rush'] } = {}) {
  const bandit = new Exp3Bandit();
  const tracker = new TendencyTracker();
  const key = banditKey({ side: 'CT', econ: 'full', score: 'even' });
  const wins = [];
  const picks = [];
  for (let i = 0; i < rounds; i += 1) {
    const drawn = bandit.sample(key, calls, rng);
    const pick = drawn.id;
    picks.push(pick);
    // Opponent always hits B. A CT that stacks B wins; otherwise it loses.
    // Deterministic so a 24-round exam is a property, not a coin-flip.
    const won = pick === 'b-rush';
    wins.push(won ? 1 : 0);
    bandit.reward(key, pick, won ? 1 : 0);
    tracker.observe({ site: 'b', firstContactSeconds: 20, lurkSeen: false, buy: 'full' });
  }
  const half = Math.floor(rounds / 2);
  const wr = (a, b) => {
    let s = 0;
    for (let i = a; i < b; i += 1) s += wins[i];
    return s / (b - a);
  };
  return {
    tracker,
    bandit,
    key,
    picks,
    wins,
    firstHalf: wr(0, half),
    secondHalf: wr(half, rounds),
    weightA: bandit.weight(key, 'a-default'),
    weightB: bandit.weight(key, 'b-rush')
  };
}
