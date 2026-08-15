// ---------------------------------------------------------------------------
// shared/sim/strategy.js
// The third brain (SIM-PLAN 18.4): lives between rounds.
//
// Outputs are priors and prices, never commands. Three components, in the
// order they are built:
//
//   1. Supervised value head: P(win | situation, call), tabular here, the
//      contextual-bandit form that is available immediately.
//   2. Adaptive selector: EXP3 over calls inside a match, seeded by the head.
//   3. Match-level RL last, and not in this file.
//
// The retrieved statistics (n, lower bound, recency, scope, attribution)
// are features the selector reads. Memory stays data; the skill of using it
// is what a later net would inherit.
// ---------------------------------------------------------------------------

import { Exp3Bandit, banditKey, mixPolicyExp3 } from './opponentModel.js';
import { reweightAvoid, applyAvoidPriors } from './avoidSet.js';

export class StrategyAI {
  constructor({ index, bandit = null, gen = 0 } = {}) {
    this.index = index;
    this.bandit = bandit || new Exp3Bandit();
    this.gen = gen;
    this.last = { key: null, call: null };
  }

  /**
   * P(win | situation, call) from the index: the supervised head.
   */
  value(key, call) {
    return this.index.read(key, call);
  }

  /**
   * Tilt a candidate list for the coming round. Never removes legality.
   *
   * @param {Array<object>} candidates
   * @param {object} args
   * @param {string} args.key   situation hash
   * @param {object} [args.policyPick]
   * @param {import('./rng.js').Rng} args.rng
   * @param {(c:object)=>string} [args.idOf]
   */
  select(candidates, { key, policyPick, rng, idOf, side = 'T', econ = 'full', score = 'even' } = {}) {
    if (!candidates?.length) return null;
    const ids = candidates.map((c) => (idOf ? idOf(c) : c.id || `${c.protocol} ${c.convert}`));
    const scored = candidates.map((c, i) => {
      const v = this.value(key, ids[i]);
      return { id: ids[i], score: v.lower, n: v.n, lower: v.lower };
    });
    const weighted = reweightAvoid(scored, { index: this.index, key, gen: this.gen });
    const thawed = candidates.map((c) => ({ ...c }));
    applyAvoidPriors(thawed, weighted);
    const bk = banditKey({ side, econ, score });
    const pick = mixPolicyExp3(thawed, {
      policyPick: policyPick ? thawed[Math.max(0, candidates.indexOf(policyPick))] : thawed[0],
      bandit: this.bandit,
      key: bk,
      rng,
      idOf: idOf || ((c) => c.id || `${c.protocol} ${c.convert}`)
    });
    const idx = Math.max(0, thawed.indexOf(pick));
    this.last = { key, call: ids[idx] ?? null, banditKey: bk };
    return candidates[idx];
  }

  /**
   * `attrib: 'perc'` is 18.6b's third bucket: the ranking was right and the
   * picture was wrong. The index already refuses to move a win counter for
   * it, and the bandit must refuse too — rewarding EXP3 for a round the call
   * did not lose teaches the selector to avoid a call that was fine. The
   * lesson for that round is the calibration bias, written separately.
   */
  observeRound({ won, attrib = 'call', scopes = ['session', 'career'] } = {}) {
    if (!this.last.key || !this.last.call) return;
    // `scopes` is passed in rather than fixed here because 18.8's ingest rule
    // is a property of WHO WAS PLAYED, which this class does not know. Fixed,
    // it would quietly route an exploiter's lessons into career while the
    // opening ledger beside it obeyed the quarantine.
    this.index.write({
      key: this.last.key,
      call: this.last.call,
      won,
      attrib,
      gen: this.gen,
      scopes
    });
    if (attrib === 'perc') return;
    this.bandit.reward(this.last.banditKey, this.last.call, won ? 1 : 0);
  }
}
