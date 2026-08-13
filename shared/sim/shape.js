// ---------------------------------------------------------------------------
// shared/sim/shape.js
// The formation frame: how a team behaves when it does not have the ball.
//
// SIM-PLAN 6.13, borrowed from football on purpose. EA's FC IQ draws the line
// this codebase needed: the formation is how your team behaves WITHOUT the
// ball; roles are how players move WITH it. CS has exactly this structure and
// nobody writes it down. The ball is INITIATIVE: who currently dictates where
// the round happens. A CT side that has lost mid has lost the ball and should
// be collapsing toward shape; a T side that owns banana has it and should be
// pulling roles forward.
//
//   a SHAPE is data: home positions per role, defined per (map, side, call,
//   phase), baked from the library's modal setups
//
//   HOME POSITION is the default answer to "what do I do now". Off-script,
//   with nothing to react to, a bot returns toward home — a far better idle
//   than "hold your anchor", and what stops five bots drifting into the same
//   corridor
//
//   TRANSITION IS AN EVENT: losing initiative triggers a shape reset with a
//   per-bot speed from role familiarity, filling the gap between "local
//   interrupt" and "team interrupt" in 10.2
//
//   BACKFILL (6.14's rule 2, living here because it is a shape recompute):
//   when a bot leaves its home, the nearest compatible teammate inherits the
//   vacated responsibility. "Nobody is watching B" is the defining failure of
//   every FPS bot team, and this is the one rule that fixes it.
// ---------------------------------------------------------------------------

/** Role focuses (6.13): two or three per role, the cheap strategic multiplier. */
export const ROLE_FOCUS = Object.freeze({
  entry: ['aggressive', 'measured'],
  support: ['tight', 'wide'],
  lurk: ['deep', 'connected'],
  anchor: ['deep', 'close', 'roam'],
  awp: ['passive', 'aggressive', 'rotational'],
  igl: ['front', 'back'],
  rotator: ['early', 'late']
});

/**
 * Seconds a fully familiar bot takes to begin moving toward a reset shape;
 * unfamiliarity stretches it, the FC IQ rule copied verbatim. `[calibrate]`
 */
export const SHAPE_TRANSITION_BASE_SECONDS = 1.5;
export const SHAPE_TRANSITION_UNFAMILIAR_SECONDS = 5;

/**
 * A team's shape for one (call, phase): who is responsible for standing where.
 *
 * @typedef {object} Shape
 * @property {string} call
 * @property {string} phase
 * @property {Array<{slot:number, role:string, focus:string, home:string}>} posts
 *   `home` is an anchor id from the catalogue — an entry in the same
 *   vocabulary every other module speaks.
 */

/** Build a shape record, validating the one invariant: one post per slot. */
export function makeShape({ call, phase = 'default', posts }) {
  const seen = new Set();
  for (const p of posts) {
    if (seen.has(p.slot)) throw new Error(`shape: slot ${p.slot} posted twice`);
    seen.add(p.slot);
    if (!p.home) throw new Error(`shape: slot ${p.slot} has no home`);
  }
  return { call, phase, posts: posts.map((p) => ({ focus: 'default', ...p })) };
}

/** The home post for a slot, or null for a slot the shape does not know. */
export function homeOf(shape, slot) {
  return shape.posts.find((p) => p.slot === slot) || null;
}

/**
 * Who has the ball? Readable from map control, the bomb, and live contact —
 * the three signals 6.13 names. Returns 'mine' | 'theirs' | 'contested'.
 *
 * @param {object} args
 * @param {number} args.controlShare   my side's share of contested ground, 0..1
 * @param {boolean} [args.bombDown]    the bomb is planted (T has the ball until retake)
 * @param {'mine'|'theirs'|null} [args.lastContactWonBy]
 * @param {'T'|'CT'} args.side
 */
export function initiative({ controlShare, bombDown = false, lastContactWonBy = null, side }) {
  if (bombDown) return side === 'T' ? 'mine' : 'theirs';
  let score = (controlShare - 0.5) * 2; // -1 .. 1
  if (lastContactWonBy === 'mine') score += 0.25;
  if (lastContactWonBy === 'theirs') score -= 0.25;
  if (score > 0.15) return 'mine';
  if (score < -0.15) return 'theirs';
  return 'contested';
}

/**
 * Did this event lose us the ball? A lost duel at the frontier, a smoke that
 * cuts control, two deaths — the transition events of 6.13. The answer is a
 * shape reset, NOT a team replan: the call stands, the bodies collapse toward
 * their posts while it is re-judged.
 */
export function isTransitionEvent(event, ctx = {}) {
  switch (event?.type) {
    case 'death':
      return Boolean(ctx.mine) || (ctx.teamDeaths ?? 0) >= 2;
    case 'frontier_lost': // a duel at the control boundary went the wrong way
    case 'control_cut': // their smoke severed our held ground
      return true;
    default:
      return false;
  }
}

/**
 * The reset order: every living bot turns toward home, each at its own speed.
 *
 * Familiarity is per (bot, role) from the library (6.13); an unfamiliar bot
 * transitions slower and the stand-in problem falls out for free. Focus can
 * hurry it: an `aggressive` focus halves the delay because that player was
 * never going to walk back slowly.
 *
 * @param {Shape} shape
 * @param {Array<boolean>} alive           per slot
 * @param {(slot:number, role:string) => number} familiarity  0..1
 * @returns {Array<{slot:number, home:string, delaySeconds:number}>}
 */
export function shapeReset(shape, alive, familiarity) {
  const out = [];
  for (const post of shape.posts) {
    if (!alive[post.slot]) continue;
    const f = Math.max(0, Math.min(1, familiarity(post.slot, post.role)));
    let delay =
      SHAPE_TRANSITION_UNFAMILIAR_SECONDS +
      (SHAPE_TRANSITION_BASE_SECONDS - SHAPE_TRANSITION_UNFAMILIAR_SECONDS) * f;
    if (post.focus === 'aggressive') delay *= 0.5;
    out.push({ slot: post.slot, home: post.home, delaySeconds: delay });
  }
  return out;
}

/**
 * Backfill: a post has been vacated — who inherits it?
 *
 * The nearest COMPATIBLE living teammate takes the responsibility, where
 * compatible means "not the only body on its own post of a different site".
 * v1 compatibility is role-based: an anchor never abandons its site to
 * backfill the other one; everyone else is eligible. The inheritor's own post
 * then cascades — one vacancy moves through the shape rather than leaving a
 * new hole, which is FIFA's "runs are relative to each other" rule.
 *
 * @param {Shape} shape
 * @param {number} vacatedSlot
 * @param {Array<boolean>} alive
 * @param {(slot:number, anchorId:string) => number} travelSeconds
 * @param {number} [maxSeconds]  beyond this nobody inherits (too far to matter)
 * @returns {{slot:number, home:string, cascade: {from:string, to:string}}|null}
 */
export function backfill(shape, vacatedSlot, alive, travelSeconds, maxSeconds = 12) {
  const vacated = homeOf(shape, vacatedSlot);
  if (!vacated) return null;

  let best = null;
  for (const post of shape.posts) {
    if (post.slot === vacatedSlot || !alive[post.slot]) continue;
    // An anchor's post is a contract on its own ground (6.19): it does not
    // leave a site to plug a hole elsewhere. Everyone else may inherit.
    if (post.role === 'anchor' && post.home !== vacated.home) continue;
    const s = travelSeconds(post.slot, vacated.home);
    if (!Number.isFinite(s) || s > maxSeconds) continue;
    if (!best || s < best.seconds) best = { post, seconds: s };
  }
  if (!best) return null;
  return {
    slot: best.post.slot,
    home: vacated.home,
    cascade: { from: best.post.home, to: vacated.home }
  };
}

/**
 * Occupancy check: which posts are currently uncovered? A post is covered
 * when SOME living bot is within reach of it — not necessarily its owner;
 * backfill means the shape cares about coverage, not name tags.
 *
 * @param {Shape} shape
 * @param {Array<boolean>} alive
 * @param {(slot:number, anchorId:string) => number} travelSeconds
 * @param {number} [coverSeconds]  within this is "covering it"
 * @returns {string[]} uncovered home anchor ids
 */
export function uncoveredPosts(shape, alive, travelSeconds, coverSeconds = 6) {
  const out = [];
  for (const post of shape.posts) {
    let covered = false;
    for (const other of shape.posts) {
      if (!alive[other.slot]) continue;
      const s = travelSeconds(other.slot, post.home);
      if (Number.isFinite(s) && s <= coverSeconds) {
        covered = true;
        break;
      }
    }
    if (!covered) out.push(post.home);
  }
  return [...new Set(out)];
}
