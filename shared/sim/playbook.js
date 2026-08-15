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
// v2 adds the coordinate path: [t, x, y, yaw] at 8 Hz per role. A v1 tape
// carries anchor waypoints only and cannot be followed step by step, so the
// version is what tells a runtime which kind of copy it is holding.
export const PLAYBOOK_VERSION = 2;

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
export function pickRound(index, { side, call = null, econ = null, econEnemy = null, exclude = null, pinCall = false, rng }) {
  const scored = scoreRounds(index, { side, call, econ, econEnemy, exclude, pinCall });
  if (!scored.length) return null;
  return hydrated(index, sample(scored.slice(0, TOP_K), rng));
}

/**
 * Fetch the chosen tape's coordinates, if the loader can.
 *
 * A v2 tape carries 71 seconds of [x, y, yaw] per role and the corpus is 9 GB
 * of it, so the server-side loader keeps only the light half in memory and
 * hands over an `index.hydrate` that reads the rest off disk by byte offset.
 * Doing it HERE rather than at each call site means every consumer of a
 * picked tape -- caller, inspector, trainer -- gets the fine path without
 * knowing the storage exists. No hydrate (the browser, a v1 file) simply
 * leaves `role.path` null, which `pathAt` already reads as "steer by
 * landmarks".
 */
function hydrated(index, entry) {
  return entry && index?.hydrate ? index.hydrate(entry) : entry;
}

/**
 * Every tape scored against the freeze (call, econ, enemy econ), nearest
 * first.
 *
 * Two of these are principled rather than soft:
 *
 * PISTOL IS A GATE, not a distance. A pistol round copied from a full-buy
 * tape peeks angles only rifles win, and a gun round copied from a pistol
 * tape rushes spots pros only rush with glocks. The operator's rule is that
 * pistol calls come from real pistol rounds, so bucket 0 draws bucket 0 and
 * nothing else — both directions.
 *
 * THE ENEMY'S MONEY IS PART OF THE SITUATION. Entries carry `econEnemy`, and
 * matching it is what makes "they are forcing, we are full" draw a real
 * antiforce round instead of a coin-flip standard. Weighted below own econ:
 * what we can buy is certain, what they bought is a read.
 */
function scoreRounds(index, { side, call = null, econ = null, econEnemy = null, exclude = null, pinCall = false } = {}) {
  const pool = index?.bySide?.[side] || [];
  if (!pool.length) return [];
  const scored = [];
  const pistol = econ === 0;
  for (const e of pool) {
    if (exclude && e.id === exclude) continue;
    // A pinned call is a drill (Bootcamp): the same round type every time,
    // never the nearest neighbour of it.
    if (pinCall && call && e.call !== call) continue;
    if (econ != null && e.econ != null && pistol !== (e.econ === 0)) continue;
    let d = 0;
    if (call && e.call !== call) d += 1;
    if (econ != null && e.econ != null) d += Math.min(1, Math.abs(e.econ - econ) / 5);
    if (econEnemy != null && e.econEnemy != null) {
      d += 0.5 * Math.min(1, Math.abs(e.econEnemy - econEnemy) / 5);
    }
    scored.push({ entry: e, distance: d });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored;
}

/**
 * The freeze-time shortlist, without the sampling. `closeMatches` is the same
 * idea for a recall; this is the one for round start, because 9.25 stage 1 is
 * explicit that "the same head is the caller's score at freeze and at recall".
 *
 * @returns {Array<{entry: PlaybookEntry, decision: string, distance: number}>}
 */
export function openingCandidates(index, { side, call = null, econ = null, econEnemy = null, pinCall = false } = {}, k = TOP_K) {
  return scoreRounds(index, { side, call, econ, econEnemy, pinCall })
    .slice(0, k)
    .map((s) => ({ entry: s.entry, decision: decisionFor(s.entry), distance: s.distance }));
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
  const scored = scoreMatches(index, { side, clock, contactRel, call });
  if (!scored.length) return null;
  // No close match is a real answer: freestyle beats a badly matched tape.
  if (scored[0].distance > MATCH_CUTOFF) return null;

  const entry = hydrated(index, sample(scored.slice(0, TOP_K), rng));
  if (!entry) return null;
  return { entry, decision: decisionFor(entry) };
}

/** How far a tape may sit from the situation before it is not an answer. */
export const MATCH_CUTOFF = 1.5;

/**
 * The shortlist behind `matchSituation`, without the sampling.
 *
 * SIM-PLAN 9.25 stage 1 needs the close matches as CANDIDATES rather than as
 * an answer: the library says which plans are plausible here, and the value
 * head says which of them is worth more than the one already running. Same
 * scoring, same cutoff, same order — this is the shortlist `matchSituation`
 * samples from, handed over unsampled.
 *
 * @returns {Array<{entry: PlaybookEntry, decision: string, distance: number}>}
 */
export function closeMatches(index, { side, clock, contactRel, call } = {}, k = TOP_K) {
  const scored = scoreMatches(index, { side, clock, contactRel, call });
  if (!scored.length || scored[0].distance > MATCH_CUTOFF) return [];
  return scored.slice(0, k).map((s) => ({
    entry: s.entry,
    decision: decisionFor(s.entry),
    distance: s.distance
  }));
}

/**
 * Every tape scored against the situation, nearest first.
 *
 * `contactRel` is the operator's key inference. A contact BEHIND means the
 * enemy spent bodies being aggressive somewhere we are not, which is exactly
 * the read that makes turning around correct rather than panicked. Rounds
 * where the same thing happened are the evidence for what to do about it.
 */
function scoreMatches(index, { side, clock, contactRel, call } = {}) {
  const pool = index?.bySide?.[side] || [];
  if (!pool.length) return [];
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
  scored.sort((a, b) => a.distance - b.distance);
  return scored;
}

/**
 * What a tape did next, read off its own shape rather than authored: it
 * planted somewhere after contact (commit), planted late (delay), or never
 * planted at all after a contact behind (turnaround).
 */
export function decisionFor(entry) {
  const fc = entry?.firstContact;
  if (!entry?.plant) return fc?.rel === 'behind' ? 'turnaround' : 'delay';
  if (entry.plant.t - (fc?.t ?? 0) > 25) return 'delay';
  return 'commit';
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
 * @param {(slot: number) => {x: number, y: number}|null} [opts.posOf]
 *        where each bot stands. When given, the leftover roles are matched to
 *        minimize total distance from each bot to its tape's first sample,
 *        because handing a bot a tape that starts across the spawn zone
 *        creates a gap it can never close: follower and tape move at the
 *        same speed, so the starting error is carried the whole round.
 * @returns {Map<number, PlaybookRole>}
 */
export function assignRoles(slots, entry, contractOf = () => null, { awpOf = () => false, posOf = null } = {}) {
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
  // Whoever is left: nearest-to-tape-start when positions are known, file
  // order when they are not. Five or fewer remain, so the assignment is
  // solved exactly rather than greedily -- greedy leaves the last pairing
  // with whatever is left, and the last pairing is the one that hurts.
  const rest = [...free];
  const starts = roles.map((role) => {
    const p = role?.path;
    return p && p.length >= PATH_FIELDS ? { x: p[0], y: p[1] } : null;
  });
  const canPlace = posOf && rest.length > 1 && starts.some(Boolean);
  if (canPlace) {
    const depth = Math.min(rest.length, roles.length);
    let bestOrder = null;
    let bestCost = Infinity;
    const perm = (order, remaining) => {
      if (order.length === depth) {
        let cost = 0;
        for (let i = 0; i < order.length; i += 1) {
          const pos = posOf(rest[i]);
          const start = starts[order[i]];
          // An unknown position or a v1 tape contributes nothing either way.
          if (pos && start) cost += Math.hypot(pos.x - start.x, pos.y - start.y);
        }
        if (cost < bestCost) {
          bestCost = cost;
          bestOrder = order.slice();
        }
        return;
      }
      for (let k = 0; k < remaining.length; k += 1) {
        order.push(remaining[k]);
        perm(order, remaining.slice(0, k).concat(remaining.slice(k + 1)));
        order.pop();
      }
    };
    perm([], roles.map((_, i) => i));
    if (bestOrder) {
      rest.forEach((slot, i) => {
        const role = roles[bestOrder[i]];
        if (role) {
          out.set(slot, role);
          free.delete(slot);
        }
      });
      return out;
    }
  }
  for (const slot of rest) {
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
/** [x, y, yaw] per path sample. Time is the index, not a stored field. */
export const PATH_FIELDS = 3;

/**
 * Where the pro was, and where they were looking, at this moment.
 *
 * The tape's fine half (v2). `waypointAt` answers with a LANDMARK the pro
 * passed through, which is what a bot navigates to; this answers with the
 * position they actually occupied, which is what a bot follows. Interpolated
 * between samples so a 64 Hz engine gets a smooth target from a 32 Hz tape
 * rather than a staircase.
 *
 * Null when the role has no path (a v1 tape) or the moment is past its end,
 * which is what tells a follower to fall back to the anchor waypoints.
 *
 * @returns {{x: number, y: number, yaw: number, i: number, last: boolean}|null}
 */
export function pathAt(role, seconds) {
  const path = role?.path;
  const hz = role?.pathHz || 0;
  if (!path || !hz || !path.length) return null;
  const n = Math.floor(path.length / PATH_FIELDS);
  const f = Math.max(0, seconds) * hz;
  const i = Math.floor(f);
  if (i >= n) return null;
  const at = (k) => k * PATH_FIELDS;
  const j = at(i);
  if (i + 1 >= n) {
    return { x: path[j], y: path[j + 1], yaw: path[j + 2], i, last: true };
  }
  const k = at(i + 1);
  const w = f - i;
  // Yaw is an angle: interpolating 179 to -179 the long way round would spin
  // the crosshair a full turn between two samples a thirtieth of a second
  // apart, which is the flick-to-nowhere the aim fix already removed once.
  let dy = path[k + 2] - path[j + 2];
  if (dy > 180) dy -= 360;
  if (dy < -180) dy += 360;
  return {
    x: path[j] + (path[k] - path[j]) * w,
    y: path[j + 1] + (path[k + 1] - path[j + 1]) * w,
    yaw: path[j + 2] + dy * w,
    i,
    last: false
  };
}

/** Seconds of fine path this role carries, or 0 for a v1 tape. */
export function pathEndSeconds(role) {
  const hz = role?.pathHz || 0;
  if (!role?.path || !hz) return 0;
  return Math.floor(role.path.length / PATH_FIELDS) / hz;
}

/**
 * The point on the tape nearest to `pos`, looking only at the stretch the pro
 * had walked by `toSeconds`.
 *
 * This is the question that separates a follower's two failure modes. A bot
 * near the tape but at an earlier sample than the clock's is BEHIND: it ran
 * the pro's route slower than the pro. A bot far from every sample is OFF the
 * path: it spawned elsewhere, detoured, or got displaced by a fight. The
 * clock-indexed error (`pathAt` distance) cannot tell those apart, and they
 * need opposite fixes, so the follower asks this instead.
 *
 * Bounded at `toSeconds` on purpose: matching against path the pro had not
 * walked yet would let a bot skip ahead of its own schedule.
 *
 * @returns {{t: number, d: number, x: number, y: number, yaw: number}|null}
 */
export function nearestPathPoint(role, pos, { fromSeconds = 0, toSeconds } = {}) {
  const path = role?.path;
  const hz = role?.pathHz || 0;
  if (!path || !hz || !path.length || !pos) return null;
  const n = Math.floor(path.length / PATH_FIELDS);
  const i0 = Math.max(0, Math.floor(fromSeconds * hz));
  const i1 = Math.min(n - 1, Math.floor((Number.isFinite(toSeconds) ? toSeconds : n / hz) * hz));
  if (i1 < i0) return null;
  let best = -1;
  let bestD = Infinity;
  for (let i = i0; i <= i1; i += 1) {
    const j = i * PATH_FIELDS;
    const d = Math.hypot(path[j] - pos.x, path[j + 1] - pos.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return null;
  const j = best * PATH_FIELDS;
  return { t: best / hz, d: bestD, x: path[j], y: path[j + 1], yaw: path[j + 2] };
}

/**
 * The tape-follower's steering answer: where to walk, given where the bot is
 * and how far along the tape it has already gotten.
 *
 * Three rules, each of which exists because its absence was measured as a
 * specific failure:
 *
 * MONOTONIC. The search starts at `cursor`, the bot's own furthest progress,
 * never at zero. Nearest-point against the whole walked stretch resolves to
 * the EARLIEST pass wherever a route crosses itself or lingers, which teleports
 * the follower's notion of progress backwards and pins it near spawn. The
 * cursor only ratchets forward.
 *
 * STANDS ARE SKIPPED WHEN BEHIND. A pro who stands for four seconds produces
 * 128 colocated samples. A lagging follower that re-stands them re-enacts the
 * pause without the reason for the pause (the pro was waiting on the clock,
 * and the clock has moved), compounding the very lag it needs to shed. So on
 * arrival at a stand, the cursor jumps to its end. The pause is still honoured
 * when it should be, by the third rule:
 *
 * THE CLOCK IS A CAP. The target never sits past `clock`, so a caught-up bot
 * walks the tape in the pro's own time, stands where they stood, and only a
 * bot BEHIND schedule hurries. Early is not faithful: timing is the call.
 *
 * @param {object} role       with a v2 path
 * @param {{x,y}} pos         where the bot is
 * @param {number} cursor     furthest tape-seconds this bot has reached
 * @param {number} clock      seconds since freeze end
 * @returns {{target: {x,y,yaw}, cursor: number, d: number}|null}
 */
export function pursuitPoint(role, pos, cursor, clock, {
  window = 8,
  lookahead = 1.5,
  standUnits = 48
} = {}) {
  const hz = role?.pathHz || 0;
  if (!role?.path || !hz || clock < 0) return null;
  const from = Math.max(0, cursor);
  const near = nearestPathPoint(role, pos, {
    fromSeconds: from,
    toSeconds: Math.min(clock, from + window)
  });
  if (!near) return null;
  let t = Math.max(from, near.t);
  if (near.d <= standUnits) {
    // On the route here. If the samples ahead sit on this same spot (the pro
    // stood), advance the cursor across the run so the follower does not
    // idle out a pause the clock has already spent.
    const path = role.path;
    const n = Math.floor(path.length / PATH_FIELDS);
    const cap = Math.min(n - 1, Math.floor(clock * hz));
    let i = Math.floor(t * hz);
    const j0 = i * PATH_FIELDS;
    while (i + 1 <= cap) {
      const j = (i + 1) * PATH_FIELDS;
      if (Math.hypot(path[j] - path[j0], path[j + 1] - path[j0 + 1]) > standUnits) break;
      i += 1;
    }
    t = i / hz;
  }
  const at = pathAt(role, Math.min(clock, t + lookahead));
  return { target: at || near, cursor: t, d: near.d };
}

export function waypointAt(role, seconds) {
  const w = role?.waypoints || [];
  let cur = null;
  for (const [t, anchor] of w) {
    if (t > seconds) break;
    cur = anchor;
  }
  return cur;
}

/**
 * Where the tape is GOING: the first waypoint whose time has not come yet,
 * or the last one once the schedule is spent.
 *
 * This is the one a follower must steer by. `waypointAt` answers "where was
 * the pro at t" — correct for grading, fatal for following, because a bot
 * steering at it is always chasing a position the tape has already left:
 * every waypoint change teleports its error to the full segment length, and
 * a fall-off test reading that error kicks the whole team local within
 * seconds of leaving spawn. Steering at the NEXT waypoint inverts that — the
 * bot arrives early, holds until the tape's own clock catches up, and moves
 * out on the pro's timing.
 *
 * @returns {{t: number, anchor: string}|null}
 */
export function nextWaypointAt(role, seconds) {
  const w = role?.waypoints || [];
  if (!w.length) return null;
  for (const [t, anchor] of w) {
    if (t > seconds) return { t, anchor };
  }
  const [t, anchor] = w[w.length - 1];
  return { t, anchor };
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
