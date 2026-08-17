// ---------------------------------------------------------------------------
// demoparser/schema.js
// The normalized demo shape. This file is the contract between whichever
// parser is plugged in and the rest of the site: nothing outside this folder
// may import a parser package directly, and nothing outside this folder knows
// what "@laihoe/demoparser2" is. Swapping parsers means writing one new
// adapter that returns this shape (see README.md).
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

/**
 * Our own adapter revision, bumped whenever a parse of the same .dem would now
 * produce different round files.
 *
 * Distinct from the parser package version: fixing how we read the underlying
 * rows changes the output without the dependency moving at all, and a demo
 * parsed before such a fix keeps the old answer until it is parsed again. This
 * number is what makes that visible on the uploads list, so bump it with any
 * change to the adapters that alters output.
 *
 *   1  original
 *   2  fire grenades read their type from the shot log, so a molotov thrown by
 *      a CT is stored as a molotov instead of an incendiary
 *   3  movement state is real. Revisions 1-2 asked demoparser2 for
 *      `is_ducking` and `in_air`, which it silently omits rather than
 *      rejecting, so every round they produced has zeros in FLAG_DUCKING and
 *      FLAG_AIRBORNE. This revision reads m_bDucked / m_flDuckAmount and
 *      m_fFlags (FL_ONGROUND), and stores the continuous duck amount in the
 *      side byte's high nibble. A round at revision < 3 cannot be upgraded
 *      without the original .dem — see shared/sim3d/deriveFlags.js for what
 *      is recoverable from the tick buffer alone, and what is not.
 *      Also records events.broken: raw entity_killed rows for map breakables,
 *      indices undecoded, so a future per-map table can read them without
 *      re-downloading anything. Doors are NOT captured and cannot be: their
 *      entity is not replicated and no door event exists in the demo.
 *   4  grenade flight simplify measures error in XYZ, not XY. Revisions 1-3
 *      drop the apex of a lofted smoke because it sits on the ground track.
 *      Same 6-unit tolerance, now on height too. Throw and land are unchanged.
 */
export const PARSER_REVISION = 4;

/** First revision whose tick buffer has real jump and crouch. The 3D viewer
 *  needs this, not the latest adapter. Grenade-path quality is revision 4. */
export const MOVEMENT_REVISION = 3;

/**
 * @typedef {object} NormalizedPlayer
 * @property {string} id        3-char short id used in round names
 * @property {string} name      display name at parse time
 * @property {string} steamId   steamid64, or '' when the demo has none
 * @property {1|2}    team      which side of the round name they belong to
 * @property {number} slot      0-9, the record slot in the tick buffer
 */

/**
 * @typedef {object} NormalizedRound
 * @property {number} round             1-99, order in the match
 * @property {1|2} winner
 * @property {'T'|'CT'} winnerSide      side that won (from round_end + team_num)
 * @property {'T'|'CT'} team1Side       side roster team 1 played this round
 * @property {'T'|'CT'} team2Side       side roster team 2 played this round
 * @property {number} econ1             0-5 economy bucket, team 1
 * @property {number} econ2             0-5 economy bucket, team 2
 * @property {number} startTick         first tick of freezetime
 * @property {number} freezeEndTick     tick the round goes live
 * @property {number|null} plantTick    tick the bomb was planted
 * @property {number} endTick           tick the winner was decided
 * @property {number} officialEndTick   tick the next freezetime begins
 * @property {NormalizedPlayer[]} players  exactly 10, ordered by slot
 * @property {string[]} weapons         dictionary; tick records store indices
 * @property {ArrayBuffer} ticks        tickFormat buffer, stride 1
 * @property {RoundEvents} events
 * @property {Record<string, PlayerRoundStats>} stats  keyed by player id
 */

/**
 * @typedef {object} BrokenEvent
 * A map entity destroyed this round — a window, a vent, a breakable prop.
 * The entity is identified ONLY by its engine index, because demoparser2
 * exposes no world-entity classes and no break event; there is no name,
 * position or model to go with it. Stored undecoded so a per-map index table
 * can interpret it later without another parse. Player deaths are excluded.
 * @property {number} tick
 * @property {number} entity     entindex_killed, opaque until mapped
 * @property {number} attacker   entindex_attacker
 * @property {number} inflictor  entindex_inflictor
 * @property {number} damageBits
 */

/**
 * @typedef {object} RoundEvents
 * @property {KillEvent[]} kills
 * @property {ShotEvent[]} shots        every shot fired, by every player
 * @property {GrenadeEvent[]} grenades  throw + detonation, with trajectory
 * @property {BombEvent[]} bomb
 * @property {DamageEvent[]} [damage]   player_hurt hits (coach / attribution)
 * @property {ItemEvent[]} [items]      post-freeze pickups / drops
 */

/**
 * @typedef {object} DamageEvent
 * @property {number} tick
 * @property {string} attacker  player id ('' for world / self omitted at parse)
 * @property {string} victim    player id
 * @property {number} hp        health damage dealt
 * @property {string} [weapon]
 */

/**
 * @typedef {object} KillEvent
 * @property {number} tick
 * @property {string} attacker   player id ('' for world)
 * @property {string} victim     player id
 * @property {string} assister   player id or ''
 * @property {string} weapon
 * @property {boolean} headshot
 * @property {boolean} noscope
 * @property {boolean} throughSmoke
 * @property {boolean} penetrated
 * @property {boolean} attackerBlind
 */

/**
 * @typedef {object} ShotEvent
 * @property {number} tick
 * @property {string} player
 * @property {string} weapon
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} yaw
 * @property {number} pitch
 */

/**
 * @typedef {object} GrenadeEvent
 * @property {string} type       flashbang | smokegrenade | hegrenade | molotov | incgrenade | decoy
 * @property {string} player     thrower
 * @property {number} throwTick
 * @property {number|null} detonateTick
 * @property {{x:number,y:number,z:number}|null} from   throw origin
 * @property {{x:number,y:number,z:number}|null} at     landing / detonation point
 * @property {Array<{tick:number,x:number,y:number,z:number}>} path  flight trajectory
 */

/**
 * @typedef {object} BombEvent
 * @property {'planted'|'defused'|'exploded'|'dropped'|'pickup'} type
 * @property {number} tick
 * @property {string} player
 * @property {string} site       'A' | 'B' | ''
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [z]
 */

/**
 * @typedef {object} ItemEvent
 * @property {number} tick
 * @property {string} player
 * @property {string} item       weapon / grenade stem (no weapon_ prefix)
 * @property {'pickup'|'remove'} op
 */

/**
 * @typedef {object} PlayerRoundStats
 * @property {number} kills
 * @property {number} deaths
 * @property {number} assists
 * @property {number} damage
 * @property {number} shots
 * @property {number} money       cash at freezetime end
 * @property {number} equipValue  value of the loadout at freezetime end
 * @property {string[]} loadout   full inventory at freezetime end
 */

/**
 * @typedef {object} NormalizedDemo
 * @property {number} schemaVersion
 * @property {{name: string, version: string}} parser
 * @property {string} map        map code (ANC, DD2, ...)
 * @property {string} mapRaw     name as the demo spelled it
 * @property {number} tickRate
 * @property {{id: string, name: string}} team1
 * @property {{id: string, name: string}} team2
 * @property {NormalizedRound[]} rounds
 * @property {object} [source]   free-form provenance from the adapter
 */

/** Grenade types the viewer knows how to draw. */
export const GRENADE_TYPES = [
  'flashbang',
  'smokegrenade',
  'hegrenade',
  'molotov',
  'incgrenade',
  'decoy'
];

/**
 * Validate an adapter's output before it reaches storage. A parser swap that
 * quietly drops rounds or ticks should fail loudly here rather than produce a
 * library full of empty replays.
 *
 * @param {NormalizedDemo} demo
 * @returns {string[]} problems, empty when the demo is usable
 */
export function validateDemo(demo) {
  const errs = [];
  if (!demo || typeof demo !== 'object') return ['demo is not an object'];
  if (demo.schemaVersion !== SCHEMA_VERSION) {
    errs.push(`schemaVersion ${demo.schemaVersion} != ${SCHEMA_VERSION}`);
  }
  if (!demo.map) errs.push('missing map code');
  if (!(demo.tickRate > 0)) errs.push('missing tickRate');
  if (!Array.isArray(demo.rounds) || demo.rounds.length === 0) {
    errs.push('no rounds parsed');
    return errs;
  }
  demo.rounds.forEach((r, i) => {
    const where = `round[${i}]`;
    if (!(r.round >= 1 && r.round <= 99)) errs.push(`${where}: round number out of range`);
    if (r.winner !== 1 && r.winner !== 2) errs.push(`${where}: winner must be 1 or 2`);
    if (!Array.isArray(r.players) || r.players.length !== 10) {
      errs.push(`${where}: expected 10 players, got ${r.players?.length ?? 0}`);
    }
    if (!(r.ticks instanceof ArrayBuffer) || r.ticks.byteLength === 0) {
      errs.push(`${where}: missing tick buffer`);
    }
    if (!r.events) errs.push(`${where}: missing events`);
  });
  return errs;
}
