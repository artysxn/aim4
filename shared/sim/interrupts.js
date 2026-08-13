// ---------------------------------------------------------------------------
// shared/sim/interrupts.js
// When does a plan stop being the plan?
//
// SIM-PLAN 10.2: every notable event is classified `ignore`, `local`, `team`,
// or — the fifth pass's addition (19.8) — `opportunity`. This taxonomy is the
// difference between "the banana player got peeked, he fights, the A execute
// continues" and "two dead plus a smoke, abort B". Get it wrong one way and
// five bots freeze on a dead tape; get it wrong the other way and every
// footstep re-plans the round.
//
//   ignore       the tape keeps rolling for everyone
//   local        the affected bot leaves FOLLOW; the other four keep walking
//   team         the hivemind fires; all living bots take new orders
//   opportunity  the round just got BETTER: promoted to the hivemind under
//                stricter conditions than a failure, because chasing every
//                piece of good news is its own pathology
//
// Pure classification: events and context in, a class and a reason out. The
// classifier never touches the engine, which is what makes the taxonomy
// testable as a table rather than through gameplay.
// ---------------------------------------------------------------------------

export const INTERRUPT = Object.freeze({
  IGNORE: 'ignore',
  LOCAL: 'local',
  TEAM: 'team',
  OPPORTUNITY: 'opportunity'
});

/** Team deaths inside the window that dissolve the call (10.2). */
export const TEAM_DEATHS_FOR_REPLAN = 2;
/** Locally broken bots at which the execute has dissolved anyway. */
export const BROKEN_FOR_REPLAN = 3;
/** Seconds into the round under which an AWPer death is a team event. */
export const AWP_DEATH_EARLY_SECONDS = 40;

/**
 * Classify one event for one side.
 *
 * @param {object} event  an engine event: {type, slot?, by?, ...}
 * @param {object} ctx
 * @param {'T'|'CT'} ctx.side              whose plan is being judged
 * @param {(slot: number) => 'T'|'CT'} ctx.sideOf
 * @param {number} ctx.teamDeaths          our deaths so far this round
 * @param {number} ctx.brokenCount         bots already off the tape
 * @param {number} ctx.roundSeconds        seconds since live start
 * @param {number|null} [ctx.awperSlot]    who carries the big gun, if anyone
 * @param {string|null} [ctx.plannedSite]  where the call is going, if T
 * @param {(slot: number) => string|null} [ctx.zoneOf]  a body's named zone
 * @param {boolean} [ctx.contactExpected]  the tape contains fighting here/now
 * @param {boolean} [ctx.farSide]          the event is across the map from the plan
 * @returns {{clazz: string, reason: string, slots?: number[]}}
 */
export function classifyEvent(event, ctx) {
  const mine = (slot) => ctx.sideOf(slot) === ctx.side;

  switch (event.type) {
    case 'freeze_end':
    case 'reload':
    case 'level_change':
      return { clazz: INTERRUPT.IGNORE, reason: 'housekeeping' };

    case 'shot': {
      // Gunfire is only news when the plan did not already contain it.
      if (ctx.contactExpected) return { clazz: INTERRUPT.IGNORE, reason: 'expected contact' };
      if (mine(event.slot)) return { clazz: INTERRUPT.IGNORE, reason: 'our own gun' };
      return { clazz: INTERRUPT.IGNORE, reason: 'distant gunfire, nobody of ours touched' };
    }

    case 'damage': {
      if (!mine(event.slot)) return { clazz: INTERRUPT.IGNORE, reason: 'their problem' };
      // Getting shot is the canonical local interrupt: spinal, one bot, the
      // other four keep walking (5.7's reflex exception).
      return { clazz: INTERRUPT.LOCAL, reason: 'taking damage', slots: [event.slot] };
    }

    case 'contact': {
      // A synthetic event the follow harness emits: an enemy became actionable
      // in this bot's cone and the tape did not have them shooting now.
      if (!mine(event.slot)) return { clazz: INTERRUPT.IGNORE, reason: 'their contact' };
      if (ctx.contactExpected) return { clazz: INTERRUPT.IGNORE, reason: 'the tape expected this' };
      return { clazz: INTERRUPT.LOCAL, reason: 'actionable contact off-script', slots: [event.slot] };
    }

    case 'follow_error':
      return { clazz: INTERRUPT.LOCAL, reason: 'fell off the tape', slots: [event.slot] };

    case 'stuck':
      return { clazz: INTERRUPT.LOCAL, reason: 'blocked on geometry', slots: [event.slot] };

    case 'death': {
      if (!mine(event.slot)) {
        // An enemy died. Whether that is worth a replan is the opportunity
        // question, and it is promoted only when the context says the round
        // genuinely improved somewhere the plan was not looking (19.8).
        if (ctx.farSide) {
          return {
            clazz: INTERRUPT.OPPORTUNITY,
            reason: 'kill on the far side: space is open'
          };
        }
        if (ctx.awperSlot != null && event.slot === ctx.awperSlot) {
          return { clazz: INTERRUPT.OPPORTUNITY, reason: 'their AWP is down' };
        }
        return { clazz: INTERRUPT.IGNORE, reason: 'enemy death inside the plan' };
      }

      // Ours. One death is local by default; the thresholds promote.
      if (ctx.teamDeaths + 1 >= TEAM_DEATHS_FOR_REPLAN) {
        return { clazz: INTERRUPT.TEAM, reason: `${ctx.teamDeaths + 1} dead` };
      }
      if (
        ctx.awperSlot != null &&
        event.slot === ctx.awperSlot &&
        ctx.roundSeconds < AWP_DEATH_EARLY_SECONDS
      ) {
        return { clazz: INTERRUPT.TEAM, reason: 'our AWPer died early' };
      }
      return { clazz: INTERRUPT.LOCAL, reason: 'first death', slots: [event.slot] };
    }

    case 'bomb_planted': {
      // The afterplant is always a team step, both sides: hold-versus-hunt is
      // a money decision and the CT plan just stopped existing (10.2, 4.9).
      return { clazz: INTERRUPT.TEAM, reason: 'bomb down' };
    }

    case 'bomb_defused':
    case 'round_end':
      return { clazz: INTERRUPT.IGNORE, reason: 'round is over' };

    case 'defuse_start': {
      if (ctx.side === 'T') return { clazz: INTERRUPT.TEAM, reason: 'they are on the bomb' };
      return { clazz: INTERRUPT.IGNORE, reason: 'our own defuse' };
    }

    case 'bomb_dropped': {
      if (ctx.side === 'T') return { clazz: INTERRUPT.TEAM, reason: 'the bomb is loose' };
      return { clazz: INTERRUPT.IGNORE, reason: 'their carrier died' };
    }

    case 'bomb_pickup':
      return { clazz: INTERRUPT.IGNORE, reason: 'carrier restored' };

    case 'site_contact': {
      // Synthetic: first contact at a site the plan was not hitting.
      if (ctx.side === 'T') return { clazz: INTERRUPT.IGNORE, reason: 'we chose the contact' };
      if (ctx.plannedSite && event.site && event.site !== ctx.plannedSite) {
        return { clazz: INTERRUPT.TEAM, reason: `contact at ${event.site}, we stacked ${ctx.plannedSite}` };
      }
      return { clazz: INTERRUPT.IGNORE, reason: 'contact where expected' };
    }

    case 'grenade_detonate': {
      if (mine(event.slot)) return { clazz: INTERRUPT.IGNORE, reason: 'our own utility' };
      return { clazz: INTERRUPT.IGNORE, reason: 'their utility, path not judged here' };
    }

    case 'zone_empty': {
      // Synthetic, from the belief: a zone's count distribution collapsed onto
      // zero (19.8). Good news, promoted as such.
      return { clazz: INTERRUPT.OPPORTUNITY, reason: `${event.zone || 'zone'} reads empty` };
    }

    default:
      return { clazz: INTERRUPT.IGNORE, reason: `unclassified ${event.type}` };
  }
}

/**
 * The heartbeat promotion (10.2): local breaks pile up until the call has
 * dissolved whether or not anything formally cancelled it.
 */
export function shouldPromote(ctx) {
  if (ctx.brokenCount >= BROKEN_FOR_REPLAN) {
    return { promote: true, reason: `${ctx.brokenCount} bots already off the tape` };
  }
  if (ctx.teamDeaths >= TEAM_DEATHS_FOR_REPLAN) {
    return { promote: true, reason: `${ctx.teamDeaths} dead` };
  }
  return { promote: false };
}
