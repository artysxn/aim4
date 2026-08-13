// ---------------------------------------------------------------------------
// shared/sim/protocols.js
// Composite options: the reusable multi-body procedures, one tier above 6.6.
//
// SIM-PLAN 20.5. Chapters 1, 7, 12, and 13 specify procedures that a team runs
// rather than a body: a three-man take, WICK, a block cycle. They are not new
// machinery. They have exactly the shape options.js already gives a single
// body — an initiation set, bound roles, a fixed micro-controller, and a
// termination condition — so they are modelled as the SAME object one tier up,
// and the tier is the only difference:
//
//   a single-body option's micro-controller compiles to an IndividualIntent
//   a PROTOCOL's micro-controller compiles to per-body OPTION ASSIGNMENTS,
//     which the option layer then compiles to intents
//
// Nothing new reaches the engine. The translator is still the only thing that
// touches it, the option vocabulary is still the only vocabulary, and a
// protocol is priceable because its parts are (19.6's two-body joint pricing,
// generalized to three and four by assigning rather than by enumerating).
//
// Two differences from the single-body tier are deliberate rather than
// accidents of implementation:
//
//   INITIATION IS A READ, NOT ENGINE TRUTH. `initiationSet(engine, slot)` asks
//   engine truth only, because whether your feet may start a thing is a fact.
//   Whether three bodies SHOULD convert an Unknown is a judgement over the
//   belief, the clock, and who holds which grenade, so a protocol's initiation
//   is a table of named clauses in the style of triggers.js, evaluated against
//   a context the arbiter assembles. A refusal names the clause that refused,
//   which is what makes "the protocol did not start" a printable sentence
//   instead of a false.
//
//   ROLES ARE BOUND, AND THEY SPEAK shape.js. A bound role is a (role, focus)
//   pair out of ROLE_FOCUS plus an option mask, so binding a protocol onto the
//   team's shape is a lookup and not a second vocabulary. Under-strength is a
//   first-class case: every role carries a `min`, so a four-man team runs the
//   five-man procedure with the rifle group one body light and says so.
//
// WICK IS A STATE MACHINE, NOT A SCRIPT. Wait, Identify, Confirm, Kill, each
// with its own masks and its own success condition, one branch (they pushed,
// so the contact came to us) and one back edge (nothing there, poke the other
// extremity). The doctrine's claim, that you always end up with a local 4v1
// somewhere, is falsifiable, and `wickManCountDistribution` is the falsifier:
// it drives the real machine over synthetic worlds and prints the distribution
// of man-count-at-contact. The measurement is deliberately taken at the moment
// of CONTACT rather than at the moment of success, because measuring only the
// contacts that succeeded would prove the threshold, not the doctrine.
//
// THE ANTIFLASH ROLE IS A PERCEPT-LEVEL OBLIGATION. One body in a grouped
// contact faces away from the likely flash bearing, is therefore not blinded,
// and is promoted to first contact when the entry is. Both halves are pure
// functions here and the wiring lives in desireBot.js: `antiflashYaw` biases
// the yaw target past the 90 degree cone where grenades.js stops charging full
// blindness, and `antiflashPromotion` fires on the entry's flash state and
// nothing else. Grouped bot pushes stop being all-or-nothing.
//
// Every protocol, every clause, and every phase carries a motive string that
// explains itself in one line (decision 21), because a composite decision that
// cannot be read back is worse than no composite decision at all.
//
// Randomness is injected (rng.js) and there is no I/O, so a protocol trial is
// as reproducible as a round.
// ---------------------------------------------------------------------------

import { DECISION_EVERY_TICKS, FLASH_VISION_BLIND, TICK_RATE, ticksFor } from './constants.js';
import { NADE } from './grenades.js';
import { OPTION_DEFS } from './options.js';
import { ROLE_FOCUS } from './shape.js';
import { ZONE } from './zones.js';

export const PROTOCOLS_VERSION = 1;

/**
 * A protocol is a bigger promise than an option, so it is committed to for
 * longer: two seconds against the option layer's 0.375. A team that re-picks
 * its procedure at 8 Hz has no procedure. `[calibrate]`
 */
export const PROTOCOL_MIN_COMMIT_TICKS = ticksFor(2);

/** Belief mass bounds that make a zone read as a POCKET rather than a stack. */
export const POCKET_FLOOR = 0.5;
export const POCKET_CEILING = 2.5;

/** Seconds either side of a block-cycle clock mark that still counts as it. */
export const CLOCK_MARK_TOLERANCE = 5;

// ---------------------------------------------------------------------------
// The table. Straight from 20.5, one row per protocol, all data.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BoundRole
 * @property {string} id        the role's name inside the protocol
 * @property {string} role      a ROLE_FOCUS key (shape.js speaks this)
 * @property {string} focus     one of ROLE_FOCUS[role]
 * @property {number|'all'} count
 * @property {number} min       below this the protocol cannot run
 * @property {string[]} mask    options this role may run; mask[0] is the lead,
 *                              the one the micro-controller picks unless the
 *                              arbiter (6.17) prices another higher
 * @property {object} [params]  overrides merged onto the filled option params
 * @property {string} [mateOf]  role id this one is paired to, for `mate`
 * @property {string} motive
 */

export const PROTOCOL_DEFS = Object.freeze({
  // ---- Three-man take: the doctrine's unit of ground conversion ------------
  three_man_take: {
    label: 'three-man take',
    bodies: 3,
    source: 'Ch 1, Ch 7, Ch 12',
    motive: 'converting a named Unknown with three bodies and one grenade',
    timeoutSeconds: 35,
    roles: [
      {
        id: 'support',
        role: 'support',
        focus: 'tight',
        count: 1,
        min: 1,
        mask: ['utility_setup', 'hold_angle', 'trade'],
        params: { utilityType: NADE.SMOKE },
        motive: 'holds the unlocking utility from Safe: the take is bought, not charged'
      },
      {
        id: 'entry1',
        role: 'entry',
        focus: 'aggressive',
        count: 1,
        min: 1,
        mask: ['clear', 'wide_swing', 'take_space'],
        params: { gait: 'run' },
        motive: 'gun out, clears the corners, permitted to die'
      },
      {
        id: 'entry2',
        role: 'entry',
        focus: 'measured',
        count: 1,
        min: 1,
        mask: ['trade', 'refrag', 'follow'],
        mateOf: 'entry1',
        motive: 'two metres back: the trade is guaranteed rather than hoped for'
      }
    ],
    initiation: {
      motive: 'a target Unknown, three available bodies, the right utility in the right hands',
      clauses: [
        {
          id: 'target_unknown',
          need: 'the target zone still reads Unknown',
          test: (c) => c.targetZoneClass === ZONE.UNKNOWN
        },
        {
          id: 'three_bodies',
          need: 'three bodies free of other work',
          test: (c) => (c.available ?? 0) >= 3
        },
        {
          id: 'utility_in_hand',
          need: 'the unlocking grenade in the support body',
          test: (c) => Boolean(c.utilityInHand)
        }
      ]
    },
    terminate: [
      {
        id: 'zone_is_risk',
        test: (a, c) => c.targetZoneClass === ZONE.RISK,
        motive: 'the Unknown converted: the zone is ours and contested, which is the point'
      },
      {
        id: 'two_down',
        test: (a, c) => (c.lost ?? 0) >= 2,
        motive: 'two of the three are down: the take is off'
      },
      {
        id: 'abort',
        test: (a, c) => Boolean(c.abort),
        motive: (a, c) => `the abort clause fired: ${typeof c.abort === 'string' ? c.abort : 'stated up front'}`
      }
    ]
  },

  // ---- WICK: the man-advantage machine -------------------------------------
  wick: {
    label: 'WICK',
    bodies: 5,
    source: 'Ch 4, Ch 7, Ch 9',
    motive: 'trading time for an isolated pocket, then collapsing four onto it',
    timeoutSeconds: 90,
    machine: 'wick',
    roles: [
      {
        id: 'core',
        role: 'support',
        focus: 'tight',
        count: 3,
        min: 2,
        mask: ['hold_angle', 'rotate', 'take_space', 'refrag'],
        motive: 'the three-core: central enough to reach either side inside fifteen seconds'
      },
      {
        id: 'prober',
        role: 'entry',
        focus: 'measured',
        count: 1,
        min: 1,
        mask: ['jiggle', 'shoulder_peek', 'wide_swing', 'punish_window'],
        motive: 'exactly one extremity body pokes: one body buys the read, four keep the shape'
      },
      {
        id: 'lurker',
        role: 'lurk',
        focus: 'connected',
        count: 1,
        min: 1,
        mask: ['lurk', 'flank', 'refrag'],
        motive: 'connected, not lost: the lurk is the fifth body of the collapse'
      }
    ],
    initiation: {
      motive: 'a man advantage, or a CT side the clock is forcing to move',
      clauses: [
        {
          id: 'advantage_or_forced',
          need: 'a man up, or an enemy the clock is forcing out of its holds',
          test: (c) => (c.ours ?? 0) - (c.theirs ?? 0) >= 1 || Boolean(c.enemyForcedToMove)
        },
        {
          id: 'four_bodies',
          need: 'four bodies: a core, a prober, and a lurk',
          test: (c) => (c.available ?? 0) >= 4
        }
      ]
    },
    terminate: [
      {
        id: 'local_advantage',
        test: (a) => a.micro.wick?.done?.reason === 'local_advantage',
        motive: (a) => a.micro.wick?.done?.motive || 'contact confirmed and the local advantage is ours'
      },
      {
        id: 'no_local_advantage',
        test: (a) => Boolean(a.micro.wick?.done) && a.micro.wick.done.reason !== 'local_advantage',
        motive: (a) => a.micro.wick?.done?.motive || 'contact came without a local advantage in it'
      },
      {
        id: 'advantage_lost',
        test: (a, c) =>
          Number.isFinite(c.ours) &&
          Number.isFinite(c.theirs) &&
          c.ours - c.theirs < 0 &&
          !c.enemyForcedToMove,
        motive: 'the man advantage that justified waiting is gone'
      }
    ]
  },

  // ---- Block cycle (CT): buying seconds with grenades -----------------------
  block_cycle: {
    label: 'block cycle',
    bodies: 1,
    side: 'CT',
    source: 'Ch 6, Ch 8',
    motive: 'cycling utility into the choke so the clock does the defending',
    timeoutSeconds: 25,
    roles: [
      {
        id: 'blocker',
        role: 'anchor',
        focus: 'close',
        count: 1,
        min: 1,
        mask: ['utility_setup', 'off_angle_hold', 'hold_angle'],
        params: { utilityType: NADE.MOLOTOV },
        motive: 'whoever owns the lineup throws it: a block nobody practised is a block nobody has'
      }
    ],
    initiation: {
      motive: 'the clock is on a block mark, or the read spiked early',
      clauses: [
        {
          id: 'ct_side',
          need: 'a CT side: the block buys time only for the side that has time to buy',
          test: (c) => c.side === 'CT'
        },
        {
          id: 'mark_or_spike',
          need: 'the clock near 1:00 or 0:40, or an early threat spike at the choke',
          test: (c) =>
            nearMark(c.clockSeconds, 60) || nearMark(c.clockSeconds, 40) || Boolean(c.threatSpike)
        },
        {
          id: 'lineup_owned',
          need: 'somebody alive who owns the lineup and still has the grenade',
          test: (c) => c.lineupOwner != null && (c.utilityLeft ?? 0) > 0
        }
      ]
    },
    terminate: [
      {
        id: 'stall_window_elapsed',
        test: (a, c) => (c.stallSecondsLeft ?? Infinity) <= 0,
        motive: 'the stall window elapsed: the block bought its seconds and is done'
      },
      {
        id: 'no_utility_left',
        test: (a, c) => (c.utilityLeft ?? 1) <= 0,
        motive: 'the lineup owner is out of grenades: there is no cycle left to run'
      }
    ]
  },

  // ---- Divide and conquer: beating pockets one at a time -------------------
  divide_and_conquer: {
    label: 'divide and conquer',
    bodies: 5,
    source: 'Ch 13',
    motive: 'their pockets are beatable one at a time, so engage exactly one',
    timeoutSeconds: 40,
    roles: [
      {
        id: 'rifles',
        role: 'entry',
        focus: 'measured',
        count: 3,
        min: 2,
        mask: ['take_space', 'hold_angle', 'wide_swing'],
        motive: 'three rifles at the point: enough weight that the pocket cannot hold'
      },
      {
        id: 'support',
        role: 'support',
        focus: 'tight',
        count: 1,
        min: 1,
        mask: ['utility_setup', 'trade'],
        params: { utilityType: NADE.FLASH },
        motive: 'a ready pop, held rather than spent: the pocket opens on command'
      },
      {
        id: 'pincher',
        role: 'lurk',
        focus: 'deep',
        count: 1,
        min: 1,
        mask: ['flank', 'lurk', 'run_in_behind'],
        motive: 'the second side of the pocket: a pocket with one way out is a fight, not a pinch'
      }
    ],
    initiation: {
      motive: 'their distribution reads as pockets and no clean pick is on offer',
      clauses: [
        {
          id: 'pockets_read',
          need: 'at least two pockets, each small enough to beat',
          test: (c) => pocketCount(c.pockets) >= 2
        },
        {
          id: 'no_clean_pick',
          need: 'no clean pick available: a pick is cheaper than a pinch',
          test: (c) => !c.cleanPickAvailable
        },
        {
          id: 'four_bodies',
          need: 'four bodies: two rifles, a pop, and a pinch',
          test: (c) => (c.available ?? 0) >= 4
        }
      ]
    },
    terminate: [
      {
        id: 'pocket_engaged',
        test: (a, c) => Boolean(c.pocketEngaged),
        motive: 'the pocket is engaged: the procedure has handed the fight over'
      },
      {
        id: 'window_closed',
        test: (a, c) => (c.timingWindowSecondsLeft ?? Infinity) <= 0,
        motive: 'the timing window closed: the pockets are no longer pockets'
      }
    ]
  },

  // ---- Antiflash: one body per grouped contact keeps its eyes --------------
  antiflash: {
    label: 'antiflash',
    bodies: 1,
    source: 'Ch 2',
    motive: 'one body of the group faces away, so a flash cannot take the whole group',
    timeoutSeconds: 20,
    roles: [
      {
        id: 'antiflash',
        role: 'support',
        focus: 'wide',
        count: 1,
        min: 1,
        mask: ['hold_angle', 'off_angle_hold', 'crossfire_hold'],
        motive: 'yaw biased past the blind cone: not blinded, therefore next in line'
      }
    ],
    initiation: {
      motive: 'two or more bodies grouped in a Risk zone',
      clauses: [
        {
          id: 'grouped',
          need: 'two or more bodies grouped together',
          test: (c) => (c.groupedBodies ?? 0) >= 2
        },
        {
          id: 'in_risk',
          need: 'the group standing in a Risk zone, where a flash is actually coming',
          test: (c) => c.zoneClass === ZONE.RISK
        }
      ]
    },
    terminate: [
      {
        id: 'contact_resolved',
        test: (a, c) => Boolean(c.contactResolved),
        motive: 'the contact resolved: there is nothing left to be the spare eyes for'
      },
      {
        id: 'ungrouped',
        test: (a, c) => (c.groupedBodies ?? 0) < 2,
        motive: 'the group broke up: an antiflash body with nobody to cover is just a body'
      }
    ]
  },

  // ---- Sync peek: spending a man advantage all at once ---------------------
  sync_peek: {
    label: 'sync peek',
    bodies: 5,
    source: 'Ch 15',
    motive: 'two men up, so every angle opens at once and none of them trades',
    timeoutSeconds: 12,
    roles: [
      {
        id: 'peeker',
        role: 'entry',
        focus: 'aggressive',
        count: 'all',
        min: 2,
        mask: ['wide_swing', 'punish_window', 'jiggle'],
        motive: 'everyone peeks on the same count: a stagger is what gives the fight back'
      }
    ],
    initiation: {
      motive: 'a man advantage of two or more, which is what pays for the whole team peeking',
      clauses: [
        {
          id: 'two_up',
          need: 'a man advantage of +2 or more',
          test: (c) => (c.ours ?? 0) - (c.theirs ?? 0) >= 2
        },
        {
          id: 'two_bodies',
          need: 'at least two living bodies to peek together',
          test: (c) => (c.available ?? 0) >= 2
        }
      ]
    },
    terminate: [
      {
        id: 'everyone_peeked',
        test: (a, c) => Number.isFinite(c.peeked) && c.peeked >= (c.peekers ?? a.bound.length),
        motive: 'everyone peeked: the count is spent'
      },
      {
        id: 'cancelled',
        test: (a, c) => Boolean(c.cancelled),
        motive: 'the call was cancelled before the count'
      }
    ]
  }
});

export const PROTOCOL_IDS = Object.freeze(Object.keys(PROTOCOL_DEFS));

/** Is the round clock within tolerance of a named block-cycle mark? */
function nearMark(clockSeconds, mark) {
  return Number.isFinite(clockSeconds) && Math.abs(clockSeconds - mark) <= CLOCK_MARK_TOLERANCE;
}

/** How many of the read zones are pockets: occupied, but beatably so. */
function pocketCount(pockets) {
  if (!Array.isArray(pockets)) return 0;
  let n = 0;
  for (const p of pockets) {
    const e = p?.expected ?? 0;
    if (e >= POCKET_FLOOR && e <= POCKET_CEILING) n += 1;
  }
  return n;
}

/** Rows may state their motive flatly or compute it from the situation. */
function motiveOf(row, active, ctx) {
  return typeof row.motive === 'function' ? row.motive(active, ctx) : row.motive;
}

// ---------------------------------------------------------------------------
// Initiation: which procedures may start, and which clause said no
// ---------------------------------------------------------------------------

/**
 * The protocol context. Everything here is a READ or a clock, never a body:
 * this file consumes belief summaries (knowledge.js `expected`, `countDist`,
 * `aliveCount`) and zone classes (zones.js), exactly as triggers.js does.
 *
 * @typedef {object} ProtocolContext
 * @property {'T'|'CT'} [side]
 * @property {number} [clockSeconds]     seconds left on the round clock
 * @property {number} [ours]             living bodies on my side
 * @property {number} [theirs]           believed living enemies
 * @property {number} [available]        bodies free to be bound to roles
 * @property {string} [targetZone]
 * @property {string} [targetZoneClass]  ZONE.* for the target (zones.js)
 * @property {string} [zoneClass]        ZONE.* for where the group is standing
 * @property {boolean} [utilityInHand]
 * @property {boolean} [enemyForcedToMove]
 * @property {boolean} [threatSpike]
 * @property {number} [utilityLeft]
 * @property {number|null} [lineupOwner]
 * @property {number} [stallSecondsLeft]
 * @property {Array<{zone:string, expected:number}>} [pockets]
 * @property {boolean} [cleanPickAvailable]
 * @property {boolean} [pocketEngaged]
 * @property {number} [timingWindowSecondsLeft]
 * @property {number} [groupedBodies]
 * @property {boolean} [contactResolved]
 * @property {number} [peeked]
 * @property {number} [peekers]
 * @property {boolean} [cancelled]
 * @property {number} [lost]             bodies lost since the protocol began
 * @property {string|boolean} [abort]    the LayerAction's abort clause (20.3)
 */

/**
 * May this protocol start, and if not, which clause refused?
 *
 * The refusal is the product. "three-man take needs the unlocking grenade in
 * the support body" is a sentence the decision log can print; a false is not.
 *
 * @param {string} id
 * @param {ProtocolContext} ctx
 * @returns {{ok:boolean, id:string, motive:string, refusedBy:string|null}}
 */
export function initiationCheck(id, ctx = {}) {
  const def = PROTOCOL_DEFS[id];
  if (!def) throw new Error(`protocols: unknown protocol ${id}`);
  for (const clause of def.initiation.clauses) {
    if (!clause.test(ctx)) {
      return {
        ok: false,
        id,
        refusedBy: clause.id,
        motive: `${def.label} needs ${clause.need}`
      };
    }
  }
  return { ok: true, id, refusedBy: null, motive: `${def.label}: ${def.initiation.motive}` };
}

/**
 * Which protocols may START right now. The composite mirror of
 * `initiationSet(engine, slot)`, over a read rather than over engine truth.
 *
 * @param {ProtocolContext} ctx
 * @returns {Set<string>}
 */
export function protocolInitiationSet(ctx = {}) {
  const out = new Set();
  for (const id of PROTOCOL_IDS) if (initiationCheck(id, ctx).ok) out.add(id);
  return out;
}

// ---------------------------------------------------------------------------
// Binding: protocol roles onto the shape's bodies
// ---------------------------------------------------------------------------

/**
 * Bind roles to bodies, preferring the ones already playing them.
 *
 * The roster is shape.js's own currency: `{slot, role, focus}` posts, which is
 * what `makeShape` produces and what `backfill` moves around. Scoring is role
 * first, focus second, slot order last, so binding is deterministic without an
 * rng and two identical rosters bind identically in every replay.
 *
 * Under-strength is not a failure until a role drops below its `min`: a team
 * of four runs the five-body procedure with the rifle group one light, which
 * is what a team of four actually does.
 *
 * @param {string} id
 * @param {Array<{slot:number, role?:string, focus?:string, alive?:boolean}>} roster
 * @returns {{ok:boolean, bound:Array, unfilled:string[], motive:string}}
 */
export function bindRoles(id, roster = []) {
  const def = PROTOCOL_DEFS[id];
  if (!def) throw new Error(`protocols: unknown protocol ${id}`);

  const pool = roster.filter((b) => b && b.alive !== false).map((b) => ({ ...b }));
  const bound = [];
  const unfilled = [];
  const taken = new Set();

  for (const role of def.roles) {
    const want = role.count === 'all' ? pool.length : role.count;
    const ranked = pool
      .filter((b) => !taken.has(b.slot))
      .map((b) => ({
        b,
        score: (b.role === role.role ? 2 : 0) + (b.focus === role.focus ? 1 : 0)
      }))
      .sort((x, y) => y.score - x.score || x.b.slot - y.b.slot);

    let filled = 0;
    for (const { b } of ranked) {
      if (filled >= want) break;
      taken.add(b.slot);
      bound.push({
        slot: b.slot,
        roleId: role.id,
        role: role.role,
        focus: role.focus,
        mask: [...role.mask],
        wasPlaying: b.role || null,
        motive: role.motive
      });
      filled += 1;
    }
    if (filled < role.min) unfilled.push(role.id);
  }

  const ok = unfilled.length === 0;
  return {
    ok,
    bound,
    unfilled,
    motive: ok
      ? `${def.label}: ${bound.length} bodies bound, ${def.roles.length} roles filled`
      : `${def.label} cannot run: no bodies for ${unfilled.join(', ')}`
  };
}

// ---------------------------------------------------------------------------
// The lifecycle: begin, step, terminate, replace. beginOption's shape, one
// tier up.
// ---------------------------------------------------------------------------

/**
 * An active protocol.
 * @typedef {object} ActiveProtocol
 * @property {string} id
 * @property {object} params
 * @property {Array} bound
 * @property {number} startedTick
 * @property {number} minCommitTicks
 * @property {number} timeoutTick
 * @property {object} micro   per-protocol scratch; WICK keeps its machine here
 * @property {string} motive
 */

/**
 * Start a protocol. Pure: returns the record, mutates nothing but its own
 * fresh state. The binding happens here because a protocol without bound roles
 * is a name, not a procedure.
 */
export function beginProtocol(
  id,
  { tick = 0, params = {}, roster = [], minCommitTicks = PROTOCOL_MIN_COMMIT_TICKS } = {}
) {
  const def = PROTOCOL_DEFS[id];
  if (!def) throw new Error(`protocols: unknown protocol ${id}`);
  const binding = bindRoles(id, roster);
  const active = {
    id,
    params: { ...params },
    bound: binding.bound,
    binding,
    startedTick: tick,
    minCommitTicks,
    timeoutTick: tick + ticksFor(def.timeoutSeconds),
    micro: {},
    motive: `${def.label}: ${def.motive}`
  };
  if (def.machine === 'wick') active.micro.wick = new WickMachine({ tick });
  return active;
}

/**
 * Should this protocol end now, and why?
 *
 * The same shape as `checkTermination`: a table of named conditions, plus the
 * universal timeout. Every row carries the motive that will be logged, so an
 * ending is never an unexplained disappearance from the log.
 *
 * @param {ActiveProtocol} active
 * @param {number} tick
 * @param {ProtocolContext} ctx
 * @returns {{reason:string, motive:string}|null}
 */
export function checkProtocolTermination(active, tick, ctx = {}) {
  const def = PROTOCOL_DEFS[active.id];
  for (const row of def.terminate) {
    if (row.test(active, ctx)) return { reason: row.id, motive: motiveOf(row, active, ctx) };
  }
  if (tick >= active.timeoutTick) {
    return { reason: 'timeout', motive: `${def.label}: the window elapsed without an ending` };
  }
  return null;
}

/** May the arbiter deliberately replace a running protocol? (6.6's clocks.) */
export function mayReplaceProtocol(active, tick, gate) {
  if (tick - active.startedTick < active.minCommitTicks) return false;
  return gate ? gate.mayDecide(tick) : true;
}

/**
 * Protocol params are a small shared vocabulary and `OPTION_DEFS[id].params`
 * already names what each option needs, so filling one from the other by name
 * keeps the table free of per-role plumbing: a role's mask can be re-ordered,
 * or an option swapped for a cousin, without touching any code.
 */
function optionParams(optionId, p, view = {}) {
  const want = OPTION_DEFS[optionId]?.params || [];
  const out = {};
  for (const key of want) {
    switch (key) {
      case 'spot':
        out.spot = p.spot ?? p.target ?? null;
        break;
      case 'cover':
        out.cover = p.cover ?? p.from ?? null;
        break;
      case 'yaw':
        out.yaw = p.yaw ?? null;
        break;
      case 'target':
        out.target = p.target ?? null;
        break;
      case 'site':
        out.site = p.site ?? null;
        break;
      case 'entry':
        out.entry = p.entry ?? p.target ?? null;
        break;
      case 'enemyAnchor':
        out.enemyAnchor = p.enemyAnchor ?? p.at ?? null;
        break;
      case 'mate':
        out.mate = view.mate ?? null;
        break;
      case 'trackSlot':
        out.trackSlot = view.mate ?? null;
        break;
      case 'cornerSeq':
        out.cornerSeq = p.cornerSeq ?? (p.target ? [p.target] : []);
        break;
      case 'utilityType':
        out.utilityType = p.utilityType ?? NADE.SMOKE;
        break;
      case 'at':
        out.at = p.at ?? p.gate ?? p.target ?? null;
        break;
      case 'gait':
        out.gait = p.gait ?? 'run';
        break;
      case 'delaySeconds':
        out.delaySeconds = p.delaySeconds ?? 1;
        break;
      case 'mode':
        out.mode = p.mode ?? null;
        break;
      default:
        out[key] = p[key] ?? null;
    }
  }
  return out;
}

/**
 * The protocol tier's micro-controller: one decision step in, per-body OPTION
 * ASSIGNMENTS out.
 *
 * This is the exact analogue of `microIntent`, and the reason the tier costs
 * so little: a protocol never speaks to the engine, it speaks to the option
 * layer, which already knows how to compile an option into an intent.
 *
 * @param {ActiveProtocol} active
 * @param {number} tick
 * @param {ProtocolContext} ctx
 * @returns {Array<{slot:number, roleId:string, optionId:string, params:object, mask:string[], motive:string}>}
 */
export function protocolAssignments(active, tick, ctx = {}) {
  const def = PROTOCOL_DEFS[active.id];
  const wick = active.micro.wick;
  const phase = wick ? WICK_PHASES[wick.phase] : null;

  const slotOf = (roleId) => active.bound.find((b) => b.roleId === roleId)?.slot ?? null;

  const out = [];
  for (const b of active.bound) {
    const roleDef = def.roles.find((r) => r.id === b.roleId);
    // A machine phase overrides the role's standing mask: that is what makes
    // WICK a state machine rather than five bodies with fixed jobs.
    const mask = phase?.masks?.[b.roleId] || b.mask;
    const optionId = mask[0];
    const params = {
      ...optionParams(optionId, active.params, { mate: slotOf(roleDef?.mateOf) }),
      ...(roleDef?.params || {})
    };
    out.push({
      slot: b.slot,
      roleId: b.roleId,
      optionId,
      params,
      mask: [...mask],
      motive: phase ? `${phase.id}: ${phase.motive}` : b.motive
    });
  }
  return out;
}

/**
 * One team's protocol lifecycle. Owns the active record and nothing else, so
 * that it stacks over OptionRunner exactly the way OptionRunner stacks over
 * the translator: the arbiter decides WHAT procedure runs, this decides
 * whether it is still running and what each body should be doing.
 */
export class ProtocolRunner {
  /** @param {object} [cfg]  {gate?: import('./attention.js').LatencyGate} */
  constructor({ gate = null } = {}) {
    this.gate = gate;
    /** @type {ActiveProtocol|null} */
    this.active = null;
    /** @type {{id:string, reason:string, motive:string, tick:number}|null} */
    this.lastEnd = null;
  }

  begin(tick, id, opts = {}) {
    if (this.active) {
      this.lastEnd = {
        id: this.active.id,
        reason: 'orderChanged',
        motive: 'the team called something else',
        tick
      };
    }
    this.active = beginProtocol(id, { tick, ...opts });
    if (this.gate) this.gate.decided();
    return this.active;
  }

  /**
   * One decision step: advance any machine, test termination, and emit the
   * per-body assignments.
   *
   * @returns {{assignments:Array, phase:string|null, ended:{id:string, reason:string, motive:string}|null}}
   */
  step(tick, ctx = {}) {
    if (!this.active) return { assignments: [], phase: null, ended: null };
    const wick = this.active.micro.wick;
    if (wick) wick.step(tick, ctx);

    const end = checkProtocolTermination(this.active, tick, ctx);
    if (end) {
      const ended = { id: this.active.id, ...end };
      this.lastEnd = { ...ended, tick };
      this.active = null;
      return { assignments: [], phase: null, ended };
    }
    return {
      assignments: protocolAssignments(this.active, tick, ctx),
      phase: wick ? wick.phase : null,
      ended: null
    };
  }

  mayReplace(tick) {
    if (!this.active) return true;
    return mayReplaceProtocol(this.active, tick, this.gate);
  }
}

// ---------------------------------------------------------------------------
// WICK: Wait, Identify, Confirm, Kill
//
// A machine, not a script: four phases, each with its own masks and its own
// success condition, one branch out of Wait (they pushed, so the contact came
// to us and Identify and Confirm are moot), and one back edge out of Confirm
// (the poke found nothing, so re-place and poke the other extremity).
// ---------------------------------------------------------------------------

/** Seconds the Wait phase holds before the core starts moving. `[calibrate]` */
export const WICK_WAIT_SECONDS = 20;

/** The advantage that counts as the doctrine's local 4v1: four of ours to one. */
export const WICK_LOCAL_ADVANTAGE = 3;

export const WICK_PHASE_IDS = Object.freeze(['wait', 'identify', 'confirm', 'kill']);

export const WICK_PHASES = Object.freeze({
  wait: {
    id: 'wait',
    timeoutSeconds: 40,
    masks: {
      core: ['hold_angle', 'crossfire_hold'],
      prober: ['hold_angle', 'jiggle'],
      lurker: ['lurk']
    },
    /** Either they came to us, or the hold has bought what it was going to. */
    success: (ctx) =>
      Boolean(ctx.enemyPushed) || (ctx.holdSeconds ?? 0) >= (ctx.waitSeconds ?? WICK_WAIT_SECONDS),
    motive: 'hold: if they push we get the fight we wanted, if they stack we lose nothing'
  },
  identify: {
    id: 'identify',
    timeoutSeconds: 20,
    masks: {
      core: ['rotate', 'take_space', 'hold_angle'],
      prober: ['hold_angle'],
      lurker: ['lurk']
    },
    /** Central enough to reach either side in 10 to 15 s, and connected. */
    success: (ctx) => Boolean(ctx.coreCentral) && Boolean(ctx.lurkerConnected),
    motive: 'core to the central pathway: either side inside fifteen seconds, connected to the lurk'
  },
  confirm: {
    id: 'confirm',
    timeoutSeconds: 12,
    masks: {
      core: ['hold_angle'],
      prober: ['jiggle', 'shoulder_peek', 'wide_swing'],
      lurker: ['lurk']
    },
    success: (ctx) => Boolean(ctx.contact),
    motive: 'exactly one extremity body pokes: one body buys the read, four keep the shape'
  },
  kill: {
    id: 'kill',
    timeoutSeconds: 15,
    masks: {
      core: ['refrag', 'take_space', 'advance'],
      prober: ['trade', 'punish_window'],
      lurker: ['refrag', 'flank']
    },
    success: (ctx) => Boolean(ctx.pocketEngaged),
    motive: 'collapse four onto the isolated pocket'
  }
});

/**
 * THE MEASUREMENT HOOK. Man-count-at-contact, from a raw contact record.
 *
 * `ours` is the prober (already there, he is the one who made contact) plus
 * every collapser who can arrive before the pocket stops being isolated;
 * `theirs` is the pocket. `windowSeconds` is how long the pocket stays
 * isolated, which is their rotation, not the length of a duel: the whole point
 * of the Identify phase is to win that race, so that is the race the
 * measurement has to model.
 *
 * @param {object} contact
 * @param {number} contact.theirs
 * @param {Array<{role:string, reachSeconds:number}>} contact.collapsers
 * @param {number} contact.windowSeconds
 * @returns {{ours:number, theirs:number, key:string, advantage:number, local:boolean, arriving:string[], motive:string}}
 */
export function wickManCount(contact) {
  const arriving = (contact.collapsers || []).filter(
    (c) => c.reachSeconds <= contact.windowSeconds
  );
  const ours = 1 + arriving.length;
  const theirs = contact.theirs;
  const advantage = ours - theirs;
  return {
    ours,
    theirs,
    key: `${ours}v${theirs}`,
    advantage,
    local: advantage >= WICK_LOCAL_ADVANTAGE,
    arriving: arriving.map((c) => c.role),
    motive:
      advantage >= WICK_LOCAL_ADVANTAGE
        ? `a local ${ours}v${theirs} at ${contact.where ?? 'the pocket'}: collapse`
        : theirs > 1
          ? `${ours}v${theirs} at ${contact.where ?? 'the pocket'}: that is a stack, not a pocket`
          : `${ours}v${theirs} at ${contact.where ?? 'the pocket'}: the collapse cannot get there in time`
  };
}

export class WickMachine {
  constructor({ tick = 0 } = {}) {
    this.phase = 'wait';
    this.enteredTick = tick;
    /** @type {{phase:string, tick:number, from:string|null}[]} */
    this.history = [{ phase: 'wait', tick, from: null }];
    /** The measurement, taken once, at the moment of contact. */
    this.contact = null;
    /** @type {{reason:string, motive:string}|null} */
    this.done = null;
    /** How many pokes the Confirm phase has spent. */
    this.pokes = 0;
  }

  /** The option masks this phase imposes, per bound role id. */
  masks() {
    return WICK_PHASES[this.phase].masks;
  }

  secondsIn(tick) {
    return (tick - this.enteredTick) / TICK_RATE;
  }

  _enter(phase, tick, from) {
    this.phase = phase;
    this.enteredTick = tick;
    this.history.push({ phase, tick, from });
  }

  _finish(reason, motive) {
    this.done = { reason, motive };
    return { phase: this.phase, transitioned: false, done: this.done, motive };
  }

  /**
   * Take the contact measurement and decide whether a collapse exists at all.
   * A Kill phase with no local advantage in it is not a Kill phase, so the
   * machine says so rather than running the clock on a fight it does not want.
   */
  _contact(raw, tick, from) {
    this.contact = { ...wickManCount(raw), where: raw.where ?? raw.pocket ?? null, via: from };
    if (!this.contact.local) {
      return this._finish('no_local_advantage', this.contact.motive);
    }
    this._enter('kill', tick, from);
    return { phase: 'kill', transitioned: true, from, done: null, motive: this.contact.motive };
  }

  /**
   * One step. `ctx` is the protocol context plus the phase's own reads:
   * `enemyPushed`/`holdSeconds` for Wait, `coreCentral`/`lurkerConnected` for
   * Identify, `contact` for Confirm, `pocketEngaged` for Kill.
   */
  step(tick, ctx = {}) {
    if (this.done) return { phase: this.phase, transitioned: false, done: this.done, motive: this.done.motive };

    const def = WICK_PHASES[this.phase];
    const from = this.phase;
    const elapsed = this.secondsIn(tick);
    const timedOut = elapsed >= def.timeoutSeconds;

    if (def.success(ctx)) {
      switch (from) {
        case 'wait':
          // The branch: a push IS the contact, and it arrived at our shape.
          if (ctx.enemyPushed && ctx.contact) return this._contact(ctx.contact, tick, 'wait');
          this._enter('identify', tick, from);
          break;
        case 'identify':
          this._enter('confirm', tick, from);
          break;
        case 'confirm':
          this.pokes += 1;
          return this._contact(ctx.contact, tick, 'confirm');
        case 'kill':
          return this._finish('local_advantage', this.contact?.motive || def.motive);
        default:
          break;
      }
      return { phase: this.phase, transitioned: true, from, done: null, motive: WICK_PHASES[this.phase].motive };
    }

    if (timedOut) {
      switch (from) {
        case 'wait':
          this._enter('identify', tick, from);
          break;
        case 'identify':
          // As central as we are going to get: poke anyway.
          this._enter('confirm', tick, from);
          break;
        case 'confirm':
          // The back edge: nothing there. Re-place and poke elsewhere.
          this.pokes += 1;
          this._enter('identify', tick, from);
          break;
        case 'kill':
          return this._finish('collapse_stalled', 'the collapse never landed on the pocket');
        default:
          break;
      }
      return { phase: this.phase, transitioned: true, from, done: null, motive: WICK_PHASES[this.phase].motive };
    }

    return { phase: this.phase, transitioned: false, from, done: null, motive: def.motive };
  }
}

// ---------------------------------------------------------------------------
// Is the doctrine true? The synthetic trial behind wickManCountDistribution.
//
// The world is deliberately not generous. Enemy splits come from a table that
// encodes the same doctrine knowledge.js's header states ("a 2-2-1 is a real
// thing and a 5-0-0 is not") and includes lopsided splits, so the prober CAN
// walk into a stack; the read is noisy, so it does; and the measurement is
// taken at contact rather than at success, so the failures are counted.
// ---------------------------------------------------------------------------

/** Plausible CT splits over [extremity A, middle, extremity B]. */
const SPLITS = Object.freeze({
  3: [[1, 1, 1], [2, 1, 0], [0, 1, 2], [2, 0, 1], [1, 0, 2], [1, 2, 0], [0, 2, 1], [3, 0, 0], [0, 0, 3]],
  4: [[2, 1, 1], [1, 2, 1], [1, 1, 2], [2, 2, 0], [0, 2, 2], [2, 0, 2], [3, 1, 0], [0, 1, 3], [3, 0, 1], [1, 0, 3]],
  5: [[2, 1, 2], [2, 2, 1], [1, 2, 2], [3, 1, 1], [1, 1, 3], [1, 3, 1], [2, 3, 0], [0, 3, 2], [3, 2, 0], [0, 2, 3]]
});

const POCKET_NAMES = Object.freeze(['a_side', 'middle', 'b_side']);

/**
 * Sample one world for a WICK trial. Every band is stated with the doctrine
 * sentence it comes from, and every one of them is `[calibrate]`.
 */
export function sampleWickWorld(rng, opts = {}) {
  // WICK initiates on a man advantage OR a CT side forced to move, so the
  // enemy count spans both: 3 and 4 are the advantage, 5 is the forced case.
  const theirs = opts.theirs ?? rng.pick([3, 4, 4, 5]);
  const split = [...rng.pick(SPLITS[theirs])];

  // The read that picks where to poke. A perfect read never pokes a stack; a
  // poor one pokes at random, which is where the doctrine gets tested.
  const readQuality = opts.readQuality ?? rng.range(0.35, 0.95);
  const believed = split.map((n) => n + (1 - readQuality) * rng.range(-1.6, 1.6));

  // The extremities first, thinnest believed first: WICK pokes where isolated
  // bodies live, and mid last because mid is where they are not isolated.
  const order = [0, 2].sort((a, b) => believed[a] - believed[b]);
  const pokeOrder = [...order, 1];

  // "move a three-core to the map's central pathway so it can reach either
  // side within 10 to 15 seconds": the core is placed to win the rotation
  // race, and how well it is placed is exactly what varies.
  const coreReach = [rng.range(6, 15), rng.range(1, 4), rng.range(6, 15)];
  const lurkSide = rng.next() < 0.5 ? 0 : 2;
  const lurkReach = [0, 0, 0].map((_, i) =>
    i === lurkSide ? rng.range(2, 6) : i === 1 ? rng.range(6, 12) : rng.range(12, 20)
  );

  // How long a pocket stays isolated: their rotation, not a duel timer.
  const rotationSeconds = opts.rotationSeconds ?? rng.range(8, 22);

  return {
    theirs,
    split,
    believed,
    readQuality,
    pokeOrder,
    coreReach,
    lurkReach,
    lurkSide,
    rotationSeconds,
    theyPush: rng.next() < (opts.pushChance ?? 0.25),
    pushFrom: rng.pick([0, 1, 2]),
    pushAtSeconds: rng.range(2, 18),
    duelWindowSeconds: rng.range(3, 8),
    coreTravelSeconds: rng.range(4, 12),
    lurkConnectSeconds: rng.range(2, 10),
    pokeSeconds: rng.range(1, 4)
  };
}

/** The collapsers and their reach to a pocket: three core bodies and the lurk. */
function collapsersTo(world, pocket) {
  return [
    { role: 'core', reachSeconds: world.coreReach[pocket] },
    { role: 'core', reachSeconds: world.coreReach[pocket] + 1 },
    { role: 'core', reachSeconds: world.coreReach[pocket] + 2 },
    { role: 'lurker', reachSeconds: world.lurkReach[pocket] }
  ];
}

/** Build the phase context the machine reads, from the world and the clock. */
function wickTrialContext(world, m, tick) {
  const sec = m.secondsIn(tick);
  switch (m.phase) {
    case 'wait': {
      const pushed = world.theyPush && sec >= world.pushAtSeconds;
      if (!pushed) return { holdSeconds: sec, waitSeconds: WICK_WAIT_SECONDS };
      const pocket = world.pushFrom;
      return {
        holdSeconds: sec,
        waitSeconds: WICK_WAIT_SECONDS,
        enemyPushed: true,
        contact: {
          where: POCKET_NAMES[pocket],
          theirs: Math.max(1, world.split[pocket]),
          // They came to us: the core is already here, the lurk is not.
          collapsers: [
            { role: 'core', reachSeconds: 0 },
            { role: 'core', reachSeconds: 0 },
            { role: 'core', reachSeconds: 1 },
            { role: 'lurker', reachSeconds: world.lurkReach[pocket] }
          ],
          windowSeconds: world.duelWindowSeconds
        }
      };
    }
    case 'identify':
      return {
        coreCentral: sec >= world.coreTravelSeconds,
        lurkerConnected: sec >= world.lurkConnectSeconds
      };
    case 'confirm': {
      const pocket = world.pokeOrder[Math.min(m.pokes, world.pokeOrder.length - 1)];
      const there = world.split[pocket];
      if (!there || sec < world.pokeSeconds) return { contact: null };
      return {
        contact: {
          where: POCKET_NAMES[pocket],
          theirs: there,
          collapsers: collapsersTo(world, pocket),
          windowSeconds: world.rotationSeconds
        }
      };
    }
    case 'kill': {
      const reaches = (m.contact?.arriving || []).length;
      return { pocketEngaged: reaches > 0 && sec >= 1 };
    }
    default:
      return {};
  }
}

/**
 * Run WICK once against a sampled world, driving the real machine.
 *
 * @param {import('./rng.js').Rng} rng
 * @returns {{world:object, contact:object|null, done:object|null, path:string[], pokes:number}}
 */
export function runWickTrial(rng, opts = {}) {
  const world = sampleWickWorld(rng, opts);
  const m = new WickMachine({ tick: 0 });
  const limit = ticksFor(240);
  let tick = 0;
  while (!m.done && tick < limit) {
    m.step(tick, wickTrialContext(world, m, tick));
    tick += DECISION_EVERY_TICKS;
  }
  return {
    world,
    contact: m.contact,
    done: m.done,
    path: m.history.map((h) => h.phase),
    pokes: m.pokes
  };
}

/**
 * The plan's own test: run WICK a thousand times and print the distribution of
 * man-count-at-contact. Reports the shares honestly, including the contacts
 * that produced no local advantage at all, because the point of the exercise
 * is finding out whether the doctrine or the implementation is wrong.
 *
 * @param {object} args
 * @param {import('./rng.js').Rng} args.rng
 * @param {number} [args.trials]
 * @returns {object} counts, shares, and the split by how contact was made
 */
export function wickManCountDistribution({ rng, trials = 1000, ...opts }) {
  const counts = new Map();
  const byVia = { wait: 0, confirm: 0 };
  const outcomes = new Map();
  let local = 0;
  let ahead = 0;
  let contacts = 0;
  let sumOurs = 0;
  let sumTheirs = 0;

  for (let i = 0; i < trials; i += 1) {
    const t = runWickTrial(rng, opts);
    const reason = t.done?.reason || 'unterminated';
    outcomes.set(reason, (outcomes.get(reason) || 0) + 1);
    if (!t.contact) continue;
    contacts += 1;
    counts.set(t.contact.key, (counts.get(t.contact.key) || 0) + 1);
    byVia[t.contact.via] = (byVia[t.contact.via] || 0) + 1;
    sumOurs += t.contact.ours;
    sumTheirs += t.contact.theirs;
    if (t.contact.local) local += 1;
    if (t.contact.advantage > 0) ahead += 1;
  }

  return {
    trials,
    contacts,
    counts: [...counts.entries()]
      .map(([key, n]) => ({ key, n, share: n / Math.max(1, contacts) }))
      .sort((a, b) => b.n - a.n),
    outcomes: [...outcomes.entries()].map(([reason, n]) => ({ reason, n })),
    byVia,
    /** The doctrine's own claim: a local 4v1 or better. */
    localShare: local / Math.max(1, contacts),
    /** The weaker claim: any local advantage at all. */
    aheadShare: ahead / Math.max(1, contacts),
    meanOurs: sumOurs / Math.max(1, contacts),
    meanTheirs: sumTheirs / Math.max(1, contacts)
  };
}

// ---------------------------------------------------------------------------
// The antiflash role: a percept-level obligation, in two pure functions
//
// grenades.js charges full blindness inside 53 degrees, two seconds out to 90,
// and 0.3 s past it; engine.js blinds a body only above FLASH_VISION_BLIND
// (0.5 s). So facing MORE than 90 degrees off the flash bearing is not a
// mitigation, it is immunity, at any distance. That exact number is what makes
// the role implementable at all, and it is why the bias is computed rather
// than tuned.
// ---------------------------------------------------------------------------

/** Past this many degrees off, grenades.js stops charging real blindness. */
export const FLASH_SAFE_OFF_DEGREES = 90;

/** Standing on the cliff edge of a threshold is not a plan. `[calibrate]` */
export const ANTIFLASH_MARGIN_DEGREES = 15;

/** Degrees between a facing and a bearing, 0..180. engine.js's own formula. */
export function flashOffAngle(yaw, bearing) {
  const m = ((((bearing - yaw + 180) % 360) + 360) % 360) - 180;
  return Math.abs(Math.abs(m) - 180) === 0 ? 180 : Math.abs(m);
}

/** Signed rotation from one yaw to another, -180..180. */
function signedDelta(from, to) {
  return ((((to - from + 180) % 360) + 360) % 360) - 180;
}

function wrap360(deg) {
  return ((deg % 360) + 360) % 360;
}

/**
 * Where is the flash most likely to come from? The belief already knows.
 *
 * @param {object} args
 * @param {import('./knowledge.js').JointBelief} args.belief
 * @param {Array<{anchor:string, level?:string, yaw:number}>} args.bearings
 *   candidate throwing positions with the yaw from the group to each, which is
 *   what the angle catalogue gives for free
 * @returns {{bearing:number, anchor:string, mass:number, motive:string}|null}
 */
export function likelyFlashBearing({ belief, bearings }) {
  let best = null;
  for (const b of bearings || []) {
    const mass = belief.massAt(b.anchor, b.level ?? 'default');
    if (!best || mass > best.mass) best = { anchor: b.anchor, bearing: b.yaw, mass };
  }
  if (!best) return null;
  return {
    ...best,
    motive: `the flash comes from ${best.anchor}: the read puts ${best.mass.toFixed(2)} there`
  };
}

/**
 * The posture flag: bias a yaw target away from the likely flash bearing.
 *
 * Minimal rotation, not a turn-around: the antiflash body gives up the least
 * angle it can while still sitting outside the cone, and if it is already
 * outside it gives up nothing at all. Pure; the caller writes the result into
 * the hold's `yaw` param and desireBot.js does the wiring.
 *
 * @param {object} args
 * @param {number} args.holdYaw       the yaw the body would hold with no flash
 * @param {number} args.flashBearing  degrees, from likelyFlashBearing
 * @param {number} [args.marginDegrees]
 * @returns {{yaw:number, biasDegrees:number, offDegrees:number, motive:string}}
 */
export function antiflashYaw({ holdYaw, flashBearing, marginDegrees = ANTIFLASH_MARGIN_DEGREES }) {
  const need = FLASH_SAFE_OFF_DEGREES + marginDegrees;
  const off = flashOffAngle(holdYaw, flashBearing);
  if (off >= need) {
    return {
      yaw: wrap360(holdYaw),
      biasDegrees: 0,
      offDegrees: off,
      motive: `already ${Math.round(off)} degrees off the flash: no bias needed`
    };
  }
  // Two ways out of the cone; take the one that costs the least rotation.
  const a = wrap360(flashBearing + need);
  const b = wrap360(flashBearing - need);
  const da = signedDelta(holdYaw, a);
  const db = signedDelta(holdYaw, b);
  const bias = Math.abs(da) <= Math.abs(db) ? da : db;
  const yaw = wrap360(holdYaw + bias);
  return {
    yaw,
    biasDegrees: bias,
    offDegrees: flashOffAngle(yaw, flashBearing),
    motive: `holding ${Math.round(need)} degrees off the flash bearing: a pop cannot blind me`
  };
}

/**
 * The promotion rule: the antiflash body takes over as first contact when, and
 * only when, the entry is actually blind.
 *
 * Percepts in, decision out. A dead entry is NOT a promotion, it is a trade,
 * and conflating the two is how a group ends up with two bodies doing the same
 * job at the moment it can least afford it.
 *
 * @param {object} args
 * @param {{slot:number, alive:boolean, flashSeconds:number}} args.entry
 * @param {{slot:number, alive:boolean, flashSeconds:number}} args.cover
 * @param {number} [args.blindFloor]  engine.js's own vision threshold
 * @returns {{promote:boolean, firstContact:number|null, motive:string}}
 */
export function antiflashPromotion({ entry, cover, blindFloor = FLASH_VISION_BLIND }) {
  if (!cover?.alive) {
    return {
      promote: false,
      firstContact: entry?.alive ? entry.slot : null,
      motive: 'no antiflash body alive: the group is as blind as its entry'
    };
  }
  if (!entry?.alive) {
    return {
      promote: false,
      firstContact: entry?.slot ?? null,
      motive: 'the entry is down: that is a trade, not a promotion'
    };
  }
  if ((entry.flashSeconds ?? 0) <= blindFloor) {
    return {
      promote: false,
      firstContact: entry.slot,
      motive: 'the entry can still see: nothing to take over'
    };
  }
  if ((cover.flashSeconds ?? 0) > blindFloor) {
    return {
      promote: false,
      firstContact: entry.slot,
      motive: 'both are blind: the antiflash body was facing the wrong way'
    };
  }
  return {
    promote: true,
    firstContact: cover.slot,
    motive: `the entry is blind for ${(entry.flashSeconds ?? 0).toFixed(1)}s: ${cover.slot} was facing away and takes first contact`
  };
}
