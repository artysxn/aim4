// ---------------------------------------------------------------------------
// shared/sim/triggers.js
// Anticipation: arming options against the future, not the present.
//
// SIM-PLAN 6.15. Foresight prices options against the belief as it IS; every
// valuable CS decision is about the belief as it WILL BE. A rotation started
// after the contact is a late rotation; a flank started after they hear you is
// a walk into a crossfire. Football Manager's pressing triggers are the
// borrowed shape: contextual conditions that ARM an option with a lead time,
// rather than constants that fire on a clock.
//
// Each trigger is DATA. It fires with its lead time, it is logged, and it
// prints in the decision log as English. Each is gated by the bot's
// `anticipation` trait (6.16): a low-anticipation bot fires fewer of them,
// later — which is precisely what a worse player looks like, and far better
// than making them aim worse.
//
// The conditions read belief summaries and fitted quantities the other
// modules already expose (cycleW's reload window, live PFW, earliestOccupy,
// the timing table); nothing here touches engine truth.
// ---------------------------------------------------------------------------

/**
 * The table, straight from the plan. `when(ctx)` reads the trigger context
 * assembled by the arbiter each tactical step; `arms` names options (6.6) the
 * trigger puts on the candidate list with priority; `leadSeconds` is how far
 * ahead of the window the option should begin.
 */
export const TRIGGERS = Object.freeze([
  {
    id: 'awp_cycling',
    leadSeconds: 1.4,
    arms: ['punish_window', 'wide_swing'],
    when: (ctx) => Boolean(ctx.enemyAwpCycling),
    motive: 'their AWP fired and is cycling'
  },
  {
    id: 'reload_or_util_window',
    leadSeconds: 2,
    arms: ['punish_window', 'take_space'],
    when: (ctx) => Boolean(ctx.enemyReloading || ctx.enemyJustThrewUtility),
    motive: 'a known enemy is reloading or just threw'
  },
  {
    id: 'split_read',
    leadSeconds: 8,
    arms: ['rotate', 'crossfire_hold'],
    when: (ctx) =>
      (ctx.accountedOneSide ?? 0) >= 2 &&
      (ctx.unaccounted ?? 0) >= 2 &&
      Boolean(ctx.otherSideReachable),
    motive: 'two accounted on one side, the rest unaccounted'
  },
  {
    id: 'free_ground',
    leadSeconds: 0,
    arms: ['take_space', 'run_in_behind'],
    when: (ctx) =>
      (ctx.beliefMassOnMyAngle ?? 1) < 0.12 && (ctx.earliestOccupyEdgeSeconds ?? -1) > 0,
    motive: 'my angle reads empty and I win the race there'
  },
  {
    id: 'mate_losing',
    leadSeconds: 1.5,
    arms: ['trade', 'show_short'],
    when: (ctx) => Number.isFinite(ctx.matePfw) && ctx.matePfw < 0.35,
    motive: 'a teammate is about to lose their duel'
  },
  {
    id: 'smoke_cut',
    leadSeconds: 1,
    arms: ['utility_setup'],
    when: (ctx) => Boolean(ctx.enemyCommittedToCorridor),
    motive: 'their pack is committed to a corridor a smoke can cut'
  },
  {
    id: 'commit_window',
    leadSeconds: 0,
    arms: ['execute_entry', 'fall_back'],
    when: (ctx) => Boolean(ctx.clockPastCommitWindow),
    motive: "the clock crossed the call's commit window"
  }
]);

/**
 * Which triggers fire for this bot, this step?
 *
 * Anticipation gates twice, both ways a weaker player is actually weaker:
 *
 *   FEWER: each armed trigger needs a draw under the trait, so a 0.4 bot
 *   simply misses reads a 0.9 bot makes. Deterministic through the engine rng.
 *
 *   LATER: the lead shrinks with the trait. A pro starts rotating eight
 *   seconds before the fact; a mixer starts when it happens.
 *
 * @param {object} ctx   the trigger context (see TRIGGERS conditions)
 * @param {object} args
 * @param {number} args.anticipation  0..1 trait (6.16)
 * @param {import('./rng.js').Rng} args.rng
 * @returns {Array<{id:string, arms:string[], leadSeconds:number, motive:string}>}
 */
export function firedTriggers(ctx, { anticipation, rng }) {
  const a = Math.max(0, Math.min(1, anticipation));
  const out = [];
  for (const t of TRIGGERS) {
    if (!t.when(ctx)) continue;
    // The miss chance: full anticipation misses nothing, none misses most.
    if (rng.next() > 0.25 + 0.75 * a) continue;
    out.push({
      id: t.id,
      arms: [...t.arms],
      leadSeconds: t.leadSeconds * a,
      motive: t.motive
    });
  }
  return out;
}
