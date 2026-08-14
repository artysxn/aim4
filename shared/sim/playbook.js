// ---------------------------------------------------------------------------
// shared/sim/playbook.js
// Winning rounds as runnable tapes, and the queries a caller makes of them.
//
// The knowledge tables (knowledgeBake.js) say what a POSITION is: where
// winners stand on Banana, when they arrive, what they throw. The playbook
// says what a ROUND is: which five contracts were manned, where each walked
// and when, what each threw and from where, and how the round opened.
//
// The caller uses it twice:
//
//   at round start   pick a round matching (side, call, econ) and run it role
//                    by role, which is the operator's "copy the pathing and
//                    utility until some chaos happens"
//   on chaos         match the CURRENT situation against how winning rounds
//                    looked at the same moment, and take what those rounds did
//                    next: commit, delay, or turn around
//
// Two properties matter more than the lookup being clever:
//
//   SAMPLING, NOT ARGMAX. Always taking the best-matching round makes a team
//   that plays the same round forever, which is both boring and trivially
//   exploitable. Matches are drawn from a softmax over the top k, so the same
//   situation produces a family of plausible answers.
//
//   MISSES ARE ORDINARY. A situation with no close match returns null and the
//   caller falls through to freestyle. A playbook that always answers is a
//   playbook that answers wrongly, and the arbiter is a better improviser than
//   a badly matched tape.
// ---------------------------------------------------------------------------

/** Bumped when an entry's shape changes, so a stale mine is refused loudly. */
export const PLAYBOOK_VERSION = 1;

/** How many candidates a draw considers before the softmax. `[calibrate]` */
export const TOP_K = 12;
/**
 * Softmax temperature over match distance. Higher is more varied; at 0 this
 * degenerates to argmax and the team plays one round forever.
 */
export const TEMPERATURE = 0.35;

/**
 * @typedef {object} PlaybookRole
 * @property {string} contract   the anchor they settled on
 * @property {string} steamId    who played it, for per-player mimicry (10.3)
 * @property {boolean} awp
 * @property {Array<[number, string]>} waypoints  [seconds, anchor], in order
 * @property {Array<object>} utility  {t, type, from, at, fx, fy, ax, ay, flight}
 */

/**
 * @typedef {object} PlaybookEntry
 * @property {string} id
 * @property {string} map
 * @property {'T'|'CT'} side
 * @property {string} call
 * @property {number|null} econ
 * @property {number|null} econEnemy
 * @property {{site: string|null, t: number}|null} plant
 * @property {{t: number, rel: 'front'|'site'|'behind'}|null} firstContact
 * @property {PlaybookRole[]} roles
 */

/**
 * Index a list of entries for querying. Pure: the loader (server side) reads
 * the JSONL, this arranges it, so the browser and the trainer can both use it.
 *
 * @param {PlaybookEntry[]} entries
 */
export function indexPlaybook(entries) {
  const bySide = { T: [], CT: [] };
  for (const e of entries) {
    if (e?.side === 'T' || e?.side === 'CT') bySide[e.side].push(e);
  }
  const callsOf = (side) => {
    const counts = new Map();
    for (const e of bySide[side]) counts.set(e.call, (counts.get(e.call) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  return {
    size: entries.length,
    bySide,
    calls: { T: callsOf('T'), CT: callsOf('CT') },
    /** Every contract this side ever manned, by how often. */
    contracts(side) {
      const counts = new Map();
      for (const e of bySide[side]) {
        for (const r of e.roles) {
          if (!r.contract) continue;
          const cur = counts.get(r.contract) || { n: 0, awp: 0 };
          cur.n += 1;
          if (r.awp) cur.awp += 1;
          counts.set(r.contract, cur);
        }
      }
      return [...counts.entries()]
        .map(([contract, v]) => ({ contract, n: v.n, awpShare: v.awp / v.n }))
        .sort((a, b) => b.n - a.n);
    }
  };
}

/** Draw one of `scored` by softmax over -distance. Deterministic given rng. */
function sample(scored, rng, temperature = TEMPERATURE) {
  if (!scored.length) return null;
  if (!(temperature > 0)) return scored[0].entry;
  let total = 0;
  const weights = scored.map((s) => {
    const w = Math.exp(-s.distance / temperature);
    total += w;
    return w;
  });
  let r = (rng?.next ? rng.next() : 0.5) * total;
  for (let i = 0; i < scored.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return scored[i].entry;
  }
  return scored[scored.length - 1].entry;
}

/**
 * The round-start pick: a tape to run this round.
 *
 * Economy is matched rather than required, because a playbook that insists on
 * an exact econ pair finds nothing on the rounds that matter most.
 *
 * @returns {PlaybookEntry|null}
 */
export function pickRound(index, { side, call = null, econ = null, exclude = null, rng }) {
  const pool = index?.bySide?.[side] || [];
  if (!pool.length) return null;
  const scored = [];
  for (const e of pool) {
    if (exclude && e.id === exclude) continue;
    let d = 0;
    if (call && e.call !== call) d += 1;
    if (econ != null && e.econ != null) d += Math.min(1, Math.abs(e.econ - econ) / 5);
    scored.push({ entry: e, distance: d });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return sample(scored.slice(0, TOP_K), rng);
}

/**
 * Sample a named call from how often winners ran it. Frequent calls sit
 * closer, a StrategyAI hint (`prefer`) is a bonus rather than a filter, and
 * the same softmax as pickRound keeps a side from opening every round the
 * same way.
 *
 * @returns {string|null}
 */
export function pickCall(index, { side, prefer = null, rng }) {
  const list = index?.calls?.[side] || [];
  if (!list.length) return null;
  const scored = list.map(([call, n]) => ({
    entry: call,
    distance: (prefer && call !== prefer ? 1 : 0) + 1 / Math.max(1, n)
  }));
  scored.sort((a, b) => a.distance - b.distance);
  return sample(scored.slice(0, TOP_K), rng);
}

/**
 * The re-call: given what just happened, what did winning rounds do next?
 *
 * `contactRel` is the operator's key inference. A contact BEHIND means the
 * enemy spent bodies being aggressive somewhere we are not, which is exactly
 * the read that makes turning around correct rather than panicked. Rounds
 * where the same thing happened are the evidence for what to do about it.
 *
 * @returns {{entry: PlaybookEntry, decision: 'commit'|'delay'|'turnaround'}|null}
 */
export function matchSituation(index, { side, clock, alive, enemyAlive, contactRel, call, rng }) {
  const pool = index?.bySide?.[side] || [];
  if (!pool.length) return null;

  const scored = [];
  for (const e of pool) {
    const fc = e.firstContact;
    if (!fc) continue;
    let d = 0;
    // The shape of the opening is what has to match: where contact happened
    // and roughly when. Everything else is a tiebreak.
    if (contactRel && fc.rel !== contactRel) d += 1.2;
    if (Number.isFinite(clock)) d += Math.min(1, Math.abs(fc.t - clock) / 40);
    if (call && e.call !== call) d += 0.3;
    scored.push({ entry: e, distance: d });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => a.distance - b.distance);
  // No close match is a real answer: freestyle beats a badly matched tape.
  if (scored[0].distance > 1.5) return null;

  const entry = sample(scored.slice(0, TOP_K), rng);
  if (!entry) return null;

  // What that round did next, read off its own shape rather than authored:
  // it planted somewhere after contact (commit), planted late (delay), or
  // never planted at all after a contact behind (turnaround).
  const fc = entry.firstContact;
  let decision = 'commit';
  if (!entry.plant) decision = fc?.rel === 'behind' ? 'turnaround' : 'delay';
  else if (entry.plant.t - (fc?.t ?? 0) > 25) decision = 'delay';
  return { entry, decision };
}

/**
 * Assign this side's five bots to the five roles of a tape.
 *
 * Keeps a bot on the contract it already occupies when it can, so a re-call
 * mid-round does not swap everyone's job: continuity is most of what makes a
 * team look coached rather than teleported.
 *
 * @param {number[]} slots
 * @param {PlaybookEntry} entry
 * @param {(slot: number) => string|null} contractOf  where each bot is now
 * @param {object} [opts]
 * @param {(slot: number) => boolean} [opts.awpOf]  the AWPer seat, matched first
 * @returns {Map<number, PlaybookRole>}
 */
export function assignRoles(slots, entry, contractOf = () => null, { awpOf = () => false } = {}) {
  const out = new Map();
  const roles = [...(entry?.roles || [])];
  const free = new Set(slots);

  // AWP roles go to AWP seats before anyone else is placed, so the big gun
  // keeps playing the AWPer's tape rather than inheriting a lurk by order.
  for (const role of roles.slice()) {
    if (!role.awp) continue;
    for (const slot of free) {
      if (!awpOf(slot)) continue;
      out.set(slot, role);
      free.delete(slot);
      roles.splice(roles.indexOf(role), 1);
      break;
    }
  }

  // Anybody already standing on a role's contract keeps it, so a re-call
  // mid-round does not swap everyone's job.
  for (const role of roles.slice()) {
    for (const slot of free) {
      if (contractOf(slot) && contractOf(slot) === role.contract) {
        out.set(slot, role);
        free.delete(slot);
        roles.splice(roles.indexOf(role), 1);
        break;
      }
    }
  }
  // Whoever is left, in order.
  for (const slot of [...free]) {
    const role = roles.shift();
    if (!role) break;
    out.set(slot, role);
    free.delete(slot);
  }
  return out;
}

/**
 * Where a role should be at time `t`, and what it should have thrown by now.
 * The tape is a schedule, not a rail: the caller asks where to be, and the
 * usual movement layer works out how to get there.
 */
export function waypointAt(role, seconds) {
  const w = role?.waypoints || [];
  let cur = null;
  for (const [t, anchor] of w) {
    if (t > seconds) break;
    cur = anchor;
  }
  return cur;
}

/** A throw this many seconds past its clock is skipped rather than pinning the bot. */
export const UTILITY_STALE_SECONDS = 8;

/**
 * When this role's schedule is exhausted: the later of its last waypoint and
 * its last throw. Past this plus a grace window the tape is no longer a plan.
 */
export function tapeEndSeconds(role) {
  let end = 0;
  for (const [t] of role?.waypoints || []) {
    if (Number.isFinite(t) && t > end) end = t;
  }
  for (const u of role?.utility || []) {
    if (Number.isFinite(u.t) && u.t > end) end = u.t;
  }
  return end;
}

/** Throws whose clock has come, which have not been thrown, and which are not stale. */
export function dueUtility(role, seconds, thrown = new Set()) {
  const out = [];
  for (let i = 0; i < (role?.utility || []).length; i += 1) {
    const u = role.utility[i];
    if (u.t > seconds) continue;
    if (seconds - u.t > UTILITY_STALE_SECONDS) continue;
    if (thrown.has(i)) continue;
    out.push({ index: i, ...u });
  }
  return out;
}
