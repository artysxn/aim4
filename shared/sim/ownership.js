// ---------------------------------------------------------------------------
// shared/sim/ownership.js
// Zone ownership, and who wins when two bots have ideas.
//
// SIM-PLAN 20.8. Chapter 12 answers a question the plan had not asked: when
// two bots have ideas, who wins? The answer is geography, not degree.
//
//   Every named zone has exactly one owner per round, assigned at freeze
//   alongside roles. The owner has the right and the obligation to set tempo
//   there: when to poke or hold, which utility layer to spend, when to call
//   the hit, and what ASP follows. Non-owners entering that zone default to
//   Entry 2 / Support under the owner's plan and may not overtake his lane.
//   Implementation is an option-mask term keyed by (bot, zone), which is the
//   same mechanism role contracts already use (6.19), so it costs nothing
//   new.
//
//   This is also the plan's answer to the freedom question, and it is the
//   document's answer too: the owner is free inside his zone, everybody else
//   is bound. Individual initiative and team structure stop being in tension
//   because they are separated by geography rather than by a slider.
//
// Assignment prefers the roster member whose home post is that zone. Homes
// that do not match a named zone are not a claim on some other zone; unused
// zones go to the IGL. Ties break on slot order. The same freeze always
// produces the same owners, because a disputed overcall that cannot name
// who owned the ground is not an overcall, it is an argument.
//
// THE OVERCALL PROTOCOL is needed the moment ASPs exist, because conflicting
// calls will happen:
//
//   time-sensitive   one voice (the IGL, or the owner if the owner is the
//                    one speaking) preempts every pending ASP. Everybody
//                    follows immediately. No arbitration.
//   relaxed          information is relayed, and the zone owner or the IGL
//                    assembles the call. Nobody is preempted.
//
// Who may overcall is a role property: the IGL always, the owner of the
// zone. A random slot may not.
//
// TEAM IDENTITY (chapter 12's regional split of call ownership) is one
// enum in the match config: who owns the first twenty seconds, who
// assembles the mid-round. `igl-early` is IGL first then players;
// `players-early` is the other regional split. That is a genuinely
// different-feeling team for one parameter, and it is exactly the kind of
// variety the behaviour archive (9.22) wants to index.
//
// Pure: no I/O, no clock, no rng. Same freeze, same owners. Same overcall
// arguments, same preemption.
// ---------------------------------------------------------------------------

/** Who may speak for a zone, and how urgently. */
export const OVERCALL = Object.freeze({
  TIME_SENSITIVE: 'time-sensitive',
  RELAXED: 'relaxed'
});

/**
 * Team-identity parameter: who owns the first twenty seconds, who
 * assembles the mid-round. Values are `'igl'` | `'players'`.
 */
export const IDENTITY = Object.freeze({
  IGL: 'igl',
  PLAYERS: 'players'
});

/** Chapter 12's early window, in seconds. `[calibrate]` only if the split moves. */
export const IDENTITY_EARLY_SECONDS = 20;

const IDENTITY_PRESETS = Object.freeze({
  'igl-early': Object.freeze({
    name: 'igl-early',
    earlyOwner: IDENTITY.IGL,
    midOwner: IDENTITY.PLAYERS,
    earlySeconds: IDENTITY_EARLY_SECONDS
  }),
  'players-early': Object.freeze({
    name: 'players-early',
    earlyOwner: IDENTITY.PLAYERS,
    midOwner: IDENTITY.IGL,
    earlySeconds: IDENTITY_EARLY_SECONDS
  })
});

/**
 * The identity parameter for a named split. Unknown names throw: a typo
 * here would quietly give every team the same voice.
 *
 * @param {string} name  `'igl-early'` | `'players-early'`
 * @returns {{name:string, earlyOwner:string, midOwner:string, earlySeconds:number}}
 */
export function identityPreset(name) {
  const row = IDENTITY_PRESETS[name];
  if (!row) throw new Error(`ownership: unknown identity ${name}`);
  return row;
}

function zoneId(z) {
  return typeof z === 'string' ? z : z?.id;
}

function zoneIds(zones) {
  const ids = [];
  for (const z of zones || []) {
    const id = zoneId(z);
    if (id) ids.push(id);
  }
  return ids;
}

/** Exact home match is distance 0; anything else is not a claim. */
function defaultDistance(home, zone) {
  return home === zone ? 0 : Infinity;
}

/**
 * Every named zone gets exactly one owner. Assigned at freeze.
 *
 * Prefer the roster member whose `home` is this zone. Unused zones go to
 * the IGL. Ties break on lowest slot. Optional `distance(home, zone)` lets
 * a caller with geometry pick the nearest post; without it, only an exact
 * home match counts as close.
 *
 * @param {object} args
 * @param {Iterable<string|{id:string}>} args.zones
 * @param {Array<{slot:number, home:string, role?:string}>} args.roster
 * @param {number} args.iglSlot
 * @param {(home:string, zone:string) => number} [args.distance]
 * @returns {Map<string, number>} zone -> owner slot
 */
export function assignZoneOwners({ zones, roster = [], iglSlot, distance = defaultDistance } = {}) {
  if (!Number.isInteger(iglSlot)) throw new Error('ownership: assignZoneOwners needs an iglSlot');
  const ids = zoneIds(zones);
  const players = [...roster].filter((p) => p && Number.isInteger(p.slot));
  players.sort((a, b) => a.slot - b.slot);

  const assignment = new Map();
  for (const zone of ids) {
    let bestSlot = null;
    let bestD = Infinity;
    for (const p of players) {
      const d = distance(p.home, zone);
      if (!Number.isFinite(d)) continue;
      if (d < bestD || (d === bestD && (bestSlot == null || p.slot < bestSlot))) {
        bestD = d;
        bestSlot = p.slot;
      }
    }
    assignment.set(zone, bestSlot == null ? iglSlot : bestSlot);
  }
  return assignment;
}

/** Owner slot of a zone, or undefined if the zone was not assigned. */
export function ownerOf(assignment, zone) {
  if (!assignment) return undefined;
  return assignment.get(zone);
}

/**
 * Is this slot the owner of the zone, or a guest?
 *
 * Guests default to Entry 2 / Support under the owner's plan:
 * `{ status: 'guest', maskHint: 'support' }`. Owners are free inside the
 * zone and carry no extra mask.
 *
 * @param {object} args
 * @param {Map<string, number>} args.assignment
 * @param {number} args.slot
 * @param {string} args.zone
 * @returns {{status:'owner'|'guest', maskHint:string|null}}
 */
export function roleInZone({ assignment, slot, zone }) {
  const owner = ownerOf(assignment, zone);
  if (owner === slot) return { status: 'owner', maskHint: null };
  return { status: 'guest', maskHint: 'support' };
}

/**
 * Who may overcall: the IGL always, the owner of the zone.
 *
 * @param {object} args
 * @param {number} args.from
 * @param {number} args.iglSlot
 * @param {number} [args.ownerSlot]
 */
export function mayOvercall({ from, iglSlot, ownerSlot = null } = {}) {
  return from === iglSlot || (ownerSlot != null && from === ownerSlot);
}

/**
 * Resolve a conflicting call.
 *
 * Time-sensitive: if `from` may overcall, one voice preempts and everybody
 * follows. If they may not, nothing is preempted. Relaxed: never preempts;
 * the owner (else the IGL) assembles. `priority` is logged through, not
 * used as a second mode.
 *
 * @param {object} args
 * @param {string} args.mode  OVERCALL.TIME_SENSITIVE | OVERCALL.RELAXED
 * @param {number} args.from
 * @param {number} args.iglSlot
 * @param {number} [args.ownerSlot]
 * @param {string} [args.priority]
 * @returns {{preempt:boolean, follow?:boolean, assemble?:boolean, assembler?:number, motive:string, priority?:string}}
 */
export function overcall({ mode, from, iglSlot, ownerSlot = null, priority = null } = {}) {
  const resolved = mode || priority || OVERCALL.RELAXED;
  const allowed = mayOvercall({ from, iglSlot, ownerSlot });

  if (resolved === OVERCALL.TIME_SENSITIVE) {
    if (!allowed) {
      return {
        preempt: false,
        follow: false,
        assemble: false,
        motive: `slot ${from} may not overcall this zone`,
        priority
      };
    }
    const voice = from === iglSlot ? 'the IGL' : 'the zone owner';
    return {
      preempt: true,
      follow: true,
      assemble: false,
      motive: `time-sensitive: ${voice} overcalls, everybody follows`,
      priority
    };
  }

  const assembler = ownerSlot ?? iglSlot;
  return {
    preempt: false,
    follow: false,
    assemble: true,
    assembler,
    motive:
      assembler === iglSlot
        ? 'relaxed: information is relayed, the IGL assembles'
        : `relaxed: information is relayed, slot ${assembler} assembles`,
    priority
  };
}
