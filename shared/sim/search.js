// ---------------------------------------------------------------------------
// shared/sim/search.js
// Depth-limited search at decision time (SIM-PLAN 6.11) and the expert-iteration
// log it writes (9.13).
//
// Recipe: sample the enemy from the particle filter, evaluate K rollouts of
// 2-4 seconds per candidate, vary the enemy continuation (passive / aggressive
// / bc), average the leaf. Hard millisecond cap. Off during bulk RL, because
// a live CS2 server cannot be forked and the policy must be strong without
// this. Search is a training amplifier, never a runtime dependency.
//
// The engine clone the plan describes is optional: callers that can fork pass
// `rollout`; callers that cannot pass `evaluate(candidate, layout, continuation)`
// which is the reduced model. Both paths share the budget and the log format.
//
// Disagreements (search argmax != policy pick) are the expert-iteration
// targets: (obs, mask, search distribution).
//
// Pure given injected `now` and `rng`. Default `now` is 0 so unit tests are
// deterministic; production passes `() => performance.now()`.
// ---------------------------------------------------------------------------

export const SEARCH_K = 32;
export const SEARCH_HORIZON_SECONDS = 3;
export const SEARCH_MAX_MS = 8;
export const CONTINUATIONS = Object.freeze(['passive', 'aggressive', 'bc']);

/**
 * @param {object} args
 * @param {Array} args.candidates
 * @param {object} [args.policyPick]
 * @param {(c: object, layout: object, continuation: string) => number} [args.evaluate]
 * @param {() => object[]} [args.sampleLayouts]
 * @param {string[]} [args.continuations]
 * @param {number} [args.K]
 * @param {number} [args.maxMs]
 * @param {() => number} [args.now]
 * @param {boolean} [args.enabled]
 * @param {import('./rng.js').Rng} [args.rng]
 * @param {Float64Array|number[]} [args.obs]
 * @param {Set<string>|string[]} [args.mask]
 * @param {(c: object) => string} [args.idOf]
 * @returns {{pick: object, dist: Array<{id:string, p:number, value:number}>, disagreement: object|null, evaluations: number, timedOut: boolean}}
 */
export function decisionSearch({
  candidates = [],
  policyPick = null,
  evaluate = null,
  sampleLayouts = null,
  continuations = CONTINUATIONS,
  K = SEARCH_K,
  maxMs = SEARCH_MAX_MS,
  now = () => 0,
  enabled = true,
  rng = null,
  obs = null,
  mask = null,
  idOf = (c) => c?.id || c?.convert || String(c)
} = {}) {
  if (!enabled || !candidates.length) {
    return {
      pick: policyPick || candidates[0] || null,
      dist: [],
      disagreement: null,
      evaluations: 0,
      timedOut: false
    };
  }

  const start = now();
  const layouts = sampleLayouts ? sampleLayouts() : [{}];
  const nLayout = Math.max(1, layouts.length);
  const perCand = Math.max(1, Math.ceil(K / candidates.length));
  const values = candidates.map(() => 0);
  const counts = candidates.map(() => 0);
  let evaluations = 0;
  let timedOut = false;

  outer: for (let k = 0; k < perCand; k += 1) {
    for (let ci = 0; ci < candidates.length; ci += 1) {
      if (now() - start > maxMs) {
        timedOut = true;
        break outer;
      }
      const layout = layouts[rng ? rng.int(nLayout) : k % nLayout];
      const cont = continuations[k % continuations.length];
      const v = evaluate ? evaluate(candidates[ci], layout, cont) : 0;
      values[ci] += v;
      counts[ci] += 1;
      evaluations += 1;
    }
  }

  const means = values.map((s, i) => (counts[i] ? s / counts[i] : 0));
  const max = Math.max(-Infinity, ...means);
  const exps = means.map((m) => Math.exp(m - max));
  const z = exps.reduce((a, b) => a + b, 0) || 1;
  const dist = candidates.map((c, i) => ({
    id: idOf(c),
    p: exps[i] / z,
    value: means[i]
  }));

  let bestI = 0;
  for (let i = 1; i < dist.length; i += 1) if (dist[i].p > dist[bestI].p) bestI = i;
  const pick = candidates[bestI];
  const policyId = policyPick ? idOf(policyPick) : null;
  const searchId = idOf(pick);
  const disagreement =
    policyId && searchId && policyId !== searchId
      ? {
          obs,
          mask: mask ? [...mask] : null,
          dist,
          policy: policyId,
          search: searchId
        }
      : null;

  return { pick, dist, disagreement, evaluations, timedOut };
}

/**
 * Append-only expert-iteration buffer. Distillable: each row is
 * (obs, mask, search distribution).
 */
export class ExpertIterLog {
  constructor() {
    this.rows = [];
  }

  push(disagreement) {
    if (disagreement) this.rows.push(disagreement);
  }

  /** JSONL-ready rows, one per disagreement. */
  toJSONL() {
    return this.rows.map((r) =>
      JSON.stringify({
        obs: r.obs,
        mask: r.mask,
        dist: r.dist,
        policy: r.policy,
        search: r.search
      })
    );
  }
}
