// ---------------------------------------------------------------------------
// shared/sim/clearPartition.js
// Commitment is a team act: who pre-aims what, and what nobody covers.
//
// SIM-PLAN 19.5. The tension in the brief is real and the resolution is
// structural rather than a compromise: an entry who visualizes four angles
// pre-aims none of them and dies to all four, while a team that only ever
// looks at one angle walks into the other three. So the TEAM visualizes
// broadly, the breadth is partitioned across bodies, and each body commits to
// ONE slice. The first man pre-aims the highest-mass angle AND NOTHING ELSE.
//
// That is an assignment problem, so it is solved rather than scripted:
//
//   angles  the spot-encounter list for the entry corridor (6.8), filtered to
//           entries whose belief mass clears a floor, typed by threat (19.3)
//   bodies  the pack, ordered by arrival time along the corridor
//   cost    −[ mass × P(win there | pre-aimed, typed threat)
//               × P(traded | he dies there) ]  +  arrival mismatch penalty
//   solve   Hungarian, THE SAME SOLVER spawn choice uses (4.12, spawnChoice.js)
//
// Three things fall out that no rule in this codebase could previously say:
//
//   THE UNCOVERED SET is the angles nobody takes, and its mass is the honest
//   price of the entry. Too high and the correct act is not courage: it is
//   utility, gathering (19.4), or another corridor — refused for a STATED
//   reason, which is a different product from a threshold saying no.
//
//   THE FLASH REQUEST has a target for free: `flashTarget` is the highest-mass
//   uncovered angle, which is exactly what you ask a teammate for (19.6).
//
//   MAN-DOWN EXECUTION for free: `manDown` re-solves over the remaining bodies
//   and the uncovered mass rises. That is the whole answer to "we lost
//   someone, do we still go", and nobody wrote a man-down rule.
//
// Post-round, `gradeEntry` asks where the killer actually was: covered means
// the read was right and a duel was lost, uncovered means the read or the
// partition was wrong. That is 18.6's attribution applied to entries, and it
// feeds the mistake ledger with a distinction no coach rule makes.
//
// SERVES 20.13 TOO. The execute's utility assignment is solved at runtime, not
// retrieved: molotovs from close so the second man carries them, flashes last
// so the fourth man does and arrives late. Nobody memorized that order, it is
// the unique solution to a small assignment whose costs are geometry and
// timing. `assignAtMostOne` is that solver with the value function left open,
// and `clearPartition` is one caller of it; the execute assigner is another,
// with lineup geometry in the value and the DAG's ordering constraints
// expressed as cells that price at zero.
//
// WHAT IT BINDS TO, AND WHAT IT APPROXIMATES:
//
//   angles.js `anchorEncountersAlong(route)` is the intended input: rows of
//   {index, anchor, level, yaw, at, cell}, one per anchor. Per ANCHOR and not
//   per (spot, yaw) entry on purpose — a body checks "car", not the four yaw
//   sectors of car, and knowledge.js keys mass on `anchor|level` so per-entry
//   rows would count one hypothesis four times (the argument angles.js itself
//   makes in `threatAt`). Rows are deduped by key here anyway, so passing raw
//   `encountersAlong` output is safe.
//
//   `at` is DISTANCE along the route in world units, not seconds; the
//   catalogue has no clock. So `opensAt` (seconds) is the caller's conversion,
//   `at / pace`, which assumes a uniform pace and no acceleration model.
//   Omit it and the arrival penalty is simply zero.
//
//   Encounter rows carry `index` but not the watcher's world point, so
//   `pTradedFromGeometry` takes `spotOf`; bind it as
//   `(a) => catalogue.entries[a.index].world`, the same field `nearestAnchor`
//   reads. mass binds as `massFromBelief(belief, weaponClass)`, i.e.
//   JointBelief.massAt(anchor, level, class).
//
//   pWin is fully injected. The honest reason: P(win | pre-aimed) belongs to
//   the fitted duel model, and inventing a stand-in here would be a second
//   engine lying (decision 21's neighbour). desireBot supplies the real one.
//
// COST, CAP, DETERMINISM. Hungarian is O(n^3) and it runs ONCE per entry at
// the pace type's commit window (6.20), not per tick — five bodies against a
// capped twelve angles is seventeen columns and a few thousand operations, so
// nothing here is worth optimizing. The cap is `MAX_PARTITION_ANGLES = 12`,
// matching 6.7's twelve-hypothesis foresight ceiling: the partition must never
// consider more angles than the bot can reason about, and 19.3 caps its own
// candidate set at ~8 for the same reason. Angles past the cap are reported in
// `dropped` rather than silently discarded, because their mass is real.
//
// Pure: no I/O, no clock, no RNG. Exact ties are broken by a 1e-9 nudge toward
// the diagonal (earliest body on the best angle, then down the line), so the
// same input gives the same partition every time and "the first man takes the
// best angle" is a property of the solve rather than of list order.
// ---------------------------------------------------------------------------

import { tradeCover } from './geometry.js';
import { hungarian } from './spawnChoice.js';

/** Angles considered per entry. See the header: 6.7's ceiling, not a guess. */
export const MAX_PARTITION_ANGLES = 12;

/** Belief mass below which an angle is not worth a body's crosshair. `[calibrate]` */
export const DEFAULT_MASS_FLOOR = 0.05;

/**
 * Mass units charged per second of arrival mismatch. At 0.15 a body two
 * seconds out of step with an angle pays 0.3, which is more than most single
 * angles are worth, so the pack pre-aims in the order it walks. `[calibrate]`
 */
export const DEFAULT_ARRIVAL_WEIGHT = 0.15;

/** Smaller than any real difference in value; big enough to order equal cells. */
const TIE = 1e-9;

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Identity of an angle. `id` when the caller gives one; otherwise the belief's
 * own key, `anchor|level`, because that is the granularity mass is stored at.
 */
export function angleKey(angle) {
  if (angle.id !== undefined && angle.id !== null) return String(angle.id);
  if (angle.anchor !== undefined && angle.anchor !== null) {
    return `${angle.anchor}|${angle.level || 'default'}`;
  }
  if (angle.index !== undefined && angle.index !== null) return `#${angle.index}`;
  throw new Error('clearPartition: an angle needs an id, an anchor, or a catalogue index');
}

/** What the motive string calls it. */
export function angleLabel(angle) {
  return String(angle.label ?? angle.anchor ?? angle.id ?? angleKey(angle));
}

/** Bodies carry `pos` in the sim and bare coordinates in tests; accept both. */
function pointOf(body) {
  return body.pos || body;
}

function slotOf(body, i) {
  return body.slot !== undefined && body.slot !== null ? body.slot : i;
}

/**
 * The solver, with the value function left open. Each row takes AT MOST ONE
 * column, and taking nothing is always available: every row gets its own idle
 * column at zero, so a row is only matched when its cell is worth more than
 * standing there doing nothing. That "at most one" is not a limitation to work
 * around, it is the entire point of 19.5.
 *
 * `valueOf` returns how much the pairing is WORTH (higher is better); zero or
 * negative means not worth doing, and non-finite means forbidden, which is how
 * an execute's ordering constraint says "this body cannot throw that" (20.13).
 *
 * @param {object} args
 * @param {Array<object>} args.rows
 * @param {Array<object>} args.cols
 * @param {(row:object, col:object, i:number, j:number) => number} args.valueOf
 * @returns {{pairs: Array<{i:number, j:number, row:object, col:object, value:number}>,
 *            idleRows: number[], openCols: number[]}}
 */
export function assignAtMostOne({ rows, cols, valueOf }) {
  const n = rows.length;
  const m = cols.length;
  if (!n || !m) {
    return {
      pairs: [],
      idleRows: rows.map((_, i) => i),
      openCols: cols.map((_, j) => j)
    };
  }

  const width = m + n; // m real columns, then one idle column per row
  const cost = [];
  const values = [];
  for (let i = 0; i < n; i += 1) {
    const row = new Array(width).fill(0);
    const vals = new Array(m).fill(0);
    for (let j = 0; j < m; j += 1) {
      const raw = valueOf(rows[i], cols[j], i, j);
      const v = Number.isFinite(raw) ? raw : 0;
      vals[j] = v;
      // Distance from the diagonal, scaled to nothing. A tie between two whole
      // permutations cannot be broken by any per-row or per-column nudge (both
      // cancel out over a matching), so the nudge has to couple the two: this
      // one is minimized by pairing the earliest body with the best angle and
      // walking down. Bounded by TIE * (rows + cols)^2, which is ~1e-7 at the
      // sizes this runs at and cannot outvote a real difference in value.
      row[j] = -v + TIE * (i - j) * (i - j);
    }
    cost.push(row);
    values.push(vals);
  }

  const picks = hungarian(cost);
  const pairs = [];
  const idleRows = [];
  const taken = new Set();
  for (let i = 0; i < n; i += 1) {
    const j = picks[i];
    // Idle columns sit past the real ones, and a non-positive cell is refused
    // outright rather than left to the solver's indifference at exactly zero.
    if (j >= 0 && j < m && values[i][j] > 0) {
      pairs.push({ i, j, row: rows[i], col: cols[j], value: values[i][j] });
      taken.add(j);
    } else {
      idleRows.push(i);
    }
  }
  const openCols = [];
  for (let j = 0; j < m; j += 1) if (!taken.has(j)) openCols.push(j);
  return { pairs, idleRows, openCols };
}

/**
 * Solve the entry's clear partition.
 *
 * @param {object} args
 * @param {Array<object>} args.angles  spot-encounter rows (6.8); see the header
 * @param {Array<object>} args.bodies  the pack; sorted here by arrival, defensively
 * @param {(angle:object) => number} args.mass  belief mass, typed by threat (19.3)
 * @param {(body:object, angle:object, ctx:object) => number} [args.pWin]
 *   P(this body wins there | pre-aimed, typed threat). Defaults to 1, which
 *   reduces the solve to a pure mass partition: right for tests, not for play.
 * @param {(body:object, angle:object, ctx:object) => number} [args.pTraded]
 *   P(traded | he dies there). `pTradedFromGeometry` builds it from 6.12's
 *   tradeCover. Defaults to 1, same caveat.
 * @param {(body:object, angle:object, ctx:object) => number} [args.arrival]
 *   seconds of mismatch between the body and the angle opening. Defaults to
 *   |body.arrival − angle.opensAt| when both are known, else 0.
 * @param {number} [args.arrivalWeight]
 * @param {number} [args.massFloor]
 * @param {number} [args.maxAngles]
 * @returns {object} assignment, uncovered, uncoveredMass, flashTarget, motive
 */
export function clearPartition({
  angles = [],
  bodies = [],
  mass = () => 0,
  pWin = () => 1,
  pTraded = () => 1,
  arrival = defaultArrivalMismatch,
  arrivalWeight = DEFAULT_ARRIVAL_WEIGHT,
  massFloor = DEFAULT_MASS_FLOOR,
  maxAngles = MAX_PARTITION_ANGLES
} = {}) {
  // ---- the angle set ------------------------------------------------------
  const byKey = new Map();
  for (const angle of angles) {
    const key = angleKey(angle);
    const opensAt = Number.isFinite(angle.opensAt) ? angle.opensAt : null;
    const prev = byKey.get(key);
    // One anchor is one hypothesis. Keep the row that opens first: that is the
    // one the crosshair reaches, and the later sectors are the same enemy.
    if (prev && !(opensAt !== null && (prev.opensAt === null || opensAt < prev.opensAt))) continue;
    const m = mass(angle);
    byKey.set(key, {
      angle,
      key,
      label: angleLabel(angle),
      mass: Math.max(0, Number.isFinite(m) ? m : 0),
      opensAt
    });
  }

  const floor = Math.max(0, massFloor);
  const dropped = [];
  const kept = [];
  for (const row of byKey.values()) {
    if (row.mass < floor) dropped.push({ ...row, why: 'floor' });
    else kept.push(row);
  }
  kept.sort(
    (a, b) =>
      b.mass - a.mass ||
      (a.opensAt ?? Infinity) - (b.opensAt ?? Infinity) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
  for (const row of kept.slice(maxAngles)) dropped.push({ ...row, why: 'cap' });
  const considered = kept.slice(0, maxAngles);

  // ---- the pack -----------------------------------------------------------
  const pack = bodies
    .map((body, i) => ({ body, slot: slotOf(body, i), order: i }))
    .sort(
      (a, b) =>
        (Number.isFinite(a.body.arrival) ? a.body.arrival : 0) -
          (Number.isFinite(b.body.arrival) ? b.body.arrival : 0) ||
        a.order - b.order
    );

  const ctx = { bodies: pack.map((p) => p.body), angles: considered.map((c) => c.angle) };

  // ---- the solve ----------------------------------------------------------
  const terms = new Map();
  const { pairs, idleRows } = assignAtMostOne({
    rows: pack,
    cols: considered,
    valueOf: (packed, angleRow, i, j) => {
      const body = packed.body;
      const angle = angleRow.angle;
      const cell = { ...ctx, index: i, angleIndex: j };
      const win = clamp01(pWin(body, angle, cell));
      const traded = clamp01(pTraded(body, angle, cell));
      // Exactly 19.5's bracket, product and all. An angle nobody can trade on
      // prices at nothing even when this body would win it, which is what makes
      // the entry a team act rather than five duels, and it is why the geometry
      // adapter's floor sits above zero rather than at it. `[calibrate]`
      const cover = angleRow.mass * win * traded;
      const mismatch = Math.abs(Number(arrival(body, angle, cell)) || 0);
      const penalty = arrivalWeight * mismatch;
      terms.set(`${i}|${j}`, { win, traded, cover, mismatch, penalty });
      return cover - penalty;
    }
  });

  // ---- the answer ---------------------------------------------------------
  const assignment = [];
  for (const pair of pairs) {
    const t = terms.get(`${pair.i}|${pair.j}`);
    const a = considered[pair.j];
    assignment.push({
      slot: pack[pair.i].slot,
      body: pack[pair.i].body,
      angle: a.angle,
      key: a.key,
      label: a.label,
      mass: a.mass,
      pWin: t.win,
      pTraded: t.traded,
      cover: t.cover,
      mismatch: t.mismatch,
      penalty: t.penalty,
      value: pair.value,
      motive:
        `slot ${pack[pair.i].slot} pre-aims ${a.label}: ` +
        `${a.mass.toFixed(2)} mass, win ${t.win.toFixed(2)}, trade ${t.traded.toFixed(2)}`
    });
  }
  assignment.sort((a, b) => b.mass - a.mass || (a.key < b.key ? -1 : 1));

  const takenKeys = new Set(assignment.map((a) => a.key));
  const uncovered = considered
    .filter((c) => !takenKeys.has(c.key))
    .sort((a, b) => b.mass - a.mass || (a.key < b.key ? -1 : 1));

  const sum = (rows) => rows.reduce((t, r) => t + r.mass, 0);
  const coveredMass = sum(assignment);
  const uncoveredMass = sum(uncovered);
  const droppedMass = sum(dropped);

  const out = {
    assignment,
    uncovered,
    /** The honest price of the entry: mass we looked at and nobody took. */
    uncoveredMass,
    coveredMass,
    /** Everything that cleared the floor and the cap. */
    consideredMass: coveredMass + uncoveredMass,
    /** Below the floor or past the cap. Real mass, reported, not covered. */
    dropped,
    droppedMass,
    /** What to ask a teammate to flash (19.6). */
    flashTarget: uncovered[0] || null,
    /** Bodies with nothing worth pre-aiming: free for the plant, the trade, the lurk. */
    idle: idleRows.map((i) => pack[i].slot),
    motive: ''
  };
  out.motive = partitionMotive(out);
  return out;
}

/** Default mismatch: both clocks known, or no penalty at all. */
export function defaultArrivalMismatch(body, angle) {
  if (!Number.isFinite(body?.arrival) || !Number.isFinite(angle?.opensAt)) return 0;
  return Math.abs(body.arrival - angle.opensAt);
}

/**
 * One line, because a decision that cannot be explained in one line is not
 * shippable (decision 21). No em dashes: the inspector renders these.
 */
export function partitionMotive(partition) {
  const total = partition.assignment.length + partition.uncovered.length;
  if (!total) return 'no angle on this corridor clears the floor';
  const head = `${partition.assignment.length} of ${total} angles covered (${partition.coveredMass.toFixed(2)} mass)`;
  if (!partition.uncovered.length) return `${head}, nothing left open`;
  const open = partition.uncovered
    .slice(0, 3)
    .map((u) => `${u.label} ${u.mass.toFixed(2)}`)
    .join(', ');
  return `${head}; open: ${open}. Price ${partition.uncoveredMass.toFixed(2)}`;
}

/** Which angle a body is pre-aiming, or null if it was left free. */
export function angleFor(partition, slot) {
  return partition.assignment.find((a) => a.slot === slot) || null;
}

/**
 * Man-down execution, for free (19.5, claim 4). Re-solve over the remaining
 * bodies; the uncovered mass rises by exactly what the missing body was
 * holding, and "do we still go" becomes a number with a sentence attached.
 *
 * @param {object} input  the same argument object `clearPartition` takes
 * @param {number|number[]} down  slot(s) no longer entering
 */
export function manDown(input, down) {
  const gone = new Set(Array.isArray(down) ? down : [down]);
  const before = clearPartition(input);
  const after = clearPartition({
    ...input,
    bodies: (input.bodies || []).filter((b, i) => !gone.has(slotOf(b, i)))
  });
  const addedMass = after.uncoveredMass - before.uncoveredMass;
  const who = [...gone].join(', ');
  return {
    before,
    after,
    addedMass,
    motive:
      `without slot ${who} the entry opens ${addedMass.toFixed(2)} more mass ` +
      `(${before.uncoveredMass.toFixed(2)} to ${after.uncoveredMass.toFixed(2)})`
  };
}

/**
 * The post-round grade, separate from the duel (19.5 claim 3, 18.6).
 *
 * Given where the killer actually was, was he in the covered set or the
 * uncovered set? The plan writes two verdicts; there is honestly a third, and
 * collapsing it into "uncovered" would blame the partition for a failure of
 * the belief. An angle nobody even considered is a READ error: the mass was
 * never there to partition. An angle that was considered and left open is a
 * PARTITION error: we saw it, we priced it, we went anyway. Both feed the
 * mistake ledger, and they are not the same mistake.
 *
 * @param {object} partition  a `clearPartition` result
 * @param {object} killer     the angle he actually held: {anchor, level} or {id}
 */
export function gradeEntry(partition, killer) {
  const key = angleKey(killer);
  const label = angleLabel(killer);

  const held = partition.assignment.find((a) => a.key === key);
  if (held) {
    return {
      verdict: 'covered',
      blame: 'duel',
      slot: held.slot,
      mass: held.mass,
      angle: held.angle,
      line: `covered: slot ${held.slot} pre-aimed ${held.label} and lost the duel`
    };
  }

  const open = partition.uncovered.find((u) => u.key === key);
  if (open) {
    return {
      verdict: 'uncovered',
      blame: 'partition',
      slot: null,
      mass: open.mass,
      angle: open.angle,
      line: `uncovered: ${open.label} carried ${open.mass.toFixed(2)} mass and nobody took it`
    };
  }

  const cut = partition.dropped.find((d) => d.key === key);
  return {
    verdict: 'unconsidered',
    blame: 'read',
    slot: null,
    mass: cut ? cut.mass : 0,
    angle: cut ? cut.angle : killer,
    line: cut
      ? `unconsidered: ${cut.label} was cut by the ${cut.why} at ${cut.mass.toFixed(2)} mass`
      : `unconsidered: ${label} was not on the corridor's angle set at all`
  };
}

// ---- adapters: how the real modules plug in --------------------------------

/**
 * mass, from the joint belief (19.2/19.3). `weaponClass` is the typing: pass
 * 'awp' and the partition prices the AWP field instead of the whole team.
 *
 * @param {{massAt: (anchor:string, level:string, weaponClass:?string) => number}} belief
 */
export function massFromBelief(belief, weaponClass = null) {
  return (angle) => belief.massAt(angle.anchor, angle.level || 'default', weaponClass);
}

/**
 * pTraded, from 6.12's trade geometry. A held line is cover now; ground a mate
 * can reach inside the trade window is cover soon; neither is not cover, and
 * the floor is deliberately above zero because an untraded death still takes
 * the angle off the table for a second or two.
 *
 * @param {object} args
 * @param {(angle:object) => {x:number,y:number,level?:string}} args.spotOf
 *   where the killer fires from; bind to `catalogue.entries[a.index].world`
 * @param {(ax,ay,bx,by,level:string) => boolean} args.canSee
 * @param {(from:object, to:object) => number} [args.travelSeconds]
 * @param {number} [args.line]   `[calibrate]`
 * @param {number} [args.reach]  `[calibrate]`
 * @param {number} [args.none]   `[calibrate]`
 */
export function pTradedFromGeometry({
  spotOf,
  canSee,
  travelSeconds = null,
  line = 0.85,
  reach = 0.6,
  none = 0.1
}) {
  return (body, angle, ctx) => {
    const killerSpot = spotOf(angle);
    if (!killerSpot) return none;
    let best = none;
    for (const mate of ctx.bodies) {
      if (mate === body) continue;
      const cover = tradeCover({ killerSpot, mate: pointOf(mate), canSee, travelSeconds });
      if (!cover.covered) continue;
      const p = cover.how === 'line' ? line : reach;
      if (p > best) best = p;
    }
    return best;
  };
}
