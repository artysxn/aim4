// ---------------------------------------------------------------------------
// shared/sim/avoidSet.js
// Avoidance without cowardice (SIM-PLAN 18.5).
//
// Six rules, all of them load-bearing:
//
//   1. Relative to alternatives at the same decision point. When every branch
//      is bad, take the least bad. Never stop choosing.
//   2. Evidence must beat the library prior by a margin.
//   3. Only call-attributed losses update the situation. Execution losses
//      go to the mistake ledger.
//   4. UCB bonus on rarely-visited keys (curiosity).
//   5. Scoping and decay by generation distance.
//   6. The avoid-set NEVER masks. It reweights. Legality stays with the
//      contract and the initiation set.
// ---------------------------------------------------------------------------

export const AVOID_MARGIN = 0.08;
export const UCB_C = 0.4;

/**
 * Reweight a list of {id, score} by the experience index. Does not delete.
 *
 * @param {Array<{id:string, score:number}>} candidates
 * @param {object} args
 * @param {import('./experience.js').ExperienceIndex} args.index
 * @param {string} args.key
 * @param {number} [args.gen]
 * @returns {Array<{id:string, score:number, penalty:number, lower:number}>}
 */
export function reweightAvoid(candidates, { index, key, gen = 0 } = {}) {
  const list = (candidates || []).map((c) => ({ ...c, penalty: 0, lower: 0.5 }));
  if (!list.length || !index) return list;

  const reads = list.map((c) => index.read(key, c.id));
  const bestLower = Math.max(...reads.map((r) => r.lower));

  for (let i = 0; i < list.length; i += 1) {
    const r = reads[i];
    const priorMean = r.prior && r.prior.n ? r.prior.w / r.prior.n : 0.5;
    const callShare = r.attrib.call + r.attrib.exec > 0
      ? r.attrib.call / (r.attrib.call + r.attrib.exec)
      : 1;
    // Rule 3: execution-attributed misery does not move the call.
    const evidence = r.lower;
    const beatsPrior = priorMean - evidence >= AVOID_MARGIN;
    const ucb = r.n > 0 ? UCB_C * Math.sqrt(Math.log(1 + r.n) / r.n) : UCB_C;
    let penalty = 0;
    if (beatsPrior && callShare > 0.5) {
      penalty = (bestLower - evidence) * callShare;
    }
    // Rule 4: rarely visited keys get a bonus, not a penalty.
    const curiosity = r.n < 4 ? ucb : 0;
    // Rule 5: older generations decay.
    const age = Math.max(0, gen - (r.gen || 0));
    const decay = 1 / (1 + 0.15 * age);
    list[i].lower = evidence;
    list[i].penalty = penalty * decay;
    list[i].score = list[i].score - list[i].penalty + curiosity;
  }

  // Rule 1: if every branch is bad, the least-bad still wins. We never drop.
  return list;
}

/**
 * Apply reweighted scores as priors onto LayerAction / option candidates
 * that carry `.prior`. Legality is untouched.
 */
export function applyAvoidPriors(candidates, weighted) {
  const byId = new Map((weighted || []).map((w) => [w.id, w]));
  for (const c of candidates || []) {
    const id = c.id || `${c.protocol} ${c.convert}`;
    const w = byId.get(id);
    if (!w) continue;
    c.prior = Math.max(0.01, (c.prior ?? 1) * Math.exp(-w.penalty));
  }
  return candidates;
}
